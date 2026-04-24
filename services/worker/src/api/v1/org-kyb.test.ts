/**
 * Org KYB route tests (SCRUM-1162)
 *
 * Covers the happy path, no-config-503, upstream-failure, RPC-failure, and
 * input-validation branches. No live network — Middesk client is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({
  db: {
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../integrations/kyb/middesk.js', async () => {
  const actual = await vi.importActual<typeof import('../../integrations/kyb/middesk.js')>(
    '../../integrations/kyb/middesk.js',
  );
  return {
    ...actual,
    submitBusiness: vi.fn(),
  };
});

import { db } from '../../utils/db.js';
import {
  submitBusiness,
  MiddeskApiError,
  MiddeskConfigError,
} from '../../integrations/kyb/middesk.js';
import { orgKybRouter } from './org-kyb.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDb = db as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSubmit = submitBusiness as any;

const VALID_ORG_ID = '00000000-0000-0000-0000-000000000001';
const VALID_PAYLOAD = {
  legal_name: 'Arkova Inc',
  ein: '123456789',
  address: {
    line1: '1 Market St',
    city: 'San Francisco',
    state: 'CA',
    postal_code: '94105',
  },
};

function createApp(userId: string | null = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (userId) {
      (req as unknown as { userId: string }).userId = userId;
    }
    next();
  });
  app.use('/api/v1/org-kyb', orgKybRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/org-kyb/:orgId/start', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = createApp(null);
    const res = await request(app)
      .post(`/api/v1/org-kyb/${VALID_ORG_ID}/start`)
      .send(VALID_PAYLOAD);
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid orgId', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/org-kyb/not-a-uuid/start')
      .send(VALID_PAYLOAD);
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid EIN', async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/v1/org-kyb/${VALID_ORG_ID}/start`)
      .send({ ...VALID_PAYLOAD, ein: '12-3456789' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when address is missing required fields', async () => {
    const app = createApp();
    const { address: _, ...withoutAddress } = VALID_PAYLOAD;
    const res = await request(app)
      .post(`/api/v1/org-kyb/${VALID_ORG_ID}/start`)
      .send(withoutAddress);
    expect(res.status).toBe(400);
  });

  it('returns 503 when MiddeskConfigError thrown (missing API key)', async () => {
    mockSubmit.mockRejectedValueOnce(new MiddeskConfigError('MIDDESK_API_KEY not set'));
    const app = createApp();
    const res = await request(app)
      .post(`/api/v1/org-kyb/${VALID_ORG_ID}/start`)
      .send(VALID_PAYLOAD);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('kyb_unavailable');
  });

  it('forwards 4xx from Middesk upstream', async () => {
    mockSubmit.mockRejectedValueOnce(
      new MiddeskApiError('rejected', 422, { reason: 'bad_ein' }),
    );
    const app = createApp();
    const res = await request(app)
      .post(`/api/v1/org-kyb/${VALID_ORG_ID}/start`)
      .send(VALID_PAYLOAD);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('kyb_upstream_error');
  });

  it('returns 502 on Middesk 5xx', async () => {
    mockSubmit.mockRejectedValueOnce(new MiddeskApiError('boom', 502, null));
    const app = createApp();
    const res = await request(app)
      .post(`/api/v1/org-kyb/${VALID_ORG_ID}/start`)
      .send(VALID_PAYLOAD);
    expect(res.status).toBe(502);
  });

  it('returns 202 + reference_id on happy path', async () => {
    mockSubmit.mockResolvedValueOnce({
      id: 'biz_123',
      external_id: VALID_ORG_ID,
    });
    mockDb.rpc.mockResolvedValueOnce({ data: { success: true }, error: null });

    const app = createApp();
    const res = await request(app)
      .post(`/api/v1/org-kyb/${VALID_ORG_ID}/start`)
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(202);
    expect(res.body.reference_id).toBe('biz_123');
    expect(mockDb.rpc).toHaveBeenCalledWith('start_kyb_verification', {
      p_org_id: VALID_ORG_ID,
      p_provider: 'middesk',
      p_reference_id: 'biz_123',
    });
  });

  it('returns 202 with warning when RPC fails after vendor submit', async () => {
    mockSubmit.mockResolvedValueOnce({ id: 'biz_9', external_id: VALID_ORG_ID });
    mockDb.rpc.mockResolvedValueOnce({ data: null, error: { message: 'rls_denied' } });

    const app = createApp();
    const res = await request(app)
      .post(`/api/v1/org-kyb/${VALID_ORG_ID}/start`)
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(202);
    expect(res.body.reference_id).toBe('biz_9');
    expect(res.body.warning).toContain('Arkova state update failed');
  });
});

describe('GET /api/v1/org-kyb/:orgId/status', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = createApp(null);
    const res = await request(app).get(`/api/v1/org-kyb/${VALID_ORG_ID}/status`);
    expect(res.status).toBe(401);
  });

  it('returns 404 when org not visible', async () => {
    const mockFrom = vi.fn().mockReturnThis();
    const mockSelect = vi.fn().mockReturnThis();
    const mockEq = vi.fn().mockReturnThis();
    const mockMaybeSingle = vi.fn().mockResolvedValueOnce({ data: null, error: null });

    mockDb.from.mockImplementationOnce(() => ({
      select: mockSelect.mockReturnThis(),
      eq: mockEq.mockReturnThis(),
      maybeSingle: mockMaybeSingle,
    }));

    const app = createApp();
    const res = await request(app).get(`/api/v1/org-kyb/${VALID_ORG_ID}/status`);
    expect(res.status).toBe(404);
  });

  it('returns 200 with org + events on happy path', async () => {
    const orgRow = {
      id: VALID_ORG_ID,
      verification_status: 'PENDING',
      kyb_provider: 'middesk',
      kyb_submitted_at: '2026-04-24T00:00:00Z',
      kyb_completed_at: null,
    };

    let callCount = 0;
    mockDb.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // organizations lookup
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValueOnce({ data: orgRow, error: null }),
        };
      }
      // kyb_events lookup
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValueOnce({
          data: [{ event_type: 'kyb.submitted', status: 'submitted', created_at: '2026-04-24T00:00:00Z' }],
          error: null,
        }),
      };
    });

    const app = createApp();
    const res = await request(app).get(`/api/v1/org-kyb/${VALID_ORG_ID}/status`);

    expect(res.status).toBe(200);
    expect(res.body.org_id).toBe(VALID_ORG_ID);
    expect(res.body.verification_status).toBe('PENDING');
    expect(res.body.recent_events).toHaveLength(1);
  });
});
