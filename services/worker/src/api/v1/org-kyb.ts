/**
 * Org KYB routes (SCRUM-1162)
 *
 *   POST /api/v1/org-kyb/:orgId/start   — submit org to Middesk (ORG_ADMIN only)
 *   GET  /api/v1/org-kyb/:orgId/status  — read org's current KYB state + recent events (org member)
 *
 * Constitution refs:
 *   - 1.4: Middesk API key + webhook secret from Secret Manager. Never log.
 *   - 1.2: Every write validated via Zod.
 *   - 1.4: EIN + address are PII. Not logged. Not returned outside the vendor.
 *
 * Per 2026-04-24 decision, there is no `ENABLE_ORG_KYB` feature flag — the
 * route is always registered. Missing `MIDDESK_API_KEY` surfaces as 503.
 *
 * SECURITY (fix, 2026-07-28): neither route checked that `:orgId` (a route
 * param, not RLS-protected here — `db` is the service_role client, which
 * BYPASSES RLS by design) had anything to do with the authenticated caller.
 * Any authenticated Arkova user could submit ANY org's legal name/EIN/address
 * to Middesk (an irreversible third-party disclosure of another org's PII),
 * and read any org's KYB verification status/history, just by guessing or
 * enumerating org UUIDs. Fixed via the same `_org-auth.ts` single source of
 * truth used elsewhere:
 *   - POST /start  — ORG_ADMIN required. Submitting legal/EIN/address data to
 *     a third-party KYB vendor is a significant, hard-to-reverse action.
 *   - GET /status  — org membership only. Viewing verification status is
 *     lower-sensitivity (no PII in the response) than initiating a submission.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import {
  submitBusiness,
  MiddeskApiError,
  MiddeskConfigError,
  type MiddeskBusinessInput,
} from '../../integrations/kyb/middesk.js';
import { isCallerOrgAdminResult, isUserMemberOfOrgResult } from '../_org-auth.js';

export const orgKybRouter = Router();

const StartKybSchema = z.object({
  // Legal name + EIN + address are required for a Middesk submission. All
  // three are PII; validation happens once, they never leave this function.
  legal_name: z.string().min(1).max(200),
  ein: z
    .string()
    .regex(/^\d{9}$/, 'EIN must be 9 digits, no hyphen'),
  address: z.object({
    line1: z.string().min(1).max(200),
    line2: z.string().max(200).optional(),
    city: z.string().min(1).max(100),
    state: z.string().length(2, 'State must be a 2-letter abbreviation'),
    postal_code: z.string().min(3).max(20),
    country: z.string().length(2).optional(),
  }),
});

// ─── POST /api/v1/org/:orgId/kyb/start ────────────────────────────────

orgKybRouter.post('/:orgId/start', async (req: Request, res: Response) => {
  const userId = (req as unknown as { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ error: { code: 'unauthenticated', message: 'Sign in required' } });
    return;
  }

  const orgIdRaw = req.params.orgId;
  if (typeof orgIdRaw !== 'string' || !/^[0-9a-f-]{36}$/i.test(orgIdRaw)) {
    res.status(400).json({ error: { code: 'bad_request', message: 'Invalid org id' } });
    return;
  }
  const orgId: string = orgIdRaw;

  // ORG_ADMIN required — submitting legal name/EIN/address to Middesk on
  // behalf of an org is a significant, effectively-irreversible action.
  const { value: isAdmin, error: adminCheckError } = await isCallerOrgAdminResult(userId, orgId);
  if (adminCheckError) {
    logger.error({ userId, orgId }, 'org-kyb: admin lookup failed');
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to verify permissions' } });
    return;
  }
  if (!isAdmin) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'Organization administrator role required' },
    });
    return;
  }

  const parsed = StartKybSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'invalid_body', message: 'Invalid KYB payload', details: parsed.error.flatten() },
    });
    return;
  }

  const input: MiddeskBusinessInput = {
    name: parsed.data.legal_name,
    ein: parsed.data.ein,
    address: parsed.data.address,
    external_id: orgId,
  };

  let middeskResponse;
  try {
    middeskResponse = await submitBusiness(input);
  } catch (err) {
    if (err instanceof MiddeskConfigError) {
      // No API key — surface clearly so ops can provision the secret.
      // Note: do NOT echo the error message into client-visible response —
      // it's diagnostic, not user-facing.
      logger.error({ err: err.message }, 'Middesk not configured');
      res.status(503).json({
        error: {
          code: 'kyb_unavailable',
          message: 'KYB verification is not available. Arkova operators: provision MIDDESK_API_KEY in Secret Manager.',
        },
      });
      return;
    }
    if (err instanceof MiddeskApiError) {
      // Map sensibly. 4xx from Middesk → 4xx to caller. 5xx → 502 (bad upstream).
      const status = err.status >= 400 && err.status < 500 ? err.status : 502;
      logger.warn({ status: err.status }, 'Middesk upstream error');
      res.status(status).json({
        error: { code: 'kyb_upstream_error', message: 'KYB vendor rejected the submission.' },
      });
      return;
    }
    // Unknown failure — bubble as 500.
    logger.error({ err: (err as Error).message }, 'Unexpected KYB submission error');
    res.status(500).json({ error: { code: 'kyb_failed', message: 'KYB submission failed' } });
    return;
  }

  // Persist the vendor reference + mark org as submitted. The RPC also writes
  // the audit row in `kyb_events` and flips `organizations.verification_status`
  // to PENDING. Cast until database.types.ts is regenerated post-0250.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpcUntyped = db.rpc as any;
  const { error: rpcErr } = await rpcUntyped('start_kyb_verification', {
    p_org_id: orgId,
    p_provider: 'middesk',
    p_reference_id: middeskResponse.id,
  });

  if (rpcErr) {
    logger.error({ rpcErr }, 'start_kyb_verification RPC failed after Middesk submit');
    // Vendor already has the submission; we cannot roll that back. Return 200
    // with a reconciliation note so the caller (and Sentry) see the mismatch.
    res.status(202).json({
      ok: true,
      reference_id: middeskResponse.id,
      warning:
        'Submission accepted by vendor but Arkova state update failed; contact support if status does not update.',
    });
    return;
  }

  res.status(202).json({
    ok: true,
    reference_id: middeskResponse.id,
  });
});

// ─── GET /api/v1/org/:orgId/kyb/status ────────────────────────────────

orgKybRouter.get('/:orgId/status', async (req: Request, res: Response) => {
  const userId = (req as unknown as { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ error: { code: 'unauthenticated', message: 'Sign in required' } });
    return;
  }

  const orgIdRaw = req.params.orgId;
  if (typeof orgIdRaw !== 'string' || !/^[0-9a-f-]{36}$/i.test(orgIdRaw)) {
    res.status(400).json({ error: { code: 'bad_request', message: 'Invalid org id' } });
    return;
  }
  const orgId: string = orgIdRaw;

  // Org membership required. NOTE: `db` is the service_role client (see
  // utils/db.ts) which BYPASSES RLS by design — the `organizations`/
  // `kyb_events` RLS policies do NOT gate this service_role-executed query
  // (a prior comment here incorrectly claimed they did; that was never true
  // for this code path). This app-layer membership check is the only thing
  // that scopes this read to the caller's own org.
  const { value: isMember, error: memberCheckError } = await isUserMemberOfOrgResult(userId, orgId);
  if (memberCheckError) {
    logger.error({ userId, orgId }, 'org-kyb: membership lookup failed');
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to verify permissions' } });
    return;
  }
  if (!isMember) {
    res.status(404).json({ error: { code: 'not_found', message: 'Org not found or not visible' } });
    return;
  }

  // Narrow row shape — migration 0250 adds these columns; types regenerate
  // after prod apply (see HANDOFF.md "types regen" follow-up).
  type OrgKybRow = {
    id: string;
    verification_status: string | null;
    kyb_provider: string | null;
    kyb_submitted_at: string | null;
    kyb_completed_at: string | null;
  };
  const { data: org, error: orgErr } = (await db
    .from('organizations')
    .select('id, verification_status, kyb_provider, kyb_submitted_at, kyb_completed_at')
    .eq('id', orgId)
    .maybeSingle()) as { data: OrgKybRow | null; error: unknown };

  if (orgErr) {
    logger.error({ orgErr }, 'Failed to read org for KYB status');
    res.status(500).json({ error: { code: 'read_failed', message: 'Failed to read org' } });
    return;
  }
  if (!org) {
    res.status(404).json({ error: { code: 'not_found', message: 'Org not found or not visible' } });
    return;
  }

  // `kyb_events` is in migration 0250 — not yet in generated types.
  const kybEventsTable = db.from('kyb_events' as never);
  const { data: events, error: eventsErr } = await kybEventsTable
    .select('event_type, status, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (eventsErr) {
    logger.warn({ eventsErr }, 'Failed to read KYB events');
  }

  res.json({
    org_id: org.id,
    verification_status: org.verification_status,
    kyb_provider: org.kyb_provider,
    kyb_submitted_at: org.kyb_submitted_at,
    kyb_completed_at: org.kyb_completed_at,
    recent_events: events ?? [],
  });
});
