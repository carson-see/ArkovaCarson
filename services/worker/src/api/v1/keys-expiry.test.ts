/**
 * SCRUM-5023 — expiry is visible, bounded, and owner-controllable.
 *
 * Three defects, one root cause: `expires_at` was write-once and read-raw.
 *
 *   1. GET /api/v1/keys returned `is_active` and `expires_at` side by side and
 *      called it a day. Prod (2026-09-12, read-only) held 19 keys, 13 with
 *      `is_active = true` AND an expiry already past. HakiChain's two keys —
 *      created 2026-06-01 with a 30-day expiry, expired 2026-07-01 — are still
 *      `is_active = true` today. Their report was "keys expired unexpectedly";
 *      what they mean is nothing ever said so.
 *   2. One prod row carries `expires_at` EARLIER than `created_at` — born
 *      expired. POST must not be the path that can do that.
 *   3. There was no way to extend an expiry. The only remedy was a new key,
 *      which means new credentials distributed to a partner over email.
 *
 * This suite drives the REAL router over the stateful in-memory table (the
 * harness `keys-revocation.test.ts` established), because the bugs live in
 * how the routes combine columns — a unit test of the derivation alone would
 * have passed while GET still shipped raw columns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const TEST_HMAC_SECRET = 'test-hmac-secret-for-expiry-flow';
const ADMIN_USER = 'user-admin-1';
const DAY_MS = 24 * 60 * 60 * 1000;

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

  /** Minimal stateful supabase-js builder fake — same shape as keys-revocation. */
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
      is: (c: string, v: unknown) => { filters.push([c, v]); return b; },
      order: () => b,
      single: () => { wantSingle = true; return b; },
      then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve().then(exec).then(onOk, onErr),
    };
    return b;
  }

  const ADMIN_USER_H = 'user-admin-1';
  const ORG_H = 'org-expiry-1';

  const reset = () => {
    state.profiles = [{ id: ADMIN_USER_H, org_id: ORG_H, role: 'ORG_ADMIN' }];
    state.api_keys = [];
    idCounter = 0;
  };

  return { state, makeBuilder, reset, ORG: ORG_H };
});

vi.mock('../../utils/db.js', () => ({
  db: { from: (table: string) => h.makeBuilder(table) },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/auditEvent.js', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue({ ok: true }),
}));

import { keysRouter, UpdateKeySchema, CreateKeySchema } from './keys.js';
import { recordAuditEvent } from '../../utils/auditEvent.js';
import { MAX_EXPIRES_IN_DAYS } from './keyExpiryStatus.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = ADMIN_USER;
    req.hmacSecret = TEST_HMAC_SECRET;
    next();
  });
  app.use('/api/v1/keys', keysRouter);
  return app;
}

/** Seed a row directly, to reproduce shapes POST can no longer create. */
function seedKey(fields: Record<string, unknown>): string {
  const id = `seeded-${h.state.api_keys.length + 1}`;
  h.state.api_keys.push({
    id,
    org_id: h.ORG,
    key_prefix: 'ak_live_seed',
    key_hash: 'hash-not-a-secret-in-tests',
    name: 'seeded',
    scopes: ['verify'],
    rate_limit_tier: 'free',
    is_active: true,
    created_at: new Date(Date.now() - 90 * DAY_MS).toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revocation_reason: null,
    ...fields,
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();
});

describe('GET /api/v1/keys — §1.8 additive status fields', () => {
  it('reports expired on the HakiChain shape while leaving is_active untouched', async () => {
    seedKey({ name: 'hakichain-prod', expires_at: '2026-07-01T00:00:00.000Z' });

    const res = await request(makeApp()).get('/api/v1/keys').expect(200);
    const [key] = res.body.keys;

    expect(key.status).toBe('expired');
    expect(key.days_until_expiry).toBeLessThan(0);
    // §1.8: the frozen columns are byte-unchanged. A client reading is_active
    // sees exactly what it saw before — it just now has a better field.
    expect(key.is_active).toBe(true);
    expect(key.expires_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('reports expiring_soon with days remaining inside the window', async () => {
    // 5.5 days out: `days_until_expiry` floors to 5 regardless of how many
    // milliseconds elapse between seeding and the request, so this pins the
    // value rather than racing the clock.
    seedKey({ expires_at: new Date(Date.now() + 5.5 * DAY_MS).toISOString() });

    const res = await request(makeApp()).get('/api/v1/keys').expect(200);
    expect(res.body.keys[0].status).toBe('expiring_soon');
    expect(res.body.keys[0].days_until_expiry).toBe(5);
  });

  it('reports active with a null days_until_expiry for a key that never expires', async () => {
    seedKey({ expires_at: null });

    const res = await request(makeApp()).get('/api/v1/keys').expect(200);
    expect(res.body.keys[0].status).toBe('active');
    expect(res.body.keys[0].days_until_expiry).toBeNull();
  });

  it('does NOT echo an expires_in_days field — that name is the REQUEST field', async () => {
    // `expires_in_days` on POST/PATCH means "set the expiry this many days
    // out". A response field of the same name means a countdown that goes
    // negative. One name, two opposite meanings, is how a client ends up
    // PUTting a countdown back as a duration.
    // 2.5 days out, NOT 3: `days_until_expiry` FLOORS, so a whole-day seed is
    // a coin flip on the request clock — sampled in the same millisecond it
    // floors to 3, a millisecond later to 2. The half-day offset puts the
    // value in the middle of a day's band, so it pins 2 no matter how long
    // the request takes. Same reason the expiring_soon test above seeds 5.5.
    seedKey({ expires_at: new Date(Date.now() + 2.5 * DAY_MS).toISOString() });

    const res = await request(makeApp()).get('/api/v1/keys').expect(200);
    expect('expires_in_days' in res.body.keys[0]).toBe(false);
    expect(res.body.keys[0].days_until_expiry).toBe(2);
  });

  it('reports revoked ahead of expired when the row is both', async () => {
    seedKey({
      is_active: false,
      revoked_at: new Date(Date.now() - 10 * DAY_MS).toISOString(),
      expires_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    });

    const res = await request(makeApp()).get('/api/v1/keys').expect(200);
    expect(res.body.keys[0].status).toBe('revoked');
  });

  it('still strips key_hash and org_id — the new fields did not widen the response', async () => {
    seedKey({ expires_at: null });

    const res = await request(makeApp()).get('/api/v1/keys').expect(200);
    expect(res.body.keys[0].key_hash).toBeUndefined();
    expect(res.body.keys[0].org_id).toBeUndefined();
  });
});

describe('POST /api/v1/keys — a created key can never be born expired', () => {
  it('rejects zero days', () => {
    expect(CreateKeySchema.safeParse({ name: 'k', expires_in_days: 0 }).success).toBe(false);
  });

  it('rejects a negative expiry — the shape that would write a past timestamp', () => {
    expect(CreateKeySchema.safeParse({ name: 'k', expires_in_days: -30 }).success).toBe(false);
  });

  it('rejects a fractional expiry', () => {
    expect(CreateKeySchema.safeParse({ name: 'k', expires_in_days: 1.5 }).success).toBe(false);
  });

  it(`caps expiry at ${MAX_EXPIRES_IN_DAYS} days`, () => {
    expect(CreateKeySchema.safeParse({ name: 'k', expires_in_days: MAX_EXPIRES_IN_DAYS }).success).toBe(true);
    expect(CreateKeySchema.safeParse({ name: 'k', expires_in_days: MAX_EXPIRES_IN_DAYS + 1 }).success).toBe(false);
  });

  it('answers 400 with a field-scoped validation error, not a server internal', async () => {
    const res = await request(makeApp())
      .post('/api/v1/keys')
      .send({ name: 'over-cap', scopes: ['verify'], expires_in_days: 999999 })
      .expect(400);

    expect(res.body.error).toBe('validation_error');
    expect(res.body.details.expires_in_days).toBeDefined();
    // Sanitized: no stack, no SQL, no internal identifiers.
    expect(JSON.stringify(res.body)).not.toMatch(/at Object|supabase|postgres|\/src\//i);
  });

  it('writes an expiry strictly after creation for an accepted request', async () => {
    const res = await request(makeApp())
      .post('/api/v1/keys')
      .send({ name: 'bounded', scopes: ['verify'], expires_in_days: 30 })
      .expect(201);

    expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(
      new Date(res.body.created_at).getTime(),
    );
    expect(res.body.status).toBe('active');
    // EXACTLY 30. The route reads the clock ONCE for both the write and the
    // response; reading it twice makes `now + 30d` fall a few milliseconds
    // short of 30 whole days by the time the countdown is floored, so a key
    // created for 30 days reports 29. A range assertion hid that.
    expect(res.body.days_until_expiry).toBe(30);
  });

  it('reports the FULL day count on a one-day key, never "expires today"', async () => {
    // The same off-by-one at its worst: a 1-day key floors to 0, which the
    // dashboard renders as "expires today" on a credential just issued.
    const res = await request(makeApp())
      .post('/api/v1/keys')
      .send({ name: 'one-day', scopes: ['verify'], expires_in_days: 1 })
      .expect(201);

    expect(res.body.days_until_expiry).toBe(1);
  });
});

describe('PATCH /api/v1/keys/:keyId — owner-controlled expiry', () => {
  it('extends an expired key back into the future', async () => {
    const id = seedKey({ expires_at: '2026-07-01T00:00:00.000Z' });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: 90 })
      .expect(200);

    expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.status).toBe('active');
    // Exactly 90, for the same one-clock reason as POST above.
    expect(res.body.days_until_expiry).toBe(90);
  });

  it('sets an expiry from NOW, not from the old expiry — an extend must not stack on a stale base', async () => {
    // The naive implementation is `old_expires_at + n days`. On HakiChain's
    // key that lands 2026-07-01 + 30d = still in the past, and the partner's
    // "extend" would appear to do nothing.
    const id = seedKey({ expires_at: '2026-07-01T00:00:00.000Z' });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: 1 })
      .expect(200);

    expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('clears the expiry with expires_in_days: null', async () => {
    const id = seedKey({ expires_at: new Date(Date.now() + 3 * DAY_MS).toISOString() });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: null })
      .expect(200);

    expect(res.body.expires_at).toBeNull();
    expect(res.body.status).toBe('active');
    expect(res.body.days_until_expiry).toBeNull();
  });

  it('writes an api_key.expiry_changed audit row carrying old and new values', async () => {
    const id = seedKey({ expires_at: '2026-07-01T00:00:00.000Z' });

    await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: 365 })
      .expect(200);

    const call = vi.mocked(recordAuditEvent).mock.calls.find(
      ([row]) => (row as Record<string, unknown>).event_type === 'api_key.expiry_changed',
    );
    expect(call, 'an expiry change must leave an audit trail').toBeDefined();

    const row = call![0] as Record<string, unknown>;
    expect(row.target_type).toBe('api_key');
    expect(row.target_id).toBe(id);
    expect(row.org_id).toBe(h.ORG);

    const details = JSON.parse(row.details as string);
    expect(details.old_expires_at).toBe('2026-07-01T00:00:00.000Z');
    expect(new Date(details.new_expires_at).getTime()).toBeGreaterThan(Date.now());
    // The audit row describes the change, not the credential.
    expect(JSON.stringify(details)).not.toMatch(/key_hash|ak_live_[a-f0-9]{64}/);
  });

  it('logs the expiry change on a CLEAR too', async () => {
    const id = seedKey({ expires_at: '2026-12-01T00:00:00.000Z' });

    await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: null })
      .expect(200);

    const call = vi.mocked(recordAuditEvent).mock.calls.find(
      ([row]) => (row as Record<string, unknown>).event_type === 'api_key.expiry_changed',
    );
    const details = JSON.parse((call![0] as Record<string, unknown>).details as string);
    expect(details.old_expires_at).toBe('2026-12-01T00:00:00.000Z');
    expect(details.new_expires_at).toBeNull();
  });

  it('refuses to extend a REVOKED key — revocation is terminal (409, not a silent no-op)', async () => {
    const id = seedKey({
      is_active: false,
      revoked_at: new Date(Date.now() - DAY_MS).toISOString(),
    });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: 30 })
      .expect(409);

    expect(res.body.error).toBe('api_key_already_revoked');
    // The row is untouched — a refused request must not half-apply.
    expect(h.state.api_keys[0].expires_at).toBeNull();
    expect(vi.mocked(recordAuditEvent).mock.calls.some(
      ([row]) => (row as Record<string, unknown>).event_type === 'api_key.expiry_changed',
    )).toBe(false);
  });

  it('refuses to extend a DEACTIVATED key that carries no revocation stamp (pre-FD-P7 row)', async () => {
    // Revocation used to flip `is_active` without stamping `revoked_at`, so
    // prod holds rows that are withdrawn but unstamped. Guarding on
    // `revoked_at` alone would extend one of those: auth reads `is_active` and
    // would keep refusing it, leaving an owner staring at a future expiry on a
    // key that does not work. Same contradiction the story exists to remove.
    const id = seedKey({ is_active: false, revoked_at: null });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: 30 })
      .expect(409);

    expect(res.body.error).toBe('api_key_already_revoked');
    expect(h.state.api_keys[0].expires_at).toBeNull();
  });

  it('rejects an expires_in_days over the cap', () => {
    expect(UpdateKeySchema.safeParse({ expires_in_days: MAX_EXPIRES_IN_DAYS + 1 }).success).toBe(false);
  });

  it('rejects a non-null expires_at — set an expiry by duration, never by client clock', () => {
    // Accepting an arbitrary timestamp would let a client write a past expiry
    // (defect 3 again, via the other door) and would trust the caller's clock.
    expect(UpdateKeySchema.safeParse({ expires_at: '2030-01-01T00:00:00Z' }).success).toBe(false);
  });

  it('rejects an expiry change bundled with a REACTIVATION', () => {
    // No safe ordering: the caller asked to bring a key back AND to re-time it
    // in one request, and the two readings differ materially.
    expect(UpdateKeySchema.safeParse({ is_active: true, expires_in_days: 30 }).success).toBe(false);
  });

  it('HONOURS a revoke that carries an expiry, dropping the expiry', async () => {
    // A blanket "one intent per request" refusal turned the request that stops
    // a leaked credential into a 400 that revoked nothing, just because the
    // body carried a second field. A revoke is always safe to honour.
    const id = seedKey({ expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString() });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ is_active: false, expires_in_days: 30 })
      .expect(200);

    expect(res.body.status).toBe('revoked');
    expect(h.state.api_keys[0].is_active).toBe(false);
    expect(h.state.api_keys[0].revoked_at).toBeTruthy();
    // The expiry is NOT rewritten onto a key revocation just killed.
    expect(vi.mocked(recordAuditEvent).mock.calls.some(
      ([row]) => (row as Record<string, unknown>).event_type === 'api_key.expiry_changed',
    )).toBe(false);
  });

  // ── An "extend" that quietly shortens ────────────────────────────────────
  //
  // `expires_in_days` REPLACES the expiry; it does not add to it. That is the
  // right semantics (stacking onto a stale base is what leaves HakiChain's key
  // in the past), but it means the SAME request that rescues a lapsed key can
  // amputate a healthy one, and the caller cannot tell the two apart: both are
  // `{expires_in_days: 30}` sent from a button labelled "Extend".

  it('refuses a value EARLIER than the current expiry (409, nothing written)', async () => {
    const farFuture = new Date(Date.now() + 330 * DAY_MS).toISOString();
    const id = seedKey({ expires_at: farFuture });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: 30 })
      .expect(409);

    expect(res.body.error).toBe('api_key_expiry_would_shorten');
    expect(res.body.current_expires_at).toBe(farFuture);
    expect(h.state.api_keys[0].expires_at).toBe(farFuture);
    expect(vi.mocked(recordAuditEvent).mock.calls.some(
      ([row]) => (row as Record<string, unknown>).event_type === 'api_key.expiry_changed',
    )).toBe(false);
  });

  it('refuses to give a NEVER-EXPIRING key an expiry without acknowledgement', async () => {
    // The starkest case: the key lives forever today, so every preset is a
    // reduction, and `Infinity` is the only honest reading of its current end.
    const id = seedKey({ expires_at: null });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: 3650 })
      .expect(409);

    expect(res.body.error).toBe('api_key_expiry_would_shorten');
    expect(res.body.current_expires_at).toBeNull();
    expect(h.state.api_keys[0].expires_at).toBeNull();
  });

  it('applies a shortening when the caller sends allow_shorten', async () => {
    const id = seedKey({ expires_at: new Date(Date.now() + 330 * DAY_MS).toISOString() });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: 30, allow_shorten: true })
      .expect(200);

    expect(res.body.days_until_expiry).toBe(30);
  });

  it('does NOT block a genuine extension', async () => {
    const id = seedKey({ expires_at: new Date(Date.now() + 3 * DAY_MS).toISOString() });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: 90 })
      .expect(200);

    expect(res.body.days_until_expiry).toBe(90);
  });

  it('does NOT block a short extension of an ALREADY-EXPIRED key', async () => {
    // Every forward move improves a key that is already refusing traffic, and
    // this is the remedy path the dashboard offers straight from the failure.
    const id = seedKey({ expires_at: '2026-07-01T00:00:00.000Z' });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: 1 })
      .expect(200);

    expect(res.body.days_until_expiry).toBe(1);
  });

  it('does NOT block REMOVING an expiry — that only lengthens the key\'s life', async () => {
    const id = seedKey({ expires_at: new Date(Date.now() + 3 * DAY_MS).toISOString() });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ expires_in_days: null })
      .expect(200);

    expect(res.body.expires_at).toBeNull();
  });

  it('accepts allow_shorten as a schema field', () => {
    expect(UpdateKeySchema.safeParse({ expires_in_days: 30, allow_shorten: true }).success).toBe(true);
    expect(UpdateKeySchema.safeParse({ expires_in_days: 30, allow_shorten: 'yes' }).success).toBe(false);
  });

  it('leaves the existing revoke path working, untouched', async () => {
    const id = seedKey({ expires_at: null });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ is_active: false, revocation_reason: 'rotated' })
      .expect(200);

    expect(res.body.is_active).toBe(false);
    expect(res.body.revoked_at).toBeTruthy();
    expect(res.body.status).toBe('revoked');
    expect(h.state.api_keys[0].revocation_reason).toBe('rotated');
  });

  it('leaves the existing rename path working, untouched', async () => {
    const id = seedKey({ name: 'before' });

    const res = await request(makeApp())
      .patch(`/api/v1/keys/${id}`)
      .send({ name: 'after' })
      .expect(200);

    expect(res.body.name).toBe('after');
    expect(res.body.expires_at).toBeNull();
  });
});
