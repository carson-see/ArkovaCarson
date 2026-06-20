/**
 * Issuer Partnerships API tests — SCRUM-2082 CSI-04D.
 *
 * No real Postgres, no real KMS — every test injects fakes. Exercises the
 * Express router via supertest.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// The router module imports `logger` and `db` at top level, both of which call
// loadConfig() at import time and throw without a full worker env. Every test
// here injects its own fakes via deps, so stub these modules to inert values so
// importing the router never touches real config / Postgres (matches the
// docusign-member-oauth.test.ts convention in this folder).
vi.mock('../../../config.js', () => ({
  config: {
    frontendUrl: 'http://localhost:5173',
    supabaseJwtSecret: 'jwt-secret',
    supabaseServiceKey: 'service-secret',
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../utils/db.js', () => ({
  db: {},
}));

import {
  createIssuerPartnershipsRouter,
  type IssuerPartnershipsRouterDeps,
} from './issuer-partnerships.js';
import type { MemberIntegrationRowDeps } from '../../../integrations/credential-sources/token-store.js';

const ARKOVA_ORG_ID = '00000000-0000-4000-8000-000000000001';
const BETA_ORG_ID = '00000000-0000-4000-8000-000000000002';
const ARKOVA_ADMIN_USER_ID = '00000000-0000-0000-0000-000000000010';
const ARKOVA_MEMBER_USER_ID = '00000000-0000-0000-0000-000000000011';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

function makeApp(deps: IssuerPartnershipsRouterDeps, userId?: string) {
  const app = express();
  app.use(express.json());
  // Stub the upstream auth middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (userId) {
      (req as Request & { user?: { id: string } }).user = { id: userId };
    }
    next();
  });
  app.use(
    '/api/v1/integrations/issuer-partnerships',
    createIssuerPartnershipsRouter(deps),
  );
  return app;
}

/**
 * Minimal fake supabase-js query-builder. Each test wires up the chain
 * the endpoint actually calls.
 */
function makeFakeDb(rows: {
  org_members: Array<{ org_id: string; user_id: string; role: string }>;
  member_integrations: Array<Record<string, unknown>>;
}) {
  const operations: Array<{ table: string; op: string; payload?: unknown }> = [];

  function from(table: string) {
    // Per-call mutable filter state for member_integrations chain.
    const state: {
      table: string;
      action: 'select' | 'insert' | 'update' | null;
      filters: Array<[string, unknown]>;
      isNullFilters: string[];
      inFilters: Array<[string, ReadonlyArray<unknown>]>;
      updatePayload?: Record<string, unknown>;
      insertPayload?: Record<string, unknown>;
      selectColumns?: string;
      order?: { column: string; ascending: boolean };
      limitN?: number;
    } = {
      table,
      action: null,
      filters: [],
      isNullFilters: [],
      inFilters: [],
    };

    const chain = {
      select(cols: string) {
        state.action = state.action ?? 'select';
        state.selectColumns = cols;
        return chain;
      },
      insert(payload: Record<string, unknown>) {
        state.action = 'insert';
        state.insertPayload = payload;
        return chain;
      },
      update(payload: Record<string, unknown>) {
        state.action = 'update';
        state.updatePayload = payload;
        return chain;
      },
      eq(col: string, val: unknown) {
        state.filters.push([col, val]);
        if (state.action === 'update') {
          return Promise.resolve(materialise());
        }
        return chain;
      },
      is(col: string, val: unknown) {
        if (val === null) state.isNullFilters.push(col);
        return chain;
      },
      in(col: string, vals: ReadonlyArray<unknown>) {
        state.inFilters.push([col, vals]);
        return chain;
      },
      order(col: string, opts: { ascending: boolean }) {
        state.order = { column: col, ascending: opts.ascending };
        return Promise.resolve(materialise());
      },
      limit(n: number) {
        state.limitN = n;
        return Promise.resolve(materialise());
      },
    };

    function applyFilters<T extends Record<string, unknown>>(items: T[]): T[] {
      let out = items;
      for (const [col, val] of state.filters) {
        out = out.filter((it) => it[col] === val);
      }
      for (const col of state.isNullFilters) {
        out = out.filter((it) => it[col] === null || it[col] === undefined);
      }
      for (const [col, vals] of state.inFilters) {
        out = out.filter((it) => vals.includes(it[col]));
      }
      return out;
    }

    function materialise(): { data: unknown; error: null } {
      operations.push({
        table,
        op: state.action ?? 'select',
        payload: state.insertPayload ?? state.updatePayload,
      });

      if (state.action === 'insert' && state.insertPayload) {
        const inserted = {
          id: VALID_UUID,
          ...state.insertPayload,
          revoked_at: null,
        };
        rows.member_integrations.push(inserted);
        return { data: [{ id: VALID_UUID }], error: null };
      }
      if (state.action === 'update' && state.updatePayload) {
        if (table === 'member_integrations') {
          const matched = applyFilters(
            rows.member_integrations as Array<Record<string, unknown>>,
          );
          for (const m of matched) Object.assign(m, state.updatePayload);
          return { data: matched, error: null };
        }
        return { data: [], error: null };
      }
      // SELECT
      if (table === 'org_members') {
        const filtered = applyFilters(rows.org_members);
        return { data: filtered.slice(0, state.limitN ?? filtered.length), error: null };
      }
      if (table === 'member_integrations') {
        let filtered = applyFilters(
          rows.member_integrations as Array<Record<string, unknown>>,
        );
        if (state.order) {
          const col = state.order.column;
          const asc = state.order.ascending;
          filtered = [...filtered].sort((a, b) => {
            const av = String(
              (a[col] as string | number | boolean | null | undefined) ?? '',
            );
            const bv = String(
              (b[col] as string | number | boolean | null | undefined) ?? '',
            );
            return asc ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        return {
          data: filtered.slice(0, state.limitN ?? filtered.length),
          error: null,
        };
      }
      return { data: [], error: null };
    }

    return chain;
  }
  return {
    from,
    _operations: operations,
    _rows: rows,
  };
}

function makeFakeRowStore(): MemberIntegrationRowDeps {
  const rows: Array<{ id: string }> = [];
  return {
    async upsertEncryptedRow() {
      const id = VALID_UUID;
      rows.push({ id });
      return { id };
    },
    async fetchEncryptedRow() {
      return null;
    },
  };
}

const fakeKms = {
  encrypt: vi.fn(async ({ plaintext }: { plaintext: Buffer }) =>
    Buffer.from(plaintext).reverse(),
  ),
  decrypt: vi.fn(async ({ ciphertext }: { ciphertext: Buffer }) =>
    Buffer.from(ciphertext).reverse(),
  ),
};

describe('SCRUM-2082 — GET /api/v1/integrations/issuer-partnerships', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401 when no user is present on the request', async () => {
    const db = makeFakeDb({ org_members: [], member_integrations: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = makeApp({ db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() });
    const res = await request(app).get(
      `/api/v1/integrations/issuer-partnerships?org_id=${ARKOVA_ORG_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it('400 when org_id query parameter is missing', async () => {
    const db = makeFakeDb({ org_members: [], member_integrations: [] });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_ADMIN_USER_ID,
    );
    const res = await request(app).get('/api/v1/integrations/issuer-partnerships');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('org_id_required');
  });

  it('403 when caller is not an org admin/owner', async () => {
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_MEMBER_USER_ID, role: 'member' },
      ],
      member_integrations: [],
    });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_MEMBER_USER_ID,
    );
    const res = await request(app).get(
      `/api/v1/integrations/issuer-partnerships?org_id=${ARKOVA_ORG_ID}`,
    );
    expect(res.status).toBe(403);
  });

  it('returns rows scoped to the caller’s org (no secret fields)', async () => {
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_ADMIN_USER_ID, role: 'admin' },
      ],
      member_integrations: [
        {
          id: VALID_UUID,
          org_id: ARKOVA_ORG_ID,
          provider: 'credly',
          account_id: 'credly-org-1',
          account_label: 'Acme Credly',
          connected_at: '2026-05-01T00:00:00Z',
          revoked_at: null,
          kek_version: 1,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          org_id: BETA_ORG_ID,
          provider: 'credly',
          account_id: 'credly-other',
          account_label: 'Other',
          connected_at: '2026-05-02T00:00:00Z',
          revoked_at: null,
          kek_version: 1,
        },
      ],
    });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_ADMIN_USER_ID,
    );
    const res = await request(app).get(
      `/api/v1/integrations/issuer-partnerships?org_id=${ARKOVA_ORG_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].org_id).toBe(ARKOVA_ORG_ID);
    expect(res.body.data[0].provider).toBe('credly');
    // Sprint 2 placeholders surface as null
    expect(res.body.data[0].last_sync_at).toBeNull();
    expect(res.body.data[0].credential_count).toBeNull();
    // No secret fields leak
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toMatch(/encrypted_tokens|client_secret|api_key|kms_key/i);
  });
});

describe('SCRUM-2082 — POST /api/v1/integrations/issuer-partnerships', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // storeIssuerCredentials/storeApiKeyCredentials resolve the symmetric KMS
    // key name from GCP_KMS_INTEGRATION_TOKEN_KEY (getIntegrationTokenKeyName)
    // when the handler does not pass an explicit keyName. The KMS client itself
    // is faked, so only the key *name* needs to exist for the encrypt call.
    vi.stubEnv(
      'GCP_KMS_INTEGRATION_TOKEN_KEY',
      'projects/test/locations/global/keyRings/test/cryptoKeys/integration-token',
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('401 when no user is present', async () => {
    const db = makeFakeDb({ org_members: [], member_integrations: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = makeApp({ db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() });
    const res = await request(app).post('/api/v1/integrations/issuer-partnerships').send({});
    expect(res.status).toBe(401);
  });

  it('400 on malformed body', async () => {
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_ADMIN_USER_ID, role: 'admin' },
      ],
      member_integrations: [],
    });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_ADMIN_USER_ID,
    );
    const res = await request(app)
      .post('/api/v1/integrations/issuer-partnerships')
      .send({ provider: 'credly' }); // missing fields
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
  });

  it('403 when caller is not an org admin', async () => {
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_MEMBER_USER_ID, role: 'member' },
      ],
      member_integrations: [],
    });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_MEMBER_USER_ID,
    );
    const res = await request(app)
      .post('/api/v1/integrations/issuer-partnerships')
      .send({
        provider: 'credly',
        org_id: ARKOVA_ORG_ID,
        account_id: 'credly-1',
        credentials: { client_id: 'cid', client_secret: 'csec' },
      });
    expect(res.status).toBe(403);
  });

  it('201 on successful Credly connect (client_credentials shape)', async () => {
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_ADMIN_USER_ID, role: 'admin' },
      ],
      member_integrations: [],
    });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_ADMIN_USER_ID,
    );
    const res = await request(app)
      .post('/api/v1/integrations/issuer-partnerships')
      .send({
        provider: 'credly',
        org_id: ARKOVA_ORG_ID,
        account_id: 'credly-org-1',
        account_label: 'Acme Credly',
        credentials: { client_id: 'cid', client_secret: 'csec' },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.provider).toBe('credly');
    expect(fakeKms.encrypt).toHaveBeenCalledTimes(1);
  });

  it('201 on successful Accredible connect (api_key shape)', async () => {
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_ADMIN_USER_ID, role: 'admin' },
      ],
      member_integrations: [],
    });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_ADMIN_USER_ID,
    );
    const res = await request(app)
      .post('/api/v1/integrations/issuer-partnerships')
      .send({
        provider: 'accredible',
        org_id: ARKOVA_ORG_ID,
        account_id: 'accredible-org-1',
        credentials: { api_key: 'ak-1234567890' },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.provider).toBe('accredible');
  });

  it('500 without echoing the secret when credential storage throws', async () => {
    // §1.4 regression pin: when the encrypt/store path fails, the response
    // must be a generic 500 and must NOT reflect the submitted secret back to
    // the caller (the catch branch logs via the redaction-aware path only).
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_ADMIN_USER_ID, role: 'admin' },
      ],
      member_integrations: [],
    });
    const throwingKms = {
      encrypt: vi.fn(async () => {
        throw new Error('kms unavailable');
      }),
      decrypt: vi.fn(async ({ ciphertext }: { ciphertext: Buffer }) =>
        Buffer.from(ciphertext).reverse(),
      ),
    };
    const SECRET = 'super-secret-client-value';
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: throwingKms, rowStore: makeFakeRowStore() },
      ARKOVA_ADMIN_USER_ID,
    );
    const res = await request(app)
      .post('/api/v1/integrations/issuer-partnerships')
      .send({
        provider: 'credly',
        org_id: ARKOVA_ORG_ID,
        account_id: 'credly-org-1',
        credentials: { client_id: 'cid', client_secret: SECRET },
      });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body.error.code).toBe('internal');
  });
});

describe('SCRUM-2082 — DELETE /api/v1/integrations/issuer-partnerships/:rowId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('400 when rowId is not a UUID', async () => {
    const db = makeFakeDb({ org_members: [], member_integrations: [] });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_ADMIN_USER_ID,
    );
    const res = await request(app).delete(
      '/api/v1/integrations/issuer-partnerships/not-a-uuid',
    );
    expect(res.status).toBe(400);
  });

  it('400 on a 36-char hex string that is not a valid UUID layout', async () => {
    // Regression pin for the tightened RFC-4122 matcher: a 36-char all-hex
    // string with no dashes in the canonical positions is NOT a UUID. The
    // previous loose /^[0-9a-fA-F-]{36}$/ guard would have accepted it.
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_ADMIN_USER_ID, role: 'admin' },
      ],
      member_integrations: [],
    });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_ADMIN_USER_ID,
    );
    const notAUuid = '1234567890abcdef1234567890abcdef1234'; // 36 hex chars
    const res = await request(app).delete(
      `/api/v1/integrations/issuer-partnerships/${notAUuid}`,
    );
    expect(res.status).toBe(400);
  });

  it('404 when the row does not exist', async () => {
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_ADMIN_USER_ID, role: 'admin' },
      ],
      member_integrations: [],
    });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_ADMIN_USER_ID,
    );
    const res = await request(app).delete(
      `/api/v1/integrations/issuer-partnerships/${VALID_UUID}`,
    );
    expect(res.status).toBe(404);
  });

  it('403 when caller is not an admin of the row’s org', async () => {
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_MEMBER_USER_ID, role: 'member' },
      ],
      member_integrations: [
        {
          id: VALID_UUID,
          org_id: ARKOVA_ORG_ID,
          provider: 'credly',
          revoked_at: null,
        },
      ],
    });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_MEMBER_USER_ID,
    );
    const res = await request(app).delete(
      `/api/v1/integrations/issuer-partnerships/${VALID_UUID}`,
    );
    expect(res.status).toBe(403);
  });

  it('403 when non-admin probes an already-revoked row', async () => {
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_MEMBER_USER_ID, role: 'member' },
      ],
      member_integrations: [
        {
          id: VALID_UUID,
          org_id: ARKOVA_ORG_ID,
          provider: 'credly',
          revoked_at: '2026-04-01T00:00:00Z',
        },
      ],
    });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_MEMBER_USER_ID,
    );
    const res = await request(app).delete(
      `/api/v1/integrations/issuer-partnerships/${VALID_UUID}`,
    );
    expect(res.status).toBe(403);
  });

  it('200 and soft-revokes the row when the caller is an admin', async () => {
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_ADMIN_USER_ID, role: 'admin' },
      ],
      member_integrations: [
        {
          id: VALID_UUID,
          org_id: ARKOVA_ORG_ID,
          provider: 'credly',
          revoked_at: null,
        },
      ],
    });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_ADMIN_USER_ID,
    );
    const res = await request(app).delete(
      `/api/v1/integrations/issuer-partnerships/${VALID_UUID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBe(true);
    expect(
      (db._rows.member_integrations[0] as { revoked_at: string | null }).revoked_at,
    ).toBeTruthy();
  });

  it('200 idempotent on already-revoked row', async () => {
    const db = makeFakeDb({
      org_members: [
        { org_id: ARKOVA_ORG_ID, user_id: ARKOVA_ADMIN_USER_ID, role: 'admin' },
      ],
      member_integrations: [
        {
          id: VALID_UUID,
          org_id: ARKOVA_ORG_ID,
          provider: 'credly',
          revoked_at: '2026-04-01T00:00:00Z',
        },
      ],
    });
    const app = makeApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: db as any, kms: fakeKms, rowStore: makeFakeRowStore() },
      ARKOVA_ADMIN_USER_ID,
    );
    const res = await request(app).delete(
      `/api/v1/integrations/issuer-partnerships/${VALID_UUID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBe(true);
  });
});
