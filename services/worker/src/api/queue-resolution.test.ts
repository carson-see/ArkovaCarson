/**
 * Tests for ARK-101 queue resolution API (SCRUM-1011).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

// Mock db + logger BEFORE importing the SUT so the SUT captures the mocked modules.
const rpcMock = vi.fn();
const fromMock = vi.fn();
const emitOrgAdminNotificationsMock = vi.fn();
const processBatchAnchorsMock = vi.fn();
const recordOrgQueueRunResultMock = vi.fn();

vi.mock('../utils/db.js', () => ({
  db: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../notifications/dispatcher.js', () => ({
  emitOrgAdminNotifications: (...args: unknown[]) => emitOrgAdminNotificationsMock(...args),
}));

vi.mock('../jobs/batch-anchor.js', () => ({
  processBatchAnchors: (...args: unknown[]) => processBatchAnchorsMock(...args),
}));

vi.mock('../jobs/org-queue-scheduler.js', () => ({
  recordOrgQueueRunResult: (...args: unknown[]) => recordOrgQueueRunResultMock(...args),
}));

import {
  handleResolveQueue,
  handleRunOrgAnchorQueue,
  ResolveQueueInput,
  mapRpcErrorToStatus,
} from './queue-resolution.js';

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

function mockReq(opts: { body?: unknown; query?: Record<string, string> } = {}): Request {
  return {
    body: opts.body ?? {},
    query: opts.query ?? {},
    headers: {},
  } as unknown as Request;
}

describe('ResolveQueueInput', () => {
  it('accepts minimal valid input', () => {
    const result = ResolveQueueInput.safeParse({
      external_file_id: 'drive-123',
      selected_public_id: 'pid_acmemsa1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty selected_public_id', () => {
    const result = ResolveQueueInput.safeParse({
      external_file_id: 'drive-123',
      selected_public_id: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects selected_public_id over 50 chars (slug cap)', () => {
    const result = ResolveQueueInput.safeParse({
      external_file_id: 'drive-123',
      selected_public_id: 'x'.repeat(51),
    });
    expect(result.success).toBe(false);
  });

  it('rejects request bodies that still include the legacy selected_anchor_id', () => {
    // Defense-in-depth: callers that haven't updated to public_id should fail
    // closed rather than silently accept the spurious internal-uuid field.
    const result = ResolveQueueInput.safeParse({
      external_file_id: 'drive-123',
      selected_anchor_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty external_file_id', () => {
    const result = ResolveQueueInput.safeParse({
      external_file_id: '',
      selected_public_id: 'pid_acmemsa1',
    });
    expect(result.success).toBe(false);
  });

  it('caps reason at 2000 chars', () => {
    const result = ResolveQueueInput.safeParse({
      external_file_id: 'drive-123',
      selected_public_id: 'pid_acmemsa1',
      reason: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe('mapRpcErrorToStatus', () => {
  it.each([
    // Resource-not-found (generic) → 404
    ['Anchor not found', 404],
    ['Selected anchor not found', 404],
    // "Profile not found" is an AUTH path — the RPC raises it when auth.uid()
    // doesn't resolve. Must match 403 BEFORE the generic 'not found' check.
    ['Profile not found', 403],
    ['Only organization administrators can resolve queued anchors', 403],
    ['Cannot resolve anchor from different organization', 403],
    ['insufficient_privilege', 403],
    // Conflicts (state rejections)
    ['Anchor is not awaiting resolution (status: SUBMITTED)', 409],
    ['check_violation on something', 409],
    ['Selected anchor external_file_id (a) does not match requested collision set (b)', 409],
    // Fallthrough
    ['generic db error', 500],
  ])('maps %j → %i', (msg, code) => {
    expect(mapRpcErrorToStatus(msg)).toBe(code);
  });
});

// SCRUM-2213: handleListPendingResolution was rewritten to resolve the caller's
// org from the authenticated userId and query `anchors` org-scoped directly,
// instead of the `auth.uid()`-dependent RPC `list_pending_resolution_anchors_v2`
// (which always failed under the worker's service-role client → 500). Its tests
// now live in `queue-resolution-pending.test.ts` (profiles + anchors mocks, 6
// cases). The prior RPC-mock tests for it have been removed as obsolete.

describe('handleResolveQueue', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    emitOrgAdminNotificationsMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('rejects invalid body with 400', async () => {
    const { res, status } = mockRes();
    await handleResolveQueue(mockReq({ body: { external_file_id: 'x' } }), res);
    expect(status).toHaveBeenCalledWith(400);
  });

  // ─── Endpoint-reachability regression (SCRUM-2213 bug class) ───
  // Before the fix, `resolve_anchor_queue_by_public_id` resolved the caller
  // via `auth.uid()`, which is always NULL under the worker's service_role
  // client, so it raised 'Profile not found' → 403 for EVERY caller, even
  // though `actorUserId` was already available on this handler (used only
  // for the post-success notification lookup, never passed into the RPC).
  it('401s when no actorUserId is supplied (structural reachability guard)', async () => {
    const { res, status } = mockRes();
    await handleResolveQueue(
      mockReq({
        body: { external_file_id: 'drive-123', selected_public_id: 'pid_acmemsa1' },
      }),
      res,
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('passes actorUserId to the RPC as p_caller_user_id (the SCRUM-2213 fix)', async () => {
    rpcMock.mockResolvedValue({ data: 'res-1', error: null });
    const { res } = mockRes();
    await handleResolveQueue(
      mockReq({
        body: { external_file_id: 'drive-123', selected_public_id: 'pid_acmemsa1' },
      }),
      res,
      'user-1',
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'resolve_anchor_queue_by_public_id',
      expect.objectContaining({ p_caller_user_id: 'user-1' }),
    );
  });

  it('returns resolution_id on success', async () => {
    rpcMock.mockResolvedValue({ data: 'res-1', error: null });
    const { res, json } = mockRes();
    await handleResolveQueue(
      mockReq({
        body: {
          external_file_id: 'drive-123',
          selected_public_id: 'pid_acmemsa1',
        },
      }),
      res,
      'user-1',
    );
    expect(json).toHaveBeenCalledWith({ resolution_id: 'res-1' });
  });

  it('notifies admins for the selected anchor organization (looked up via public_id)', async () => {
    rpcMock.mockResolvedValue({ data: 'res-1', error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: { org_id: 'org-1' }, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ select });

    const { res } = mockRes();
    await handleResolveQueue(
      mockReq({
        body: {
          external_file_id: 'drive-123',
          selected_public_id: 'pid_acmemsa1',
        },
      }),
      res,
      'user-1',
    );

    expect(fromMock).toHaveBeenCalledWith('anchors');
    // The lookup must filter by public_id, not the internal id (defense in depth).
    expect(eq).toHaveBeenCalledWith('public_id', 'pid_acmemsa1');
    expect(emitOrgAdminNotificationsMock).toHaveBeenCalledWith({
      type: 'queue_run_completed',
      organizationId: 'org-1',
      payload: expect.objectContaining({
        resolutionId: 'res-1',
        actorUserId: 'user-1',
        selectedPublicId: 'pid_acmemsa1',
      }),
    });
  });

  it('maps RPC 403 for insufficient privileges', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'Only organization administrators can resolve queued anchors' },
    });
    const { res, status, json } = mockRes();
    await handleResolveQueue(
      mockReq({
        body: {
          external_file_id: 'drive-123',
          selected_public_id: 'pid_acmemsa1',
        },
      }),
      res,
      'user-1',
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'forbidden' }),
    });
  });

  it('maps RPC 409 for status conflict', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'Anchor is not awaiting resolution (status: SECURED)' },
    });
    const { res, status, json } = mockRes();
    await handleResolveQueue(
      mockReq({
        body: {
          external_file_id: 'drive-123',
          selected_public_id: 'pid_acmemsa1',
        },
      }),
      res,
      'user-1',
    );
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'conflict' }),
    });
  });

  it('maps RPC 404 for not-found', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'Anchor not found' },
    });
    const { res, status, json } = mockRes();
    await handleResolveQueue(
      mockReq({
        body: {
          external_file_id: 'drive-123',
          selected_public_id: 'pid_acmemsa1',
        },
      }),
      res,
      'user-1',
    );
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'not_found' }),
    });
  });
});

/**
 * QUEUE-05 (SCRUM-2351) manual-run guard tests.
 *
 * A table-dispatching `from` mock so the canonical `_org-auth` resolver
 * (profiles + org_members) and the handler's sub-org / audit lookups can each
 * be answered independently and in any order — the guard's call ORDER is an
 * implementation detail, the per-table answer is the contract.
 */
interface TableResponses {
  profiles?: { data: unknown; error?: unknown };
  org_members?: Array<{ data: unknown; error?: unknown }>;
  organizations?: { data: unknown; error?: unknown };
  audit_events?: { error?: unknown };
}

function installFromMock(responses: TableResponses): { auditInserts: unknown[] } {
  const auditInserts: unknown[] = [];
  const orgMembersQueue = [...(responses.org_members ?? [])];

  fromMock.mockImplementation((table: string) => {
    if (table === 'audit_events') {
      return {
        insert: (row: unknown) => {
          auditInserts.push(row);
          return Promise.resolve({ error: responses.audit_events?.error ?? null });
        },
      };
    }

    // Read tables resolve through .select().eq()*.maybeSingle().
    let payload: { data: unknown; error: unknown };
    if (table === 'profiles') {
      payload = { data: responses.profiles?.data ?? null, error: responses.profiles?.error ?? null };
    } else if (table === 'org_members') {
      const next = orgMembersQueue.shift() ?? { data: null };
      payload = { data: next.data ?? null, error: next.error ?? null };
    } else if (table === 'organizations') {
      payload = { data: responses.organizations?.data ?? null, error: responses.organizations?.error ?? null };
    } else {
      payload = { data: null, error: null };
    }

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve(payload),
    };
    return chain;
  });

  return { auditInserts };
}

const OWNER_OK = { processed: 7, batchId: 'b-1', merkleRoot: 'a'.repeat(64), txId: 'tx-1' };

describe('handleRunOrgAnchorQueue', () => {
  beforeEach(() => {
    fromMock.mockReset();
    processBatchAnchorsMock.mockReset();
    recordOrgQueueRunResultMock.mockReset();
    emitOrgAdminNotificationsMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('rejects callers without an organization (403)', async () => {
    installFromMock({ profiles: { data: { org_id: null, role: 'ORG_ADMIN' } } });

    const { res, status, json } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq(), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'forbidden', message: 'No organization on profile' },
    });
    expect(processBatchAnchorsMock).not.toHaveBeenCalled();
  });

  it('owner of own org → 2xx, runs the batch + writes a manual-run audit event', async () => {
    const { auditInserts } = installFromMock({
      profiles: { data: { org_id: 'org-1', role: 'INDIVIDUAL', is_platform_admin: false } },
      org_members: [{ data: { role: 'owner' } }],
    });
    processBatchAnchorsMock.mockResolvedValue(OWNER_OK);

    const { res, status, json } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq(), res);

    expect(status).not.toHaveBeenCalled();
    expect(processBatchAnchorsMock).toHaveBeenCalledWith({ force: true, orgId: 'org-1' });
    expect(json).toHaveBeenCalledWith({ ok: true, ...OWNER_OK });
    expect(recordOrgQueueRunResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', trigger: 'manual', status: 'succeeded', triggeredBy: 'user-1' }),
    );
    // manual-run audit event recorded
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      actor_id: 'user-1',
      event_type: 'QUEUE_RUN_MANUAL',
      org_id: 'org-1',
      target_id: 'org-1',
    });
  });

  it('admin of own org → 2xx', async () => {
    installFromMock({
      profiles: { data: { org_id: 'org-1', role: 'INDIVIDUAL', is_platform_admin: false } },
      org_members: [{ data: { role: 'admin' } }],
    });
    processBatchAnchorsMock.mockResolvedValue(OWNER_OK);

    const { res, status } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq(), res);

    expect(status).not.toHaveBeenCalled();
    expect(processBatchAnchorsMock).toHaveBeenCalledWith({ force: true, orgId: 'org-1' });
  });

  it('sub-org admin → scoped 2xx: parent admin runs an APPROVED sub-org queue', async () => {
    // Caller is admin of parent org-1; targets sub-org sub-1 (approved affiliate).
    // The direct self/admin path is gated on targetOrgId===callerOrgId, so for a
    // sub-org target it is SKIPPED entirely — only the parent admin lookup runs:
    // org_members answers (parent org-1 → admin).
    installFromMock({
      profiles: { data: { org_id: 'org-1', role: 'INDIVIDUAL', is_platform_admin: false } },
      org_members: [{ data: { role: 'admin' } }],
      organizations: { data: { parent_org_id: 'org-1', parent_approval_status: 'APPROVED' } },
    });
    processBatchAnchorsMock.mockResolvedValue(OWNER_OK);

    const { res, status } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq({ body: { org_id: '11111111-1111-4111-8111-111111111111' } }), res);

    expect(status).not.toHaveBeenCalled();
    // scoped to the SUB-org, never the parent
    expect(processBatchAnchorsMock).toHaveBeenCalledWith({
      force: true,
      orgId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('plain member → 403, no run', async () => {
    installFromMock({
      profiles: { data: { org_id: 'org-1', role: 'INDIVIDUAL', is_platform_admin: false } },
      org_members: [{ data: { role: 'member' } }, { data: { role: 'member' } }],
      organizations: { data: { parent_org_id: null, parent_approval_status: null } },
    });

    const { res, status, json } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq(), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'forbidden', message: 'Only organization admins can run anchoring jobs' },
    });
    expect(processBatchAnchorsMock).not.toHaveBeenCalled();
  });

  it('cross-org → 403: admin of org-1 cannot run an UNRELATED org-2 queue', async () => {
    // Caller is owner of org-1; targets org-2, which is NOT their sub-org.
    // org_members: (target org-2 → no row), (parent lookup never reached because
    // org-2 has no parent linkage to org-1).
    installFromMock({
      profiles: { data: { org_id: 'org-1', role: 'INDIVIDUAL', is_platform_admin: false } },
      org_members: [{ data: null }],
      organizations: { data: { parent_org_id: null, parent_approval_status: null } },
    });

    const { res, status, json } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq({ body: { org_id: '22222222-2222-4222-8222-222222222222' } }), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'forbidden', message: 'Only organization admins can run anchoring jobs' },
    });
    expect(processBatchAnchorsMock).not.toHaveBeenCalled();
  });

  it('cross-org → 403: a profile-level ORG_ADMIN of org-1 cannot run an UNRELATED org-2 queue (and never anchors it)', async () => {
    // Regression for the `_org-auth` profile-level ORG_ADMIN fallback. The
    // caller is a profile ORG_ADMIN of org-1 (no org_members row in org-2) and
    // targets the UNRELATED org-2. Because the ORG_ADMIN role is OWN-ORG scoped,
    // the direct admin check must fail for org-2; org-2 has no parent linkage to
    // org-1, so the sub-org path also denies → 403, and processBatchAnchors is
    // never invoked for the unrelated org.
    installFromMock({
      profiles: { data: { org_id: 'org-1', role: 'ORG_ADMIN', is_platform_admin: false } },
      org_members: [{ data: null }],
      organizations: { data: { parent_org_id: null, parent_approval_status: null } },
    });

    const { res, status, json } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq({ body: { org_id: '22222222-2222-4222-8222-222222222222' } }), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'forbidden', message: 'Only organization admins can run anchoring jobs' },
    });
    expect(processBatchAnchorsMock).not.toHaveBeenCalled();
  });

  it('cross-org → 403: a NON-approved sub-org is denied (parent_approval_status != APPROVED)', async () => {
    installFromMock({
      profiles: { data: { org_id: 'org-1', role: 'INDIVIDUAL', is_platform_admin: false } },
      org_members: [{ data: null }],
      organizations: { data: { parent_org_id: 'org-1', parent_approval_status: 'PENDING' } },
    });

    const { res, status } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq({ body: { org_id: '33333333-3333-4333-8333-333333333333' } }), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(processBatchAnchorsMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the batch worker throws (records failed run + failed audit)', async () => {
    const { auditInserts } = installFromMock({
      profiles: { data: { org_id: 'org-1', role: 'ORG_ADMIN', is_platform_admin: false } },
      org_members: [{ data: { role: 'owner' } }],
    });
    processBatchAnchorsMock.mockRejectedValue(new Error('chain submit blew up'));

    const { res, status, json } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq(), res);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'internal', message: 'Internal server error' },
    });
    expect(recordOrgQueueRunResultMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      trigger: 'manual',
      status: 'failed',
      triggeredBy: 'user-1',
      error: 'chain submit blew up',
    }));
    // failed run still leaves an audit trail
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({ event_type: 'QUEUE_RUN_MANUAL', org_id: 'org-1' });
    expect(emitOrgAdminNotificationsMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown body key (strict schema, 400)', async () => {
    installFromMock({ profiles: { data: { org_id: 'org-1', role: 'ORG_ADMIN' } } });
    const { res, status } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq({ body: { selected_anchor_id: 'x' } }), res);
    expect(status).toHaveBeenCalledWith(400);
    expect(processBatchAnchorsMock).not.toHaveBeenCalled();
  });

  // BUG-2026-08-01-F9 (GAP 1 — manual admin endpoint). processBatchAnchors
  // does NOT throw on a definitive, fully-unwound broadcast rejection (e.g.
  // UTXO contention with a concurrently-running org's batch) — the result
  // just carries `rejectedReason` (batch-anchor.ts, PR #1828). Before this
  // fix, handleRunOrgAnchorQueue only branched on thrown-vs-not-thrown, so a
  // rejection landed in the SAME unconditional `status: 'succeeded'` /
  // `res.json({ ok: true, ... })` path as a genuine no-op run — the exact
  // "success indistinguishable from idleness" defect class fixed for the
  // scheduler path, still open here for the synchronous human-admin caller.
  it('a definitively rejected broadcast → 409 ok:false, records failed run + failed audit, no admin notification (BUG-2026-08-01-F9)', async () => {
    const { auditInserts } = installFromMock({
      profiles: { data: { org_id: 'org-1', role: 'INDIVIDUAL', is_platform_admin: false } },
      org_members: [{ data: { role: 'owner' } }],
    });
    processBatchAnchorsMock.mockResolvedValue({
      processed: 0,
      batchId: null,
      merkleRoot: 'd'.repeat(64),
      txId: null,
      rejectedReason: 'BroadcastRejectedError: min relay fee not met (code -26)',
    });

    const { res, status, json } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq(), res);

    // Synchronous human-admin caller: must see the rejection NOW, in the
    // response, not only later in run history. A 2xx `{ ok: true }` here
    // would actively lie ("your run succeeded") about a run that did nothing
    // and reverted 0 anchors of new work; a bare 5xx would misrepresent a
    // legitimate, expected, self-healing outcome as a server fault. 409
    // (Conflict — the request couldn't complete due to contention over a
    // shared resource, and is expected to succeed on retry) is neither.
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'broadcast_rejected' }),
      }),
    );
    const body = json.mock.calls[0][0] as { error: { message: string } };
    // §1.3: the response body reaches AnchorQueuePage.tsx verbatim via
    // `setError(err.message)` — it IS user-facing UI copy, so the banned
    // crypto/chain terminology list applies here even though this text is
    // assembled in worker code, not JSX.
    expect(body.error.message).not.toMatch(
      /wallet|gas|hash|block|transaction|crypto|blockchain|bitcoin|testnet|mainnet|utxo|broadcast/i,
    );

    expect(recordOrgQueueRunResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        trigger: 'manual',
        status: 'failed',
        triggeredBy: 'user-1',
        error: expect.stringContaining('min relay fee not met'),
      }),
    );
    // manual-run audit event must say failed, not succeeded
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({ event_type: 'QUEUE_RUN_MANUAL', org_id: 'org-1' });
    const details = JSON.parse((auditInserts[0] as { details: string }).details);
    expect(details.status).toBe('failed');
    // Not a completed run from the admin's perspective — must not fire the
    // "queue_run_completed" notification a real success would.
    expect(emitOrgAdminNotificationsMock).not.toHaveBeenCalled();
  });

  it('a genuinely empty run (no rejectedReason) still returns 200 ok:true (unchanged happy path)', async () => {
    installFromMock({
      profiles: { data: { org_id: 'org-1', role: 'INDIVIDUAL', is_platform_admin: false } },
      org_members: [{ data: { role: 'owner' } }],
    });
    processBatchAnchorsMock.mockResolvedValue({ processed: 0, batchId: null, merkleRoot: null, txId: null });

    const { res, status, json } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq(), res);

    expect(status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, processed: 0 }),
    );
    expect(recordOrgQueueRunResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded' }),
    );
  });
});
