/**
 * Sub-organization management over an organization API key (SCRUM-3971).
 *
 * A SECOND router over the SAME handler cores as `orgSubOrgs.ts`. The JWT mount
 * at `index.ts:532` is byte-unchanged: `requireAuthMw` there resolves a Supabase
 * user and 401s an API-key caller before any nested route runs, so widening that
 * mount was never an option — `/api/v1/org/...` is JWT territory by construction.
 *
 * ## Why this is a different path, not a widened one
 *
 * Everything that differs between the two callers is already isolated in
 * `orgSubOrgsCaller.ts`. What differs HERE is the contract: this surface is
 * published, frozen on publication (§1.8), and read by partners, so it names
 * sub-organizations by `public_id` and returns snake_case public projections
 * only. The dashboard surface answers camelCase with raw uuids to a caller who
 * already holds them. Merging the two would mean either leaking uuids to
 * partners or breaking the dashboard.
 *
 * ## Six routes, not ten
 *
 * `create`, `request`, `cancel` and `max` stay JWT-only (CTO ruling R5):
 *
 *   - `create` assigns an owner — it writes the acting USER into the new
 *     affiliate's `org_members` as `owner`. An API key has no user to put
 *     there, and picking the key's creator would hand a human membership of an
 *     organization they never asked for. Needs explicit owner semantics first
 *     (follow-up SCRUM-5060).
 *   - `request` and `cancel` act on the CALLER'S OWN affiliation — they are
 *     self-escalation primitives ("make me a child of X"), not parent
 *     administration, and `orgs:manage` is a parent-side grant.
 *   - `max` sets the platform cap on the caller's own organization; it is an
 *     account setting, not sub-organization management.
 *
 * ## Which affiliate each route may address
 *
 * Per ACTION, not per surface, and stated once: see the lifecycle diagram above
 * `ChildPredicate` in `orgSubOrgsCaller.ts`. Each route below picks the
 * resolver that encodes its own transition, which is what makes
 * offboard→revoke and revoke→offboard both reachable.
 *
 * ## 404 is the convention here
 *
 * Any organization the caller may not address — absent, another parent's, not
 * approved yet, suspended — answers `404 sub_org_not_found`. The JWT surface
 * keeps its 403s, which are right there: that caller was shown the organization
 * in the dashboard, so confirming it exists tells them nothing. A key caller
 * supplies an identifier from outside, so a 403 would make this endpoint an
 * existence oracle over every organization's public id.
 *
 * ## Inherited middleware (CTO ruling R10)
 *
 * This router is mounted inside `api/v1/router.ts`, so it inherits the whole v1
 * chain. Consequences worth stating rather than discovering:
 *
 *   - `verificationApiGate()` — `ENABLE_VERIFICATION_API` off takes these
 *     routes down with the rest of v1. Accepted; it is the same switch every
 *     other published route sits behind.
 *   - `idempotencyMiddleware()` — an `Idempotency-Key` on a POST replays the
 *     stored response. Accepted and desirable on money-moving routes.
 *   - `requirePaymentCurrent()` (index.ts:618, ahead of the whole `/api/v1`
 *     prefix) — an organization in a lapsed payment state cannot reach these
 *     routes. Accepted and stated: a parent that has stopped paying cannot
 *     move credits to its affiliates.
 *   - `usageTracking()` — every request here counts against the key's monthly
 *     quota and can 429 a free-tier key. `usageTracking` has NO exemption
 *     mechanism (`services/worker/src/middleware/usageTracking.ts` returns
 *     early only for anonymous requests), so this is accepted rather than
 *     exempted, and it is documented on every path in `docs.ts` and
 *     `docs/api/openapi.yaml`. Adding an exemption list is a change to a
 *     middleware every v1 route shares and does not belong in this PR.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { requireScopeAnyAuth } from '../../middleware/requireScopeAnyAuth.js';
import { db as _db } from '../../utils/db.js';
import { PUBLIC_ORG_ID_RE } from '../v2/resourceIdentifiers.js';
import {
  resolveSubOrgCaller,
  resolveChildForApprove,
  resolveChildForRevoke,
  resolveApprovedChild,
  resolveOwnedChild,
  type SubOrgCaller,
  type SubOrgChild,
  type SubOrgFailure,
  type SubOrgResult,
} from './orgSubOrgsCaller.js';
import {
  APPROVE_AFFILIATE_ACTION,
  REVOKE_AFFILIATE_ACTION,
  MAX_CREDIT_TRANSFER,
  applyAffiliateStatusAction,
  allocateSubOrgCreditsCore,
  subOrgCreditRollupCore,
  offboardSubOrgCore,
  type AffiliateActionSpec,
} from './orgSubOrgs.js';

// Sub-org columns from migration 0128 are not in the generated types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = _db as any;

export const orgSubOrgsApiRouter = Router();

/**
 * Write gate. The MOUNT in `api/v1/router.ts` requires `read:orgs` router-wide;
 * each mutating route additionally requires `orgs:manage`. Declared per route
 * rather than as a second `router.use`, because a `use` would have to be
 * ordered above every POST and below every GET — an ordering nobody can see
 * from the route declarations, and the shape that made
 * `middleware/requireScopeAnyAuth.ts` necessary in the first place.
 */
const requireOrgsManage = requireScopeAnyAuth('orgs:manage');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The selector. A raw uuid is refused with a DISTINCT 400 rather than silently
 * 404ing: an integration that has the internal id in hand got it from
 * somewhere, and telling it "use the public id" is the difference between a
 * one-line fix and a support ticket about a sub-organization that "disappeared".
 */
const OrgPublicIdSchema = z
  .string()
  .trim()
  .min(2)
  .max(128);

const SelectorSchema = z.object({ org_public_id: OrgPublicIdSchema });

const AllocateCreditsSchema = z.object({
  org_public_id: OrgPublicIdSchema,
  // Negative reclaims from the sub-organization back to the parent.
  amount: z
    .number()
    .int()
    .refine((n) => n !== 0, { message: 'amount must be non-zero' })
    .refine((n) => Math.abs(n) <= MAX_CREDIT_TRANSFER, {
      message: `amount must be within +/-${MAX_CREDIT_TRANSFER}`,
    }),
  note: z.string().trim().max(500).optional(),
});

const OffboardSchema = z.object({
  org_public_id: OrgPublicIdSchema,
  reason: z.string().trim().max(500).optional(),
});

function sendFailure(res: Response, failure: SubOrgFailure): void {
  const body: Record<string, string> = { error: failure.error };
  if (failure.message) body.message = failure.message;
  res.status(failure.status).json(body);
}

/**
 * Parse a body, refusing a raw uuid selector before Zod's generic 422 so the
 * caller gets the actionable error rather than "invalid_request".
 */
function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
  res: Response,
): z.infer<T> | null {
  const selector = (body as { org_public_id?: unknown } | null)?.org_public_id;
  if (typeof selector === 'string' && UUID_RE.test(selector.trim())) {
    res.status(400).json({
      error: 'use_public_id',
      message: 'org_public_id must be an organization public identifier, not an internal id.',
    });
    return null;
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.status(422).json({
      error: 'invalid_request',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return null;
  }

  const value = parsed.data as { org_public_id?: string };
  if (value.org_public_id !== undefined && !PUBLIC_ORG_ID_RE.test(value.org_public_id)) {
    res.status(422).json({
      error: 'invalid_request',
      details: [{ path: 'org_public_id', message: 'org_public_id is not a valid organization public identifier' }],
    });
    return null;
  }

  return parsed.data;
}

/** Resolve the acting key, writing the refusal itself when there is one. */
async function requireKeyCaller(req: Request, res: Response): Promise<SubOrgCaller | null> {
  const caller = await resolveSubOrgCaller(req, db);
  if (!caller.ok) {
    sendFailure(res, caller);
    return null;
  }
  return caller.value;
}

function unwrapChild(res: Response, result: SubOrgResult<SubOrgChild>): SubOrgChild | null {
  if (!result.ok) {
    sendFailure(res, result);
    return null;
  }
  return result.value;
}

// ─── GET / — list the caller's affiliated organizations ──────────────────────
orgSubOrgsApiRouter.get('/', async (req: Request, res: Response) => {
  try {
    const caller = await requireKeyCaller(req, res);
    if (!caller) return;

    const { data: subOrgs, error } = await db
      .from('organizations')
      .select('id, public_id, display_name, domain, verification_status, parent_approval_status, suspended, created_at')
      .eq('parent_org_id', caller.orgId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error({ err: error.message, orgId: caller.orgId }, 'suborg_api_list_failed');
      res.status(503).json({ error: 'sub_org_list_unavailable' });
      return;
    }

    // A successful PostgREST list read is an array. `?? []` here would report
    // "this organization has no affiliates" on a shape fault — a materially
    // wrong answer a partner would act on.
    if (!Array.isArray(subOrgs)) {
      logger.error({ orgId: caller.orgId }, 'suborg_api_list_shape');
      res.status(503).json({ error: 'sub_org_list_unavailable' });
      return;
    }
    const rows = subOrgs as {
      id: string;
      public_id: string | null;
      display_name: string;
      domain: string | null;
      verification_status: string | null;
      parent_approval_status: string | null;
      suspended: boolean | null;
      created_at: string;
    }[];

    const { data: parentOrg, error: parentError } = await db
      .from('organizations')
      .select('max_sub_orgs')
      .eq('id', caller.orgId)
      .maybeSingle();

    if (parentError) {
      logger.error({ err: parentError.message, orgId: caller.orgId }, 'suborg_api_cap_read_failed');
      res.status(503).json({ error: 'sub_org_list_unavailable' });
      return;
    }

    // Which affiliates currently run on THIS organization's DocuSign
    // connection. The JWT surface degrades to "nobody is inheriting" when this
    // read fails, because it is an additive field on a panel that already
    // worked. This surface refuses instead: a partner reading `false` has no
    // way to tell a real answer from a swallowed fault, and would reasonably
    // re-provision a connection that is already inherited.
    const childIds = rows.map((row) => row.id);
    let inheritingIds = new Set<string>();
    if (childIds.length > 0) {
      // Doubly tenant-scoped: `inherited_from_org_id` restricts to markers
      // pointing at THIS organization, `in('org_id', childIds)` to its own
      // children. The isolation rule matches only a literal `.eq('org_id', …)`.
      // eslint-disable-next-line arkova/missing-org-filter -- see the note above
      const { data: markers, error: markerError } = await db
        .from('org_integrations')
        .select('org_id')
        .eq('provider', 'docusign')
        .eq('inherited_from_org_id', caller.orgId)
        .is('revoked_at', null)
        .in('org_id', childIds);

      if (markerError) {
        logger.error({ err: markerError.message, orgId: caller.orgId }, 'suborg_api_docusign_marker_lookup_failed');
        res.status(503).json({ error: 'sub_org_list_unavailable' });
        return;
      }
      if (!Array.isArray(markers)) {
        logger.error({ orgId: caller.orgId }, 'suborg_api_docusign_marker_shape');
        res.status(503).json({ error: 'sub_org_list_unavailable' });
        return;
      }
      inheritingIds = new Set(markers.map((m: { org_id: string }) => m.org_id));
    }

    // A child with no public id cannot be named on this surface, and silently
    // dropping it would under-report the cap the caller is being told about.
    // 0453 makes the column NOT NULL; this refuses rather than trusting that.
    const unnamed = rows.filter((row) => !row.public_id);
    if (unnamed.length > 0) {
      logger.error(
        { orgId: caller.orgId, unnamedCount: unnamed.length },
        'suborg_api_child_without_public_id',
      );
      res.status(503).json({ error: 'sub_org_list_unavailable' });
      return;
    }

    res.json({
      sub_orgs: rows.map((row) => ({
        public_id: row.public_id,
        display_name: row.display_name,
        domain: row.domain ?? null,
        verification_status: row.verification_status ?? null,
        parent_approval_status: row.parent_approval_status ?? null,
        suspended: row.suspended === true,
        docusign_inherited: inheritingIds.has(row.id),
        created_at: row.created_at,
      })),
      max_sub_orgs: parentOrg?.max_sub_orgs ?? null,
      count: rows.length,
    });
  } catch (error) {
    logger.error({ error }, 'suborg_api_list_threw');
    res.status(500).json({ error: 'internal_error' });
  }
});

// ─── POST /approve, POST /revoke ─────────────────────────────────────────────
type ChildResolver = (
  caller: SubOrgCaller,
  orgPublicId: string,
  database: unknown,
) => Promise<SubOrgResult<SubOrgChild>>;

async function handleStatusAction(
  req: Request,
  res: Response,
  action: AffiliateActionSpec,
  resolveChild: ChildResolver,
): Promise<void> {
  try {
    const caller = await requireKeyCaller(req, res);
    if (!caller) return;

    const body = parseBody(SelectorSchema, req.body, res);
    if (!body) return;

    const child = unwrapChild(res, await resolveChild(caller, body.org_public_id, db));
    if (!child) return;

    const result = await applyAffiliateStatusAction(
      {
        caller,
        orgId: caller.orgId,
        childOrgId: child.id,
        childOrg: {
          id: child.id,
          parent_org_id: caller.orgId,
          parent_approval_status: child.parentApprovalStatus,
          display_name: child.displayName,
        },
      },
      action,
    );

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json({ status: action.targetStatus, public_id: child.publicId });
  } catch (error) {
    logger.error({ error }, action.failureLog);
    res.status(500).json({ error: 'internal_error' });
  }
}

orgSubOrgsApiRouter.post('/approve', requireOrgsManage, async (req: Request, res: Response) => {
  await handleStatusAction(req, res, APPROVE_AFFILIATE_ACTION, resolveChildForApprove);
});

orgSubOrgsApiRouter.post('/revoke', requireOrgsManage, async (req: Request, res: Response) => {
  await handleStatusAction(req, res, REVOKE_AFFILIATE_ACTION, resolveChildForRevoke);
});

// ─── POST /credits ───────────────────────────────────────────────────────────
orgSubOrgsApiRouter.post('/credits', requireOrgsManage, async (req: Request, res: Response) => {
  try {
    const caller = await requireKeyCaller(req, res);
    if (!caller) return;

    const body = parseBody(AllocateCreditsSchema, req.body, res);
    if (!body) return;

    const child = unwrapChild(res, await resolveApprovedChild(caller, body.org_public_id, db));
    if (!child) return;

    const result = await allocateSubOrgCreditsCore(caller, child.id, body.amount, body.note ?? null);
    if (result.status !== 200) {
      res.status(result.status).json(result.body);
      return;
    }

    res.json({
      parent_balance: result.body.parentBalance,
      child_balance: result.body.childBalance,
      amount: result.body.amount,
    });
  } catch (error) {
    logger.error({ error }, 'suborg_api_credits_threw');
    res.status(500).json({ error: 'internal_error' });
  }
});

// ─── GET /credits — rollup ───────────────────────────────────────────────────
orgSubOrgsApiRouter.get('/credits', async (req: Request, res: Response) => {
  try {
    const caller = await requireKeyCaller(req, res);
    if (!caller) return;

    const result = await subOrgCreditRollupCore(caller);
    if (!result.rollup) {
      res.status(result.status).json(result.body ?? { error: 'unknown_error' });
      return;
    }

    const children = result.rollup.children;
    if (!Array.isArray(children)) {
      logger.error({ orgId: caller.orgId }, 'suborg_api_rollup_shape');
      res.status(503).json({ error: 'rollup_projection_unavailable' });
      return;
    }
    // Refuse rather than under-report. A rollup missing a row reads as "that
    // affiliate has no balance", which is a materially wrong answer about
    // money; dropping the row silently is the failure mode this refuses.
    if (children.some((c) => !c.child_public_id)) {
      logger.error({ orgId: caller.orgId }, 'suborg_api_rollup_child_without_public_id');
      res.status(503).json({ error: 'rollup_projection_unavailable' });
      return;
    }

    // Balances only. Per decision D2 a parent sees what its sub-organizations
    // SPEND, never what they secured — no record contents cross the boundary.
    res.json({
      parent_balance: result.rollup.parent_balance,
      children: children.map((c) => ({
        public_id: c.child_public_id,
        balance: c.balance,
        monthly_allocation: c.monthly_allocation,
      })),
    });
  } catch (error) {
    logger.error({ error }, 'suborg_api_rollup_threw');
    res.status(500).json({ error: 'internal_error' });
  }
});

// ─── POST /offboard ──────────────────────────────────────────────────────────
orgSubOrgsApiRouter.post('/offboard', requireOrgsManage, async (req: Request, res: Response) => {
  try {
    const caller = await requireKeyCaller(req, res);
    if (!caller) return;

    const body = parseBody(OffboardSchema, req.body, res);
    if (!body) return;

    const child = unwrapChild(res, await resolveOwnedChild(caller, body.org_public_id, db));
    if (!child) return;

    const result = await offboardSubOrgCore(caller, child.id, body.reason ?? null);
    if (result.status !== 200) {
      res.status(result.status).json(result.body);
      return;
    }

    res.json({
      reclaimed: result.body.reclaimed,
      suspended: result.body.suspended,
      already_suspended: result.body.alreadySuspended,
    });
  } catch (error) {
    logger.error({ error }, 'suborg_api_offboard_threw');
    res.status(500).json({ error: 'internal_error' });
  }
});
