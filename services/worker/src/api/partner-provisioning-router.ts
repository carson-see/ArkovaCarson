/**
 * Partner-account provisioning HTTP surface (SCRUM-2990).
 *
 * The state machine in `partner-provisioning.ts` already owns the LEGALITY of
 * every transition (pure, injection-based, 22 tests). This module is the thin,
 * side-effectful layer around it: it authenticates, derives the actor from a
 * SERVER-VERIFIED principal, persists the returned record, and writes the
 * returned audit body.
 *
 *   POST   /api/partner-provisioning              file a request
 *   GET    /api/partner-provisioning              list (admin-or-above, org-scoped)
 *   GET    /api/partner-provisioning/:id          detail
 *   POST   /api/partner-provisioning/:id/approve  platform admin only
 *   POST   /api/partner-provisioning/:id/reject   platform admin only
 *   POST   /api/partner-provisioning/:id/cancel   platform admin only
 *   POST   /api/partner-provisioning/:id/provision platform admin only
 *
 * The whole prefix is mounted behind `partnerProvisioningGate()` in index.ts,
 * which fails CLOSED on the ENABLE_PARTNER_PROVISIONING switchboard flag (404
 * while dark). This router never sees a request until that flag is on.
 *
 * AUTHORIZATION — the surface is DELIBERATELY STRICTER THAN THE MACHINE.
 * `assertApprovalAuthority` in the machine admits `owner` / `org_admin` of the
 * sponsor org as reviewers. Over HTTP they are NOT admitted: approve, reject,
 * cancel and provision are platform-admin only. Rationale — the sponsor org is
 * an interested party in its own partner's onboarding, and provisioning is the
 * step that grants a counterparty standing in the platform; a self-serve org
 * admin must never be able to grant that to their own counterparty. The machine
 * remains the second, independent gate (defense in depth): both must pass.
 *
 * SEPARATION OF DUTIES — the machine blocks self-approve/self-reject. It does
 * NOT block self-provision (`provisionPartnerAccount` has no `assertNotSelfReview`
 * call). This router closes that leg: the requester may not provision their own
 * request either.
 *
 * §1.4: the actor is built ONLY from the authenticated `userId` plus an
 * authoritative server-side role lookup (`_org-auth.ts` / `platformAdmin.ts`).
 * Nothing role- or org-bearing is ever read out of the request body.
 * §1.2: every write path is Zod-validated at the boundary.
 * §1.6/§1.4: no credential material is generated, returned or logged here —
 * this surface issues no API keys (see the static guards in the test file).
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { db as defaultDb } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { recordAuditEvent } from '../utils/auditEvent.js';
import {
  getCallerProfile,
  isCallerOrgAdminResult,
  isUserMemberOfOrgResult,
} from './_org-auth.js';
import { isPlatformAdmin as defaultIsPlatformAdmin } from '../utils/platformAdmin.js';
import {
  requestPartnerAccount,
  approvePartnerRequest,
  rejectPartnerRequest,
  cancelApprovedRequest,
  provisionPartnerAccount,
  PartnerProvisioningError,
  type PartnerAccountRecord,
  type PartnerProvisioningStatus,
  type ProvisioningActor,
  type TransitionResult,
} from './partner-provisioning.js';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** RFC 4122 UUID matcher for the `:id` path param. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Max `limit` a caller may ask for on the list endpoint. */
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

const RequestBody = z.object({
  partner_name: z.string().trim().min(1).max(200),
  partner_contact_email: z.string().trim().email().max(320),
  sponsor_org_id: z.string().trim().uuid(),
});

const ReasonBody = z.object({
  reason: z.string().trim().min(1).max(2_000),
});

const ProvisionBody = z.object({
  partner_org_id: z.string().trim().uuid(),
});

const ListQuery = z.object({
  sponsor_org_id: z.string().trim().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Outbound projection. Deliberately explicit rather than a spread: a field
 * added to `PartnerAccountRecord` later must be opted IN to the wire, not
 * leaked by default.
 */
export interface PartnerAccountResponse {
  id: string;
  status: PartnerProvisioningStatus;
  partner_name: string;
  partner_contact_email: string;
  sponsor_org_id: string;
  requested_by: string;
  requested_at: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  partner_org_id: string | null;
  provisioned_by: string | null;
  provisioned_at: string | null;
}

function toResponse(r: PartnerAccountRecord): PartnerAccountResponse {
  return {
    id: r.id,
    status: r.status,
    partner_name: r.partnerName,
    partner_contact_email: r.partnerContactEmail,
    sponsor_org_id: r.sponsorOrgId,
    requested_by: r.requestedBy,
    requested_at: r.requestedAt,
    approved_by: r.approvedBy ?? null,
    approved_at: r.approvedAt ?? null,
    rejected_by: r.rejectedBy ?? null,
    rejected_at: r.rejectedAt ?? null,
    rejection_reason: r.rejectionReason ?? null,
    partner_org_id: r.partnerOrgId ?? null,
    provisioned_by: r.provisionedBy ?? null,
    provisioned_at: r.provisionedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Persistence port
// ---------------------------------------------------------------------------

/**
 * The persistence contract the router needs. Injected so tests exercise the
 * HTTP + authZ behaviour without Postgres (§1.7), and so the default
 * implementation is the ONLY place that knows the table shape.
 */
export interface PartnerAccountStore {
  /** `'conflict'` when an open request already exists for (sponsor, partner). */
  insert(record: PartnerAccountRecord): Promise<'inserted' | 'conflict'>;
  getById(id: string): Promise<PartnerAccountRecord | null>;
  list(opts: {
    sponsorOrgId?: string;
    limit: number;
    offset: number;
  }): Promise<PartnerAccountRecord[]>;
  /**
   * Compare-and-swap: persist `next` ONLY if the stored row is still in
   * `expectedStatus`. Returns false when a concurrent transition already moved
   * it — a read-modify-write without this lets two racing approvals both win.
   */
  transition(
    next: PartnerAccountRecord,
    expectedStatus: PartnerProvisioningStatus,
  ): Promise<boolean>;
}

/** Resolves a server-verified actor for `userId` acting within `orgId`. */
export type ActorResolver = (
  userId: string,
  orgId: string,
) => Promise<ProvisioningActor | null>;

// ---------------------------------------------------------------------------
// Default persistence — narrow hand-written DB facade
//
// `partner_accounts` (migration 0410) is not in the generated
// `database.types.ts` — the migration ships with this PR and is deliberately
// NOT applied anywhere yet, so types cannot be regenerated from it. Rather
// than scatter `as unknown as never` casts, declare exactly the subset of the
// supabase-js builder these queries use, mirroring the established approach in
// `v1/integrations/issuer-partnerships.ts` and `docusign-member-oauth.ts`.
// ---------------------------------------------------------------------------

interface DbError {
  code?: string;
  message?: string;
}
type DbResult<T> = { data: T | null; error: DbError | null };

interface DbQuery<TRow> extends PromiseLike<DbResult<TRow[]>> {
  select<Row = TRow>(columns?: string): DbQuery<Row>;
  insert(value: Record<string, unknown>): DbQuery<TRow>;
  update(value: Record<string, unknown>): DbQuery<TRow>;
  eq(column: string, value: unknown): DbQuery<TRow>;
  order(column: string, opts: { ascending: boolean }): DbQuery<TRow>;
  range(from: number, to: number): DbQuery<TRow>;
  limit(count: number): DbQuery<TRow>;
}

export interface PartnerProvisioningDb {
  from(table: 'partner_accounts'): DbQuery<PartnerAccountRow>;
}

interface PartnerAccountRow {
  id: string;
  status: PartnerProvisioningStatus;
  partner_name: string;
  partner_contact_email: string;
  sponsor_org_id: string;
  requested_by: string;
  requested_at: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  partner_org_id: string | null;
  provisioned_by: string | null;
  provisioned_at: string | null;
}

const ROW_COLUMNS =
  'id, status, partner_name, partner_contact_email, sponsor_org_id, requested_by, requested_at, ' +
  'approved_by, approved_at, rejected_by, rejected_at, rejection_reason, partner_org_id, ' +
  'provisioned_by, provisioned_at';

/** Postgres unique_violation — the partial unique index on open requests. */
const UNIQUE_VIOLATION = '23505';

function rowToRecord(row: PartnerAccountRow): PartnerAccountRecord {
  return {
    id: row.id,
    status: row.status,
    partnerName: row.partner_name,
    partnerContactEmail: row.partner_contact_email,
    sponsorOrgId: row.sponsor_org_id,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    rejectedBy: row.rejected_by ?? undefined,
    rejectedAt: row.rejected_at ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
    partnerOrgId: row.partner_org_id ?? undefined,
    provisionedBy: row.provisioned_by ?? undefined,
    provisionedAt: row.provisioned_at ?? undefined,
  };
}

function recordToRow(r: PartnerAccountRecord): Record<string, unknown> {
  return {
    id: r.id,
    status: r.status,
    partner_name: r.partnerName,
    partner_contact_email: r.partnerContactEmail,
    sponsor_org_id: r.sponsorOrgId,
    requested_by: r.requestedBy,
    requested_at: r.requestedAt,
    approved_by: r.approvedBy ?? null,
    approved_at: r.approvedAt ?? null,
    rejected_by: r.rejectedBy ?? null,
    rejected_at: r.rejectedAt ?? null,
    rejection_reason: r.rejectionReason ?? null,
    partner_org_id: r.partnerOrgId ?? null,
    provisioned_by: r.provisionedBy ?? null,
    provisioned_at: r.provisionedAt ?? null,
  };
}

export function createDefaultPartnerAccountStore(
  db: PartnerProvisioningDb,
): PartnerAccountStore {
  return {
    async insert(record) {
      const { error } = await db.from('partner_accounts').insert(recordToRow(record));
      if (error) {
        if (error.code === UNIQUE_VIOLATION) return 'conflict';
        throw error;
      }
      return 'inserted';
    },

    async getById(id) {
      // Primary-key read with no org filter BY NECESSITY: the sponsoring org is
      // not known until the row is loaded. Every caller of `getById` authorizes
      // against the loaded row's own `sponsorOrgId` before returning anything.
      const { data, error } = await db
        .from('partner_accounts')
        .select<PartnerAccountRow>(ROW_COLUMNS)
        .eq('id', id)
        .limit(1);
      if (error) throw error;
      const row = data?.[0];
      return row ? rowToRecord(row) : null;
    },

    async list({ sponsorOrgId, limit, offset }) {
      let q = db.from('partner_accounts').select<PartnerAccountRow>(ROW_COLUMNS);
      if (sponsorOrgId) q = q.eq('sponsor_org_id', sponsorOrgId);
      // An UNFILTERED list is reachable only by a verified platform admin; every
      // other caller is forced down the `sponsorOrgId` branch above by the route
      // handler, which 400s a non-platform-admin that omits the org.
      const { data, error } = await q
        .order('requested_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return (data ?? []).map(rowToRecord);
    },

    async transition(next, expectedStatus) {
      // `updated_at` is maintained by the table's moddatetime trigger, and
      // `recordToRow` never emits it, so the UPDATE cannot clobber it.
      const row = recordToRow(next);
      // Conditional UPDATE = the compare-and-swap. `.eq('status', expectedStatus)`
      // means a racing transition that already moved the row matches zero rows,
      // so the loser is told 409 instead of silently overwriting the winner.
      const { data, error } = await db
        .from('partner_accounts')
        .update(row)
        .eq('id', next.id)
        .eq('status', expectedStatus)
        .select<{ id: string }>('id');
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },
  };
}

/**
 * The single seam where the untyped-for-`partner_accounts` service_role client
 * meets the hand-written facade. Intentional and localised.
 */
function asPartnerProvisioningDb(db: typeof defaultDb): PartnerProvisioningDb {
  return db as unknown as PartnerProvisioningDb;
}

// ---------------------------------------------------------------------------
// Default actor resolution — SERVER-VERIFIED ONLY
// ---------------------------------------------------------------------------

/** Raised when a role lookup could not produce a definitive answer (→ 500). */
class ActorLookupError extends Error {
  constructor() {
    super('actor role lookup failed');
    this.name = 'ActorLookupError';
  }
}

/**
 * Build a {@link ProvisioningActor} from authoritative server state only.
 *
 * Precedence mirrors the rest of the worker (`_org-auth.ts`):
 *   1. `profiles.is_platform_admin` → platform_admin (global by design).
 *   2. `org_members` owner/admin, or profile ORG_ADMIN scoped to that org →
 *      org_admin. (The machine treats `owner` and `org_admin` identically, so
 *      collapsing them loses no authorization signal.)
 *   3. Any membership of the org → member.
 *   4. Otherwise null — the caller has no standing in that org at all.
 *
 * A lookup that ERRORED is never reported as a clean negative: it raises, and
 * the handler returns 500 rather than masking an outage as a 403.
 */
async function defaultResolveActor(
  userId: string,
  orgId: string,
): Promise<ProvisioningActor | null> {
  const profile = await getCallerProfile(userId);
  if (profile?.is_platform_admin === true) {
    // `orgId` here is NOT load-bearing: `assertApprovalAuthority` and the
    // request-time RBAC check both short-circuit on platform_admin before
    // reading it. It is supplied only to satisfy the machine's shape validator,
    // which requires a UUID. Prefer the admin's own org when they have one.
    return { userId, orgId: profile.org_id ?? orgId, role: 'platform_admin' };
  }

  const admin = await isCallerOrgAdminResult(userId, orgId, profile);
  if (admin.error) throw new ActorLookupError();
  if (admin.value) return { userId, orgId, role: 'org_admin' };

  const member = await isUserMemberOfOrgResult(userId, orgId);
  if (member.error) throw new ActorLookupError();
  if (member.value) return { userId, orgId, role: 'member' };

  return null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface PartnerProvisioningRouterDeps {
  store?: PartnerAccountStore;
  resolveActor?: ActorResolver;
  isPlatformAdmin?: (userId: string) => Promise<boolean>;
  recordAudit?: (row: Record<string, unknown>) => Promise<void>;
  now?: () => string;
}

/** Machine error code → HTTP status. */
const ERROR_STATUS: Record<PartnerProvisioningError['code'], number> = {
  invalid_input: 400,
  rbac_denied: 403,
  separation_of_duties: 403,
  illegal_transition: 409,
};

function fail(res: Response, status: number, code: string, message?: string): void {
  res.status(status).json({ error: message ? { code, message } : { code } });
}

function authUserId(req: Request): string | null {
  return req.authUserId ?? req.userId ?? null;
}

export function createPartnerProvisioningRouter(
  deps: PartnerProvisioningRouterDeps = {},
): Router {
  const router = Router();
  const store =
    deps.store ?? createDefaultPartnerAccountStore(asPartnerProvisioningDb(defaultDb));
  const resolveActor = deps.resolveActor ?? defaultResolveActor;
  const isPlatformAdminFn = deps.isPlatformAdmin ?? defaultIsPlatformAdmin;
  const now = deps.now ?? (() => new Date().toISOString());
  const recordAudit =
    deps.recordAudit ?? ((row: Record<string, unknown>) => recordAuditEvent(row));

  /** Persist the machine's audit body, stamped with the verified actor. */
  async function emitAudit(result: TransitionResult, actor: ProvisioningActor): Promise<void> {
    await recordAudit({ ...result.audit, actor_id: actor.userId });
  }

  /**
   * Shared preamble for every review verb: authenticate, validate the id, load
   * the record, resolve the actor, and enforce the platform-admin-only gate.
   * Returns null when it has already answered the request.
   */
  async function loadForReview(
    req: Request,
    res: Response,
  ): Promise<{ userId: string; record: PartnerAccountRecord; actor: ProvisioningActor } | null> {
    const userId = authUserId(req);
    if (!userId) {
      fail(res, 401, 'unauthorized');
      return null;
    }
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      fail(res, 400, 'invalid_id');
      return null;
    }
    const record = await store.getById(id);
    if (!record) {
      fail(res, 404, 'not_found');
      return null;
    }
    const actor = await resolveActor(userId, record.sponsorOrgId);
    if (!actor) {
      fail(res, 403, 'forbidden');
      return null;
    }
    // Router-level tightening over the machine (see module header): reviewing a
    // partner request is platform-admin only. The machine's own
    // `assertApprovalAuthority` still runs afterwards as the second gate.
    if (actor.role !== 'platform_admin') {
      fail(
        res,
        403,
        'platform_admin_required',
        'approving, rejecting, cancelling or provisioning a partner account requires a platform administrator',
      );
      return null;
    }
    return { userId, record, actor };
  }

  /**
   * Run a machine transition and persist it under compare-and-swap. Maps
   * machine errors to their HTTP status and audits ONLY after the swap wins.
   */
  async function commit(
    res: Response,
    record: PartnerAccountRecord,
    actor: ProvisioningActor,
    run: () => TransitionResult,
  ): Promise<void> {
    let result: TransitionResult;
    try {
      result = run();
    } catch (e) {
      if (e instanceof PartnerProvisioningError) {
        fail(res, ERROR_STATUS[e.code], e.code, e.message);
        return;
      }
      throw e;
    }
    const swapped = await store.transition(result.record, record.status);
    if (!swapped) {
      fail(
        res,
        409,
        'concurrent_transition',
        'the request changed status while this transition was being applied',
      );
      return;
    }
    await emitAudit(result, actor);
    res.status(200).json({ data: toResponse(result.record) });
  }

  /** Uniform 500 that never echoes the caller's input back. */
  function serverError(res: Response, e: unknown, op: string): void {
    logger.error({ error: e, op }, 'partner-provisioning request failed');
    fail(res, 500, 'internal');
  }

  // ---- POST / — file a partner request ------------------------------------
  router.post('/', async (req: Request, res: Response) => {
    const userId = authUserId(req);
    if (!userId) {
      fail(res, 401, 'unauthorized');
      return;
    }
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'invalid_body');
      return;
    }
    const body = parsed.data;

    try {
      const actor = await resolveActor(userId, body.sponsor_org_id);
      if (!actor) {
        fail(res, 403, 'forbidden');
        return;
      }

      let result: TransitionResult;
      try {
        result = requestPartnerAccount(
          {
            partnerName: body.partner_name,
            partnerContactEmail: body.partner_contact_email,
            sponsorOrgId: body.sponsor_org_id,
          },
          actor,
          now(),
        );
      } catch (e) {
        if (e instanceof PartnerProvisioningError) {
          fail(res, ERROR_STATUS[e.code], e.code, e.message);
          return;
        }
        throw e;
      }

      const outcome = await store.insert(result.record);
      if (outcome === 'conflict') {
        fail(
          res,
          409,
          'open_request_exists',
          'an open partner request already exists for this partner and sponsor org',
        );
        return;
      }
      await emitAudit(result, actor);
      res.status(201).json({ data: toResponse(result.record) });
    } catch (e) {
      serverError(res, e, 'request');
    }
  });

  // ---- GET / — list --------------------------------------------------------
  router.get('/', async (req: Request, res: Response) => {
    const userId = authUserId(req);
    if (!userId) {
      fail(res, 401, 'unauthorized');
      return;
    }
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      fail(res, 400, 'invalid_query');
      return;
    }
    const { sponsor_org_id: sponsorOrgId, limit, offset } = parsed.data;

    try {
      if (sponsorOrgId) {
        const actor = await resolveActor(userId, sponsorOrgId);
        if (!actor) {
          fail(res, 403, 'forbidden');
          return;
        }
        // A plain member may FILE a request but may not enumerate the org's
        // partner pipeline — the rows carry a third party's contact details.
        if (actor.role === 'member') {
          fail(res, 403, 'forbidden');
          return;
        }
        const rows = await store.list({ sponsorOrgId, limit, offset });
        res.status(200).json({ data: rows.map(toResponse), limit, offset });
        return;
      }

      // Unscoped listing is a platform-admin capability only.
      if (!(await isPlatformAdminFn(userId))) {
        fail(res, 400, 'sponsor_org_id_required');
        return;
      }
      const rows = await store.list({ limit, offset });
      res.status(200).json({ data: rows.map(toResponse), limit, offset });
    } catch (e) {
      serverError(res, e, 'list');
    }
  });

  // ---- GET /:id — detail ---------------------------------------------------
  router.get('/:id', async (req: Request, res: Response) => {
    const userId = authUserId(req);
    if (!userId) {
      fail(res, 401, 'unauthorized');
      return;
    }
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      fail(res, 400, 'invalid_id');
      return;
    }

    try {
      const record = await store.getById(id);
      if (!record) {
        fail(res, 404, 'not_found');
        return;
      }
      const actor = await resolveActor(userId, record.sponsorOrgId);
      if (!actor) {
        fail(res, 403, 'forbidden');
        return;
      }
      // Admin-or-above sees any record in the org; a plain member sees only the
      // request they filed themselves.
      if (actor.role === 'member' && record.requestedBy !== userId) {
        fail(res, 403, 'forbidden');
        return;
      }
      res.status(200).json({ data: toResponse(record) });
    } catch (e) {
      serverError(res, e, 'detail');
    }
  });

  // ---- POST /:id/approve ---------------------------------------------------
  router.post('/:id/approve', async (req: Request, res: Response) => {
    try {
      const ctx = await loadForReview(req, res);
      if (!ctx) return;
      const at = now();
      await commit(res, ctx.record, ctx.actor, () =>
        approvePartnerRequest(ctx.record, ctx.actor, at),
      );
    } catch (e) {
      serverError(res, e, 'approve');
    }
  });

  // ---- POST /:id/reject ----------------------------------------------------
  router.post('/:id/reject', async (req: Request, res: Response) => {
    try {
      const ctx = await loadForReview(req, res);
      if (!ctx) return;
      const parsed = ReasonBody.safeParse(req.body);
      if (!parsed.success) {
        fail(res, 400, 'invalid_body', 'a non-empty `reason` is required');
        return;
      }
      const at = now();
      await commit(res, ctx.record, ctx.actor, () =>
        rejectPartnerRequest(ctx.record, ctx.actor, parsed.data.reason, at),
      );
    } catch (e) {
      serverError(res, e, 'reject');
    }
  });

  // ---- POST /:id/cancel ----------------------------------------------------
  router.post('/:id/cancel', async (req: Request, res: Response) => {
    try {
      const ctx = await loadForReview(req, res);
      if (!ctx) return;
      const parsed = ReasonBody.safeParse(req.body);
      if (!parsed.success) {
        fail(res, 400, 'invalid_body', 'a non-empty `reason` is required');
        return;
      }
      const at = now();
      await commit(res, ctx.record, ctx.actor, () =>
        cancelApprovedRequest(ctx.record, ctx.actor, parsed.data.reason, at),
      );
    } catch (e) {
      serverError(res, e, 'cancel');
    }
  });

  // ---- POST /:id/provision -------------------------------------------------
  router.post('/:id/provision', async (req: Request, res: Response) => {
    try {
      const ctx = await loadForReview(req, res);
      if (!ctx) return;
      const parsed = ProvisionBody.safeParse(req.body);
      if (!parsed.success) {
        fail(res, 400, 'invalid_body', '`partner_org_id` must be a UUID');
        return;
      }
      const partnerOrgId = parsed.data.partner_org_id;

      // The partner org must be a DISTINCT org from the sponsor. Provisioning
      // the sponsor's own org would grant the sponsor partner standing over
      // itself — the machine only checks that the id is a UUID.
      if (partnerOrgId === ctx.record.sponsorOrgId) {
        fail(
          res,
          400,
          'invalid_partner_org',
          'partner_org_id must differ from the sponsor org',
        );
        return;
      }

      // Separation of duties on the PROVISION leg. The machine enforces this
      // for approve/reject but not for provision, and provisioning is the step
      // that actually confers access — so the requester is barred here.
      if (ctx.record.requestedBy === ctx.actor.userId) {
        fail(
          res,
          403,
          'separation_of_duties',
          'the requester may not provision their own request',
        );
        return;
      }

      const at = now();
      await commit(res, ctx.record, ctx.actor, () =>
        provisionPartnerAccount(ctx.record, ctx.actor, { partnerOrgId }, at),
      );
    } catch (e) {
      serverError(res, e, 'provision');
    }
  });

  return router;
}
