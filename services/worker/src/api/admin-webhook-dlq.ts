/**
 * Inbound Webhook DLQ — Operator Visibility & Resolve (SCRUM-4514)
 *
 * GET  /api/admin/webhook-dlq          — counts by provider + oldest age + per-row detail
 * POST /api/admin/webhook-dlq/resolve  — mark specific rows resolved (idempotent, atomic)
 *
 * Background: `webhook_dlq` (baseline migration, comment: "SCRUM-1148: inbound
 * webhook intake failures") was originally written by three inbound handlers —
 * `api/v1/webhooks/docusign.ts`, `adobe-sign.ts`, `checkr.ts` — whenever an
 * HMAC-valid payload fails normalization or enqueue. A FOURTH writer exists as
 * of migration 0448 (2026-09-07, SCRUM-4493): `api/v1/webhooks/computeid.ts`
 * (flag-gated dark) writes via `integrations/computeid/passport-transition.ts`'s
 * `recordPassportFailure` -> the `enqueue_computeid_failure` RPC, into this
 * same table with `provider = 'computeid'`. `webhook_dlq` was drained by
 * nobody before this change. This module is that drain.
 *
 * CTO DECISION (2026-09-13, closing the open question this module originally
 * raised): Arkova does NOT retain raw partner webhook bodies to make
 * server-side replay possible. `webhook_dlq` stores only `provider`,
 * `external_id`, `webhook_id`, `reason`, `payload_hash` — by design, per
 * §1.6A and webhooks/agents.md's "DO NOT persist raw webhook payloads" rule.
 * DocuSign/Adobe Sign bodies carry signer emails; retaining them for replay
 * would be a privacy tradeoff, not a free engineering win. An earlier version
 * of this module shipped a `POST /replay` endpoint that claimed rows and
 * always reported `not_replayable` — accurate, but a "replay" endpoint that
 * can never replay anything is misleading surface. It has been removed.
 *
 * The product value here is (1) visibility — an operator can see a DLQ'd
 * failure exists, which provider, which external id, and why — and (2)
 * acknowledgment — once the operator has separately triggered redelivery AT
 * THE PARTNER (see the partner redelivery matrix in the SCRUM-4514 Confluence
 * page: DocuSign Connect "Resend", Adobe Sign webhook retry / re-send from
 * the developer console, Checkr webhook-logs re-send, ComputeID asked to
 * re-emit), `POST /resolve` marks the row(s) done here. This module never
 * attempts to reprocess anything itself.
 *
 * ATOMICITY / idempotency: the resolve is a single
 * `UPDATE webhook_dlq SET resolved_at = now() WHERE id = ANY($ids) AND
 * resolved_at IS NULL RETURNING id`. Calling `/resolve` twice with the same
 * ids is safe — the first call resolves them (`resolved: n`), the second
 * finds nothing left to claim and reports them under `already_resolved`
 * instead of erroring or double-counting.
 *
 * No `resolved_note` (or equivalent) column exists on `webhook_dlq` (verified
 * against `database.types.ts`). Adding one is a migration — a T3 surface this
 * SCRUM-4514 change deliberately does not cross. The `note` field in the
 * resolve request is validated (bounded) but stored nowhere; it exists for
 * the operator's own record-keeping (e.g. in their own ticket/runbook), not
 * as a durable audit trail on this table. It is also never logged — treated
 * with the same discipline as `reason`/`payload_hash`, since an operator note
 * could reference partner-identifying detail.
 */

import type { Request, Response } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';

const MAX_RESOLVE_IDS = 100;
const NOTE_MAX = 500;

export const KNOWN_INBOUND_DLQ_PROVIDERS = ['docusign', 'adobe_sign', 'checkr', 'computeid'] as const;
export type KnownInboundDlqProvider = (typeof KNOWN_INBOUND_DLQ_PROVIDERS)[number];

export interface DlqRow {
  id: string;
  provider: string;
  external_id: string | null;
  webhook_id: string | null;
  reason: string;
  payload_hash: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface DlqListRow {
  id: string;
  provider: string;
  external_id: string | null;
  reason: string;
  age_seconds: number;
}

/**
 * GET /api/admin/webhook-dlq
 *
 * Counts by provider + oldest unresolved age, plus per-row `id`,
 * `external_id`, and `reason` — the fields an operator needs to go find the
 * matching delivery in the partner's own console and request redelivery
 * there. Never `payload_hash` or any request body; there is no body to
 * return.
 */
export async function handleWebhookDlqList(userId: string, req: Request, res: Response): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webhook_dlq predates strict Supabase typing on this path (matches the four writers)
    const { data, error } = await (db as any)
      .from('webhook_dlq')
      .select('id, provider, external_id, reason, created_at')
      .is('resolved_at', null)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error({ error }, 'webhook-dlq list query failed');
      res.status(500).json({ error: 'Failed to query webhook DLQ' });
      return;
    }

    const rawRows = (data ?? []) as Array<Pick<DlqRow, 'id' | 'provider' | 'external_id' | 'reason' | 'created_at'>>;
    const now = Date.now();
    const byProvider: Record<string, { count: number; oldest_age_seconds: number }> = {};
    const rows: DlqListRow[] = [];

    for (const row of rawRows) {
      const ageSeconds = Math.max(0, Math.floor((now - new Date(row.created_at).getTime()) / 1000));
      const bucket = byProvider[row.provider] ?? { count: 0, oldest_age_seconds: 0 };
      bucket.count += 1;
      bucket.oldest_age_seconds = Math.max(bucket.oldest_age_seconds, ageSeconds);
      byProvider[row.provider] = bucket;
      rows.push({
        id: row.id,
        provider: row.provider,
        external_id: row.external_id,
        reason: row.reason,
        age_seconds: ageSeconds,
      });
    }

    res.json({
      total_unresolved: rawRows.length,
      by_provider: byProvider,
      rows,
    });
  } catch (err) {
    logger.error({ error: err }, 'webhook-dlq list request threw');
    res.status(500).json({ error: 'Internal server error' });
  }
}

export interface ResolveResponse {
  resolved: number;
  already_resolved: number;
}

function isValidIdsArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_RESOLVE_IDS &&
    value.every((v) => typeof v === 'string' && v.length > 0)
  );
}

/**
 * POST /api/admin/webhook-dlq/resolve
 * Body: `{ ids: string[] (1-100), note: string (<=500 chars) }`
 *
 * Marks the given rows resolved. Idempotent: an id that is already resolved
 * (by an earlier call, or by someone else) is reported under
 * `already_resolved` rather than erroring or being double-counted. An id that
 * does not match any row is silently ignored (contributes to neither count) —
 * there is no third "not_found" bucket in this response shape.
 *
 * `note` is validated but not persisted (see module doc comment) and is
 * never logged.
 */
export async function handleWebhookDlqResolve(userId: string, req: Request, res: Response): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const { ids, note } = (req.body ?? {}) as { ids?: unknown; note?: unknown };

  if (!isValidIdsArray(ids)) {
    res.status(400).json({ error: `ids must be a non-empty array of strings, max ${MAX_RESOLVE_IDS}` });
    return;
  }
  if (typeof note !== 'string' || note.length === 0 || note.length > NOTE_MAX) {
    res.status(400).json({ error: `note must be a non-empty string, max ${NOTE_MAX} chars` });
    return;
  }

  const uniqueIds = [...new Set(ids)];
  const nowIso = new Date().toISOString();

  try {
    // Atomic claim: only rows currently unresolved are matched, so calling
    // this twice with the same ids resolves them once, then resolves zero.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: justResolved, error: updateError } = await (db as any)
      .from('webhook_dlq')
      .update({ resolved_at: nowIso })
      .in('id', uniqueIds)
      .is('resolved_at', null)
      .select('id');

    if (updateError) {
      logger.error({ error: updateError }, 'webhook-dlq resolve UPDATE failed');
      res.status(500).json({ error: 'Failed to resolve webhook DLQ rows' });
      return;
    }

    const resolvedIds = (justResolved ?? []) as Array<{ id: string }>;
    const resolvedCount = resolvedIds.length;

    // Second pass: of the requested ids, how many now exist AND are
    // resolved (either by this call or by an earlier one)? Subtracting this
    // call's own resolved count leaves "was already resolved before this
    // call" — the idempotency-visible bucket. Ids that never matched a row
    // at all are absent from both counts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: nowResolved, error: selectError } = await (db as any)
      .from('webhook_dlq')
      .select('id')
      .in('id', uniqueIds)
      .not('resolved_at', 'is', null);

    if (selectError) {
      logger.error({ error: selectError }, 'webhook-dlq resolve post-check SELECT failed');
      // The UPDATE already committed — do not fail the request over a
      // reporting-only follow-up query. Report what we know for certain.
      res.json({ resolved: resolvedCount, already_resolved: 0 } satisfies ResolveResponse);
      return;
    }

    const totalNowResolved = ((nowResolved ?? []) as Array<{ id: string }>).length;
    const alreadyResolvedCount = Math.max(0, totalNowResolved - resolvedCount);

    // Bounded, ids/counts only — never `reason`, `payload_hash`, or `note`.
    logger.info(
      { resolved: resolvedCount, already_resolved: alreadyResolvedCount, ids: uniqueIds },
      'webhook-dlq rows resolved by operator',
    );

    res.json({ resolved: resolvedCount, already_resolved: alreadyResolvedCount } satisfies ResolveResponse);
  } catch (err) {
    logger.error({ error: err }, 'webhook-dlq resolve request threw');
    res.status(500).json({ error: 'Internal server error' });
  }
}
