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
  // SCRUM-1800 (SCRUM-1743 Phase 2c): allow credential.status_changed +
  // credential.status_changed_dispatch_failed alongside the anchor.* event
  // types so the sweep can emit credential lifecycle audit rows when a
  // credential expires. event_category remains 'ANCHOR' for both — the
  // anchor row is the persistent target, credential is a derived projection.
  event_type: z.enum([
    'anchor.expired',
    'anchor.expired_dispatch_failed',
    'credential.status_changed',
    'credential.status_changed_dispatch_failed',
  ]),
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
  // SCRUM-1800 (SCRUM-1743 Phase 2c): added so the sweep can dispatch
  // credential.status_changed (SECURED → EXPIRED) alongside anchor.expired.
  // Optional + nullable — non-credential anchors skip the credential.*
  // dispatch, and existing test fixtures that predate this field still
  // type-check (undefined behaves identically to null at runtime).
  credential_type?: string | null;
}

/**
 * SCRUM-1807: keyset cursor for paginating large expiry backlogs. The DB
 * adapter orders by (expires_at ASC, id ASC) with a 500-row page; the sweep
 * loop passes the previous page's last (expires_at, id) on each subsequent
 * call. Implementations without a cursor argument behave like the original
 * single-page selectExpiringSecured.
 */
export interface ExpiringAnchorCursor {
  last_expires_at: string;
  last_id: string;
}

export interface AnchorExpirySweepDb {
  selectExpiringSecured(cursor?: ExpiringAnchorCursor): Promise<ExpiringSecuredAnchor[]>;
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
  /** SCRUM-1807: number of pages fetched via the keyset cursor (>=1). */
  pages: number;
}

/**
 * SCRUM-1807: page size for the keyset cursor + a safety cap on total pages
 * per cron tick. 500 × 50 = 25,000 anchors per sweep. A backlog larger than
 * that is itself an alerting condition and the next cron tick picks up the
 * remainder. The cap prevents a runaway loop if the cursor logic regresses.
 */
const EXPIRY_SWEEP_PAGE_SIZE = 500;
const EXPIRY_SWEEP_MAX_PAGES = 50;

export async function sweepExpiredAnchors(db: AnchorExpirySweepDb): Promise<AnchorExpirySweepResult> {
  const result: AnchorExpirySweepResult = {
    checked: 0,
    newly_expired: 0,
    webhooks_dispatched: 0,
    errors: [],
    pages: 0,
  };

  // SCRUM-1807: drain the expiring-anchors backlog via a keyset cursor
  // instead of capping at a single 500-row page. Each iteration fetches up
  // to EXPIRY_SWEEP_PAGE_SIZE rows ordered by (expires_at ASC, id ASC),
  // processes them in-order, and uses the last fetched row's
  // (expires_at, id) as the cursor for the next page. The loop terminates
  // when the page is short (last partial page) or when EXPIRY_SWEEP_MAX_PAGES
  // is reached (defensive cap; backlog beyond that is the next cron tick's
  // problem). Per-anchor processing semantics are unchanged from PR #734.
  result.pages = 0;
  const now = new Date();
  const nowIso = now.toISOString();
  let cursor: ExpiringAnchorCursor | undefined;
  const candidates: ExpiringSecuredAnchor[] = [];

  for (let page = 0; page < EXPIRY_SWEEP_MAX_PAGES; page++) {
    let pageCandidates: ExpiringSecuredAnchor[];
    try {
      pageCandidates = await db.selectExpiringSecured(cursor);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.error(
        { error: err, page, cursor },
        'sweepExpiredAnchors: selectExpiringSecured failed',
      );
      result.errors.push(`selectExpiringSecured page ${page} failed: ${msg}`);
      // Don't return early — partial pages already processed should still
      // contribute their counters to the result. Just stop fetching more.
      break;
    }

    result.pages++;
    if (pageCandidates.length === 0) break;
    candidates.push(...pageCandidates);

    // PR #753 audit fix A4: advance the cursor only to the last row whose
    // expires_at is STRUCTURALLY valid AND in the past per the worker clock.
    // The previous "advance to lastRow regardless" pattern silently dropped
    // future-dated rows in a clock-skew window: a row whose expires_at is
    // ~50ms in the past per the DB clock (so the SQL filter `lt(expires_at,
    // nowIso)` accepts it) but ~50ms in the future per the worker clock would
    // fail the runtime guard at line ~190 AND advance the cursor past it —
    // and the next cron tick (daily cadence) would never see it again.
    // Now: walk the page in reverse, find the last row with finite-and-past
    // expires_at, advance the cursor to that. Structurally-invalid rows
    // (null/NaN expires_at) DO advance the cursor since re-fetching garbage
    // would loop forever. Future-dated rows leave the cursor where it is so
    // the next tick re-evaluates them.
    let safeAdvanceRow: ExpiringSecuredAnchor | undefined;
    let sawStructurallyInvalid = false;
    for (let j = pageCandidates.length - 1; j >= 0; j--) {
      const row = pageCandidates[j];
      const expiresMs = row.expires_at ? new Date(row.expires_at).getTime() : Number.NaN;
      if (!Number.isFinite(expiresMs)) {
        sawStructurallyInvalid = true;
        // If the LAST row is structurally invalid, fall through to advance
        // past it (we'd loop on garbage otherwise). Captured separately so
        // we know to advance past it even if no clean row exists in this page.
        if (j === pageCandidates.length - 1 && safeAdvanceRow === undefined && row.expires_at) {
          safeAdvanceRow = row;
        }
        continue;
      }
      if (expiresMs < now.getTime()) {
        safeAdvanceRow = row;
        break;
      }
      // expiresMs >= now → clock skew / DB-filter inconsistency. Don't
      // advance past it; next tick will re-fetch from the prior cursor.
    }

    if (safeAdvanceRow && safeAdvanceRow.expires_at) {
      cursor = { last_expires_at: safeAdvanceRow.expires_at, last_id: safeAdvanceRow.id };
    } else if (sawStructurallyInvalid) {
      // Whole page is structural garbage — terminate the loop rather than
      // re-fetch the same garbage forever. Operators get a logger.warn +
      // errors[] entry from the per-anchor guard at line ~190.
      logger.warn(
        { page, pageSize: pageCandidates.length },
        'sweepExpiredAnchors: page contains only structurally-invalid expires_at rows — terminating cursor loop',
      );
      break;
    } else {
      // Whole page is future-dated (clock skew). Don't advance; let next
      // tick try again — but break out of THIS sweep's loop to avoid
      // re-fetching the same page repeatedly.
      logger.warn(
        { page, pageSize: pageCandidates.length, now: nowIso },
        'sweepExpiredAnchors: page contains only future-dated rows (clock skew?) — terminating this sweep without cursor advance',
      );
      break;
    }

    // Last partial page → no more rows after this.
    if (pageCandidates.length < EXPIRY_SWEEP_PAGE_SIZE) break;
  }

  if (result.pages >= EXPIRY_SWEEP_MAX_PAGES) {
    logger.warn(
      { pages: result.pages, candidates_so_far: candidates.length },
      'sweepExpiredAnchors: hit page cap; remaining backlog deferred to next cron tick',
    );
    result.errors.push(
      `hit page cap (${EXPIRY_SWEEP_MAX_PAGES} × ${EXPIRY_SWEEP_PAGE_SIZE}); backlog deferred to next cron tick`,
    );
  }

  result.checked = candidates.length;
  if (candidates.length === 0) return result;

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
    // webhook_delivery_logs. On failure we write a sentinel
    // `anchor.expired_dispatch_failed` audit event so operators can manually
    // re-dispatch through the SCRUM-1738 retry path; the failure also surfaces
    // in errors[] so the cron's structured error counter trips alerting.
    // CodeRabbit PR #734: use public_id, not internal anchor.id, so
    // outbound event metadata never leaks internal UUIDs (CLAUDE.md §6).
    const eventId = `expired-${anchor.public_id}`;
    // TODO: SCRUM-1738 — dispatch failure should not prevent retry; needs retry/dead-letter mechanism.
    // Currently, once the CAS flips status to EXPIRED, the next sweep won't revisit this anchor
    // (it only selects status='SECURED'). If dispatch throws below, the webhook is permanently
    // dropped. A proper fix requires either a separate outbox/retry table or re-enqueueing
    // failed dispatches for the SCRUM-1738 retry path.
    try {
      await db.dispatchWebhookEvent(anchor.org_id, 'anchor.expired', eventId, data);
      result.webhooks_dispatched++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.error({ error: err, anchorId: anchor.id, publicId: anchor.public_id, eventId }, 'sweepExpiredAnchors: dispatch failed');
      result.errors.push(`dispatch failed for ${anchor.public_id}: ${msg}`);
      // Sentinel audit event so the dropped dispatch is recoverable. Failure
      // here is also non-fatal — we keep draining the candidate list.
      try {
        await db.insertAuditEvent({
          event_type: 'anchor.expired_dispatch_failed',
          event_category: 'ANCHOR',
          target_type: 'anchor',
          target_id: anchor.id,
          org_id: anchor.org_id,
          details: JSON.stringify({
            public_id: anchor.public_id,
            event_id: eventId,
            error: msg,
            failed_at: nowIso,
            recovery: 'manual re-dispatch via SCRUM-1738 retry path; (endpoint_id, event_id) UNIQUE on webhook_delivery_logs prevents duplicate delivery',
          }),
        });
      } catch (auditErr) {
        const auditMsg = auditErr instanceof Error ? auditErr.message : 'unknown';
        logger.error({ error: auditErr, anchorId: anchor.id }, 'sweepExpiredAnchors: dispatch-failure sentinel audit insert also failed');
        result.errors.push(`dispatch-failure sentinel audit insert failed for ${anchor.public_id}: ${auditMsg}`);
      }
    }

    // SCRUM-1800 (SCRUM-1743 Phase 2c): credential.status_changed emit on
    // SECURED → EXPIRED. Independent of the anchor.expired dispatch — both
    // events should be observable. credential_type is required by the schema;
    // anchors without it (non-credentials) skip the credential.* dispatch.
    if (anchor.credential_type) {
      const credEventId = `cred-status-expired-${anchor.public_id}`;
      const credData = {
        public_id: anchor.public_id,
        credential_type: anchor.credential_type,
        previous_status: 'SECURED',
        new_status: 'EXPIRED',
        changed_at: nowIso,
      };
      try {
        await db.dispatchWebhookEvent(
          anchor.org_id,
          'credential.status_changed',
          credEventId,
          credData,
        );
        // CodeRabbit PR #753: count credential.status_changed in
        // webhooks_dispatched alongside anchor.expired so rollout/alerting
        // signals don't undercount the new emit path.
        result.webhooks_dispatched++;
        try {
          await db.insertAuditEvent({
            event_type: 'credential.status_changed',
            event_category: 'ANCHOR',
            target_type: 'anchor',
            target_id: anchor.id,
            org_id: anchor.org_id,
            details: JSON.stringify({
              ...credData,
              event_id: credEventId,
              dispatched: true,
            }),
          });
        } catch (auditErr) {
          const auditMsg = auditErr instanceof Error ? auditErr.message : 'unknown';
          logger.error(
            { error: auditErr, anchorId: anchor.id },
            'sweepExpiredAnchors: credential.status_changed audit insert failed',
          );
          result.errors.push(
            `credential.status_changed audit insert failed for ${anchor.public_id}: ${auditMsg}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        logger.error(
          { error: err, anchorId: anchor.id, publicId: anchor.public_id, eventId: credEventId },
          'sweepExpiredAnchors: credential.status_changed dispatch failed',
        );
        result.errors.push(
          `credential.status_changed dispatch failed for ${anchor.public_id}: ${msg}`,
        );
        try {
          await db.insertAuditEvent({
            event_type: 'credential.status_changed_dispatch_failed',
            event_category: 'ANCHOR',
            target_type: 'anchor',
            target_id: anchor.id,
            org_id: anchor.org_id,
            details: JSON.stringify({
              ...credData,
              event_id: credEventId,
              error: msg,
              failed_at: nowIso,
              recovery: 'manual re-dispatch via SCRUM-1738 retry path',
            }),
          });
        } catch (auditErr) {
          const auditMsg = auditErr instanceof Error ? auditErr.message : 'unknown';
          logger.error(
            { error: auditErr, anchorId: anchor.id },
            'sweepExpiredAnchors: credential.status_changed dispatch-failure sentinel audit insert failed',
          );
          result.errors.push(
            `credential.status_changed sentinel audit insert failed for ${anchor.public_id}: ${auditMsg}`,
          );
        }
      }
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
    async selectExpiringSecured(cursor?: ExpiringAnchorCursor): Promise<ExpiringSecuredAnchor[]> {
      const nowIso = new Date().toISOString();
      // CodeRabbit + Codex P2: filter `deleted_at IS NULL` so soft-deleted
      // anchors don't transition. ORDER BY expires_at asc, id asc so a
      // backlog larger than the page size drains deterministically (no
      // row starvation on continued inflow).
      //
      // SCRUM-1807: keyset-cursor pagination. Each call returns one page of
      // up to EXPIRY_SWEEP_PAGE_SIZE rows; when a `cursor` is supplied,
      // results are filtered to rows strictly after the cursor's
      // (expires_at, id). Lexicographic comparison on the (expires_at, id)
      // composite is expressed via PostgREST's `or(...)` because supabase-js
      // doesn't expose row-value comparison directly:
      //   expires_at > C  OR  (expires_at = C AND id > I)
      // This is a standard keyset technique and it requires the matching
      // ascending sort order on (expires_at, id) for correctness.
      let query = dbAny
        .from('anchors')
        .select(
          'id, public_id, org_id, status, chain_tx_id, chain_block_height, expires_at, credential_type, organizations(public_id)',
        )
        .eq('status', 'SECURED')
        .is('deleted_at', null)
        .not('expires_at', 'is', null)
        .lt('expires_at', nowIso);
      if (cursor) {
        // PostgREST `.or()` filter — note: PostgREST .or() expects
        // `field.op.value` syntax, not SQL. The `and(...)` nested form lets
        // us combine the strict equal-and-greater-id case.
        query = query.or(
          `expires_at.gt.${cursor.last_expires_at},and(expires_at.eq.${cursor.last_expires_at},id.gt.${cursor.last_id})`,
        );
      }
      const { data, error } = await query
        .order('expires_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(EXPIRY_SWEEP_PAGE_SIZE);
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
        credential_type: (row.credential_type as string | null) ?? null,
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
