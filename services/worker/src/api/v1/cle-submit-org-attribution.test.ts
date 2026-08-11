/**
 * POST /cle/submit — org attribution on the created anchor row.
 *
 * The route inserted into `anchors` with `user_id` and no `org_id` at all, on
 * BOTH of its authenticated paths (partner API key and dashboard JWT). The
 * worker runs as service_role and bypasses RLS, so the insert always succeeded
 * — the row was simply created unattributed.
 *
 * What that costs, concretely (the `anchors_select` policy is
 * `user_id = auth.uid() OR org_id = get_user_org_id() OR is_platform_admin()`):
 *
 *   - NOT invisible to its creator — the `user_id` branch still matches. This
 *     is why the gap is silent rather than an obvious "my record vanished".
 *   - Invisible at ORG scope. For a partner API-key submission `user_id` is the
 *     key's owning service user, so no teammate, no ORG_ADMIN, and no org-scoped
 *     dashboard query (`.eq('org_id', orgId)`) can see the record at all.
 *   - `org_id IS NULL` can never be over-visible: `NULL = get_user_org_id()` is
 *     NULL, not true, so a null-org row leaks to no one. The defect is strictly
 *     under-attribution, never over-exposure.
 *   - Quota, credit and billing attribution over CLE anchors all key on
 *     `org_id` (see `anchor-submit.ts`), so these rows were unattributable.
 *
 * `org_id IS NULL` remains LEGITIMATE for an individual attorney with no org —
 * prod carries such rows from other routes — so the fix must set the caller's
 * real org and must NOT invent one. It also must not silently write NULL when
 * the caller DOES have an org but the lookup failed; that would persist a
 * mis-attributed row, which is worse than refusing.
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleVerifyRouter } from './cle-verify.js';

const state = vi.hoisted(() => ({
  /** `profiles` row returned for the JWT path. */
  profileRow: null as { org_id: string | null } | null,
  /** Supabase-shaped error for the `profiles` lookup, when simulating a fault. */
  profileError: null as { code?: string } | null,
  /** Throw from the `profiles` lookup, to cover the transport-error path. */
  profileThrows: false,
  /** Captured `anchors` insert payload — null when no insert was attempted. */
  insertedPayload: null as Record<string, unknown> | null,
}));

vi.mock('../../utils/db.js', () => {
  function profilesQuery() {
    const q: Record<string, unknown> = {};
    const chain = () => q;
    q.select = vi.fn(chain);
    q.eq = vi.fn(chain);
    q.limit = vi.fn(chain);
    q.maybeSingle = vi.fn(() => {
      if (state.profileThrows) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve({ data: state.profileRow, error: state.profileError });
    });
    return q;
  }

  function anchorsQuery() {
    const q: Record<string, unknown> = {};
    const chain = () => q;
    q.select = vi.fn(chain);
    q.eq = vi.fn(chain);
    q.in = vi.fn(chain);
    q.ilike = vi.fn(chain);
    q.order = vi.fn(chain);
    q.gte = vi.fn(chain);
    q.lte = vi.fn(chain);
    q.limit = vi.fn(chain);
    q.insert = vi.fn((payload: Record<string, unknown>) => {
      state.insertedPayload = payload;
      return q;
    });
    q.single = vi.fn(() =>
      Promise.resolve({ data: { id: 'anchor-internal', public_id: 'ARK-CLE-1' }, error: null }),
    );
    return q;
  }

  return {
    db: { from: vi.fn((table: string) => (table === 'profiles' ? profilesQuery() : anchorsQuery())) },
  };
});

vi.mock('../../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../auth.js', () => ({
  verifyAuthToken: vi.fn(() => Promise.resolve('user-jwt-1')),
}));

vi.mock('../../config.js', () => ({
  config: { nodeEnv: 'test', apiKeyHmacSecret: 'test-secret', bitcoinNetwork: 'signet' },
}));

const VALID_SUBMISSION = {
  bar_number: 'BAR-123',
  attorney_name: 'Ada Counsel',
  course_title: 'Ethics Update',
  provider_name: 'State Bar CLE',
  credit_hours: 7,
  credit_category: 'Ethics',
  jurisdiction: 'Michigan',
  completion_date: '2026-04-01',
} as const;

/** `apiKey` set => partner API-key path; omitted => dashboard JWT path. */
function createApp(apiKey?: { orgId: string; userId: string }) {
  const app = express();
  app.use(express.json());
  if (apiKey) {
    app.use((req, _res, next) => {
      (req as unknown as { apiKey: typeof apiKey }).apiKey = apiKey;
      next();
    });
  }
  app.use('/api/v1/cle', cleVerifyRouter);
  return app;
}

describe('POST /cle/submit — anchor org attribution', () => {
  beforeEach(() => {
    state.profileRow = null;
    state.profileError = null;
    state.profileThrows = false;
    state.insertedPayload = null;
  });

  it('stamps the API key\'s org on the anchor row', async () => {
    await request(createApp({ orgId: 'org-partner-1', userId: 'user-svc-1' }))
      .post('/api/v1/cle/submit')
      .send(VALID_SUBMISSION)
      .expect(201);

    expect(state.insertedPayload).not.toBeNull();
    expect(state.insertedPayload).toHaveProperty('org_id', 'org-partner-1');
    expect(state.insertedPayload).toHaveProperty('user_id', 'user-svc-1');
  });

  it('stamps the JWT caller\'s profile org on the anchor row', async () => {
    state.profileRow = { org_id: 'org-dashboard-9' };

    await request(createApp())
      .post('/api/v1/cle/submit')
      .set('Authorization', 'Bearer jwt-test')
      .send(VALID_SUBMISSION)
      .expect(201);

    expect(state.insertedPayload).toHaveProperty('org_id', 'org-dashboard-9');
    expect(state.insertedPayload).toHaveProperty('user_id', 'user-jwt-1');
  });

  it('records a null org for an individual attorney with no org, and still anchors', async () => {
    // A solo practitioner is a first-class caller here. `org_id IS NULL` is the
    // correct, meaningful value for them — not a defect to be papered over.
    state.profileRow = { org_id: null };

    await request(createApp())
      .post('/api/v1/cle/submit')
      .set('Authorization', 'Bearer jwt-test')
      .send(VALID_SUBMISSION)
      .expect(201);

    expect(state.insertedPayload).toHaveProperty('org_id', null);
  });

  it('records a null org when the caller has no profile row at all', async () => {
    state.profileRow = null;

    await request(createApp())
      .post('/api/v1/cle/submit')
      .set('Authorization', 'Bearer jwt-test')
      .send(VALID_SUBMISSION)
      .expect(201);

    expect(state.insertedPayload).toHaveProperty('org_id', null);
  });

  it('refuses rather than creating a mis-attributed row when the org lookup errors', async () => {
    // Fail CLOSED. Coercing a failed lookup into `org_id: null` would persist a
    // row the owning org can never see and can never be billed for — a silent,
    // permanent data-integrity defect. A 503 the caller can retry is strictly
    // better than an unattributable anchor.
    state.profileError = { code: '57014' };

    const res = await request(createApp())
      .post('/api/v1/cle/submit')
      .set('Authorization', 'Bearer jwt-test')
      .send(VALID_SUBMISSION)
      .expect(503);

    expect(state.insertedPayload).toBeNull();
    expect(res.body.error).toBe('org_attribution_unavailable');
    // Never echo the caller's submission back in the failure body.
    expect(JSON.stringify(res.body)).not.toContain('BAR-123');
    expect(JSON.stringify(res.body)).not.toContain('Ada Counsel');
  });

  it('fails closed on a transport-level throw from the org lookup', async () => {
    state.profileThrows = true;

    await request(createApp())
      .post('/api/v1/cle/submit')
      .set('Authorization', 'Bearer jwt-test')
      .send(VALID_SUBMISSION)
      .expect(503);

    expect(state.insertedPayload).toBeNull();
  });

  it('never resolves org from an unauthenticated request', async () => {
    await request(createApp())
      .post('/api/v1/cle/submit')
      .send(VALID_SUBMISSION)
      .expect(401);

    expect(state.insertedPayload).toBeNull();
  });
});
