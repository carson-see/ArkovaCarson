/**
 * SCRUM-3867 — DocuSign connection inheritance, write path.
 *
 * Pre-mortem F5: migration 0328 added `org_integrations.inherited_from_org_id`,
 * the resolver, the webhook and queue reconciliation all READ it — and nothing
 * in the codebase has ever WRITTEN one. Production has zero markers. These
 * endpoints are the missing write path.
 *
 * Authorization is on the PARENT, not the child. A marker makes the sub-org's
 * envelopes run on the parent's DocuSign credentials, so the party lending
 * something is the parent; the child only receives a capability. Same shape as
 * credit allocation, where the parent admin acts on the child.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The module imports the shared client for its default; loading it for real
// would validate the whole worker config. Every router in this folder is
// dependency-injected for exactly this reason — the tests pass their own db.
vi.mock('../../../utils/db.js', () => ({ db: {} }));
vi.mock('../../../config.js', () => ({ config: {} }));

import { createDocusignInheritanceRouter } from './docusign-inheritance.js';

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';

interface Fixture {
  /** organizations rows keyed by id */
  orgs?: Record<string, { parent_org_id: string | null }>;
  /** org_members rows: `${userId}:${orgId}` -> role */
  members?: Record<string, string>;
  /** live org_integrations docusign rows keyed by org_id */
  integrations?: Record<string, { id: string; inherited_from_org_id: string | null }>;
  orgsError?: boolean;
}

/** Minimal supabase-shaped stub covering only the queries this router issues. */
function makeDb(fx: Fixture) {
  const inserted: Record<string, unknown>[] = [];
  const updated: { id: string; patch: Record<string, unknown> }[] = [];

  const db = {
    from(table: string) {
      if (table === 'organizations') {
        let id = '';
        const chain = {
          select: () => chain,
          eq: (_c: string, v: string) => { id = v; return chain; },
          maybeSingle: async () =>
            fx.orgsError
              ? { data: null, error: { message: 'boom' } }
              : { data: fx.orgs?.[id] ?? null, error: null },
        };
        return chain;
      }
      if (table === 'org_members') {
        let userId = '';
        let orgId = '';
        const chain = {
          select: () => chain,
          eq: (col: string, v: string) => {
            if (col === 'user_id') userId = v; else orgId = v;
            return chain;
          },
          maybeSingle: async () => ({
            data: fx.members?.[`${userId}:${orgId}`]
              ? { role: fx.members[`${userId}:${orgId}`] }
              : null,
            error: null,
          }),
        };
        return chain;
      }
      if (table === 'org_integrations') {
        let orgId = '';
        const chain = {
          select: () => chain,
          eq: (col: string, v: string) => { if (col === 'org_id') orgId = v; return chain; },
          is: () => chain,
          maybeSingle: async () => ({ data: fx.integrations?.[orgId] ?? null, error: null }),
          insert: (row: Record<string, unknown>) => {
            inserted.push(row);
            return {
              select: () => ({
                single: async () => ({ data: { id: 'marker-1', ...row }, error: null }),
              }),
            };
          },
          update: (patch: Record<string, unknown>) => {
            const upd = {
              eq: (col: string, v: string) => {
                if (col === 'id') updated.push({ id: v, patch });
                return upd;
              },
              select: () => ({ maybeSingle: async () => ({ data: { id: 'marker-1' }, error: null }) }),
            };
            return upd;
          },
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, inserted, updated };
}

function buildApp(fx: Fixture, userId?: string) {
  const { db, inserted, updated } = makeDb(fx);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) (req as unknown as { userId: string }).userId = userId;
    next();
  });
  app.use('/api/v1/integrations', createDocusignInheritanceRouter({ db }));
  return { app, inserted, updated };
}

/** The ordinary happy-path world: CHILD under PARENT, PARENT connected. */
const CONNECTED: Fixture = {
  orgs: { [CHILD]: { parent_org_id: PARENT }, [PARENT]: { parent_org_id: null } },
  members: { [`${ADMIN}:${PARENT}`]: 'owner' },
  integrations: { [PARENT]: { id: 'int-parent', inherited_from_org_id: null } },
};

describe('POST /docusign/inherit (SCRUM-3867)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401s without a session', async () => {
    const { app } = buildApp(CONNECTED);
    const res = await request(app).post('/api/v1/integrations/docusign/inherit').send({ org_id: CHILD });
    expect(res.status).toBe(401);
  });

  it('400s on a body that is not a uuid', async () => {
    const { app } = buildApp(CONNECTED, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: 'nope' });
    expect(res.status).toBe(400);
  });

  it('creates a credential-free marker pointing at the parent', async () => {
    const { app, inserted } = buildApp(CONNECTED, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });

    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      org_id: CHILD,
      provider: 'docusign',
      inherited_from_org_id: PARENT,
      // 0328's CHECK constraint: a marker carries no credentials of its own.
      account_id: null,
      encrypted_tokens: null,
      token_secret_name: null,
    });
  });

  it('403s a caller who administers the child but not the parent', async () => {
    // The parent is lending its credentials, so the parent authorizes. A child
    // admin must not be able to help themselves to the parent's connection.
    const { app, inserted } = buildApp({
      ...CONNECTED,
      members: { [`${ADMIN}:${CHILD}`]: 'owner' },
    }, ADMIN);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });

    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('403s a non-admin member of the parent', async () => {
    const { app } = buildApp({
      ...CONNECTED,
      members: { [`${ADMIN}:${PARENT}`]: 'member' },
    }, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });
    expect(res.status).toBe(403);
  });

  it('409s when the target org has no parent', async () => {
    const { app } = buildApp({
      ...CONNECTED,
      orgs: { [CHILD]: { parent_org_id: null } },
    }, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_a_sub_org');
  });

  it('409s when the parent has no DocuSign connection to lend', async () => {
    const { app, inserted } = buildApp({ ...CONNECTED, integrations: {} }, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('parent_not_connected');
    expect(inserted).toHaveLength(0);
  });

  it('409s rather than chaining when the parent is itself inheriting', async () => {
    // The resolver refuses to chain, so a marker pointing at a marker would be
    // a connection that silently resolves to nothing.
    const { app, inserted } = buildApp({
      ...CONNECTED,
      integrations: { [PARENT]: { id: 'int-parent', inherited_from_org_id: OTHER } },
    }, ADMIN);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('parent_inherits');
    expect(inserted).toHaveLength(0);
  });

  it('409s when the child already holds its own connection', async () => {
    const { app, inserted } = buildApp({
      ...CONNECTED,
      integrations: {
        [PARENT]: { id: 'int-parent', inherited_from_org_id: null },
        [CHILD]: { id: 'int-child', inherited_from_org_id: null },
      },
    }, ADMIN);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_connected');
    expect(inserted).toHaveLength(0);
  });

  it('is idempotent when the marker already exists', async () => {
    const { app, inserted } = buildApp({
      ...CONNECTED,
      integrations: {
        [PARENT]: { id: 'int-parent', inherited_from_org_id: null },
        [CHILD]: { id: 'marker-1', inherited_from_org_id: PARENT },
      },
    }, ADMIN);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });

    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(0);
  });

  it('503s when the org lookup fails, rather than reading as not-a-sub-org', async () => {
    const { app } = buildApp({ ...CONNECTED, orgsError: true }, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });
    expect(res.status).toBe(503);
  });
});

describe('POST /docusign/inherit/stop (SCRUM-3867)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('revokes the marker', async () => {
    const { app, updated } = buildApp({
      ...CONNECTED,
      integrations: {
        [PARENT]: { id: 'int-parent', inherited_from_org_id: null },
        [CHILD]: { id: 'marker-1', inherited_from_org_id: PARENT },
      },
    }, ADMIN);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit/stop')
      .send({ org_id: CHILD });

    expect(res.status).toBe(200);
    expect(updated).toHaveLength(1);
    expect(updated[0].patch).toHaveProperty('revoked_at');
  });

  it('404s when there is no marker to stop', async () => {
    const { app, updated } = buildApp(CONNECTED, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit/stop')
      .send({ org_id: CHILD });
    expect(res.status).toBe(404);
    expect(updated).toHaveLength(0);
  });

  it('refuses to revoke an org OWN connection through this endpoint', async () => {
    // Disconnecting a real connection is /docusign/disconnect's job — it also
    // deletes the refresh-token secret. Revoking it here would orphan that
    // secret in Secret Manager.
    const { app, updated } = buildApp({
      ...CONNECTED,
      integrations: {
        [PARENT]: { id: 'int-parent', inherited_from_org_id: null },
        [CHILD]: { id: 'int-child', inherited_from_org_id: null },
      },
    }, ADMIN);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit/stop')
      .send({ org_id: CHILD });

    expect(res.status).toBe(404);
    expect(updated).toHaveLength(0);
  });
});
