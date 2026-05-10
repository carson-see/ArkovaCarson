import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => {
  const _mockAnchorSingle = vi.fn();
  const _mockMembershipSingle = vi.fn();
  const _mockInsert = vi.fn().mockResolvedValue({ error: null });
  const _mockRpc = vi.fn().mockResolvedValue({ error: null });
  return {
    db: {
      from: vi.fn((table: string) => {
        if (table === 'anchors') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: _mockAnchorSingle,
          };
        }
        if (table === 'memberships') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: _mockMembershipSingle,
          };
        }
        return { insert: _mockInsert };
      }),
      rpc: _mockRpc,
    },
    __mockAnchorSingle: _mockAnchorSingle,
    __mockMembershipSingle: _mockMembershipSingle,
    __mockRpc: _mockRpc,
    __mockInsert: _mockInsert,
  };
});

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../notifications/dispatcher.js', () => ({
  emitNotification: vi.fn(),
}));

// SCRUM-1800 (SCRUM-1743 Phase 2c): the revoke endpoint now dispatches
// anchor.revoked + credential.status_changed webhooks. Mock so we can assert
// payloads + best-effort failure handling without contacting the delivery
// system. Hoisted because vi.mock factories run before top-level statements.
const { mockDispatchWebhookEvent } = vi.hoisted(() => ({
  mockDispatchWebhookEvent: vi.fn(),
}));
vi.mock('../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

import express from 'express';
import request from 'supertest';
import { anchorRevokeRouter } from './anchor-revoke.js';

const {
  __mockAnchorSingle: mockAnchorSingle,
  __mockMembershipSingle: mockMembershipSingle,
  __mockRpc: mockRpc,
  __mockInsert: mockInsert,
} = await import('../utils/db.js') as any;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).userId = 'u1';
    next();
  });
  app.use('/api/anchor', anchorRevokeRouter);
  return app;
}

describe('POST /api/anchor/:id/revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnchorSingle.mockResolvedValue({
      // v4 UUID (zod v4 strict UUID validator from SCRUM-1801) + my extra
      // SCRUM-1800 fields (public_id, credential_type, chain_tx_id,
      // chain_block_height) needed for the revoke endpoint's webhook emit.
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        public_id: 'ARK-PUB-1',
        status: 'SECURED',
        org_id: 'org1',
        user_id: 'u1',
        credential_type: 'DEGREE',
        chain_tx_id: 'tx-abc',
        chain_block_height: 200100,
      },
      error: null,
    });
    mockMembershipSingle.mockResolvedValue({
      data: { role: 'ORG_ADMIN' },
      error: null,
    });
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
  });

  it('revokes a SECURED anchor', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Document expired' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('REVOKED');
    expect(mockRpc).toHaveBeenCalledWith('revoke_anchor', {
      anchor_id: '11111111-1111-4111-8111-111111111111',
      reason: 'Document expired',
    });
  });

  it('rejects missing reason', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({});

    expect(res.status).toBe(400);
  });

  it('rejects non-SECURED anchor', async () => {
    mockAnchorSingle.mockResolvedValueOnce({
      data: { id: '11111111-1111-4111-8111-111111111111', status: 'PENDING', org_id: 'org1', user_id: 'u1' },
      error: null,
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(409);
  });

  it('returns 404 for missing anchor', async () => {
    mockAnchorSingle.mockResolvedValueOnce({ data: null, error: { message: 'not found' } });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/22222222-2222-4222-8222-222222222222/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(404);
  });

  it('returns 400 for non-UUID anchor id', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/not-a-uuid/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(mockAnchorSingle).not.toHaveBeenCalled();
  });

  it('returns 404 for orphan anchor (org_id null)', async () => {
    mockAnchorSingle.mockResolvedValueOnce({
      data: { id: '11111111-1111-4111-8111-111111111111', status: 'SECURED', org_id: null, user_id: 'u1' },
      error: null,
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect(mockMembershipSingle).not.toHaveBeenCalled();
  });

  it('returns 404 for anchor in another org', async () => {
    mockMembershipSingle.mockResolvedValueOnce({ data: null, error: null });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/anchor', anchorRevokeRouter);

    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(401);
  });

  it('returns 500 on RPC failure', async () => {
    mockRpc.mockResolvedValueOnce({ error: { message: 'RPC failed' } });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(500);
  });

  // ---- SCRUM-1800 (SCRUM-1743 Phase 2c): webhook emits ----

  it('dispatches anchor.revoked webhook with the revocation payload', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Document expired' });

    expect(res.status).toBe(200);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org1',
      'anchor.revoked',
      'ARK-PUB-1',
      expect.objectContaining({
        public_id: 'ARK-PUB-1',
        status: 'REVOKED',
        chain_tx_id: 'tx-abc',
        chain_block_height: 200100,
        revocation_reason: 'Document expired',
      }),
    );
  });

  it('dispatches credential.status_changed when credential_type is present', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Issued in error' });

    expect(res.status).toBe(200);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org1',
      'credential.status_changed',
      'ARK-PUB-1',
      expect.objectContaining({
        public_id: 'ARK-PUB-1',
        credential_type: 'DEGREE',
        previous_status: 'SECURED',
        new_status: 'REVOKED',
        reason: 'Issued in error',
      }),
    );
  });

  it('skips credential.status_changed when credential_type is null but still emits anchor.revoked', async () => {
    mockAnchorSingle.mockResolvedValueOnce({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        public_id: 'ARK-PUB-1',
        status: 'SECURED',
        org_id: 'org1',
        user_id: 'u1',
        credential_type: null,
        chain_tx_id: 'tx-abc',
        chain_block_height: 200100,
      },
      error: null,
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Not a credential' });

    expect(res.status).toBe(200);

    const calls = mockDispatchWebhookEvent.mock.calls;
    const eventTypes = calls.map((c: unknown[]) => c[1]);
    expect(eventTypes).toContain('anchor.revoked');
    expect(eventTypes).not.toContain('credential.status_changed');
  });

  it('still returns 200 when anchor.revoked webhook dispatch throws (best-effort)', async () => {
    mockDispatchWebhookEvent.mockImplementationOnce(() => {
      throw new Error('webhook system down');
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Test' });

    // RPC succeeded, anchor is REVOKED in DB; webhook failure must not 500.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('still returns 200 when credential.status_changed dispatch throws (best-effort)', async () => {
    mockDispatchWebhookEvent
      .mockResolvedValueOnce(undefined) // anchor.revoked succeeds
      .mockImplementationOnce(() => {
        throw new Error('credential webhook down');
      });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // ---- SCRUM-1800: audit_events rows for emit-decision tracking ----

  it('writes a credential.status_changed audit row with dispatch outcome', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Test reason' });

    expect(res.status).toBe(200);

    // mockInsert is shared between the existing anchor.revoked audit and the
    // new emit-decision rows. Assert that a credential.status_changed row was
    // inserted with `dispatched: true` and the correct status transition.
    const calls = mockInsert.mock.calls.map((c: unknown[]) => c[0]);
    const credRow = calls.find(
      (row: any) => row?.event_type === 'credential.status_changed',
    );
    expect(credRow).toBeDefined();
    expect(credRow.org_id).toBe('org1');
    expect(credRow.target_id).toBe('11111111-1111-4111-8111-111111111111');
    const details = JSON.parse(credRow.details);
    expect(details.dispatched).toBe(true);
    expect(details.previous_status).toBe('SECURED');
    expect(details.new_status).toBe('REVOKED');
    expect(details.reason).toBe('Test reason');
  });

  it('writes an anchor.revoked.dispatched audit row capturing webhook failure', async () => {
    mockDispatchWebhookEvent.mockImplementationOnce(() => {
      throw new Error('webhook system down');
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(200);

    const calls = mockInsert.mock.calls.map((c: unknown[]) => c[0]);
    const dispatchRow = calls.find(
      (row: any) => row?.event_type === 'anchor.revoked.dispatched',
    );
    expect(dispatchRow).toBeDefined();
    const details = JSON.parse(dispatchRow.details);
    expect(details.dispatched).toBe(false);
    expect(details.dispatch_error).toBe('webhook system down');
  });

  it('does not dispatch any webhooks when anchor has no public_id', async () => {
    mockAnchorSingle.mockResolvedValueOnce({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        public_id: null,
        status: 'SECURED',
        org_id: 'org1',
        user_id: 'u1',
        credential_type: 'DEGREE',
        chain_tx_id: 'tx-abc',
        chain_block_height: 200100,
      },
      error: null,
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-4111-8111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(200);
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });
});
