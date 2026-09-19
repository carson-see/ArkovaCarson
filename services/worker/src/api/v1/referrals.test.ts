/**
 * GET /api/v1/referrals — SCRUM-5024.
 *
 * Exercises the real handler off `referralsRouter.stack`, not a re-implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai' },
}));

import type { Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { referralsRouter } from './referrals.js';

type Handler = (req: Request, res: Response) => Promise<void> | void;

/** The GET / handler as Express itself registered it. */
function getHandler(): Handler {
  const stack = (referralsRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const layer = stack.find((l) => l.route?.path === '/' && l.route.methods.get);
  if (!layer?.route) throw new Error('GET / is not registered on referralsRouter');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** Loose shape covering every response body this suite asserts against —
 *  the success envelope and both error envelopes — without `any`. */
interface TestResBody {
  error?: string;
  message?: string;
  referral_code?: string | null;
  share_url?: string | null;
  referred?: Array<Record<string, unknown>>;
  total?: number;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as TestResBody | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: TestResBody) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: TestResBody };
}

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function apiKeyReq(orgId: string): Request {
  return {
    apiKey: {
      keyId: 'key-1',
      orgId,
      userId: '33333333-3333-4333-8333-333333333333',
      scopes: ['read:orgs'],
      rateLimitTier: 'free' as const,
      keyPrefix: 'ak_live_aaaa',
    },
  } as unknown as Request;
}

/** Records the org_id every read was filtered by, so tenant scoping is asserted
 *  on the QUERY, not only on the response body. */
let codeEqCalls: Array<[string, unknown]>;

function stubCodeRead(result: { data: unknown; error: unknown }) {
  (db.from as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        codeEqCalls.push([col, val]);
        return chain;
      },
      maybeSingle: () => Promise.resolve(result),
    };
    return chain;
  });
}

const ROWS = [
  {
    organization_public_id: 'org_referred_1',
    display_name: 'Referred One',
    referred_at: '2026-09-01T10:00:00.000Z',
    verification_status: 'VERIFIED',
  },
  {
    organization_public_id: null,
    display_name: 'Legacy Org With No Public Id',
    referred_at: '2026-08-20T09:00:00.000Z',
    verification_status: 'UNVERIFIED',
  },
];

describe('GET /api/v1/referrals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codeEqCalls = [];
  });

  it('401s an anonymous caller — requireScope passes those through, so the handler must not', async () => {
    const res = mockRes();
    await getHandler()({} as Request, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('authentication_required');
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('scopes both reads to the KEY org, never to a caller-supplied value', async () => {
    stubCodeRead({ data: { code: 'ABCD2345' }, error: null });
    (db.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: ROWS, error: null });

    const req = apiKeyReq(ORG_A);
    // A hostile caller putting another org on the request must have no effect.
    (req as unknown as { query: unknown }).query = { org_id: ORG_B };
    (req as unknown as { body: unknown }).body = { org_id: ORG_B };

    const res = mockRes();
    await getHandler()(req, res);

    expect(codeEqCalls).toContainEqual(['org_id', ORG_A]);
    expect(codeEqCalls).not.toContainEqual(['org_id', ORG_B]);
    expect(db.rpc).toHaveBeenCalledWith('get_org_referrals', { p_org_id: ORG_A });
  });

  it('returns the code, the share link and the attributed organizations', async () => {
    stubCodeRead({ data: { code: 'ABCD2345' }, error: null });
    (db.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: ROWS, error: null });

    const res = mockRes();
    await getHandler()(apiKeyReq(ORG_A), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.referral_code).toBe('ABCD2345');
    expect(res.body.share_url).toBe('https://app.arkova.ai/signup?ref=ABCD2345');
    expect(res.body.total).toBe(2);
    expect(res.body.referred?.[0]?.organization_public_id).toBe('org_referred_1');
  });

  it('OMITS organization_public_id rather than publishing a null', async () => {
    stubCodeRead({ data: { code: 'ABCD2345' }, error: null });
    (db.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: ROWS, error: null });

    const res = mockRes();
    await getHandler()(apiKeyReq(ORG_A), res);

    expect('organization_public_id' in (res.body.referred?.[1] ?? {})).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('"organization_public_id":null');
  });

  it('an org with no minted code is 200 with nulls and an empty list, not 404', async () => {
    stubCodeRead({ data: null, error: null });
    (db.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], error: null });

    const res = mockRes();
    await getHandler()(apiKeyReq(ORG_A), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ referral_code: null, share_url: null, referred: [], total: 0 });
  });

  it('a failed referral read is a 500 — never an empty list', async () => {
    stubCodeRead({ data: { code: 'ABCD2345' }, error: null });
    (db.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { message: 'statement timeout', code: '57014' },
    });

    const res = mockRes();
    await getHandler()(apiKeyReq(ORG_A), res);

    // Answering 200 with `referred: []` here would tell a partner they referred
    // nobody, which is the hollow-200 failure mode this repo has shipped before.
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('internal_error');
  });

  it('a failed code read is a 500', async () => {
    stubCodeRead({ data: null, error: { message: 'permission denied', code: '42501' } });

    const res = mockRes();
    await getHandler()(apiKeyReq(ORG_A), res);

    expect(res.statusCode).toBe(500);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('a thrown client is a 500, not an unhandled rejection', async () => {
    (db.from as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('connection reset');
    });

    const res = mockRes();
    await getHandler()(apiKeyReq(ORG_A), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('internal_error');
  });

  it('leaks no internal uuid in any key or value, at any depth or casing', async () => {
    stubCodeRead({ data: { code: 'ABCD2345' }, error: null });
    (db.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: ROWS, error: null });

    const res = mockRes();
    await getHandler()(apiKeyReq(ORG_A), res);

    const BANNED_KEY = /^(id|org_?id|user_?id|referral_?code_?id|referred_?org_?id|referrer_?org_?id|actor_?id)$/i;
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          expect(BANNED_KEY.test(k), `banned key ${path}.${k}`).toBe(false);
          walk(v, `${path}.${k}`);
        }
        return;
      }
      if (typeof node === 'string') {
        expect(UUID.test(node), `uuid value at ${path}`).toBe(false);
      }
    };

    walk(res.body, '$');
  });
});
