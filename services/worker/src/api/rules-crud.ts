/**
 * Organization Rules CRUD API (ARK-105/108 — SCRUM-1017/1020)
 *
 * GET  /api/rules               → list caller's org rules (newest first)
 * POST /api/rules               → create rule (enabled=false by default per ARK-110)
 * PATCH /api/rules/:id          → update rule (name/desc/enabled + optional config)
 * DELETE /api/rules/:id         → hard-delete rule (no soft-delete column yet)
 *
 * Authz: every query is filtered by `caller_profile.org_id`; Supabase RLS on
 * `organization_rules` (migration 0224) enforces the same constraint in
 * case the worker service_role ever gets misused. SECURITY DEFINER RPCs
 * double-check ORG_ADMIN for writes.
 *
 * Newly-created + NL-authored rules ship with `enabled=false` — admin must
 * flip on explicitly. This is the SEC-02 prompt-injection defense.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import {
  CreateOrgRuleInput,
  assertNoInlineSecrets,
  validateRuleConfigs,
} from '../rules/schemas.js';

const UuidSchema = z.string().uuid();

/**
 * SEC-02 — every rule lifecycle event lands in `audit_events`. Non-fatal:
 * a failed audit emit should never reject the user's write. Before/after
 * diffs are passed in `details` JSON so auditors can reconstruct history.
 */
async function emitRuleAudit(
  eventType:
    | 'ORG_RULE_CREATED'
    | 'ORG_RULE_UPDATED'
    | 'ORG_RULE_DELETED'
    | 'ORG_RULE_ENABLED'
    | 'ORG_RULE_DISABLED',
  params: {
    actorId: string;
    orgId: string;
    ruleId: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    // `audit_events.details` is TEXT (see migration 0006) with a 10000-char
    // check constraint. JSON.stringify + truncate keeps auditor greppability
    // while respecting the column limit. Supabase returns errors via `error`
    // rather than throwing — check it explicitly so ops can diagnose drops.
    const serialized = JSON.stringify(params.details ?? {}).slice(0, 10000);
    const { error } = await db.from('audit_events').insert({
      event_type: eventType,
      event_category: 'ORG',
      actor_id: params.actorId,
      org_id: params.orgId,
      target_type: 'organization_rule',
      target_id: params.ruleId,
      details: serialized,
    });
    if (error) {
      logger.warn({ error, eventType, ruleId: params.ruleId }, 'rule audit emit failed');
    }
  } catch (err) {
    logger.warn({ error: err, eventType, ruleId: params.ruleId }, 'rule audit emit threw');
  }
}

export const UpdateOrgRuleInput = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(1000).optional(),
    enabled: z.boolean().optional(),
    trigger_config: z.record(z.unknown()).optional(),
    action_config: z.record(z.unknown()).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'At least one field required');

export type UpdateOrgRuleInputT = z.infer<typeof UpdateOrgRuleInput>;

/**
 * Resolves the caller's org from their profile. Worker uses a service_role
 * client, which bypasses RLS — every query here MUST explicitly scope by
 * `org_id = callerOrg` to prevent cross-tenant writes.
 */
async function getCallerOrgId(userId: string): Promise<string | null> {
  const { data, error } = await db
    .from('profiles')
    .select('org_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    // RLS or transient failure. Log + fail-closed (null → 403) rather than
    // leaking the error upstream as "no organization", which looks identical
    // to a legitimate unaffiliated user and makes incidents invisible.
    logger.warn({ error, userId }, 'profiles lookup failed in getCallerOrgId');
    return null;
  }
  return (data?.org_id as string | null) ?? null;
}

export async function handleListRules(
  userId: string,
  _req: Request,
  res: Response,
): Promise<void> {
  const orgId = await getCallerOrgId(userId);
  if (!orgId) {
    res.status(403).json({ error: { code: 'forbidden', message: 'No organization on profile' } });
    return;
  }
  try {
    // List view only needs summary fields — `trigger_config` / `action_config`
    // (which can hold full connector allowlists or embedded corpora) are
    // re-fetched on edit from the detail endpoint.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('organization_rules')
      .select(
        'id, org_id, name, description, enabled, trigger_type, action_type, created_at, updated_at',
      )
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      logger.error({ error }, 'organization_rules list failed');
      res.status(500).json({ error: { code: 'list_failed', message: error.message } });
      return;
    }

    const items = (data ?? []) as Array<Record<string, unknown>>;
    res.json({ items, count: items.length });
  } catch (err) {
    logger.error({ error: err }, 'handleListRules unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

export async function handleCreateRule(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const orgId = await getCallerOrgId(userId);
  if (!orgId) {
    res.status(403).json({ error: { code: 'forbidden', message: 'No organization on profile' } });
    return;
  }

  const parsed = CreateOrgRuleInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Invalid body',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  // Force rule's org_id to match the caller's org regardless of request body —
  // prevents a caller from writing a rule into a different org by lying.
  if (parsed.data.org_id !== orgId) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'org_id does not match caller organization' },
    });
    return;
  }

  try {
    // Secondary validation: trigger_config must match trigger_type, and
    // neither config may carry inline secrets (use sm:handle references).
    validateRuleConfigs(parsed.data);
    assertNoInlineSecrets(parsed.data.trigger_config);
    assertNoInlineSecrets(parsed.data.action_config);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid rule config';
    const code = /secret/i.test(message) ? 'inline_secret' : 'invalid_config';
    res.status(400).json({ error: { code, message } });
    return;
  }

  try {
    // SEC-02 defense-in-depth: newly-created rules ALWAYS ship disabled
    // regardless of what the request body asks for. ARK-108 wizard + ARK-110
    // NL authoring both route through here, so every rule gets an explicit
    // human flip before it can fire an action. Downstream auditors can grep
    // for the ORG_RULE_ENABLED event as the true "rule went live" marker.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('organization_rules')
      .insert({
        org_id: parsed.data.org_id,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        trigger_type: parsed.data.trigger_type,
        trigger_config: parsed.data.trigger_config,
        action_type: parsed.data.action_type,
        action_config: parsed.data.action_config,
        enabled: false,
      })
      .select('id')
      .single();

    if (error) {
      logger.warn({ error }, 'organization_rules insert failed');
      res.status(400).json({ error: { code: 'insert_failed', message: error.message } });
      return;
    }

    const newId = (data as { id?: string } | null)?.id;
    res.status(201).json({ id: newId });
    if (newId) {
      // Fire-and-forget: audit must not gate response latency.
      void emitRuleAudit('ORG_RULE_CREATED', {
        actorId: userId,
        orgId,
        ruleId: newId,
        details: {
          name: parsed.data.name,
          trigger_type: parsed.data.trigger_type,
          action_type: parsed.data.action_type,
          enabled: false,
        },
      });
    }
  } catch (err) {
    logger.error({ error: err }, 'handleCreateRule unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

type PatchValidationResult =
  | { kind: 'ok' }
  | { kind: 'error'; status: number; body: Record<string, unknown> };

/**
 * When a caller patches trigger_config or action_config, re-validate the
 * resulting rule against the Zod schema BEFORE writing. Without this, a
 * PATCH with `{trigger_config: {anything: 'goes'}}` passes the inline-
 * secret check but corrupts the stored rule — the rules engine then skips
 * it with `unexpected_trigger_type` or silently fails to filter.
 *
 * Extracted from handleUpdateRule so its cognitive complexity stays under
 * the SonarCloud 15 cap.
 */
async function validatePatchAgainstCurrent(
  ruleId: string,
  orgId: string,
  patch: UpdateOrgRuleInputT,
): Promise<PatchValidationResult> {
  if (!patch.trigger_config && !patch.action_config) return { kind: 'ok' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: current, error: readErr } = await (db as any)
    .from('organization_rules')
    .select('trigger_type, trigger_config, action_type, action_config, org_id')
    .eq('id', ruleId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (readErr) {
    logger.warn({ error: readErr }, 'organization_rules fetch for patch-validation failed');
    return { kind: 'error', status: 500, body: { error: { code: 'internal', message: 'Internal server error' } } };
  }
  if (!current) {
    return { kind: 'error', status: 404, body: { error: { code: 'not_found', message: 'Rule not found' } } };
  }
  const merged = {
    org_id: current.org_id,
    name: patch.name ?? 'patch-validation-probe',
    description: patch.description,
    trigger_type: current.trigger_type,
    trigger_config: patch.trigger_config ?? current.trigger_config,
    action_type: current.action_type,
    action_config: patch.action_config ?? current.action_config,
    enabled: false,
  };
  try {
    validateRuleConfigs(merged);
    return { kind: 'ok' };
  } catch (err) {
    return {
      kind: 'error',
      status: 400,
      body: {
        error: {
          code: 'invalid_config',
          message: err instanceof Error ? err.message : 'Config validation failed',
        },
      },
    };
  }
}

export async function handleUpdateRule(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const orgId = await getCallerOrgId(userId);
  if (!orgId) {
    res.status(403).json({ error: { code: 'forbidden', message: 'No organization on profile' } });
    return;
  }

  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Invalid id' } });
    return;
  }
  const bodyParsed = UpdateOrgRuleInput.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Invalid body',
        details: bodyParsed.error.flatten(),
      },
    });
    return;
  }

  try {
    if (bodyParsed.data.trigger_config) assertNoInlineSecrets(bodyParsed.data.trigger_config);
    if (bodyParsed.data.action_config) assertNoInlineSecrets(bodyParsed.data.action_config);
  } catch (err) {
    res.status(400).json({
      error: {
        code: 'inline_secret',
        message: err instanceof Error ? err.message : 'Secret detected in config',
      },
    });
    return;
  }

  try {
    const validation = await validatePatchAgainstCurrent(idParsed.data, orgId, bodyParsed.data);
    if (validation.kind === 'error') {
      res.status(validation.status).json(validation.body);
      return;
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of ['name', 'description', 'enabled', 'trigger_config', 'action_config'] as const) {
      if (bodyParsed.data[k] !== undefined) update[k] = bodyParsed.data[k];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error, count } = await (db as any)
      .from('organization_rules')
      .update(update, { count: 'exact' })
      .eq('id', idParsed.data)
      .eq('org_id', orgId); // cross-tenant guard (service_role bypasses RLS)
    if (error) {
      logger.warn({ error }, 'organization_rules update failed');
      res.status(400).json({ error: { code: 'update_failed', message: error.message } });
      return;
    }
    // count=0 means either the id was wrong or the rule belongs to another
    // org. Surface as 404 so callers don't confuse a silent no-op with a
    // successful write (and so auditors don't see ORG_RULE_UPDATED events
    // for rules that didn't change).
    if (count === 0) {
      res.status(404).json({ error: { code: 'not_found', message: 'Rule not found' } });
      return;
    }
    res.json({ ok: true });
    void emitUpdateAudit(userId, orgId, idParsed.data, bodyParsed.data);
  } catch (err) {
    logger.error({ error: err }, 'handleUpdateRule unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

/**
 * SEC-02: emit the granular audit event for a rule update. `enabled` flip is
 * the most auditor-relevant signal — dedicated event types for on/off.
 */
async function emitUpdateAudit(
  userId: string,
  orgId: string,
  ruleId: string,
  patch: UpdateOrgRuleInputT,
): Promise<void> {
  if (patch.enabled === true) {
    await emitRuleAudit('ORG_RULE_ENABLED', { actorId: userId, orgId, ruleId });
    return;
  }
  if (patch.enabled === false) {
    await emitRuleAudit('ORG_RULE_DISABLED', { actorId: userId, orgId, ruleId });
    return;
  }
  await emitRuleAudit('ORG_RULE_UPDATED', {
    actorId: userId,
    orgId,
    ruleId,
    details: { patch },
  });
}

export async function handleDeleteRule(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const orgId = await getCallerOrgId(userId);
  if (!orgId) {
    res.status(403).json({ error: { code: 'forbidden', message: 'No organization on profile' } });
    return;
  }

  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Invalid id' } });
    return;
  }
  try {
    // Hard delete: `organization_rules` has no soft-delete column yet.
    // A future migration may add `deleted_at`; until then, DELETE removes
    // the row + cascades to `organization_rule_executions` via FK.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error, count } = await (db as any)
      .from('organization_rules')
      .delete({ count: 'exact' })
      .eq('id', idParsed.data)
      .eq('org_id', orgId); // cross-tenant guard (service_role bypasses RLS)
    if (error) {
      logger.warn({ error }, 'organization_rules delete failed');
      res.status(400).json({ error: { code: 'delete_failed', message: error.message } });
      return;
    }
    if (count === 0) {
      res.status(404).json({ error: { code: 'not_found', message: 'Rule not found' } });
      return;
    }
    res.json({ ok: true });
    void emitRuleAudit('ORG_RULE_DELETED', {
      actorId: userId,
      orgId,
      ruleId: idParsed.data,
    });
  } catch (err) {
    logger.error({ error: err }, 'handleDeleteRule unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}
