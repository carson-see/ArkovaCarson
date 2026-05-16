/**
 * SCRUM-1971 — Version Resolution API Tests
 *
 * POST /api/v1/versions/:versionId/resolve
 * Validates: approve → PENDING anchor, skip → resolved, flag → escalation
 * Auth: admin-only, 403 for non-admin, 404 for missing version
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockDbFrom, mockEmitNotifications } = vi.hoisted(() => {
  const mockDbFrom = vi.fn();
  const mockEmitNotifications = vi.fn();
  return { mockDbFrom, mockEmitNotifications };
});

vi.mock('../utils/db.js', () => ({
  db: { from: mockDbFrom },
}));

vi.mock('../notifications/dispatcher.js', () => ({
  emitOrgAdminNotifications: mockEmitNotifications,
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeChainable(result: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proxy: any = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (res: (v: unknown) => void) => res(result);
      return vi.fn(() => proxy);
    },
  });
  return proxy;
}

import { versionResolutionRouter } from './version-resolution.js';

function createApp(userId?: string, orgRole?: string) {
  const app = express();
  app.use(express.json());
  // Simulate auth middleware
  app.use((req, _res, next) => {
    (req as any).userId = userId;
    (req as any).orgRole = orgRole;
    next();
  });
  app.use('/api/v1/versions', versionResolutionRouter);
  return app;
}

describe('POST /api/v1/versions/:versionId/resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when no userId in request', async () => {
    const app = createApp(undefined);
    const res = await request(app)
      .post('/api/v1/versions/33333333-3333-4333-8333-333333333333/resolve')
      .send({ decision: 'approve' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid versionId (not UUID)', async () => {
    const app = createApp('user-1', 'admin');
    const res = await request(app)
      .post('/api/v1/versions/not-a-uuid/resolve')
      .send({ decision: 'approve' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid decision value', async () => {
    const app = createApp('user-1', 'admin');
    const res = await request(app)
      .post('/api/v1/versions/33333333-3333-4333-8333-333333333333/resolve')
      .send({ decision: 'reject' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when version not found', async () => {
    const app = createApp('user-1', 'admin');
    mockDbFrom.mockReturnValue(makeChainable({ data: null, error: null }));

    const res = await request(app)
      .post('/api/v1/versions/33333333-3333-4333-8333-333333333333/resolve')
      .send({ decision: 'approve' });
    expect(res.status).toBe(404);
  });

  it('returns 403 when user is not admin/owner of the org', async () => {
    const app = createApp('user-1', 'member');

    // First call: fetch version
    let callCount = 0;
    mockDbFrom.mockImplementation((table: string) => {
      callCount++;
      if (table === 'external_document_versions' && callCount === 1) {
        return makeChainable({
          data: { id: 'v-1', org_id: 'org-1', status: 'pending_review', fingerprint: 'a'.repeat(64), external_file_id: 'file-1' },
          error: null,
        });
      }
      if (table === 'org_members') {
        return makeChainable({ data: null, error: null });
      }
      return makeChainable({ data: null, error: null });
    });

    const res = await request(app)
      .post('/api/v1/versions/33333333-3333-4333-8333-333333333333/resolve')
      .send({ decision: 'approve' });
    expect(res.status).toBe(403);
  });

  it('approve creates a PENDING anchor and marks version as approved', async () => {
    const app = createApp('user-1', 'admin');

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'external_document_versions') {
        return makeChainable({
          data: { id: 'v-1', org_id: 'org-1', status: 'pending_review', fingerprint: 'a'.repeat(64), external_file_id: 'file-1', filename: 'doc.pdf' },
          error: null,
        });
      }
      if (table === 'org_members') {
        return makeChainable({ data: { role: 'admin' }, error: null });
      }
      if (table === 'version_reviews') {
        return makeChainable({ data: { id: 'review-1' }, error: null });
      }
      if (table === 'anchors') {
        return makeChainable({ data: { id: 'anchor-new' }, error: null });
      }
      return makeChainable({ data: null, error: null });
    });

    const res = await request(app)
      .post('/api/v1/versions/33333333-3333-4333-8333-333333333333/resolve')
      .send({ decision: 'approve' });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('approve');
    expect(mockDbFrom).toHaveBeenCalledWith('anchors');
    expect(mockDbFrom).toHaveBeenCalledWith('version_reviews');
  });

  it('skip marks version as skipped without creating anchor', async () => {
    const app = createApp('user-1', 'admin');

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'external_document_versions') {
        return makeChainable({
          data: { id: 'v-1', org_id: 'org-1', status: 'pending_review', fingerprint: 'a'.repeat(64), external_file_id: 'file-1' },
          error: null,
        });
      }
      if (table === 'org_members') {
        return makeChainable({ data: { role: 'admin' }, error: null });
      }
      if (table === 'version_reviews') {
        return makeChainable({ data: { id: 'review-1' }, error: null });
      }
      return makeChainable({ data: null, error: null });
    });

    const res = await request(app)
      .post('/api/v1/versions/33333333-3333-4333-8333-333333333333/resolve')
      .send({ decision: 'skip' });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('skip');
  });

  it('flag emits notification and marks version as flagged', async () => {
    const app = createApp('user-1', 'admin');

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'external_document_versions') {
        return makeChainable({
          data: { id: 'v-1', org_id: 'org-1', status: 'pending_review', fingerprint: 'a'.repeat(64), external_file_id: 'file-1' },
          error: null,
        });
      }
      if (table === 'org_members') {
        return makeChainable({ data: { role: 'owner' }, error: null });
      }
      if (table === 'version_reviews') {
        return makeChainable({ data: { id: 'review-1' }, error: null });
      }
      return makeChainable({ data: null, error: null });
    });

    const res = await request(app)
      .post('/api/v1/versions/33333333-3333-4333-8333-333333333333/resolve')
      .send({ decision: 'flag', notes: 'Needs legal review' });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('flag');
    expect(mockEmitNotifications).toHaveBeenCalled();
  });
});

describe('GET /api/v1/versions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when no userId in request', async () => {
    const app = createApp(undefined);
    const res = await request(app).get('/api/v1/versions');
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no org membership', async () => {
    const app = createApp('user-1');
    mockDbFrom.mockReturnValue(makeChainable({ data: null, error: null }));

    const res = await request(app).get('/api/v1/versions');
    expect(res.status).toBe(403);
  });

  it('returns versions for the user org', async () => {
    const app = createApp('user-1');
    const versions = [
      { id: 'v-1', org_id: 'org-1', filename: 'contract.pdf', source: 'docusign', status: 'pending_review' },
      { id: 'v-2', org_id: 'org-1', filename: 'offer.pdf', source: 'google_drive', status: 'pending_review' },
    ];

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'org_members') {
        return makeChainable({ data: { org_id: 'org-1', role: 'admin' }, error: null });
      }
      if (table === 'external_document_versions') {
        return makeChainable({ data: versions, error: null });
      }
      return makeChainable({ data: null, error: null });
    });

    const res = await request(app).get('/api/v1/versions');
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(2);
    expect(res.body.versions[0].filename).toBe('contract.pdf');
  });

  it('filters by status query param', async () => {
    const app = createApp('user-1');

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'org_members') {
        return makeChainable({ data: { org_id: 'org-1', role: 'admin' }, error: null });
      }
      if (table === 'external_document_versions') {
        return makeChainable({ data: [], error: null });
      }
      return makeChainable({ data: null, error: null });
    });

    const res = await request(app).get('/api/v1/versions?status=pending_review');
    expect(res.status).toBe(200);
    expect(res.body.versions).toEqual([]);
  });
});
