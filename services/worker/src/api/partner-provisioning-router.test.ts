/**
 * HTTP surface tests for the partner-provisioning router (SCRUM-2990).
 *
 * The state machine (`partner-provisioning.ts`) already owns the LEGALITY of
 * every transition and is covered by its own 22-test suite. This suite covers
 * what only the HTTP layer can get wrong:
 *
 *   1. AUTHORIZATION — the router is deliberately STRICTER than the machine.
 *      The machine lets an owner/org_admin of the sponsor org approve, reject,
 *      cancel and provision. The HTTP surface does NOT: every review verb is
 *      platform-admin ONLY, because provisioning is the step that mints a
 *      partner's access and a self-serve org admin must never be able to grant
 *      it to their own counterparty. Each forbidden (verb, role) pair has an
 *      explicit negative test below.
 *   2. SEPARATION OF DUTIES over HTTP — the requester cannot approve/reject
 *      their own request (machine-enforced) NOR provision it (router-enforced;
 *      `provisionPartnerAccount` has no self-review check of its own).
 *   3. ACTOR CONSTRUCTION — `ProvisioningActor` is built ONLY from a
 *      server-verified principal. A client-supplied `role` / `org_id` in the
 *      body must never reach the machine (the module's SECURITY CONTRACT).
 *   4. CONCURRENCY — transitions persist via a compare-and-swap on the prior
 *      status, so two racing approvals cannot both win.
 *   5. NO SECRETS — this surface issues no API keys and returns/logs no key
 *      material (static guard, mirroring partner-provisioning.guard.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';

// The router imports the service_role client (and, through `_org-auth` /
// `platformAdmin` / `auditEvent`, so do its default deps). Mock it so importing
// the module does not require real worker config — every test below injects
// fakes for the store, the actor resolver and the audit writer, so the mock is
// never actually exercised.
vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn(() => ({})), rpc: vi.fn() },
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';

import {
  createPartnerProvisioningRouter,
  type PartnerAccountStore,
} from './partner-provisioning-router.js';
import type {
  PartnerAccountRecord,
  PartnerProvisioningStatus,
  ProvisioningActor,
  ProvisioningRole,
} from './partner-provisioning.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SPONSOR_ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const ARKOVA_ORG = '33333333-3333-4333-8333-333333333333';
const PARTNER_ORG = '44444444-4444-4444-8444-444444444444';
const RECORD_ID = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-08-12T00:00:00.000Z';

/**
 * Server-verified principals, keyed by user id. The fake resolver below plays
 * the role of the real `_org-auth.ts` lookup: the HTTP body can NEVER
 * influence what comes out of it.
 */
const PRINCIPALS: Record<string, { role: ProvisioningRole; orgId: string }> = {
  'u-plat': { role: 'platform_admin', orgId: ARKOVA_ORG },
  'u-plat2': { role: 'platform_admin', orgId: ARKOVA_ORG },
  'u-owner': { role: 'owner', orgId: SPONSOR_ORG },
  'u-orgadmin': { role: 'org_admin', orgId: SPONSOR_ORG },
  'u-member': { role: 'member', orgId: SPONSOR_ORG },
  'u-outsider': { role: 'org_admin', orgId: OTHER_ORG },
};

function baseRecord(over: Partial<PartnerAccountRecord> = {}): PartnerAccountRecord {
  return {
    id: RECORD_ID,
    status: 'requested',
    partnerName: 'HakiChain',
    partnerContactEmail: 'ops@hakichain.example',
    sponsorOrgId: SPONSOR_ORG,
    requestedBy: 'u-member',
    requestedAt: NOW,
    ...over,
  };
}

/** In-memory store with a real compare-and-swap, mirroring the SQL default. */
function makeStore(seed: PartnerAccountRecord[] = []): PartnerAccountStore & {
  rows: Map<string, PartnerAccountRecord>;
  failNextCas: boolean;
  conflictOnInsert: boolean;
} {
  const rows = new Map(seed.map((r) => [r.id, r]));
  const store = {
    rows,
    failNextCas: false,
    conflictOnInsert: false,
    async insert(record: PartnerAccountRecord) {
      if (store.conflictOnInsert) return 'conflict' as const;
      rows.set(record.id, record);
      return 'inserted' as const;
    },
    async getById(id: string) {
      return rows.get(id) ?? null;
    },
    async list(opts: { sponsorOrgId?: string; limit: number; offset: number }) {
      const all = [...rows.values()].filter(
        (r) => !opts.sponsorOrgId || r.sponsorOrgId === opts.sponsorOrgId,
      );
      return all.slice(opts.offset, opts.offset + opts.limit);
    },
    async transition(next: PartnerAccountRecord, expected: PartnerProvisioningStatus) {
      if (store.failNextCas) {
        store.failNextCas = false;
        return false;
      }
      const current = rows.get(next.id);
      if (!current || current.status !== expected) return false;
      rows.set(next.id, next);
      return true;
    },
  };
  return store;
}

interface Harness {
  app: express.Express;
  store: ReturnType<typeof makeStore>;
  audits: Array<Record<string, unknown>>;
}

/**
 * Build an app whose auth middleware sets `req.userId` from an `x-test-user`
 * header — standing in for the real JWT `requireAuth`. Note the actor is
 * resolved from PRINCIPALS by user id ONLY; the request body is never
 * consulted, which is what lets the body-spoofing tests below be meaningful.
 */
function harness(seed: PartnerAccountRecord[] = []): Harness {
  const store = makeStore(seed);
  const audits: Array<Record<string, unknown>> = [];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const u = req.header('x-test-user');
    if (u) (req as express.Request & { userId?: string }).userId = u;
    next();
  });
  app.use(
    '/api/partner-provisioning',
    createPartnerProvisioningRouter({
      store,
      now: () => NOW,
      recordAudit: async (row) => {
        audits.push(row);
      },
      resolveActor: async (userId: string, orgId: string): Promise<ProvisioningActor | null> => {
        const p = PRINCIPALS[userId];
        if (!p) return null;
        if (p.role === 'platform_admin') return { userId, orgId: p.orgId, role: p.role };
        // Non-platform principals only resolve within their OWN org.
        if (p.orgId !== orgId) return null;
        return { userId, orgId, role: p.role };
      },
      isPlatformAdmin: async (userId: string) =>
        PRINCIPALS[userId]?.role === 'platform_admin',
    }),
  );
  return { app, store, audits };
}

const as = (h: Harness, method: 'get' | 'post', path: string, user?: string) => {
  const r = request(h.app)[method](`/api/partner-provisioning${path}`);
  return user ? r.set('x-test-user', user) : r;
};

// ---------------------------------------------------------------------------
// POST / — file a partner request
// ---------------------------------------------------------------------------

const VALID_BODY = {
  partner_name: 'HakiChain',
  partner_contact_email: 'ops@hakichain.example',
  sponsor_org_id: SPONSOR_ORG,
};

describe('POST /api/partner-provisioning (request)', () => {
  it('401s an unauthenticated caller', async () => {
    const res = await as(harness(), 'post', '/').send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('201s for a plain member of the sponsor org and persists the record', async () => {
    const h = harness();
    const res = await as(h, 'post', '/', 'u-member').send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('requested');
    expect(res.body.data.sponsor_org_id).toBe(SPONSOR_ORG);
    expect(res.body.data.requested_by).toBe('u-member');
    expect(h.store.rows.size).toBe(1);
  });

  it('201s for a platform admin filing on behalf of any org', async () => {
    const h = harness();
    const res = await as(h, 'post', '/', 'u-plat').send(VALID_BODY);
    expect(res.status).toBe(201);
  });

  it('403s a caller who is not a member of the named sponsor org', async () => {
    const h = harness();
    const res = await as(h, 'post', '/', 'u-outsider').send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(h.store.rows.size).toBe(0);
  });

  it('400s an invalid body (bad email, missing name, non-uuid sponsor org)', async () => {
    const h = harness();
    for (const body of [
      { ...VALID_BODY, partner_contact_email: 'not-an-email' },
      { ...VALID_BODY, partner_name: '' },
      { ...VALID_BODY, sponsor_org_id: 'not-a-uuid' },
      {},
    ]) {
      const res = await as(h, 'post', '/', 'u-member').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.store.rows.size).toBe(0);
  });

  it('409s when an open request already exists for that partner + sponsor', async () => {
    const h = harness();
    h.store.conflictOnInsert = true;
    const res = await as(h, 'post', '/', 'u-member').send(VALID_BODY);
    expect(res.status).toBe(409);
  });

  it('emits partner.account.requested with the server-verified actor as actor_id', async () => {
    const h = harness();
    await as(h, 'post', '/', 'u-member').send(VALID_BODY);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      event_type: 'partner.account.requested',
      event_category: 'ORG',
      target_type: 'partner_account',
      org_id: SPONSOR_ORG,
      actor_id: 'u-member',
    });
  });

  it('IGNORES a client-supplied role/org_id — actor comes from the server only', async () => {
    const h = harness();
    const res = await as(h, 'post', '/', 'u-outsider').send({
      ...VALID_BODY,
      role: 'platform_admin',
      org_id: SPONSOR_ORG,
      requested_by: 'u-plat',
    });
    // Body-supplied privilege must not promote the outsider.
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Review verbs — the authZ matrix. Approve / reject / cancel / provision are
// PLATFORM-ADMIN ONLY at the HTTP surface.
// ---------------------------------------------------------------------------

/** (verb, path suffix, prior status the verb is legal from, body) */
const REVIEW_VERBS = [
  { verb: 'approve', suffix: '/approve', from: 'requested' as const, body: {} },
  { verb: 'reject', suffix: '/reject', from: 'requested' as const, body: { reason: 'no' } },
  { verb: 'cancel', suffix: '/cancel', from: 'approved' as const, body: { reason: 'backed out' } },
  {
    verb: 'provision',
    suffix: '/provision',
    from: 'approved' as const,
    body: { partner_org_id: PARTNER_ORG },
  },
];

describe('review verbs: platform-admin-only authZ matrix', () => {
  for (const { verb, suffix, from, body } of REVIEW_VERBS) {
    describe(`POST /:id${suffix}`, () => {
      const seeded = () =>
        harness([
          baseRecord({
            status: from,
            ...(from === 'approved'
              ? { approvedBy: 'u-plat2', approvedAt: NOW }
              : {}),
          }),
        ]);

      it('401s an unauthenticated caller', async () => {
        const res = await as(seeded(), 'post', `/${RECORD_ID}${suffix}`).send(body);
        expect(res.status).toBe(401);
      });

      it('400s a non-uuid id', async () => {
        const res = await as(seeded(), 'post', `/not-a-uuid${suffix}`, 'u-plat').send(body);
        expect(res.status).toBe(400);
      });

      it('404s an unknown record', async () => {
        const res = await as(
          seeded(),
          'post',
          `/66666666-6666-4666-8666-666666666666${suffix}`,
          'u-plat',
        ).send(body);
        expect(res.status).toBe(404);
      });

      // ---- the negative matrix: every non-platform-admin is denied ----
      for (const user of ['u-owner', 'u-orgadmin', 'u-member', 'u-outsider']) {
        it(`403s ${PRINCIPALS[user].role} '${user}' — ${verb} is platform-admin only`, async () => {
          const h = seeded();
          const res = await as(h, 'post', `/${RECORD_ID}${suffix}`, user).send(body);
          expect(res.status).toBe(403);
          // and the record is untouched
          expect(h.store.rows.get(RECORD_ID)!.status).toBe(from);
          expect(h.audits).toHaveLength(0);
        });
      }

      it('200s for a platform admin who is not the requester', async () => {
        const h = seeded();
        const res = await as(h, 'post', `/${RECORD_ID}${suffix}`, 'u-plat').send(body);
        expect(res.status).toBe(200);
      });

      it('409s when the record is in an illegal prior status', async () => {
        const h = harness([baseRecord({ status: 'rejected', rejectedBy: 'u-plat2', rejectedAt: NOW })]);
        const res = await as(h, 'post', `/${RECORD_ID}${suffix}`, 'u-plat').send(body);
        expect(res.status).toBe(409);
      });

      it('409s when a concurrent transition wins the compare-and-swap', async () => {
        const h = seeded();
        h.store.failNextCas = true;
        const res = await as(h, 'post', `/${RECORD_ID}${suffix}`, 'u-plat').send(body);
        expect(res.status).toBe(409);
        expect(h.audits).toHaveLength(0);
      });
    });
  }
});

describe('separation of duties over HTTP', () => {
  it('403s a platform admin approving their OWN request', async () => {
    const h = harness([baseRecord({ requestedBy: 'u-plat' })]);
    const res = await as(h, 'post', `/${RECORD_ID}/approve`, 'u-plat').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('separation_of_duties');
  });

  it('403s a platform admin rejecting their OWN request', async () => {
    const h = harness([baseRecord({ requestedBy: 'u-plat' })]);
    const res = await as(h, 'post', `/${RECORD_ID}/reject`, 'u-plat').send({ reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('separation_of_duties');
  });

  it('403s a platform admin PROVISIONING their own request (router-level; the machine allows it)', async () => {
    const h = harness([
      baseRecord({ status: 'approved', requestedBy: 'u-plat', approvedBy: 'u-plat2', approvedAt: NOW }),
    ]);
    const res = await as(h, 'post', `/${RECORD_ID}/provision`, 'u-plat').send({
      partner_org_id: PARTNER_ORG,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('separation_of_duties');
  });

  it('allows a DIFFERENT platform admin to provision', async () => {
    const h = harness([
      baseRecord({ status: 'approved', requestedBy: 'u-plat', approvedBy: 'u-plat2', approvedAt: NOW }),
    ]);
    const res = await as(h, 'post', `/${RECORD_ID}/provision`, 'u-plat2').send({
      partner_org_id: PARTNER_ORG,
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Per-verb behaviour + audit
// ---------------------------------------------------------------------------

describe('approve', () => {
  it('moves requested -> approved, stamps the approver, and audits', async () => {
    const h = harness([baseRecord()]);
    const res = await as(h, 'post', `/${RECORD_ID}/approve`, 'u-plat').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.approved_by).toBe('u-plat');
    expect(res.body.data.approved_at).toBe(NOW);
    expect(h.store.rows.get(RECORD_ID)!.status).toBe('approved');
    expect(h.audits[0]).toMatchObject({
      event_type: 'partner.account.approved',
      target_id: RECORD_ID,
      org_id: SPONSOR_ORG,
      actor_id: 'u-plat',
    });
  });
});

describe('reject', () => {
  it('requires a reason', async () => {
    const h = harness([baseRecord()]);
    const res = await as(h, 'post', `/${RECORD_ID}/reject`, 'u-plat').send({});
    expect(res.status).toBe(400);
  });

  it('moves requested -> rejected with the reason and audits', async () => {
    const h = harness([baseRecord()]);
    const res = await as(h, 'post', `/${RECORD_ID}/reject`, 'u-plat').send({
      reason: 'sanctions screening failed',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.rejection_reason).toBe('sanctions screening failed');
    expect(h.audits[0]).toMatchObject({ event_type: 'partner.account.rejected' });
  });
});

describe('cancel', () => {
  it('moves approved -> rejected and audits partner.account.cancelled', async () => {
    const h = harness([
      baseRecord({ status: 'approved', approvedBy: 'u-plat2', approvedAt: NOW }),
    ]);
    const res = await as(h, 'post', `/${RECORD_ID}/cancel`, 'u-plat').send({ reason: 'withdrew' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');
    expect(h.audits[0]).toMatchObject({ event_type: 'partner.account.cancelled' });
  });

  it('409s from requested (cancel requires approved)', async () => {
    const h = harness([baseRecord()]);
    const res = await as(h, 'post', `/${RECORD_ID}/cancel`, 'u-plat').send({ reason: 'x' });
    expect(res.status).toBe(409);
  });
});

describe('provision', () => {
  const approved = () =>
    harness([baseRecord({ status: 'approved', approvedBy: 'u-plat2', approvedAt: NOW })]);

  it('400s a missing or non-uuid partner_org_id', async () => {
    for (const body of [{}, { partner_org_id: 'nope' }]) {
      const res = await as(approved(), 'post', `/${RECORD_ID}/provision`, 'u-plat').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('400s when partner_org_id equals the sponsor org (self-provisioning)', async () => {
    const res = await as(approved(), 'post', `/${RECORD_ID}/provision`, 'u-plat').send({
      partner_org_id: SPONSOR_ORG,
    });
    expect(res.status).toBe(400);
  });

  it('moves approved -> provisioned and audits with the partner org in details', async () => {
    const h = approved();
    const res = await as(h, 'post', `/${RECORD_ID}/provision`, 'u-plat').send({
      partner_org_id: PARTNER_ORG,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('provisioned');
    expect(res.body.data.partner_org_id).toBe(PARTNER_ORG);
    expect(h.audits[0]).toMatchObject({ event_type: 'partner.account.provisioned' });
    expect(String(h.audits[0].details)).toContain(PARTNER_ORG);
  });

  it('returns NO credential material — provisioning issues no API key on this surface', async () => {
    const h = approved();
    const res = await as(h, 'post', `/${RECORD_ID}/provision`, 'u-plat').send({
      partner_org_id: PARTNER_ORG,
    });
    const body = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ['api_key', 'apikey', 'secret', 'token', 'password', 'ark_']) {
      expect(body, `response must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('GET / (list)', () => {
  const seed = () =>
    harness([
      baseRecord(),
      baseRecord({ id: '77777777-7777-4777-8777-777777777777', sponsorOrgId: OTHER_ORG }),
    ]);

  it('401s an unauthenticated caller', async () => {
    const res = await as(seed(), 'get', '/');
    expect(res.status).toBe(401);
  });

  it('lets a platform admin list across all orgs', async () => {
    const res = await as(seed(), 'get', '/', 'u-plat');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('400s a non-platform-admin who omits sponsor_org_id', async () => {
    const res = await as(seed(), 'get', '/', 'u-orgadmin');
    expect(res.status).toBe(400);
  });

  it('scopes an org admin to their own org', async () => {
    const res = await as(seed(), 'get', `/?sponsor_org_id=${SPONSOR_ORG}`, 'u-orgadmin');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].sponsor_org_id).toBe(SPONSOR_ORG);
  });

  it("403s an org admin asking for ANOTHER org's list", async () => {
    const res = await as(seed(), 'get', `/?sponsor_org_id=${OTHER_ORG}`, 'u-orgadmin');
    expect(res.status).toBe(403);
  });

  it('403s a plain member (listing is admin-or-above)', async () => {
    const res = await as(seed(), 'get', `/?sponsor_org_id=${SPONSOR_ORG}`, 'u-member');
    expect(res.status).toBe(403);
  });

  it('400s an out-of-range limit', async () => {
    const res = await as(seed(), 'get', '/?limit=9999', 'u-plat');
    expect(res.status).toBe(400);
  });
});

describe('GET /:id (detail)', () => {
  it('404s an unknown id', async () => {
    const res = await as(
      harness([baseRecord()]),
      'get',
      '/66666666-6666-4666-8666-666666666666',
      'u-plat',
    );
    expect(res.status).toBe(404);
  });

  it('lets a platform admin read any record', async () => {
    const res = await as(harness([baseRecord()]), 'get', `/${RECORD_ID}`, 'u-plat');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(RECORD_ID);
  });

  it('lets an org admin of the sponsor org read it', async () => {
    const res = await as(harness([baseRecord()]), 'get', `/${RECORD_ID}`, 'u-orgadmin');
    expect(res.status).toBe(200);
  });

  it('lets the requester read their own request even as a plain member', async () => {
    const res = await as(harness([baseRecord({ requestedBy: 'u-member' })]), 'get', `/${RECORD_ID}`, 'u-member');
    expect(res.status).toBe(200);
  });

  it('403s a plain member who is NOT the requester', async () => {
    const res = await as(harness([baseRecord({ requestedBy: 'u-orgadmin' })]), 'get', `/${RECORD_ID}`, 'u-member');
    expect(res.status).toBe(403);
  });

  it('403s a member of an unrelated org', async () => {
    const res = await as(harness([baseRecord()]), 'get', `/${RECORD_ID}`, 'u-outsider');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Static guards — the router must not grow a secret-issuing path unreviewed
// ---------------------------------------------------------------------------

describe('router static guards (SCRUM-2990)', () => {
  const routerSource = readFileSync(
    fileURLToPath(new URL('./partner-provisioning-router.ts', import.meta.url)),
    'utf8',
  );
  const indexSource = readFileSync(
    fileURLToPath(new URL('../index.ts', import.meta.url)),
    'utf8',
  );

  it('references no key/secret/credential issuance module', () => {
    for (const forbidden of [
      'secret-manager',
      'secretmanager',
      'apiKeyAuth',
      'generateApiKey',
      'createHmac',
      'randomBytes',
      'API_KEY_HMAC_SECRET',
      'stripe',
      'bitcoinjs',
      'child_process',
    ]) {
      expect(
        routerSource.toLowerCase(),
        `router must not reference "${forbidden}"`,
      ).not.toContain(forbidden.toLowerCase());
    }
  });

  it('is mounted in index.ts UNDER the existing fail-closed gate', () => {
    // The gate must still be the FIRST middleware on the prefix; the router is
    // appended after it, never in place of it.
    expect(indexSource).toMatch(
      /app\.use\(\s*'\/api\/partner-provisioning'\s*,\s*partnerProvisioningGate\(\)/,
    );
    expect(indexSource).toContain('createPartnerProvisioningRouter(');
  });

  it('requires authentication in the mount chain', () => {
    const mount = indexSource.slice(
      indexSource.indexOf("app.use('/api/partner-provisioning'"),
    );
    const stanza = mount.slice(0, mount.indexOf(');') + 2);
    expect(stanza).toContain('requireAuthMw');
  });
});

describe('actor construction never trusts the request', () => {
  it('does not read role/org from req.body anywhere in the router', () => {
    const routerSource = readFileSync(
      fileURLToPath(new URL('./partner-provisioning-router.ts', import.meta.url)),
      'utf8',
    );
    expect(routerSource).not.toMatch(/req\.body\.role/);
    expect(routerSource).not.toMatch(/req\.body\.org_id/);
    expect(routerSource).not.toMatch(/role:\s*req\./);
  });

  it('never passes a body-derived role into the state machine', async () => {
    const h = harness([baseRecord()]);
    const spy = vi.spyOn(h.store, 'transition');
    await as(h, 'post', `/${RECORD_ID}/approve`, 'u-member').send({
      role: 'platform_admin',
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
