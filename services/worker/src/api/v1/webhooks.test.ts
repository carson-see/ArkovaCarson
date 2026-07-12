import express, { type Request } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDeadLetterEntries = vi.fn();
const mockResolveDlqEntry = vi.fn();

vi.mock('../../webhooks/delivery.js', () => ({
  getDeadLetterEntries: mockGetDeadLetterEntries,
  isPrivateUrlResolved: vi.fn(),
  replayDelivery: vi.fn(),
  resolveDlqEntry: mockResolveDlqEntry,
  signPayload: vi.fn(() => 'sig-test'),
}));

const mockDbFrom = vi.fn();

vi.mock('../../utils/db.js', () => ({
  db: {
    from: mockDbFrom,
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const { webhooksRouter } = await import('./webhooks.js');

function buildApp(apiKey: Request['apiKey'] | null = {
  keyId: 'key-1',
  keyPrefix: 'ak_test',
  orgId: 'org-001',
  userId: 'user-001',
  scopes: ['webhooks:manage'],
  rateLimitTier: 'paid',
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (apiKey) req.apiKey = apiKey;
    next();
  });
  app.use('/api/v1/webhooks', webhooksRouter);
  return app;
}

function mockProfileRole(role: string) {
  const single = vi.fn().mockResolvedValue({ data: { role }, error: null });
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  mockDbFrom.mockImplementation((table: string) => {
    if (table === 'profiles') return { select };
    if (table === 'audit_events') return { insert: vi.fn().mockResolvedValue({ error: null }) };
    return {};
  });
}

describe('webhooks self-service DLQ routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbFrom.mockReturnValue({});
    mockGetDeadLetterEntries.mockResolvedValue([
      { id: 'dlq-001', event_id: 'evt-001', resolved: false },
    ]);
    mockResolveDlqEntry.mockResolvedValue(true);
  });

  it('lists unresolved DLQ entries through the deployed /webhooks/dlq route', async () => {
    mockProfileRole('ORG_ADMIN');

    const res = await request(buildApp()).get('/api/v1/webhooks/dlq').expect(200);

    expect(mockGetDeadLetterEntries).toHaveBeenCalledWith('org-001', 50);
    expect(res.body).toEqual({
      entries: [{ id: 'dlq-001', event_id: 'evt-001', resolved: false }],
      total: 1,
    });
  });

  it('rejects non-admin API keys before listing DLQ entries', async () => {
    mockProfileRole('INDIVIDUAL');

    await request(buildApp()).get('/api/v1/webhooks/dlq').expect(403);

    expect(mockGetDeadLetterEntries).not.toHaveBeenCalled();
  });

  it('resolves a seeded DLQ entry through the deployed /webhooks/dlq/:id/resolve route', async () => {
    mockProfileRole('ORG_ADMIN');

    const res = await request(buildApp())
      .post('/api/v1/webhooks/dlq/dlq-001/resolve')
      .expect(200);

    expect(mockResolveDlqEntry).toHaveBeenCalledWith('dlq-001', 'org-001');
    expect(res.body).toEqual({ resolved: true, id: 'dlq-001' });
  });
});
