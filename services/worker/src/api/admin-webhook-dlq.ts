/**
 * Inbound Webhook DLQ — Operator Drain, Replay & Visibility (SCRUM-4514)
 *
 * GET  /api/admin/webhook-dlq          — counts by provider + oldest age (ids/providers only)
 * POST /api/admin/webhook-dlq/replay   — claim + attempt-replay up to `limit` unresolved rows
 *
 * Background: `webhook_dlq` (baseline migration, comment: "SCRUM-1148: inbound
 * webhook intake failures") was originally written by three inbound handlers —
 * `api/v1/webhooks/docusign.ts`, `adobe-sign.ts`, `checkr.ts` — whenever an
 * HMAC-valid payload fails normalization or enqueue. Per that folder's
 * agents.md: "Nothing under services/worker/src/jobs/ reads that table ...
 * drained by nobody. Treat a DLQ insert as a record of the loss, never as a
 * recovery path." This module is that drain.
 *
 * A FOURTH writer exists as of migration 0448 / PR #2570-adjacent work
 * (2026-09-07, SCRUM-4493): `api/v1/webhooks/computeid.ts` (flag-gated dark)
 * writes via `integrations/computeid/passport-transition.ts`'s
 * `recordPassportFailure` -> the `enqueue_computeid_failure` RPC, which
 * INSERTs into this same `webhook_dlq` table with `provider = 'computeid'`
 * (deduped on `(provider, payload_hash, reason)`, unlike the other three
 * providers' plain inserts). The original task brief for this ticket named
 * only DocuSign/Adobe Sign/Checkr; `computeid` was found by grepping the
 * actual writers rather than trusting that list, and is included below.
 *
 * REPLAYABILITY (verified against the writers + the table schema, not
 * asserted): `webhook_dlq` stores only `provider`, `external_id`,
 * `webhook_id`, `reason`, `payload_hash` — never the raw webhook body. All
 * four writers follow the explicit rule ("DO NOT persist raw webhook
 * payloads" in webhooks/agents.md; "the partner's free-text reason and the
 * raw body never reach the DLQ" in passport-transition.ts). That means there
 * is no request body anywhere to hand back into the original handler's
 * processing function. Re-invoking the same handler code path — the CTO
 * design requirement for this change — is therefore not possible for ANY
 * row today, for ANY of the four providers. This module fails closed
 * accordingly: `assessReplayability()` returns `replayable: false` with a
 * specific per-row reason for every provider, and is the single extension
 * point if a future change decides to retain enough data (a separate, larger
 * design/privacy discussion — see docs/reference and §1.6A) to make replay
 * real. Until then, "drain" means: claim the row so it stops sitting
 * invisibly in an unresolved backlog, record why it can't be replayed, and
 * surface counts to an operator — not silently keep losing deliveries.
 *
 * ATOMICITY (double-fire safety): Cloud Run runs this service at
 * `minScale >= 2` with in-process behavior, so two concurrent hits of this
 * route (two instances, a retried operator request, or two operators) must
 * never claim + report the same row twice. The claim is a single
 * `UPDATE webhook_dlq SET resolved_at = now() WHERE id IN (...) AND
 * resolved_at IS NULL RETURNING *` — Postgres serializes concurrent UPDATEs
 * against the same rows, and the `resolved_at IS NULL` guard means a row
 * already closed out by a concurrent caller simply falls out of the second
 * caller's RETURNING set. The preceding SELECT (oldest-first, LIMIT `limit`)
 * is ordering only, not the safety mechanism.
 *
 * No `claimed_at` / `attempt_count` / `last_error` column exists on
 * `webhook_dlq` (verified against `database.types.ts`). Adding one is a
 * migration — a T3 surface this SCRUM-4514 change deliberately does not
 * cross. `resolved_at` is reused as both the claim marker and the terminal
 * "drained" marker (there is nothing to retry into once a row is confirmed
 * non-replayable — the raw body it would need is gone for good). Per-row
 * outcome is returned in the API response and logged (bounded, ids/provider/
 * reason text only — never a payload or payload_hash in a log line) since
 * there is no column to persist it to.
 */

import type { Request, Response } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';

const MAX_REPLAY_BATCH = 50;
const DEFAULT_REPLAY_BATCH = 20;
const DETAIL_MAX = 500; // matches webhook_dlq.reason's own CHECK (char_length <= 500)

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

export interface ReplayAssessment {
  replayable: boolean;
  detail: string;
}

/**
 * Per-provider replayability check. Every branch returns `replayable: false`
 * today — see the module doc comment for why. Kept as a function (not an
 * inline constant) so a provider that starts persisting enough to reprocess
 * can flip independently without touching the claim/response plumbing below.
 */
export function assessReplayability(row: Pick<DlqRow, 'provider'>): ReplayAssessment {
  switch (row.provider) {
    case 'docusign':
    case 'adobe_sign':
    case 'checkr':
      return {
        replayable: false,
        detail:
          'raw webhook payload not persisted (webhooks/agents.md: "DO NOT persist raw webhook payloads") — ' +
          'only payload_hash and ids are retained, which is not enough to re-invoke the original handler',
      };
    case 'computeid':
      return {
        replayable: false,
        detail:
          'raw webhook payload not persisted (passport-transition.ts: "the raw body never reach[es] the DLQ") — ' +
          'only payload_hash and ids are retained, which is not enough to re-invoke the original handler',
      };
    default:
      return {
        replayable: false,
        detail: `unknown provider "${row.provider}" — no replay handler registered for it`,
      };
  }
}

function bounded(text: string, max = DETAIL_MAX): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * GET /api/admin/webhook-dlq
 *
 * Counts by provider + oldest unresolved age, plus the bare id list. Never
 * returns `reason` or `payload_hash` in bulk — `reason` can echo
 * upstream-derived failure text, and this is a list/count view, not a
 * per-row detail view.
 */
export async function handleWebhookDlqList(userId: string, req: Request, res: Response): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webhook_dlq predates strict Supabase typing on this path (matches the three writers)
    const { data, error } = await (db as any)
      .from('webhook_dlq')
      .select('id, provider, created_at')
      .is('resolved_at', null)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error({ error }, 'webhook-dlq list query failed');
      res.status(500).json({ error: 'Failed to query webhook DLQ' });
      return;
    }

    const rows = (data ?? []) as Array<Pick<DlqRow, 'id' | 'provider' | 'created_at'>>;
    const now = Date.now();
    const byProvider: Record<string, { count: number; oldest_age_seconds: number }> = {};
    for (const row of rows) {
      const ageSeconds = Math.max(0, Math.floor((now - new Date(row.created_at).getTime()) / 1000));
      const bucket = byProvider[row.provider] ?? { count: 0, oldest_age_seconds: 0 };
      bucket.count += 1;
      bucket.oldest_age_seconds = Math.max(bucket.oldest_age_seconds, ageSeconds);
      byProvider[row.provider] = bucket;
    }

    res.json({
      total_unresolved: rows.length,
      by_provider: byProvider,
      ids: rows.map((r) => r.id),
    });
  } catch (err) {
    logger.error({ error: err }, 'webhook-dlq list request threw');
    res.status(500).json({ error: 'Internal server error' });
  }
}

export interface ReplayRowOutcome {
  id: string;
  provider: string;
  replayable: boolean;
  outcome: 'not_replayable' | 'replayed' | 'error';
  detail: string;
}

export interface ReplayResponse {
  claimed: number;
  replayed: number;
  not_replayable: number;
  errored: number;
  results: ReplayRowOutcome[];
}

/**
 * POST /api/admin/webhook-dlq/replay
 * Body: `{ limit?: number }` — default 20, max 50.
 *
 * Claims up to `limit` of the oldest unresolved rows and, per row, either
 * re-invokes the original handler's processing path (no provider qualifies
 * today — see module doc comment) or records why it can't and marks it
 * resolved anyway, so it stops occupying the unresolved backlog. Returns
 * counts + per-row outcome; never a payload or payload_hash.
 */
export async function handleWebhookDlqReplay(userId: string, req: Request, res: Response): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const rawLimit = req.body?.limit;
  let limit = DEFAULT_REPLAY_BATCH;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1) {
      res.status(400).json({ error: 'limit must be a positive integer' });
      return;
    }
    limit = Math.min(rawLimit, MAX_REPLAY_BATCH);
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: candidates, error: selectError } = await (db as any)
      .from('webhook_dlq')
      .select('id, provider, external_id, webhook_id, reason, payload_hash, resolved_at, created_at')
      .is('resolved_at', null)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (selectError) {
      logger.error({ error: selectError }, 'webhook-dlq replay candidate select failed');
      res.status(500).json({ error: 'Failed to query webhook DLQ' });
      return;
    }

    const candidateRows = (candidates ?? []) as DlqRow[];
    if (candidateRows.length === 0) {
      res.json({ claimed: 0, replayed: 0, not_replayable: 0, errored: 0, results: [] } satisfies ReplayResponse);
      return;
    }

    const ids = candidateRows.map((r) => r.id);
    const nowIso = new Date().toISOString();

    // Atomic claim: the WHERE resolved_at IS NULL guard is what prevents two
    // concurrent callers from claiming the same row — not the ordering of the
    // SELECT above. A row a concurrent caller already resolved between the
    // SELECT and this UPDATE simply will not appear in `claimed` here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: claimed, error: claimError } = await (db as any)
      .from('webhook_dlq')
      .update({ resolved_at: nowIso })
      .in('id', ids)
      .is('resolved_at', null)
      .select('id, provider, external_id, webhook_id, reason, payload_hash, resolved_at, created_at');

    if (claimError) {
      logger.error({ error: claimError }, 'webhook-dlq replay claim UPDATE failed');
      res.status(500).json({ error: 'Failed to claim webhook DLQ rows' });
      return;
    }

    const claimedRows = (claimed ?? []) as DlqRow[];
    const results: ReplayRowOutcome[] = [];
    let replayedCount = 0;
    let notReplayableCount = 0;
    // Always 0 today: no provider reaches the `replayable: true` branch below,
    // so there is no actual re-invocation attempt that could throw yet. Kept
    // as a named counter (not folded away) so the response/log shape does not
    // have to change the day a provider does.
    const erroredCount = 0;

    for (const row of claimedRows) {
      const assessment = assessReplayability(row);
      if (assessment.replayable) {
        // No provider reaches this branch today (see module doc comment).
        // Left in place as the extension point for a future provider that
        // persists enough to actually reprocess.
        replayedCount += 1;
        results.push({
          id: row.id,
          provider: row.provider,
          replayable: true,
          outcome: 'replayed',
          detail: bounded(assessment.detail),
        });
        continue;
      }
      notReplayableCount += 1;
      results.push({
        id: row.id,
        provider: row.provider,
        replayable: false,
        outcome: 'not_replayable',
        detail: bounded(assessment.detail),
      });
    }

    // Bounded, ids/provider/counts only — never `reason` or `payload_hash`.
    logger.warn(
      {
        claimed: claimedRows.length,
        replayed: replayedCount,
        not_replayable: notReplayableCount,
        errored: erroredCount,
        providers: [...new Set(claimedRows.map((r) => r.provider))],
        ids: claimedRows.map((r) => r.id),
      },
      'webhook-dlq operator drain executed',
    );

    res.json({
      claimed: claimedRows.length,
      replayed: replayedCount,
      not_replayable: notReplayableCount,
      errored: erroredCount,
      results,
    } satisfies ReplayResponse);
  } catch (err) {
    logger.error({ error: err }, 'webhook-dlq replay request threw');
    res.status(500).json({ error: 'Internal server error' });
  }
}
