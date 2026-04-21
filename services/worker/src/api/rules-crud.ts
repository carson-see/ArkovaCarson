/**
 * Organization Rules CRUD API (ARK-105/108 — SCRUM-1017/1020)
 *
 * GET  /api/rules               → list caller's org rules (newest first)
 * POST /api/rules               → create rule (enabled=false by default per ARK-110)
 * PATCH /api/rules/:id          → update rule (name/desc/enabled + optional config)
 * DELETE /api/rules/:id         → soft-delete rule
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

export async function handleListRules(
  _req: Request,
  res: Response,
): Promise<void> {
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
  req: Request,
  res: Response,
): Promise<void> {
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
        enabled: parsed.data.enabled,
      })
      .select('id')
      .single();

    if (error) {
      logger.warn({ error }, 'organization_rules insert failed');
      res.status(400).json({ error: { code: 'insert_failed', message: error.message } });
      return;
    }

    res.status(201).json({ id: (data as { id?: string } | null)?.id });
  } catch (err) {
    logger.error({ error: err }, 'handleCreateRule unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

export async function handleUpdateRule(
  req: Request,
  res: Response,
): Promise<void> {
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
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of ['name', 'description', 'enabled', 'trigger_config', 'action_config'] as const) {
      if (bodyParsed.data[k] !== undefined) update[k] = bodyParsed.data[k];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any)
      .from('organization_rules')
      .update(update)
      .eq('id', idParsed.data);
    if (error) {
      logger.warn({ error }, 'organization_rules update failed');
      res.status(400).json({ error: { code: 'update_failed', message: error.message } });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err }, 'handleUpdateRule unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

export async function handleDeleteRule(
  req: Request,
  res: Response,
): Promise<void> {
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
    const { error } = await (db as any)
      .from('organization_rules')
      .delete()
      .eq('id', idParsed.data);
    if (error) {
      logger.warn({ error }, 'organization_rules delete failed');
      res.status(400).json({ error: { code: 'delete_failed', message: error.message } });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err }, 'handleDeleteRule unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}
