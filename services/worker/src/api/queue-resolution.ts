/**
 * Anchor Queue Resolution API (ARK-101 — SCRUM-1011)
 *
 * GET  /api/queue/pending       → list PENDING_RESOLUTION anchors for caller's org
 * POST /api/queue/resolve       → admin picks terminal version; siblings → REVOKED
 *
 * The heavy lifting lives in the DB RPCs `list_pending_resolution_anchors`
 * and `resolve_anchor_queue` (migration 0228). The endpoints here are thin
 * wrappers: authenticate via Supabase JWT, forward to the RPC under the
 * user's role, shape the response, map RPC exceptions to HTTP codes.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';
import { emitOrgAdminNotifications } from '../notifications/dispatcher.js';
import { processBatchAnchors } from '../jobs/batch-anchor.js';
import { recordOrgQueueRunResult } from '../jobs/org-queue-scheduler.js';
import { mapRpcErrorToStatus } from './rpc-error-status.js';
import { getCallerProfile, isCallerOrgAdminResult } from './_org-auth.js';

export { mapRpcErrorToStatus } from './rpc-error-status.js';

/**
 * SCRUM-1121: row identifier round-tripped to clients is `public_id`, the
 * short opaque slug. Internal `anchors.id` UUID never leaves the server per
 * CLAUDE.md §6 ("Only `public_id` + derived fields").
 */
export interface PendingResolutionAnchor {
  public_id: string;
  external_file_id: string | null;
  filename: string | null;
  fingerprint: string;
  created_at: string;
  sibling_count: number;
}

// `.strict()` rejects unknown keys — important here because a caller still
// posting the legacy `selected_anchor_id` field would otherwise silently
// strip it and process the request without our new public_id parameter.
export const ResolveQueueInput = z
  .object({
    external_file_id: z.string().trim().min(1).max(255),
    selected_public_id: z.string().trim().min(1).max(50),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

function rpcErrorCodeForStatus(status: number): 'forbidden' | 'not_found' | 'conflict' | 'internal' {
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  return 'internal';
}

/** Safely read a string field from an anchor's `metadata` JSON blob. */
function metadataString(metadata: unknown, key: string): string | null {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const v = (metadata as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

/**
 * GET /api/queue/pending
 * Returns anchors currently in PENDING_RESOLUTION for the caller's org,
 * with a `sibling_count` per row so the UI can badge collisions.
 *
 * SCRUM-2213: the previous implementation called the RPC
 * `list_pending_resolution_anchors_v2`, which resolves the caller via
 * `auth.uid()`. But the worker invokes RPCs through the **service-role** client,
 * where `auth.uid()` is NULL → the RPC raised "Profile not found" → this endpoint
 * 500'd on every request and the Review Queue page hung. We now resolve the
 * caller's org explicitly from the authenticated `callerUserId` (passed by the
 * route, which already validated the JWT) and query org-scoped directly — no
 * `auth.uid()` dependency, and bounded/indexed (no full-table scan).
 */
export async function handleListPendingResolution(
  req: Request,
  res: Response,
  callerUserId?: string,
): Promise<void> {
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? '100', 10) || 100, 1),
    500,
  );

  if (!callerUserId) {
    res.status(401).json({ error: { code: 'authentication_required', message: 'Authentication required' } });
    return;
  }

  try {
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', callerUserId)
      .maybeSingle();

    if (profileError) {
      logger.error({ error: profileError, userId: callerUserId }, 'queue/pending: profile lookup failed');
      res.status(500).json({ error: { code: 'internal', message: 'Failed to list pending resolutions' } });
      return;
    }

    // No profile or no org → empty queue (renders an empty state, never an error).
    if (!profile?.org_id) {
      res.json({ items: [], count: 0 });
      return;
    }

    // Org-scoped PENDING_RESOLUTION fetch. Uses idx_anchors_org_status_created
    // (org_id, status, created_at DESC) WHERE deleted_at IS NULL — bounded + fast.
    // Fetch up to the 500 cap so sibling_count reflects the full pending set
    // before the display `limit` is applied (matching the prior RPC's window).
    const { data: rows, error: rowsError } = await db
      .from('anchors')
      .select('public_id, metadata, filename, fingerprint, created_at')
      .eq('org_id', profile.org_id)
      .eq('status', 'PENDING_RESOLUTION')
      .is('deleted_at', null)
      .not('public_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500);

    if (rowsError) {
      logger.error({ error: rowsError, userId: callerUserId }, 'queue/pending: anchors query failed');
      res.status(500).json({ error: { code: 'internal', message: 'Failed to list pending resolutions' } });
      return;
    }

    const pending = rows ?? [];

    // sibling_count = number of OTHER pending anchors sharing the same
    // external_file_id (collision badge), computed over the full pending set.
    const countByFileId = new Map<string, number>();
    for (const r of pending) {
      const fid = metadataString(r.metadata, 'external_file_id');
      if (fid) countByFileId.set(fid, (countByFileId.get(fid) ?? 0) + 1);
    }

    const items: PendingResolutionAnchor[] = pending.slice(0, limit).map((r) => {
      const externalFileId = metadataString(r.metadata, 'external_file_id');
      return {
        public_id: r.public_id as string,
        external_file_id: externalFileId,
        filename: r.filename ?? null,
        fingerprint: r.fingerprint,
        created_at: r.created_at,
        sibling_count: externalFileId ? Math.max((countByFileId.get(externalFileId) ?? 1) - 1, 0) : 0,
      };
    });

    res.json({ items, count: items.length });
  } catch (err) {
    logger.error({ error: err, userId: callerUserId }, 'handleListPendingResolution unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

/**
 * POST /api/queue/resolve
 * Admin picks the terminal version among PENDING_RESOLUTION anchors sharing
 * an external_file_id. Resolution RPC enforces ORG_ADMIN role, row-locks the
 * collision set, flips selected → PENDING, siblings → REVOKED, and records
 * the audit event.
 *
 * `actorUserId` (endpoint-reachability audit / SCRUM-2213 bug class — see
 * services/worker/src/api/agents.md): was already threaded through by the
 * route (admin.ts already resolves + gates on it), but this handler only
 * used it for the post-success notification lookup — never passed it into
 * the RPC call itself. `resolve_anchor_queue_by_public_id` resolves the
 * caller via `auth.uid()`, which is always NULL under the worker's
 * service_role client, so it raised 'Profile not found' → 403 for every
 * caller. Now passed as `p_caller_user_id` to a NEW service_role-only RPC
 * overload (migration 0367) that takes the identity explicitly instead of
 * reading `auth.uid()`. Every existing authorization check inside the RPC
 * (profile exists, role = ORG_ADMIN, caller's org matches the target
 * anchor's org) is unchanged.
 */
export async function handleResolveQueue(
  req: Request,
  res: Response,
  actorUserId?: string,
): Promise<void> {
  const parsed = ResolveQueueInput.safeParse(req.body);
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

  if (!actorUserId) {
    res.status(401).json({
      error: { code: 'authentication_required', message: 'Authentication required' },
    });
    return;
  }

  try {
    const { data, error } = await callRpc<string>(db, 'resolve_anchor_queue_by_public_id', {
      p_external_file_id: parsed.data.external_file_id,
      p_selected_public_id: parsed.data.selected_public_id,
      p_reason: parsed.data.reason ?? null,
      p_caller_user_id: actorUserId,
    });

    if (error) {
      const status = mapRpcErrorToStatus(error.message ?? '');
      logger.warn({ error }, 'resolve_anchor_queue RPC returned error');
      // 500-class errors never leak raw RPC messages — the underlying error
      // may include internal role names, column names, or trigger details
      // that are useful in logs but not in the HTTP response.
      const isInternal = status >= 500;
      res.status(status).json({
        error: {
          code: rpcErrorCodeForStatus(status),
          message: isInternal ? 'Internal server error' : error.message ?? 'Resolve failed',
        },
      });
      return;
    }

    res.json({ resolution_id: data });
    const notificationOrgId = actorUserId
      ? await getSelectedAnchorOrgId(parsed.data.selected_public_id)
      : null;
    if (notificationOrgId) {
      void emitOrgAdminNotifications({
        type: 'queue_run_completed',
        organizationId: notificationOrgId,
        payload: {
          resolutionId: data,
          externalFileId: parsed.data.external_file_id,
          selectedPublicId: parsed.data.selected_public_id,
          actorUserId,
        },
      });
    }
  } catch (err) {
    logger.error({ error: err }, 'handleResolveQueue unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

/**
 * QUEUE-05 (SCRUM-2351): the optional `org_id` lets a caller target a *specific*
 * org's queue (their own, or an approved sub-org they administer). Omitted →
 * the caller's own org. `.strict()` rejects unknown keys so a typo never
 * silently runs the wrong org.
 */
export const RunOrgQueueInput = z
  .object({ org_id: z.string().uuid().optional() })
  .strict();

/**
 * Outcome of the manual-run authorization check. `relationship` records HOW the
 * caller was authorized (own org vs parent admin of a sub-org) for the audit row.
 */
type RunAuthOutcome =
  | { ok: true; orgId: string; relationship: 'self' | 'sub_org' }
  | { ok: false; status: 401 | 403 | 500; code: 'authentication_required' | 'forbidden' | 'internal'; message: string };

/**
 * Authorize a manual queue run for `targetOrgId` by `userId`, owner-inclusively.
 *
 * Uses the canonical `_org-auth` resolver (`isCallerOrgAdminResult`) — NO direct
 * `org_members` membership probe in this handler. A caller may run:
 *   1. their OWN org's queue if they are owner/admin (or ORG_ADMIN/platform) of it; OR
 *   2. an APPROVED sub-org's queue if they are owner/admin of that sub-org's
 *      PARENT org (parent admins administer their affiliates).
 * Fails closed: an operational lookup error surfaces as 500, a true negative 403.
 */
async function authorizeManualRun(
  userId: string,
  callerOrgId: string,
  targetOrgId: string,
  preloadedProfile: Awaited<ReturnType<typeof getCallerProfile>>,
): Promise<RunAuthOutcome> {
  // Direct path: caller administers their OWN org itself (owner-inclusive).
  // Defense-in-depth: gate the self/admin shortcut on targetOrgId===callerOrgId
  // so the profile-level ORG_ADMIN fallback inside isCallerOrgAdminResult can
  // NEVER authorize an arbitrary target org via this path — an unrelated target
  // must go through the explicit approved-sub-org path below or be denied. (The
  // _org-auth helper is also org-scoped now; this is the belt-and-suspenders.)
  if (targetOrgId === callerOrgId) {
    const direct = await isCallerOrgAdminResult(userId, targetOrgId, preloadedProfile);
    if (direct.value) return { ok: true, orgId: targetOrgId, relationship: 'self' };
    if (direct.error) {
      return { ok: false, status: 500, code: 'internal', message: 'Internal server error' };
    }
  }

  // Sub-org path: target is an APPROVED affiliate of the caller's own org, and
  // the caller administers that parent org.
  const { data: targetOrg, error: targetErr } = await db
    .from('organizations')
    .select('parent_org_id, parent_approval_status')
    .eq('id', targetOrgId)
    .maybeSingle();
  if (targetErr) {
    logger.warn({ error: targetErr, userId, targetOrgId }, 'queue/run: target org lookup failed');
    return { ok: false, status: 500, code: 'internal', message: 'Internal server error' };
  }
  const parentOrgId = (targetOrg as { parent_org_id?: string | null } | null)?.parent_org_id ?? null;
  const approval = (targetOrg as { parent_approval_status?: string | null } | null)?.parent_approval_status ?? null;
  if (parentOrgId && parentOrgId === callerOrgId && approval === 'APPROVED') {
    // parentOrgId === callerOrgId here, so the preloaded profile (for callerOrgId)
    // is the correct one to reuse — avoids a redundant profiles round-trip.
    const parent = await isCallerOrgAdminResult(userId, parentOrgId, preloadedProfile);
    if (parent.value) return { ok: true, orgId: targetOrgId, relationship: 'sub_org' };
    if (parent.error) {
      return { ok: false, status: 500, code: 'internal', message: 'Internal server error' };
    }
  }

  return {
    ok: false,
    status: 403,
    code: 'forbidden',
    message: 'Only organization admins can run anchoring jobs',
  };
}

/**
 * Zod schema for the manual-run audit row — validate the persisted payload
 * before the `audit_events` insert (CLAUDE.md §1.2: Zod on every write path).
 * Server-constructed, but parsing it fails closed on any drift in shape.
 */
const ManualRunAuditRow = z
  .object({
    actor_id: z.string().min(1),
    event_type: z.literal('QUEUE_RUN_MANUAL'),
    event_category: z.literal('ANCHOR'),
    target_type: z.literal('organization'),
    target_id: z.string().min(1),
    org_id: z.string().min(1),
    details: z.string(),
  })
  .strict();

/**
 * Record the manual-run audit event (QUEUE-05). Non-fatal: an audit write
 * failure is logged but never blocks or fails the run (the run itself is the
 * source of truth, mirroring the jobs/ audit convention).
 */
async function recordManualRunAudit(args: {
  userId: string;
  orgId: string;
  relationship: 'self' | 'sub_org';
  status: 'succeeded' | 'failed';
  processed: number;
  batchId: string | null;
}): Promise<void> {
  try {
    // §1.2: validate the persisted shape before the write. We parse a separate
    // copy (throws on any drift → caught below, logged, never blocks the run)
    // and keep the `.insert()` argument as a bare inline object literal carrying
    // the explicit `org_id` tenant scope, so the `arkova/missing-org-filter`
    // tenant-isolation lint can statically see the scope (it only recognizes an
    // inline literal, not a wrapping parse() call or a const). Both objects are
    // the same server-constructed shape.
    ManualRunAuditRow.parse({
      actor_id: args.userId,
      event_type: 'QUEUE_RUN_MANUAL',
      event_category: 'ANCHOR',
      target_type: 'organization',
      target_id: args.orgId,
      org_id: args.orgId,
      details: JSON.stringify({
        trigger: 'manual',
        relationship: args.relationship,
        status: args.status,
        processed: args.processed,
        batch_id: args.batchId,
      }),
    });
    const { error } = await db.from('audit_events').insert({
      actor_id: args.userId,
      event_type: 'QUEUE_RUN_MANUAL',
      event_category: 'ANCHOR',
      target_type: 'organization',
      target_id: args.orgId,
      org_id: args.orgId,
      details: JSON.stringify({
        trigger: 'manual',
        relationship: args.relationship,
        status: args.status,
        processed: args.processed,
        batch_id: args.batchId,
      }),
    });
    if (error) {
      logger.warn({ error, orgId: args.orgId, userId: args.userId }, 'queue/run: manual-run audit insert failed');
    }
  } catch (err) {
    logger.warn({ error: err, orgId: args.orgId, userId: args.userId }, 'queue/run: manual-run audit insert threw');
  }
}

/**
 * POST /api/queue/run
 * Organization admins can force a batch run for their own org queue, and sub-org
 * admins (via parent-org admin) for an approved sub-org's queue. The underlying
 * claim RPC still owns row locking and PENDING → BROADCASTING, so this endpoint
 * cannot bypass the worker safety rails or claim an unrelated org's anchors.
 */
export async function handleRunOrgAnchorQueue(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = RunOrgQueueInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'Invalid body', details: parsed.error.flatten() },
    });
    return;
  }

  const profile = await getCallerProfile(userId);
  const callerOrgId = profile?.org_id ?? null;
  if (!callerOrgId) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'No organization on profile' },
    });
    return;
  }

  const targetOrgId = parsed.data.org_id ?? callerOrgId;
  const auth = await authorizeManualRun(userId, callerOrgId, targetOrgId, profile);
  if (!auth.ok) {
    res.status(auth.status).json({ error: { code: auth.code, message: auth.message } });
    return;
  }
  const orgId = auth.orgId;

  const startedAt = new Date();
  try {
    const result = await processBatchAnchors({ force: true, orgId });

    // SCRUM-3031: the drain never ran — another instance holds the batch run
    // lease. Do not file run evidence for it: `recordOrgQueueRunResult` writes
    // `last_run_at`, and `claim_due_org_queue_runs` only re-offers an org 24
    // hours after that, so recording a refusal as "succeeded" would tell the
    // admin their queue ran AND defer the org's next scheduled drain by a day.
    // `skipped` is an additive field on an existing 200 response (§1.8).
    if (result.skipped) {
      logger.info({ orgId, userId }, 'Manual org queue run skipped — batch run lease held elsewhere');
      res.json({ ok: true, ...result });
      return;
    }

    const finishedAt = new Date();

    // BUG-2026-08-01-F9 (GAP 1): processBatchAnchors does NOT throw on a
    // definitive, fully-unwound broadcast rejection (e.g. UTXO contention
    // with a concurrently-running org's batch) — that outcome is resolved
    // and self-healing, not an exception. `rejectedReason` is only ever set
    // on that exact path (batch-anchor.ts), so — mirroring the scheduler
    // fix in this same PR — record it as a failed run, not a plain success.
    const rejected = typeof result.rejectedReason === 'string' && result.rejectedReason.length > 0;

    await recordOrgQueueRunResult({
      orgId,
      trigger: 'manual',
      status: rejected ? 'failed' : 'succeeded',
      startedAt,
      finishedAt,
      processed: result.processed,
      batchId: result.batchId,
      merkleRoot: result.merkleRoot,
      txId: result.txId,
      triggeredBy: userId,
      error: rejected ? (result.rejectedReason ?? null) : null,
    });
    await recordManualRunAudit({
      userId,
      orgId,
      relationship: auth.relationship,
      status: rejected ? 'failed' : 'succeeded',
      processed: result.processed,
      batchId: result.batchId,
    });

    if (rejected) {
      // This is a SYNCHRONOUS human-admin caller, not a scheduled cron: they
      // need to see the rejection NOW, not discover it later in run history.
      // Response-shape choice (see PR body for full reasoning):
      //   - NOT 200 { ok: true } — that is a direct lie ("your run
      //     succeeded") about a run that reverted every claimed anchor.
      //   - NOT a bare 5xx — the rejection is a legitimate, EXPECTED,
      //     self-healing outcome (the node examined and refused the signed
      //     tx; the next drain retries and typically clears). A 5xx would
      //     misrepresent normal contention as a server fault and could
      //     trigger on-call paging for something that isn't broken.
      //   - 409 Conflict: the request could not complete because of a
      //     conflict over a shared, contended resource (the treasury's
      //     spendable inputs), and retrying later is expected to succeed —
      //     exactly what 409's semantics describe. `ok: false` in the body
      //     is the explicit, non-ambiguous signal (existing 400/403/500
      //     paths on this same endpoint already return non-2xx + `{error}`,
      //     never a 2xx-with-a-flag shape, so this keeps the response
      //     family consistent for any caller keying off HTTP status).
      // §1.3: this message reaches the operator verbatim (AnchorQueuePage.tsx
      // renders `error.message` directly) — it is UI copy and must avoid the
      // banned terminology list even though it is assembled in worker code.
      res.status(409).json({
        ok: false,
        processed: result.processed,
        error: {
          code: 'broadcast_rejected',
          message:
            'This run could not complete because of a temporary conflict over shared network capacity. ' +
            'This is expected to clear on its own — try running again shortly.',
        },
      });
      return;
    }

    res.json({ ok: true, ...result });
    void emitOrgAdminNotifications({
      type: 'queue_run_completed',
      organizationId: orgId,
      payload: {
        triggeredBy: userId,
        trigger: 'manual',
        processed: result.processed,
        batchId: result.batchId,
        txId: result.txId,
        merkleRoot: result.merkleRoot,
      },
    });
  } catch (err) {
    const finishedAt = new Date();
    await recordOrgQueueRunResult({
      orgId,
      trigger: 'manual',
      status: 'failed',
      startedAt,
      finishedAt,
      processed: 0,
      batchId: null,
      merkleRoot: null,
      txId: null,
      triggeredBy: userId,
      error: err instanceof Error ? err.message : 'manual org queue run failed',
    });
    await recordManualRunAudit({
      userId,
      orgId,
      relationship: auth.relationship,
      status: 'failed',
      processed: 0,
      batchId: null,
    });
    logger.error({ error: err, orgId, userId }, 'manual org queue run failed');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

async function getSelectedAnchorOrgId(publicId: string): Promise<string | null> {
  const { data, error } = await db
    .from('anchors')
    .select('org_id')
    .eq('public_id', publicId)
    .maybeSingle();

  if (error) {
    logger.warn({ error, publicId }, 'Failed to load selected anchor org for queue notification');
    return null;
  }

  return (data?.org_id as string | null) ?? null;
}
