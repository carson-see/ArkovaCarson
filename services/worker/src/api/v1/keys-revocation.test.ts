/**
 * FD-P7 — API-key revocation must be reachable and must stamp the designation.
 *
 * The 2026-08 fullsoak found the CC6.8 control asserted to the SOC 2 auditor
 * was unreachable from every client: `toPublicKey` stripped `id` from create
 * AND list responses while PATCH/DELETE /api/v1/keys/:keyId are addressed by
 * that id. On top of that, a revoke set only `is_active=false` — `revoked_at`
 * and `revocation_reason` stayed NULL, so a designation export read
 * `revoked = false` after a successful product-path revoke.
 *
 * This suite drives the REAL router + REAL apiKeyAuth middleware over a
 * stateful in-memory api_keys table (supertest), pinning the full flow:
 * create -> list (id addressable) -> revoke (designation stamped) -> the
 * revoked key is refused 401 -> delete cleans up.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const TEST_HMAC_SECRET = 'test-hmac-secret-for-revocation-flow';
const ADMIN_USER = 'user-admin-1';

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state: Record<string, Row[]> = { profiles: [], api_keys: [] };
  let idCounter = 0;

  const pickCols = (row: Row, cols: string | undefined): Row => {
    if (!cols || cols.trim() === '*') return { ...row };
    const out: Row = {};
    for (const c of cols.split(',').map((s) => s.trim())) out[c] = row[c] ?? null;
    return out;
  };

  /**
   * Minimal stateful supabase-js query-builder fake. Supports the exact
   * chains keys.ts and apiKeyAuth.ts use: select/insert/update/delete +
   * eq/order/single, lazy-thenable like the real builder.
   */
  function makeBuilder(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row | null = null;
    let cols: string | undefined;
    let wantSingle = false;
    const filters: Array<[string, unknown]> = [];

    const exec = () => {
      const rows = state[table] ?? [];
      const matches = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
      let data: Row[];
      if (op === 'insert' && payload) {
        idCounter += 1;
        const inserted: Row = {
          id: `key-uuid-${idCounter}`,
          is_active: true,
          rate_limit_tier: 'free',
          created_at: new Date().toISOString(),
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
          revocation_reason: null,
          ...payload,
        };
        rows.push(inserted);
        data = [inserted];
      } else if (op === 'update') {
        for (const r of matches) Object.assign(r, payload);
        data = matches;
      } else if (op === 'delete') {
        state[table] = rows.filter((r) => !matches.includes(r));
        data = matches;
      } else {
        data = matches;
      }
      const projected = (data as Row[]).map((r) => pickCols(r, cols));
      if (wantSingle) {
        return {
          data: projected[0] ?? null,
          error: projected[0] ? null : { code: 'PGRST116', message: 'no rows' },
        };
      }
      return { data: projected, error: null };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: (c?: string) => { cols = c; return b; },
      insert: (p: Row) => { op = 'insert'; payload = p; return b; },
      update: (p: Row) => { op = 'update'; payload = p; return b; },
      delete: () => { op = 'delete'; return b; },
      eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
      order: () => b,
      single: () => { wantSingle = true; return b; },
      then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve().then(exec).then(onOk, onErr),
    };
    return b;
  }

  const reset = () => {
    state.profiles = [{ id: ADMIN_USER_H, org_id: ORG_H, role: 'ORG_ADMIN' }];
    state.api_keys = [];
    idCounter = 0;
  };

  // Hoisted copies (the outer consts are not visible inside vi.hoisted).
  const ADMIN_USER_H = 'user-admin-1';
  const ORG_H = 'org-flow-1';

  return { state, makeBuilder, reset };
});

vi.mock('../../utils/db.js', () => ({
  db: { from: (table: string) => h.makeBuilder(table) },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/auditEvent.js', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { keysRouter, UpdateKeySchema } from './keys.js';
import { apiKeyAuth } from '../../middleware/apiKeyAuth.js';
import { recordAuditEvent } from '../../utils/auditEvent.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = ADMIN_USER;
    req.hmacSecret = TEST_HMAC_SECRET;
    next();
  });
  app.use('/api/v1/keys', keysRouter);
  app.get(
    '/api/v1/protected',
    apiKeyAuth(TEST_HMAC_SECRET, { required: true }),
    (_req, res) => { res.json({ ok: true }); },
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();
});

describe('FD-P7 — create -> list -> revoke -> refused -> delete (CC6.8)', () => {
  it('walks the full product-path lifecycle', async () => {
    const app = makeApp();

    // 1. Create through the real POST flow.
    const created = await request(app)
      .post('/api/v1/keys')
      .send({ name: 'flow-key', scopes: ['verify'] })
      .expect(201);
    expect(created.body.key).toMatch(/^ak_live_[a-f0-9]{64}$/);
    // The addressable id MUST be exposed (FD-P7) — secrets must not.
    expect(created.body.id).toBeDefined();
    expect(created.body.key_hash).toBeUndefined();
    expect(created.body.org_id).toBeUndefined();

    // 2. List rows carry the same addressable id.
    const listed = await request(app).get('/api/v1/keys').expect(200);
    expect(listed.body.keys).toHaveLength(1);
    expect(listed.body.keys[0].id).toBe(created.body.id);
    expect(listed.body.keys[0].key_hash).toBeUndefined();
    expect(listed.body.keys[0].org_id).toBeUndefined();

    // 3. The live key authenticates.
    await request(app)
      .get('/api/v1/protected')
      .set('Authorization', `Bearer ${created.body.key}`)
      .expect(200);

    // 4. Revoke through the product path, with a reason.
    const revoked = await request(app)
      .patch(`/api/v1/keys/${created.body.id}`)
      .send({ is_active: false, revocation_reason: 'leaked in CI logs' })
      .expect(200);
    expect(revoked.body.is_active).toBe(false);
    // CC6.8 designation is stamped, not just the boolean flipped.
    expect(revoked.body.revoked_at).toBeTruthy();

    const row = h.state.api_keys[0];
    expect(row.revoked_at).toBeTruthy();
    expect(row.revocation_reason).toBe('leaked in CI logs');

    // Audit trail records the revocation with its reason.
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'api_key.revoked',
        details: expect.stringContaining('leaked in CI logs'),
      }),
    );

    // 5. The revoked key is refused — the CC6.8 daily assertion.
    const refused = await request(app)
      .get('/api/v1/protected')
      .set('Authorization', `Bearer ${created.body.key}`);
    expect([401, 403]).toContain(refused.status);
    expect(refused.body.error).toBe('api_key_revoked');

    // 6. Delete cleans up (the probe's P7e step).
    await request(app).delete(`/api/v1/keys/${created.body.id}`).expect(204);
    const after = await request(app).get('/api/v1/keys').expect(200);
    expect(after.body.keys).toHaveLength(0);
  });

  it('does not overwrite the original revocation stamp on a repeat revoke', async () => {
    const app = makeApp();
    const created = await request(app)
      .post('/api/v1/keys')
      .send({ name: 'stamp-once', scopes: ['verify'] })
      .expect(201);

    await request(app)
      .patch(`/api/v1/keys/${created.body.id}`)
      .send({ is_active: false, revocation_reason: 'first' })
      .expect(200);
    const firstStamp = h.state.api_keys[0].revoked_at;

    await request(app)
      .patch(`/api/v1/keys/${created.body.id}`)
      .send({ is_active: false, revocation_reason: 'second' })
      .expect(200);
    expect(h.state.api_keys[0].revoked_at).toBe(firstStamp);
    expect(h.state.api_keys[0].revocation_reason).toBe('first');
  });

  it('refuses to reactivate a revoked key (409) — revocation is one-way', async () => {
    // 0382's validate_api_key never authenticates a key with revoked_at set,
    // so allowing is_active=true again would create a row that CLAIMS active
    // while the edge path refuses it. Fail the request instead.
    const app = makeApp();
    const created = await request(app)
      .post('/api/v1/keys')
      .send({ name: 'one-way', scopes: ['verify'] })
      .expect(201);

    await request(app)
      .patch(`/api/v1/keys/${created.body.id}`)
      .send({ is_active: false })
      .expect(200);

    const res = await request(app)
      .patch(`/api/v1/keys/${created.body.id}`)
      .send({ is_active: true });
    expect(res.status).toBe(409);
    expect(h.state.api_keys[0].is_active).toBe(false);
  });
});

describe('UpdateKeySchema — revocation_reason contract', () => {
  it('accepts revocation_reason alongside is_active:false and carries it through', () => {
    const parsed = UpdateKeySchema.safeParse({ is_active: false, revocation_reason: 'leaked' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.revocation_reason).toBe('leaked');
  });

  it('rejects revocation_reason without is_active:false', () => {
    expect(UpdateKeySchema.safeParse({ revocation_reason: 'leaked' }).success).toBe(false);
    expect(
      UpdateKeySchema.safeParse({ is_active: true, revocation_reason: 'leaked' }).success,
    ).toBe(false);
  });

  it('rejects a revocation_reason over 500 chars', () => {
    expect(
      UpdateKeySchema.safeParse({ is_active: false, revocation_reason: 'x'.repeat(501) }).success,
    ).toBe(false);
  });
});
