/**
 * Organization Rules CRUD API (ARK-105/108 — SCRUM-1017/1020)
 *
 * GET  /api/rules               → list caller's org rules (newest first)
 * GET  /api/rules/:id           → fetch a full rule for review/edit
 * GET  /api/rules/:id/executions → recent execution history for one rule
 * POST /api/rules/test          → simulate a rule against a sample event
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
import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import {
  CreateOrgRuleInput,
  assertNoInlineSecrets,
  validateRuleConfigs,
} from '../rules/schemas.js';
import { evaluateRule, type TriggerEvent, type RuleRow } from '../rules/evaluator.js';
import {
  mirrorConnectedDriveFolders,
  extractDriveFoldersToMirror,
  shouldMirrorDriveFoldersForRule,
  type DriveFolderMirrorDb,
  type MirrorConnectedDriveFolderResult,
} from '../integrations/connectors/drive-folder-mirror.js';

/**
 * Connectors page (SPEC-CONNECTORS §1.4) marks the rule it writes with
 * `action_config.tag: 'connector-<provider>'` so it can recognise its own
 * rule later. Used ONLY to scope the adopt-vs-create race guard below to
 * connector-originated creates — never trust `tag` for anything
 * security-relevant, it is caller-supplied.
 */
function isConnectorManagedActionConfig(actionConfig: unknown): boolean {
  if (!actionConfig || typeof actionConfig !== 'object') return false;
  const tag = (actionConfig as Record<string, unknown>).tag;
  return typeof tag === 'string' && /^connector-[a-z0-9_]+$/.test(tag);
}

/**
 * Drive-folder mirroring for a rule create/update. Scoped to the Connectors
 * page's own Drive rule (`shouldMirrorDriveFoldersForRule`) with a
 * non-empty `drive_folders` list — every other rule create/update (DocuSign,
 * RulesPage/RuleBuilderPage, bare enable-toggles) is a no-op call that never
 * touches `org_integrations` or `folders`.
 *
 * Review P2 (feat/mirror-connected-drive-folders): this used to be
 * fire-and-forget, called AFTER the response was already sent. A restart or
 * transient DB failure mid-mirror then left an enabled rule with no folders
 * and no trace of the attempt — for a connected folder with zero documents
 * ever arriving, the migration-0462 LAZY mirror never fires either, so
 * nothing would ever create it until an admin happened to re-save the rule.
 * The caller now AWAITS this and folds the result into its response body
 * (a recoverable partial result, not a swallowed exception) — bounded work,
 * since the folder picker caps connected folders at three (PR #3084), so
 * this is at most a few sequential `folders` upserts, not unbounded fan-out.
 * Still never throws: `mirrorConnectedDriveFolders` itself is non-throwing
 * by contract, and the try/catch here is belt-and-suspenders so a mirror
 * failure can never turn an already-successful rule save into a 500.
 *
 * Returns `null` when mirroring does not apply to this rule at all (so the
 * caller can omit `drive_folder_mirror` from the response entirely), or the
 * per-folder result array — which may itself contain `outcome: 'error'`
 * entries — when it was attempted.
 */
async function mirrorDriveFoldersForRuleWrite(
  orgId: string,
  actorUserId: string,
  triggerType: string,
  triggerConfig: unknown,
  actionConfig: unknown,
): Promise<MirrorConnectedDriveFolderResult[] | null> {
  if (!shouldMirrorDriveFoldersForRule(triggerType, actionConfig)) return null;
  const folders = extractDriveFoldersToMirror(triggerConfig as Record<string, unknown> | null | undefined);
  if (folders.length === 0) return null;
  try {
    return await mirrorConnectedDriveFolders(
      { db: db as unknown as DriveFolderMirrorDb, logger },
      { orgId, actorUserId, folders },
    );
  } catch (error: unknown) {
    logger.warn({ error, orgId }, 'drive-folder-mirror wiring failed');
    return folders.map((f) => ({
      folderId: '',
      driveFolderId: f.folderId,
      outcome: 'error' as const,
      error: String(error),
    }));
  }
}

const UuidSchema = z.string().uuid();
const ExecutionLimitSchema = z.coerce.number().int().min(1).max(100).default(25);

const TestRuleDefinitionInput = CreateOrgRuleInput.omit({ org_id: true })
  .extend({
    org_id: z.string().uuid().optional(),
    enabled: z.boolean().optional(),
  });

const TestTriggerEventInput = z.object({
  org_id: z.string().uuid().optional(),
  trigger_type: CreateOrgRuleInput.shape.trigger_type,
  vendor: z.string().trim().min(1).max(100).optional(),
  filename: z.string().trim().min(1).max(500).optional(),
  folder_path: z.string().trim().min(1).max(1000).optional(),
  sender_email: z.string().email().toLowerCase().optional(),
  subject: z.string().trim().min(1).max(500).optional(),
});

const TestRuleInput = z.object({
  rule: TestRuleDefinitionInput,
  event: TestTriggerEventInput,
  assume_enabled: z.boolean().default(true),
});

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
    | 'ORG_RULE_DISABLED'
    | 'ORG_RULE_RUN_QUEUED',
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

// D4 (Connectors page — SPEC-CONNECTORS §1.5): the one-click toggle between
// "Secure it immediately" (INSTANT_SECURE) and "Add it to the secure queue"
// (AUTO_ANCHOR) needs a way to change an EXISTING rule's action_type without
// DELETE + POST + PATCH, which would mint a new rule id and orphan that
// rule's `organization_rule_executions` history. `action_type` is optional
// and MUST be paired with `action_config` in the same PATCH — a config left
// over from the OLD action would pass this schema but corrupt the stored
// rule (`validateRuleConfigs` needs the pair together to catch a mismatch;
// see `validatePatchAgainstCurrent` below). `trigger_type` stays immutable —
// there is no field for it here, and connector rules never change trigger
// type.
const ACTION_TYPE_PAIRING_MESSAGE = 'action_config is required when action_type is present';

export const UpdateOrgRuleInput = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(1000).optional(),
    enabled: z.boolean().optional(),
    trigger_config: z.record(z.string(), z.unknown()).optional(),
    action_config: z.record(z.string(), z.unknown()).optional(),
    action_type: z
      .enum([
        'AUTO_ANCHOR',
        'FAST_TRACK_ANCHOR',
        'INSTANT_SECURE',
        'QUEUE_FOR_REVIEW',
        'FLAG_COLLISION',
        'NOTIFY',
        'FORWARD_TO_URL',
      ])
      .optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'At least one field required')
  .superRefine((d, ctx) => {
    if (d.action_type !== undefined && d.action_config === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action_config'],
        message: ACTION_TYPE_PAIRING_MESSAGE,
      });
    }
  });

export type UpdateOrgRuleInputT = z.infer<typeof UpdateOrgRuleInput>;

const MANUAL_RUNS_PER_ORG_PER_MINUTE = 5;
const manualRunWindows = new Map<string, { count: number; resetAt: number }>();

export function resetManualRuleRunRateLimitForTests(): void {
  manualRunWindows.clear();
}

function takeManualRunSlot(orgId: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const existing = manualRunWindows.get(orgId);
  if (!existing || existing.resetAt <= now) {
    manualRunWindows.set(orgId, { count: 1, resetAt: now + 60_000 });
    return { ok: true };
  }
  if (existing.count >= MANUAL_RUNS_PER_ORG_PER_MINUTE) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  existing.count += 1;
  return { ok: true };
}

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

async function isCallerOrgAdmin(userId: string, orgId: string): Promise<boolean> {
  const { data: membership, error: membershipError } = await db
    .from('org_members')
    .select('role')
    .eq('user_id', userId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (membershipError) {
    logger.warn({ error: membershipError, userId, orgId }, 'org_members admin lookup failed');
  }

  const role = (membership as { role?: string } | null)?.role;
  if (role === 'owner' || role === 'admin') return true;

  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('role, is_platform_admin')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) {
    logger.warn({ error: profileError, userId }, 'profile admin fallback lookup failed');
    return false;
  }

  const profileRow = profile as { role?: string | null; is_platform_admin?: boolean | null } | null;
  return profileRow?.role === 'ORG_ADMIN' || profileRow?.is_platform_admin === true;
}

async function requireOrgAdmin(userId: string, orgId: string, res: Response): Promise<boolean> {
  if (await isCallerOrgAdmin(userId, orgId)) return true;
  res.status(403).json({
    error: {
      code: 'forbidden',
      message: 'Only organization admins can manage rules',
    },
  });
  return false;
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
        'id, org_id, name, description, enabled, trigger_type, action_type, created_at, updated_at, last_executed_at',
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

export async function handleGetRule(
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
    // Full configs are intentionally kept out of the list response. The edit
    // surface fetches one scoped row at a time so a compromised client cannot
    // bulk scrape every connector/action config for the org.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('organization_rules')
      .select(
        'id, org_id, name, description, enabled, trigger_type, trigger_config, action_type, action_config, created_by_user_id, created_at, updated_at, last_executed_at',
      )
      .eq('id', idParsed.data)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      logger.error({ error, ruleId: idParsed.data }, 'organization_rules detail fetch failed');
      res.status(500).json({ error: { code: 'detail_failed', message: 'Failed to load rule' } });
      return;
    }
    if (!data) {
      res.status(404).json({ error: { code: 'not_found', message: 'Rule not found' } });
      return;
    }

    res.json({ item: data });
  } catch (err) {
    logger.error({ error: err }, 'handleGetRule unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

export async function handleListRuleExecutions(
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
  const limitParsed = ExecutionLimitSchema.safeParse(req.query.limit);
  if (!limitParsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Invalid limit' } });
    return;
  }

  try {
    // First prove the rule belongs to the caller org. Returning [] for a
    // foreign rule would be ambiguous and makes tenancy incidents harder to
    // diagnose during support.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rule, error: ruleError } = await (db as any)
      .from('organization_rules')
      .select('id')
      .eq('id', idParsed.data)
      .eq('org_id', orgId)
      .maybeSingle();

    if (ruleError) {
      logger.warn({ error: ruleError, ruleId: idParsed.data }, 'rule history ownership check failed');
      res.status(500).json({ error: { code: 'history_failed', message: 'Failed to load rule history' } });
      return;
    }
    if (!rule) {
      res.status(404).json({ error: { code: 'not_found', message: 'Rule not found' } });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('organization_rule_executions')
      .select(
        'id, rule_id, trigger_event_id, status, input_payload, output_payload, error, attempt_count, duration_ms, started_at, completed_at, created_at',
      )
      .eq('rule_id', idParsed.data)
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limitParsed.data);

    if (error) {
      logger.warn({ error, ruleId: idParsed.data }, 'organization_rule_executions history fetch failed');
      res.status(500).json({ error: { code: 'history_failed', message: 'Failed to load rule history' } });
      return;
    }

    const items = (data ?? []) as Array<Record<string, unknown>>;
    res.json({ items, count: items.length, limit: limitParsed.data });
  } catch (err) {
    logger.error({ error: err }, 'handleListRuleExecutions unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

export async function handleRunRuleNow(
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

  if (!(await requireOrgAdmin(userId, orgId, res))) return;

  try {
    // Prove ownership before spending the org's manual-run rate-limit slot.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rule, error: ruleError } = await (db as any)
      .from('organization_rules')
      .select('id, org_id, name, enabled, trigger_type, action_type')
      .eq('id', idParsed.data)
      .eq('org_id', orgId)
      .maybeSingle();

    if (ruleError) {
      logger.warn({ error: ruleError, ruleId: idParsed.data }, 'rule run ownership lookup failed');
      res.status(500).json({ error: { code: 'run_lookup_failed', message: 'Failed to queue rule run' } });
      return;
    }
    if (!rule) {
      res.status(404).json({ error: { code: 'not_found', message: 'Rule not found' } });
      return;
    }

    const rate = takeManualRunSlot(orgId);
    if (!rate.ok) {
      res.setHeader('Retry-After', rate.retryAfterSeconds.toString());
      res.status(429).json({
        error: {
          code: 'rate_limited',
          message: 'Manual rule runs are limited to 5 per minute per organization',
          retry_after: rate.retryAfterSeconds,
        },
      });
      return;
    }

    const triggerEventId = `manual:${crypto.randomUUID()}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('organization_rule_executions')
      .insert({
        rule_id: idParsed.data,
        org_id: orgId,
        trigger_event_id: triggerEventId,
        status: 'PENDING',
        input_payload: {
          source: 'manual_run',
          actor_user_id: userId,
          queued_at: new Date().toISOString(),
          rule_name: (rule as { name?: string }).name ?? null,
          trigger_type: (rule as { trigger_type?: string }).trigger_type ?? null,
          action_type: (rule as { action_type?: string }).action_type ?? null,
        },
      })
      .select('id')
      .single();

    if (error) {
      logger.warn({ error, ruleId: idParsed.data }, 'manual rule run queue insert failed');
      res.status(500).json({ error: { code: 'run_queue_failed', message: 'Failed to queue rule run' } });
      return;
    }

    const executionId = (data as { id?: string } | null)?.id ?? null;
    res.status(202).json({
      ok: true,
      queued: true,
      execution_id: executionId,
      trigger_event_id: triggerEventId,
    });
    void emitRuleAudit('ORG_RULE_RUN_QUEUED', {
      actorId: userId,
      orgId,
      ruleId: idParsed.data,
      details: { execution_id: executionId, trigger_event_id: triggerEventId },
    });
  } catch (err) {
    logger.error({ error: err, ruleId: idParsed.data }, 'handleRunRuleNow unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

export async function handleTestRule(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const orgId = await getCallerOrgId(userId);
  if (!orgId) {
    res.status(403).json({ error: { code: 'forbidden', message: 'No organization on profile' } });
    return;
  }

  const parsed = TestRuleInput.safeParse(req.body);
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

  const ruleOrgId = parsed.data.rule.org_id ?? orgId;
  const eventOrgId = parsed.data.event.org_id ?? orgId;
  if (ruleOrgId !== orgId || eventOrgId !== orgId) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'Rule test must stay within caller organization' },
    });
    return;
  }

  if (!(await requireOrgAdmin(userId, orgId, res))) return;

  const ruleInput = {
    org_id: orgId,
    name: parsed.data.rule.name,
    description: parsed.data.rule.description,
    trigger_type: parsed.data.rule.trigger_type,
    trigger_config: parsed.data.rule.trigger_config,
    action_type: parsed.data.rule.action_type,
    action_config: parsed.data.rule.action_config,
    enabled: parsed.data.rule.enabled ?? false,
  };

  try {
    validateRuleConfigs(ruleInput);
    assertNoInlineSecrets(ruleInput.trigger_config);
    assertNoInlineSecrets(ruleInput.action_config);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid rule config';
    const code = /secret/i.test(message) ? 'inline_secret' : 'invalid_config';
    res.status(400).json({ error: { code, message } });
    return;
  }

  const evaluatedEnabled = parsed.data.assume_enabled ? true : ruleInput.enabled;
  const rule: RuleRow = {
    id: 'test-rule',
    org_id: orgId,
    name: ruleInput.name,
    enabled: evaluatedEnabled,
    trigger_type: ruleInput.trigger_type,
    trigger_config: ruleInput.trigger_config,
    action_type: ruleInput.action_type,
    action_config: ruleInput.action_config,
  };
  const event: TriggerEvent = {
    ...parsed.data.event,
    org_id: orgId,
  };
  const result = evaluateRule(rule, event);

  res.json({
    ok: true,
    persisted: false,
    matched: result.matched,
    reason: result.reason,
    needs_semantic_match: result.needs_semantic_match,
    semantic_match: result.semantic_match,
    evaluated_enabled: evaluatedEnabled,
    action_type: ruleInput.action_type,
    action_preview: {
      action_type: ruleInput.action_type,
      config: ruleInput.action_config,
    },
  });
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

  if (!(await requireOrgAdmin(userId, orgId, res))) return;

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

  // Connectors-page adopt-vs-create race (CTO pre-mortem, 2026-09-13): the
  // page reads the org's rule count for a trigger_type at load and decides
  // create-vs-adopt client-side, but `docusign-rule-seed.ts` auto-seeds an
  // ESIGN_COMPLETED rule on every DocuSign connect — asynchronously, on its
  // own trigger. A seed landing in the window between the page's read and
  // this POST would leave TWO enabled rules on the same trigger_type, and a
  // signed envelope / Drive change would fire both (PM-5's double-anchor).
  // Re-check SERVER-SIDE, inside this write path, immediately before the
  // insert — narrows the race to the gap between this SELECT and the INSERT
  // below (irreducible without a DB-level unique constraint, which is a
  // migration and out of scope here) rather than the gap between the page
  // load and the Save click.
  //
  // Scoped to CONNECTOR-MANAGED creates only (action_config.tag matches
  // `connector-<provider>`, the marker set in SPEC-CONNECTORS §1.4) — a
  // RulesPage/RuleBuilderPage admin building a second, differently-filtered
  // rule on the same trigger_type on purpose is a legitimate, existing use
  // of this endpoint and must not be blocked by a check that exists to
  // protect ONE UI's adopt-vs-create invariant.
  if (isConnectorManagedActionConfig(parsed.data.action_config)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existingEnabled, error: existingErr } = await (db as any)
      .from('organization_rules')
      .select('id')
      .eq('org_id', orgId)
      .eq('trigger_type', parsed.data.trigger_type)
      .eq('enabled', true)
      .limit(1)
      .maybeSingle();
    if (existingErr) {
      logger.warn({ error: existingErr, orgId }, 'connector rule race-check lookup failed');
      res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
      return;
    }
    if (existingEnabled?.id) {
      res.status(409).json({
        error: {
          code: 'rule_exists',
          message: 'An enabled rule for this trigger already exists — adopt it instead of creating a new one.',
          existing_rule_id: existingEnabled.id,
        },
      });
      return;
    }
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
        created_by_user_id: userId,
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
    let mirrorResults: MirrorConnectedDriveFolderResult[] | null = null;
    if (newId) {
      // Eager Drive-folder mirror (founder spec — "duplicate connected
      // folders in Arkova automatically upon setup"). Review P2: AWAITED
      // before the response goes out — see `mirrorDriveFoldersForRuleWrite`'s
      // doc comment for why the old fire-and-forget-after-response shape was
      // unsafe.
      mirrorResults = await mirrorDriveFoldersForRuleWrite(
        orgId,
        userId,
        parsed.data.trigger_type,
        parsed.data.trigger_config,
        parsed.data.action_config,
      );
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
    res.status(201).json(
      mirrorResults !== null ? { id: newId, drive_folder_mirror: mirrorResults } : { id: newId },
    );
  } catch (err) {
    logger.error({ error: err }, 'handleCreateRule unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

type PatchValidationResult =
  | { kind: 'ok'; currentActionType?: string; currentTriggerType?: string; currentActionConfig?: unknown; currentCreatedByUserId?: string | null }
  | { kind: 'error'; status: number; body: Record<string, unknown> };

type ParsedUpdateRuleRequest =
  | { kind: 'ok'; ruleId: string; patch: UpdateOrgRuleInputT }
  | { kind: 'error'; status: number; body: Record<string, unknown> };

function parseUpdateRuleRequest(req: Request): ParsedUpdateRuleRequest {
  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return { kind: 'error', status: 400, body: { error: { code: 'invalid_request', message: 'Invalid id' } } };
  }

  const bodyParsed = UpdateOrgRuleInput.safeParse(req.body);
  if (!bodyParsed.success) {
    // D4: the action_type/action_config pairing superRefine gets its OWN
    // code (`invalid_config`) rather than the generic `invalid_request` —
    // it is a config-pairing rule, not a malformed-shape rule, and every
    // other config-pairing rejection in this file (validatePatchAgainstCurrent,
    // handleCreateRule) already uses `invalid_config`.
    const isActionPairingIssue = bodyParsed.error.issues.some(
      (issue) => issue.code === 'custom' && issue.path.join('.') === 'action_config' && issue.message === ACTION_TYPE_PAIRING_MESSAGE,
    );
    return {
      kind: 'error',
      status: 400,
      body: {
        error: {
          code: isActionPairingIssue ? 'invalid_config' : 'invalid_request',
          message: isActionPairingIssue ? ACTION_TYPE_PAIRING_MESSAGE : 'Invalid body',
          details: bodyParsed.error.flatten(),
        },
      },
    };
  }

  return { kind: 'ok', ruleId: idParsed.data, patch: bodyParsed.data };
}

function validatePatchSecrets(patch: UpdateOrgRuleInputT): PatchValidationResult {
  try {
    if (patch.trigger_config) assertNoInlineSecrets(patch.trigger_config);
    if (patch.action_config) assertNoInlineSecrets(patch.action_config);
    return { kind: 'ok' };
  } catch (err) {
    return {
      kind: 'error',
      status: 400,
      body: {
        error: {
          code: 'inline_secret',
          message: err instanceof Error ? err.message : 'Secret detected in config',
        },
      },
    };
  }
}

function buildRuleUpdate(patch: UpdateOrgRuleInputT): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const k of ['name', 'description', 'enabled', 'trigger_config', 'action_config', 'action_type'] as const) {
    if (patch[k] !== undefined) update[k] = patch[k];
  }
  return update;
}

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
    .select('trigger_type, trigger_config, action_type, action_config, org_id, created_by_user_id')
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
    // D4: an action_type patch is validated against the (also-required)
    // patched action_config — never the stale current one, which is exactly
    // the mismatch (INSTANT_SECURE row keeping a NOTIFY config, say) this
    // guard exists to catch.
    action_type: patch.action_type ?? current.action_type,
    action_config: patch.action_config ?? current.action_config,
    enabled: false,
  };
  try {
    validateRuleConfigs(merged);
    return {
      kind: 'ok',
      currentActionType: current.action_type as string | undefined,
      currentTriggerType: current.trigger_type as string | undefined,
      currentActionConfig: current.action_config,
      currentCreatedByUserId: current.created_by_user_id as string | null | undefined,
    };
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

/**
 * Adopt-vs-create race guard, second half (CTO pre-mortem, 2026-09-13).
 *
 * `handleCreateRule`'s race check only covers the INSERT: the Connectors
 * page's create flow is actually two calls — `POST /api/rules`
 * (SEC-02 forces `enabled=false` on every create, connector or not) then
 * `PATCH /api/rules/:id {enabled:true}` to activate it. A rule seeded by
 * `docusign-rule-seed.ts` can land in the gap BETWEEN those two calls just
 * as easily as in the gap the create-time check narrows — and nothing
 * guarded that second gap until now: `validatePatchAgainstCurrent` doesn't
 * even read the current row for a bare `{enabled:true}` patch (no
 * trigger_config/action_config in the body), so a plain enable-toggle had
 * zero connector awareness. Same scoping as the create-time guard —
 * connector-tagged rules only, `enabled: false -> true` transitions only
 * (an already-enabled rule being re-patched is a no-op for this check) —
 * and same limit: check-then-update, not a DB-level constraint, so this
 * narrows the residual window rather than closing it to zero.
 */
async function checkConnectorEnableRace(
  ruleId: string,
  orgId: string,
): Promise<PatchValidationResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: current, error: readErr } = await (db as any)
    .from('organization_rules')
    .select('trigger_type, action_config, enabled')
    .eq('id', ruleId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (readErr) {
    logger.warn({ error: readErr, orgId }, 'connector rule enable race-check read failed');
    return { kind: 'error', status: 500, body: { error: { code: 'internal', message: 'Internal server error' } } };
  }
  if (!current || current.enabled === true || !isConnectorManagedActionConfig(current.action_config)) {
    return { kind: 'ok' };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingEnabled, error: existingErr } = await (db as any)
    .from('organization_rules')
    .select('id')
    .eq('org_id', orgId)
    .eq('trigger_type', current.trigger_type)
    .eq('enabled', true)
    .limit(1)
    .maybeSingle();
  if (existingErr) {
    logger.warn({ error: existingErr, orgId }, 'connector rule enable race-check lookup failed');
    return { kind: 'error', status: 500, body: { error: { code: 'internal', message: 'Internal server error' } } };
  }
  // The row being enabled is still `enabled=false` as of the read above, so
  // it can never match its own id in this second query — no self-exclusion
  // needed.
  if (existingEnabled?.id) {
    return {
      kind: 'error',
      status: 409,
      body: {
        error: {
          code: 'rule_exists',
          message: 'An enabled rule for this trigger already exists — adopt it instead of enabling a second one.',
          existing_rule_id: existingEnabled.id,
        },
      },
    };
  }
  return { kind: 'ok' };
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

  const parsed = parseUpdateRuleRequest(req);
  if (parsed.kind === 'error') {
    res.status(parsed.status).json(parsed.body);
    return;
  }
  const secretValidation = validatePatchSecrets(parsed.patch);
  if (secretValidation.kind === 'error') {
    res.status(secretValidation.status).json(secretValidation.body);
    return;
  }

  if (!(await requireOrgAdmin(userId, orgId, res))) return;

  try {
    const validation = await validatePatchAgainstCurrent(parsed.ruleId, orgId, parsed.patch);
    if (validation.kind === 'error') {
      res.status(validation.status).json(validation.body);
      return;
    }

    if (parsed.patch.enabled === true) {
      const raceCheck = await checkConnectorEnableRace(parsed.ruleId, orgId);
      if (raceCheck.kind === 'error') {
        res.status(raceCheck.status).json(raceCheck.body);
        return;
      }
    }

    // CIBA-HARDEN-05: rely on the DB trigger `set_organization_rules_updated_at`
    // (migration 0224) instead of stamping `updated_at` here. Two sources of
    // truth meant a race could set the column to the handler's pre-commit
    // `new Date()` instead of the DB commit time, and the trigger has always
    // been authoritative for audit.
    const update = buildRuleUpdate(parsed.patch);
    const actionConfig = parsed.patch.action_config ?? validation.currentActionConfig;
    const connectorDriveResave = !!parsed.patch.trigger_config
      && !!validation.currentTriggerType
      && shouldMirrorDriveFoldersForRule(validation.currentTriggerType, actionConfig);
    if (connectorDriveResave && validation.currentCreatedByUserId === null) {
      // Atomic compare-and-set: only an authorized org admin reaches this
      // point, and a concurrent/non-null original creator is never replaced.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const claim = await (db as any).from('organization_rules')
        .update({ created_by_user_id: userId }, { count: 'exact' })
        .eq('id', parsed.ruleId).eq('org_id', orgId).is('created_by_user_id', null);
      if (claim.error) {
        logger.warn({ error: claim.error, ruleId: parsed.ruleId, orgId }, 'connector rule creator claim failed');
        res.status(500).json({ error: { code: 'creator_claim_failed', message: 'Could not repair connector rule ownership' } });
        return;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error, count } = await (db as any)
      .from('organization_rules')
      .update(update, { count: 'exact' })
      .eq('id', parsed.ruleId)
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
    // Eager Drive-folder mirror, adopt/re-save path (founder spec). Only when
    // THIS patch actually carries a trigger_config — a bare `{enabled:true}`
    // toggle or an unrelated rename never re-derives it. `trigger_type` is
    // immutable and absent from the patch body itself, so it comes from the
    // current-row read `validatePatchAgainstCurrent` already did; same for
    // `action_config` when this patch didn't also resend it.
    //
    // Review P2: AWAITED before the response goes out (see
    // `mirrorDriveFoldersForRuleWrite`'s doc comment) — the old
    // fire-and-forget-after-response shape could silently lose the mirror on
    // a restart or transient DB failure with no trace and no retry.
    let mirrorResults: MirrorConnectedDriveFolderResult[] | null = null;
    if (parsed.patch.trigger_config) {
      const triggerType = validation.currentTriggerType;
      if (triggerType) {
        mirrorResults = await mirrorDriveFoldersForRuleWrite(orgId, userId, triggerType, parsed.patch.trigger_config, actionConfig);
      }
    }
    res.json(mirrorResults !== null ? { ok: true, drive_folder_mirror: mirrorResults } : { ok: true });
    void emitUpdateAudit(userId, orgId, parsed.ruleId, parsed.patch, validation.currentActionType);
  } catch (err) {
    logger.error({ error: err }, 'handleUpdateRule unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

/**
 * SEC-02: emit the granular audit event for a rule update. `enabled` flip is
 * the most auditor-relevant signal — dedicated event types for on/off.
 *
 * D4: an `action_type` patch gets its own `{from, to}` detail shape instead
 * of the generic `{patch}` dump — that is the one field on this endpoint
 * that changes what an already-enabled rule actually DOES (credit-funded
 * INSTANT_SECURE vs free-queue AUTO_ANCHOR, say), so an auditor greps for the
 * transition directly rather than parsing it back out of a raw patch blob.
 * `currentActionType` comes from the SAME row read `validatePatchAgainstCurrent`
 * already did — no extra query.
 */
async function emitUpdateAudit(
  userId: string,
  orgId: string,
  ruleId: string,
  patch: UpdateOrgRuleInputT,
  currentActionType?: string,
): Promise<void> {
  if (patch.enabled === true) {
    await emitRuleAudit('ORG_RULE_ENABLED', { actorId: userId, orgId, ruleId });
    return;
  }
  if (patch.enabled === false) {
    await emitRuleAudit('ORG_RULE_DISABLED', { actorId: userId, orgId, ruleId });
    return;
  }
  if (patch.action_type !== undefined) {
    await emitRuleAudit('ORG_RULE_UPDATED', {
      actorId: userId,
      orgId,
      ruleId,
      details: { from: currentActionType, to: patch.action_type },
    });
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
  if (!(await requireOrgAdmin(userId, orgId, res))) return;
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
