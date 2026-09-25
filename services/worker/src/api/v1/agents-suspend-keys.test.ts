/**
 * `PATCH /api/v1/agents/:agentId {status}` — org-side suspension must actually
 * stop the agent (SCRUM-5290).
 *
 * The auth path reads ONLY `api_keys` (`middleware/apiKeyAuth.ts` selects
 * is_active / revoked_at / expires_at and never joins `agents`), so recording
 * `agents.status = 'suspended'` without touching the keys left the agent fully
 * able to authenticate. An org admin who suspended an agent believed it had
 * stopped acting; it had not. `services/worker/src/api/v1/agents.md` recorded
 * this as known-and-unfixed ("org-side suspension is decorative today").
 *
 * The ComputeID-driven path already got this right via migration 0448's
 * `apply_computeid_agent_transition`, whose TLA+ invariant is `suspendedHasNoKey`.
 * This suite holds the admin path to the same invariant.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainableBuilder as builder, routeDbTables } from '../../test-utils/chainable-builder.js';

const dbFromMock = vi.fn();
vi.mock('../../utils/db.js', () => ({ db: { from: (...args: unknown[]) => dbFromMock(...args), rpc: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../utils/auditEvent.js', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import { agentsRouter } from './agents.js';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { authUserId: string }).authUserId = USER_ID; next(); });
  app.use('/api/v1/agents', agentsRouter);
  return app;
}

const activeRow = { id: AGENT_ID, org_id: ORG_ID, name: 'a', status: 'active', allowed_scopes: ['verify'] };
const suspendedRow = { ...activeRow, status: 'suspended' };

function setup(agentRows: { data?: unknown; error?: unknown }[]) {
  const agents = builder(agentRows);
  const apiKeys = builder({ data: null });
  routeDbTables(dbFromMock, {
    profiles: builder({ data: { org_id: ORG_ID, role: 'ORG_ADMIN' } }),
    agents,
    api_keys: apiKeys,
  });
  return { agents, apiKeys };
}

beforeEach(() => { vi.clearAllMocks(); dbFromMock.mockReset(); });

describe('PATCH {status:"suspended"} — the keys must stop working', () => {
  it('deactivates the agent\'s active keys, scoped to the org', async () => {
    const { apiKeys } = setup([{ data: activeRow }, { data: suspendedRow }]);
    const res = await request(createApp()).patch(`/api/v1/agents/${AGENT_ID}`).send({ status: 'suspended' });

    expect(res.status).toBe(200);
    expect(apiKeys.update).toHaveBeenCalledWith(expect.objectContaining({
      is_active: false,
      // Distinct from the RPC's 'computeid:…' marker so an admin resume can
      // never resurrect a key ComputeID suspended (that would be an escalation).
      revocation_reason: 'admin:agent.suspended',
    }));
    // Defense-in-depth against an agent_id collision revoking another tenant.
    expect(apiKeys.eq).toHaveBeenCalledWith('agent_id', AGENT_ID);
    expect(apiKeys.eq).toHaveBeenCalledWith('org_id', ORG_ID);
    expect(apiKeys.eq).toHaveBeenCalledWith('is_active', true);
  });

  it('reactivates ONLY admin-suspended keys when the agent is resumed', async () => {
    const { apiKeys } = setup([{ data: suspendedRow }, { data: activeRow }]);
    const res = await request(createApp()).patch(`/api/v1/agents/${AGENT_ID}`).send({ status: 'active' });

    expect(res.status).toBe(200);
    expect(apiKeys.update).toHaveBeenCalledWith(expect.objectContaining({
      is_active: true, revoked_at: null, revocation_reason: null,
    }));
    // The marker predicate is what stops an org admin undoing a partner
    // suspension — mirrors 0448's reactivate branch.
    expect(apiKeys.eq).toHaveBeenCalledWith('revocation_reason', 'admin:agent.suspended');
  });

  it('leaves keys alone for a non-status edit', async () => {
    const { apiKeys } = setup([{ data: activeRow }, { data: { ...activeRow, name: 'renamed' } }]);
    const res = await request(createApp()).patch(`/api/v1/agents/${AGENT_ID}`).send({ name: 'renamed' });

    expect(res.status).toBe(200);
    expect(apiKeys.update).not.toHaveBeenCalled();
  });

  it('leaves keys DEACTIVATED when the suspend status write fails', async () => {
    const { apiKeys } = setup([{ data: activeRow }, { data: null, error: { message: 'boom' } }]);
    const res = await request(createApp()).patch(`/api/v1/agents/${AGENT_ID}`).send({ status: 'suspended' });

    expect(res.status).toBe(404);
    // Keys go first by design, so this failure leaves dead keys and a stale
    // 'active' status. That is the safe direction: the agent cannot act, and a
    // retry completes the suspension. Asserting the opposite would be asserting
    // the original defect.
    expect(apiKeys.update).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
  });

  it('does not touch keys when a RESUME status write fails', async () => {
    const { apiKeys } = setup([{ data: suspendedRow }, { data: null, error: { message: 'boom' } }]);
    const res = await request(createApp()).patch(`/api/v1/agents/${AGENT_ID}`).send({ status: 'active' });

    expect(res.status).toBe(404);
    // Resume grants access, so it must come LAST — a failed status write must
    // never hand a live key back.
    expect(apiKeys.update).not.toHaveBeenCalled();
  });

  // ORDER IS THE DESIGN. These are two round-trips, so a crash between them is
  // reachable; the order decides whether the intermediate state fails closed.
  it('deactivates keys BEFORE touching status, so a key failure leaves the agent unsuspended', async () => {
    const agents = builder([{ data: activeRow }, { data: suspendedRow }]);
    const apiKeys = builder({ data: null, error: { message: 'key write blew up' } });
    routeDbTables(dbFromMock, {
      profiles: builder({ data: { org_id: ORG_ID, role: 'ORG_ADMIN' } }),
      agents,
      api_keys: apiKeys,
    });

    const res = await request(createApp()).patch(`/api/v1/agents/${AGENT_ID}`).send({ status: 'suspended' });

    expect(res.status).toBe(500);
    // The proof of ordering: the status write never happened. Had it run first,
    // this would be a suspended agent holding live keys — the original defect.
    expect(agents.update).not.toHaveBeenCalled();
  });

  it('restores status BEFORE keys on resume, so a key failure leaves the agent keyless', async () => {
    const agents = builder([{ data: suspendedRow }, { data: activeRow }]);
    const apiKeys = builder({ data: null, error: { message: 'key write blew up' } });
    routeDbTables(dbFromMock, {
      profiles: builder({ data: { org_id: ORG_ID, role: 'ORG_ADMIN' } }),
      agents,
      api_keys: apiKeys,
    });

    const res = await request(createApp()).patch(`/api/v1/agents/${AGENT_ID}`).send({ status: 'active' });

    expect(res.status).toBe(500);
    // Status moved, keys did not: the agent still cannot authenticate, which is
    // the safe direction. The reverse would hand back a live key to an agent
    // whose status change had not committed.
    expect(agents.update).toHaveBeenCalled();
  });
});
