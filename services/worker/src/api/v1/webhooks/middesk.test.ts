/**
 * Middesk webhook handler tests (SCRUM-1162)
 *
 * Covers signature verification, replay protection, and status-transition
 * logic without any live network calls. DB is mocked via vi.mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../../utils/db.js', () => ({
  db: {
    from: vi.fn(),
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

import { db } from '../../../utils/db.js';
import { middeskWebhookRouter } from './middesk.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDb = db as any;

const WEBHOOK_SECRET = 'whsec_test_arkova';

function createApp() {
  const app = express();
  app.use(
    '/webhooks/middesk',
    express.raw({ type: 'application/json' }),
    (req, _res, next) => {
      (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
      next();
    },
    middeskWebhookRouter,
  );
  return app;
}

function signBody(body: string | Buffer, secret = WEBHOOK_SECRET): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

const VALID_EVENT = {
  object: 'event',
  id: 'evt_abc',
  type: 'business.updated',
  data: {
    object: {
      id: 'biz_999',
      external_id: '10000000-1000-4000-8000-000000000001',
      status: 'pending',
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MIDDESK_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

describe('POST /webhooks/middesk', () => {
  it('returns 503 when MIDDESK_WEBHOOK_SECRET is not set', async () => {
    delete process.env.MIDDESK_WEBHOOK_SECRET;
    const app = createApp();
    const body = JSON.stringify(VALID_EVENT);
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', signBody(body, 'any'))
      .send(body);
    expect(res.status).toBe(503);
  });

  it('returns 401 on missing signature header', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(VALID_EVENT));
    expect(res.status).toBe(401);
  });

  it('returns 401 on invalid signature', async () => {
    const app = createApp();
    const body = JSON.stringify(VALID_EVENT);
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', 'a'.repeat(64))
      .send(body);
    expect(res.status).toBe(401);
  });

  it('returns 200 on duplicate (nonce unique-violation)', async () => {
    mockDb.from.mockImplementationOnce(() => ({
      insert: vi.fn().mockResolvedValueOnce({ error: { code: '23505' } }),
    }));

    const app = createApp();
    const body = JSON.stringify(VALID_EVENT);
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', signBody(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
  });

  it('returns 200 orphaned when org not found', async () => {
    // First call: nonce insert succeeds.
    // Second & third calls: organizations lookups (by id, then kyb_reference_id) return null.
    let call = 0;
    mockDb.from.mockImplementation(() => {
      call++;
      if (call === 1) {
        return { insert: vi.fn().mockResolvedValueOnce({ error: null }) };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValueOnce({ data: null, error: null }),
      };
    });

    const app = createApp();
    const body = JSON.stringify(VALID_EVENT);
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', signBody(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.orphaned).toBe(true);
  });

  it('SCRUM-1217: PostgREST filter syntax in external_id cannot inject into the org lookup', async () => {
    // Hostile external_id value attempts to inject a second clause via
    // PostgREST `.or()` syntax. With the new `.eq()` lookup this just
    // becomes a literal value that the DB compares character-for-character
    // (and never matches anything), so the call falls through to the
    // kyb_reference_id lookup with the trusted vendor id.
    const HOSTILE = ').or(verification_status.eq.VERIFIED';
    const hostileEvent = {
      ...VALID_EVENT,
      id: 'evt_hostile',
      data: {
        object: {
          id: 'biz_attack',
          external_id: HOSTILE,
          status: 'pending',
        },
      },
    };

    const eqCalls: Array<{ field: string; value: unknown }> = [];
    let call = 0;
    mockDb.from.mockImplementation(() => {
      call++;
      if (call === 1) {
        return { insert: vi.fn().mockResolvedValueOnce({ error: null }) };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((field: string, value: unknown) => {
          eqCalls.push({ field, value });
          return {
            maybeSingle: vi.fn().mockResolvedValueOnce({ data: null, error: null }),
          };
        }),
      };
    });

    const app = createApp();
    const body = JSON.stringify(hostileEvent);
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', signBody(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.orphaned).toBe(true);
    // Exactly two lookups, each with a fixed column name (no payload-derived
    // column names) and the payload value as a literal value, never a filter.
    expect(eqCalls).toHaveLength(2);
    expect(eqCalls[0]).toEqual({ field: 'id', value: HOSTILE });
    expect(eqCalls[1]).toEqual({ field: 'kyb_reference_id', value: 'biz_attack' });
    // Field names are hardcoded column names — none derived from the payload.
    expect(eqCalls.every((c) => c.field === 'id' || c.field === 'kyb_reference_id')).toBe(true);
  });

  it('inserts event + flips verification_status on verified event', async () => {
    const verifiedEvent = { ...VALID_EVENT, id: 'evt_verified', type: 'business.verified' };
    const orgId = verifiedEvent.data.object.external_id;
    const body = JSON.stringify(verifiedEvent);

    let call = 0;
    let capturedEventInsert: Record<string, unknown> | null = null;
    let capturedOrgUpdate: Record<string, unknown> | null = null;

    mockDb.from.mockImplementation(() => {
      call++;
      if (call === 1) {
        // kyb_webhook_nonces insert
        return { insert: vi.fn().mockResolvedValueOnce({ error: null }) };
      }
      if (call === 2) {
        // organizations lookup by id (external_id present → first lookup hits this branch)
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValueOnce({
            data: { id: orgId },
            error: null,
          }),
        };
      }
      if (call === 3) {
        // kyb_events insert
        return {
          insert: vi.fn().mockImplementationOnce((row: Record<string, unknown>) => {
            capturedEventInsert = row;
            return Promise.resolve({ error: null });
          }),
        };
      }
      // organizations.update
      return {
        update: vi.fn().mockImplementationOnce((row: Record<string, unknown>) => {
          capturedOrgUpdate = row;
          return { eq: vi.fn().mockResolvedValueOnce({ error: null }) };
        }),
      };
    });

    const app = createApp();
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', signBody(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(capturedEventInsert).toMatchObject({
      org_id: orgId,
      provider: 'middesk',
      event_type: 'business.verified',
      status: 'verified',
      provider_event_id: 'evt_verified',
    });
    expect(capturedOrgUpdate).toMatchObject({ verification_status: 'VERIFIED' });
  });

  /**
   * AUDIT-0424-10 (durability half): the replay nonce is committed BEFORE the
   * kyb_events insert and the organizations update. So when a downstream write
   * fails the handler returns 500 — but Middesk's retry re-presents the same
   * event.id, hits the nonce UNIQUE violation, and is answered
   * `200 {duplicate:true}`. The rejection is then permanently lost AND the
   * provider is told everything succeeded.
   *
   * That is what made the CHECK-constraint defect silent rather than noisy: the
   * 23514 did not produce an endless retry, it produced one 500 and then a
   * cheerful 200. Widening the constraint (migration 0407) fixes the specific
   * write, but any transient failure would still swallow a rejection. The
   * handler must release the nonce on every post-nonce failure path so the
   * retry can genuinely reprocess — the same compensating-delete pattern
   * stripe/handlers.ts uses for `webhook_event_claims`.
   */
  describe('AUDIT-0424-10: releases the replay nonce on post-nonce failure', () => {
    const REJECTION_EVENT = {
      ...VALID_EVENT,
      id: 'evt_reject',
      type: 'business.rejected',
      data: {
        object: {
          id: 'biz_999',
          external_id: '10000000-1000-4000-8000-000000000001',
          status: 'rejected',
        },
      },
    };

    /**
     * `kyb_webhook_nonces` has a COMPOSITE primary key `(provider, nonce)`, so
     * the release must filter on BOTH columns. Deleting by `nonce` alone would
     * drop any other provider's row that happened to carry the same event id —
     * silently disarming that provider's replay protection. This helper records
     * the full filter chain so the tests can assert both.
     *
     * @param failAt which write fails after the nonce is committed
     * @returns `filters`, the ordered [column, value] pairs of the delete chain
     */
    function mockFlowFailingAt(failAt: 'kyb_events' | 'organizations') {
      const filters: Array<[string, unknown]> = [];
      // Chainable eq: records each filter and is itself awaitable, so the same
      // mock serves a one-eq or two-eq chain.
      const makeEq = (): ((col: string, val: unknown) => unknown) =>
        vi.fn((col: string, val: unknown) => {
          filters.push([col, val]);
          const thenable = Promise.resolve({ error: null }) as Promise<{ error: unknown }> & {
            eq: unknown;
          };
          thenable.eq = makeEq();
          return thenable;
        });
      const nonceDelete = vi.fn(() => ({ eq: makeEq() }));

      mockDb.from.mockImplementation((table: string) => {
        if (table === 'kyb_webhook_nonces') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
            delete: nonceDelete,
          };
        }
        if (table === 'kyb_events') {
          return {
            insert: vi.fn().mockResolvedValue({
              error: failAt === 'kyb_events' ? { code: '23503', message: 'boom' } : null,
            }),
          };
        }
        if (table === 'organizations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'org-001' }, error: null }),
            // The real 23514 the un-widened CHECK constraint raised.
            update: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({
                error:
                  failAt === 'organizations'
                    ? {
                        code: '23514',
                        message:
                          'new row violates check constraint "organizations_verification_status_valid"',
                      }
                    : null,
              }),
            })),
          };
        }
        return {};
      });

      return { filters };
    }

    async function postRejection() {
      const app = createApp();
      const body = JSON.stringify(REJECTION_EVENT);
      return request(app)
        .post('/webhooks/middesk')
        .set('Content-Type', 'application/json')
        .set('x-middesk-signature', signBody(body))
        .send(body);
    }

    it('releases the nonce when the organizations update fails', async () => {
      const { filters } = mockFlowFailingAt('organizations');

      const res = await postRejection();

      expect(res.status).toBe(500);
      // Without this, the Middesk retry short-circuits as a duplicate and the
      // rejection is lost forever. Both PK columns must be filtered — see the
      // composite-key note on mockFlowFailingAt.
      expect(filters).toEqual([
        ['provider', 'middesk'],
        ['nonce', 'evt_reject'],
      ]);
    });

    it('releases the nonce when the kyb_events insert fails', async () => {
      const { filters } = mockFlowFailingAt('kyb_events');

      const res = await postRejection();

      expect(res.status).toBe(500);
      expect(filters).toEqual([
        ['provider', 'middesk'],
        ['nonce', 'evt_reject'],
      ]);
    });

    it('does NOT release the nonce on success (replay protection intact)', async () => {
      const nonceDeleteEq = vi.fn().mockResolvedValue({ error: null });
      mockDb.from.mockImplementation((table: string) => {
        if (table === 'kyb_webhook_nonces') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
            delete: vi.fn(() => ({ eq: nonceDeleteEq })),
          };
        }
        if (table === 'kyb_events') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === 'organizations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'org-001' }, error: null }),
            update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
          };
        }
        return {};
      });

      const res = await postRejection();

      expect(res.status).toBe(200);
      expect(nonceDeleteEq).not.toHaveBeenCalled();
    });
  });

  it('returns 400 on malformed body', async () => {
    mockDb.from.mockImplementationOnce(() => ({
      insert: vi.fn().mockResolvedValueOnce({ error: null }),
    }));

    const app = createApp();
    const body = 'not valid json at all';
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', signBody(body))
      .send(body);
    // Signature verifies (body is bytes), then JSON parse fails → 400
    expect(res.status).toBe(400);
  });
});

/**
 * AUDIT-0424-10 — code/constraint parity for `organizations.verification_status`.
 *
 * The original defect was not that the Middesk handler wrote the wrong value:
 * it wrote exactly the right one. `REJECTED` and `REQUIRES_INPUT` were simply
 * not admitted by the live CHECK constraint
 * `organizations_verification_status_valid`, so the UPDATE raised SQLSTATE
 * 23514 and a real KYB rejection could not be recorded at all. The same gap
 * made the checkout handler's `currentStatus === 'REJECTED'` guard dead code.
 *
 * A unit test with a mocked DB cannot see that — the mock accepts any string.
 * So this asserts the invariant directly against the migration set: every value
 * the worker can write must be admitted by the effective constraint. A census
 * of call sites would miss the next one; this does not.
 */
describe('AUDIT-0424-10: verification_status code/constraint parity', () => {
  const migrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../../supabase/migrations',
  );

  /**
   * Effective allow-list = the LAST definition of the constraint across the
   * migration set in applied (filename) order. The baseline sorts first, so a
   * later widening migration correctly wins.
   */
  function effectiveAllowedStatuses(): string[] {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    let allowed: string[] | null = null;

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      // Match each CHECK body attached to the named constraint, taking the last
      // occurrence within the file as well (a file may drop then re-add).
      const re = /organizations_verification_status_valid[\s\S]{0,400}?ARRAY\s*\[([^\]]*)\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) {
        allowed = [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
      }
    }
    return allowed ?? [];
  }

  it('finds the constraint definition in the migration set', () => {
    // Guards the regex itself: a silent no-match would make every assertion
    // below vacuously... loud, but for the wrong reason.
    expect(effectiveAllowedStatuses().length).toBeGreaterThan(0);
  });

  it('admits every status the Middesk webhook can write', () => {
    const allowed = effectiveAllowedStatuses();
    // The three terminal outcomes middesk.ts maps from mapMiddeskEventToStatus.
    // Kept as literals on purpose: this test is the independent statement of
    // what the code writes, so importing the module under test would let both
    // sides drift together.
    for (const status of ['VERIFIED', 'REJECTED', 'REQUIRES_INPUT']) {
      expect(allowed, `constraint must admit ${status}`).toContain(status);
    }
  });

  it('still admits the pre-KYB lifecycle states', () => {
    const allowed = effectiveAllowedStatuses();
    for (const status of ['UNVERIFIED', 'PENDING']) {
      expect(allowed, `constraint must still admit ${status}`).toContain(status);
    }
  });
});
