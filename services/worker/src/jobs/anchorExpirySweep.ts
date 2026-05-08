/**
 * Anchor expiry sweep (SCRUM-1736).
 *
 * Daily cron. Transitions SECURED anchors whose `expires_at` has passed
 * to status=EXPIRED, dispatches the canonical `anchor.expired` webhook
 * event (schema in `services/worker/src/webhooks/payload-schemas.ts`,
 * shipped under SCRUM-1735), and writes an audit_event row per anchor.
 *
 * Why compare-and-set on the UPDATE: a SECURED anchor can also be
 * REVOKED through the `revoke_anchor` RPC. If revocation lands between
 * our SELECT and our UPDATE, the row is no longer SECURED. The CAS
 * `WHERE status = 'SECURED'` makes the transition idempotent and
 * collision-safe — we silently skip rather than double-fire.
 *
 * Why the runtime expires_at < now() defensive check: the DB filter is
 * the source of truth, but a clock-skew bug or test fixture could feed
 * a future-expiring row through. We refuse to dispatch in that case
 * rather than emit a misleading webhook.
 *
 * Audit failure is non-fatal: the transition is the source of truth,
 * audit is observability. We log + push to errors[] but keep draining
 * the candidate list so one bad row doesn't starve the rest.
 */

import { z } from 'zod';
import { logger } from '../utils/logger.js';

/**
 * CodeRabbit PR #734: schema-validate every write path before issuing
 * DB operations.
 */
const AnchorIdSchema = z.string().uuid();

const AuditEventRowSchema = z.object({
  event_type: z.literal('anchor.expired'),
  event_category: z.literal('ANCHOR'),
  target_type: z.literal('anchor'),
  target_id: z.string().uuid(),
  org_id: z.string().uuid().nullable(),
  details: z.string(),
}).strict();

export interface ExpiringSecuredAnchor {
  id: string;
  public_id: string;
  org_id: string | null;
  org_public_id: string | null;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  expires_at: string | null;
}

export interface AnchorExpirySweepDb {
  selectExpiringSecured(): Promise<ExpiringSecuredAnchor[]>;
  casUpdateToExpired(anchorId: string, expiredAtIso: string): Promise<boolean>;
  insertAuditEvent(row: Record<string, unknown>): Promise<void>;
  dispatchWebhookEvent(
    orgId: string,
    eventType: string,
    eventId: string,
    data: Record<string, unknown>,
  ): Promise<void>;
}

export interface AnchorExpirySweepResult {
  checked: number;
  newly_expired: number;
  webhooks_dispatched: number;
  errors: string[];
}

export async function sweepExpiredAnchors(db: AnchorExpirySweepDb): Promise<AnchorExpirySweepResult> {
  const result: AnchorExpirySweepResult = {
    checked: 0,
    newly_expired: 0,
    webhooks_dispatched: 0,
    errors: [],
  };

  let candidates: ExpiringSecuredAnchor[];
  try {
    candidates = await db.selectExpiringSecured();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    logger.error({ error: err }, 'sweepExpiredAnchors: selectExpiringSecured failed');
    result.errors.push(`selectExpiringSecured failed: ${msg}`);
    return result;
  }

  result.checked = candidates.length;
  if (candidates.length === 0) return result;

  const now = new Date();
  const nowIso = now.toISOString();

  for (const anchor of candidates) {
    // CodeRabbit PR #734: also catch malformed timestamps (NaN). Without
    // Number.isFinite, `new Date('garbage').getTime()` returns NaN and
    // `NaN >= now` is false, so the row would still transition.
    const expiresAtMs = anchor.expires_at ? new Date(anchor.expires_at).getTime() : Number.NaN;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs >= now.getTime()) {
      result.errors.push(
        `anchor ${anchor.public_id} (id=${anchor.id}) returned by selectExpiringSecured has invalid, future, or null expires_at; refusing to dispatch`,
      );
      continue;
    }

    let transitioned = false;
    try {
      transitioned = await db.casUpdateToExpired(anchor.id, nowIso);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.error({ error: err, anchorId: anchor.id }, 'sweepExpiredAnchors: CAS update failed');
      result.errors.push(`CAS update failed for ${anchor.public_id}: ${msg}`);
      continue;
    }

    if (!transitioned) {
      logger.info(
        { anchorId: anchor.id, publicId: anchor.public_id },
        'sweepExpiredAnchors: anchor no longer SECURED (likely concurrent revocation); skipping',
      );
      continue;
    }

    result.newly_expired++;

    try {
      await db.insertAuditEvent({
        event_type: 'anchor.expired',
        event_category: 'ANCHOR',
        target_type: 'anchor',
        target_id: anchor.id,
        org_id: anchor.org_id,
        details: JSON.stringify({
          public_id: anchor.public_id,
          expires_at: anchor.expires_at,
          expired_at: nowIso,
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.error({ error: err, anchorId: anchor.id }, 'sweepExpiredAnchors: audit insert failed');
      result.errors.push(`audit insert failed for ${anchor.public_id}: ${msg}`);
    }

    if (!anchor.org_id) continue;

    const data: Record<string, unknown> = {
      public_id: anchor.public_id,
      chain_tx_id: anchor.chain_tx_id,
      chain_block_height: anchor.chain_block_height,
      status: 'EXPIRED',
      expires_at: anchor.expires_at,
      expired_at: nowIso,
    };
    if (anchor.org_public_id) data.org_public_id = anchor.org_public_id;

    // CodeRabbit PR #734 review: dispatch failures previously orphaned the
    // anchor.expired event because the next sweep only sees status=SECURED.
    // Use a deterministic event_id derived from anchor.id so a future retry
    // path can dedupe via the (endpoint_id, event_id) UNIQUE constraint on
    // webhook_delivery_logs. Failures surface in errors[] for ops visibility;
    // CodeRabbit's full retry-table refactor is tracked under SCRUM-1738
    // close-out.
    const eventId = `expired-${anchor.id}`;
    try {
      await db.dispatchWebhookEvent(anchor.org_id, 'anchor.expired', eventId, data);
      result.webhooks_dispatched++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.error({ error: err, anchorId: anchor.id, publicId: anchor.public_id, eventId }, 'sweepExpiredAnchors: dispatch failed');
      result.errors.push(`dispatch failed for ${anchor.public_id}: ${msg}`);
    }
  }

  logger.info(
    {
      checked: result.checked,
      newly_expired: result.newly_expired,
      webhooks_dispatched: result.webhooks_dispatched,
      error_count: result.errors.length,
    },
    'anchor expiry sweep complete',
  );
  return result;
}

/**
 * Real-DB adapter. Wraps the Supabase client into the AnchorExpirySweepDb
 * interface. Exported for cron handlers + integration tests.
 */
export function makeAnchorExpirySweepDb(deps: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  dispatchWebhookEvent: (
    orgId: string,
    eventType: string,
    eventId: string,
    data: Record<string, unknown>,
  ) => Promise<void>;
}): AnchorExpirySweepDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = deps.db as any;
  return {
    async selectExpiringSecured(): Promise<ExpiringSecuredAnchor[]> {
      const nowIso = new Date().toISOString();
      // CodeRabbit + Codex P2: filter `deleted_at IS NULL` so soft-deleted
      // anchors don't transition. ORDER BY expires_at asc, id asc so a
      // backlog larger than the page size drains deterministically (no
      // row starvation on continued inflow).
      const { data, error } = await dbAny
        .from('anchors')
        .select(
          'id, public_id, org_id, status, chain_tx_id, chain_block_height, expires_at, organizations(public_id)',
        )
        .eq('status', 'SECURED')
        .is('deleted_at', null)
        .not('expires_at', 'is', null)
        .lt('expires_at', nowIso)
        .order('expires_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(500);
      if (error) throw new Error(error.message ?? String(error));
      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: row.id as string,
        public_id: row.public_id as string,
        org_id: (row.org_id as string | null) ?? null,
        org_public_id: ((row.organizations as { public_id?: string } | null)?.public_id) ?? null,
        status: row.status as string,
        chain_tx_id: (row.chain_tx_id as string | null) ?? null,
        chain_block_height: (row.chain_block_height as number | null) ?? null,
        expires_at: (row.expires_at as string | null) ?? null,
      }));
    },
    async casUpdateToExpired(anchorId: string, _expiredAtIso: string): Promise<boolean> {
      // CodeRabbit PR #734: schema-validate before write.
      AnchorIdSchema.parse(anchorId);
      const { data, error } = await dbAny
        .from('anchors')
        .update({ status: 'EXPIRED' })
        .eq('id', anchorId)
        .eq('status', 'SECURED')
        .is('deleted_at', null)
        .select('id');
      if (error) throw new Error(error.message ?? String(error));
      return Array.isArray(data) && data.length > 0;
    },
    async insertAuditEvent(row: Record<string, unknown>): Promise<void> {
      // CodeRabbit PR #734: schema-validate audit row before insert.
      const validated = AuditEventRowSchema.parse(row);
      // eslint-disable-next-line arkova/missing-org-filter -- audit insert carries org_id in the row payload (SCRUM-1208 pre-existing pattern)
      const { error } = await dbAny.from('audit_events').insert(validated);
      if (error) throw new Error(error.message ?? String(error));
    },
    dispatchWebhookEvent: deps.dispatchWebhookEvent,
  };
}
