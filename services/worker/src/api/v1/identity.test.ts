/**
 * Identity Verification API Tests (IDT WS1)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { identityRouter } from './identity.js';

// Mock stripe
vi.mock('../../stripe/client.js', () => ({
  stripe: {
    identity: {
      verificationSessions: {
        create: vi.fn().mockResolvedValue({
          id: 'vs_test_123',
          client_secret: 'vs_test_secret_123',
          status: 'requires_input',
        }),
        retrieve: vi.fn().mockResolvedValue({
          id: 'vs_test_123',
          client_secret: 'vs_test_secret_123',
          status: 'requires_input',
        }),
      },
    },
  },
}));

// Mock DB (identity.ts imports db from ../../utils/db.js)
const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockEq = vi.fn();
const mockSingle = vi.fn();
const mockMaybeSingle = vi.fn();

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(() => ({
      select: mockSelect.mockReturnValue({
        eq: mockEq.mockReturnValue({
          single: mockSingle,
          maybeSingle: mockMaybeSingle,
        }),
      }),
      update: mockUpdate.mockReturnValue({
        eq: vi.fn().mockReturnValue({
          error: null,
        }),
      }),
    })),
  },
}));

// PAY-01 (SCRUM-2384): isolate the entitlement gate (own unit tests cover the
// resolver + DB read). Here we assert the endpoint surfaces its boolean.
// vi.hoisted so the spy exists when the hoisted vi.mock factory runs.
const { mockHasActiveVerified } = vi.hoisted(() => ({ mockHasActiveVerified: vi.fn() }));
vi.mock('../../billing/entitlements.js', () => ({
  hasActiveVerifiedEntitlement: mockHasActiveVerified,
}));

vi.mock('../../config.js', () => ({
  config: {
    useMocks: false,
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createApp() {
  const app = express();
  app.use(express.json());
  // Inject userId for auth
  app.use((req, _res, next) => {
    (req as unknown as { userId?: string }).userId = 'test-user-123';
    next();
  });
  app.use('/identity', identityRouter);
  return app;
}

describe('Identity API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /identity/session', () => {
    it('creates a verification session for unstarted user', async () => {
      mockSingle.mockResolvedValue({
        data: { identity_verification_status: 'unstarted', identity_verification_session_id: null },
        error: null,
      });

      const app = createApp();
      const res = await request(app).post('/identity/session').send();

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('sessionId', 'vs_test_123');
      expect(res.body).toHaveProperty('clientSecret', 'vs_test_secret_123');
    });

    it('rejects already-verified users', async () => {
      mockSingle.mockResolvedValue({
        data: { identity_verification_status: 'verified', identity_verification_session_id: 'vs_old' },
        error: null,
      });

      const app = createApp();
      const res = await request(app).post('/identity/session').send();

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Identity already verified');
    });
  });

  describe('GET /identity/status', () => {
    it('returns verification status', async () => {
      mockSingle.mockResolvedValue({
        data: { identity_verification_status: 'verified', identity_verified_at: '2026-03-26T12:00:00Z' },
        error: null,
      });

      const app = createApp();
      const res = await request(app).get('/identity/status').send();

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('verified');
      expect(res.body.verifiedAt).toBe('2026-03-26T12:00:00Z');
    });
  });

  // PAY-01 (SCRUM-2384): verified-only feature gate
  describe('GET /identity/entitlement', () => {
    it('returns entitled:true when the gate grants on the current period', async () => {
      mockMaybeSingle.mockResolvedValue({ data: { org_id: 'org-1' }, error: null });
      mockHasActiveVerified.mockResolvedValue(true);

      const app = createApp();
      const res = await request(app).get('/identity/entitlement').send();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ entitled: true });
      expect(mockHasActiveVerified).toHaveBeenCalledWith({ userId: 'test-user-123', orgId: 'org-1' });
    });

    it('returns entitled:false when the gate denies (lapsed/declined/stale period)', async () => {
      mockMaybeSingle.mockResolvedValue({ data: { org_id: null }, error: null });
      mockHasActiveVerified.mockResolvedValue(false);

      const app = createApp();
      const res = await request(app).get('/identity/entitlement').send();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ entitled: false });
      expect(mockHasActiveVerified).toHaveBeenCalledWith({ userId: 'test-user-123', orgId: null });
    });

    it('fails closed (entitled:false) when the org lookup errors', async () => {
      mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'db down' } });

      const app = createApp();
      const res = await request(app).get('/identity/entitlement').send();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ entitled: false });
      expect(mockHasActiveVerified).not.toHaveBeenCalled();
    });

    it('requires authentication', async () => {
      const app = express();
      app.use(express.json());
      app.use('/identity', identityRouter); // no userId injected
      const res = await request(app).get('/identity/entitlement').send();
      expect(res.status).toBe(401);
    });
  });
});
