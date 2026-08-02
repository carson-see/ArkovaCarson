/**
 * SEC — `POST /api/verify-anchor` must not be an unauthenticated fingerprint oracle.
 *
 * The route was mounted at `app.use('/api', anchorRouter)` (index.ts:404) with
 * NO auth middleware and queried `anchors` through the **service_role** client
 * (RLS bypassed) with **no status filter**. A hit returned `anchor_timestamp`,
 * `network_receipt_id`, `credential_type` and `record_uri` — the latter being
 * the `public_id` **capability** the owner chose to share. A miss returned a
 * bare `{ verified: false }`. Anyone holding a fingerprint could therefore
 * convert document possession into: existence, lifecycle status (including
 * PENDING / SUBMITTED / SUPERSEDED / EXPIRED / REVOKED anchors that are NOT
 * deliberately published), issue time, the on-chain receipt id, and the
 * shareable record link.
 *
 * The route bypassed `get_public_anchor_by_fingerprint`, so the SQL-side
 * SECURED-only hardening (migration 0386) did not cover it. It had no
 * first-party consumers, so it was removed rather than auth-gated.
 *
 * The invariant asserted here is **indistinguishability**, not merely
 * "returns not found": an anonymous caller must get a byte-identical status
 * and body for a fingerprint that exists and one that never did. A
 * distinguishable error path is still an oracle.
 *
 * These are real HTTP round-trips against a real Express app wired the same
 * way `index.ts` wires it (router mount + JSON 404 fallback), so the assertion
 * covers the mount and the fallback, not just the handler.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

const { mockExtractAuthUserId, mockFrom, mockLogger } = vi.hoisted(() => ({
  mockExtractAuthUserId: vi.fn(),
  mockFrom: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./middleware.js', () => ({
  corsMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  extractAuthUserId: mockExtractAuthUserId,
}));

vi.mock('../utils/rateLimit.js', () => ({
  rateLimiters: {
    checkout: (_req: Request, _res: Response, next: NextFunction) => next(),
  },
}));

vi.mock('../utils/db.js', () => ({ db: { from: mockFrom } }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.test', corsAllowedOrigins: '' },
}));

import { anchorRouter } from './anchor.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

const FP_SECURED = 'a'.repeat(64);
const FP_PENDING = 'b'.repeat(64);
const FP_REVOKED = 'c'.repeat(64);
const FP_NEVER_SEEN = 'd'.repeat(64);
const FP_MALFORMED = 'not-a-sha256';

/**
 * Rows the service_role client WOULD have returned. If any future change
 * reintroduces a fingerprint lookup, these are the values it would disclose,
 * and the assertions below will catch them.
 */
const ROWS: Record<string, Record<string, unknown>> = {
  [FP_SECURED]: {
    fingerprint: FP_SECURED,
    status: 'SECURED',
    chain_tx_id: 'e4c1'.repeat(16),
    chain_block_height: 872_431,
    chain_timestamp: '2026-01-15T10:30:00.000Z',
    public_id: 'anc_secured_capability_token',
    created_at: '2026-01-15T09:00:00.000Z',
    credential_type: 'DIPLOMA',
  },
  [FP_PENDING]: {
    fingerprint: FP_PENDING,
    status: 'PENDING',
    chain_tx_id: null,
    chain_block_height: null,
    chain_timestamp: null,
    public_id: 'anc_pending_capability_token',
    created_at: '2026-07-30T11:00:00.000Z',
    credential_type: 'LICENSE',
  },
  [FP_REVOKED]: {
    fingerprint: FP_REVOKED,
    status: 'REVOKED',
    chain_tx_id: 'aa11'.repeat(16),
    chain_block_height: 861_002,
    chain_timestamp: '2026-02-02T08:00:00.000Z',
    public_id: 'anc_revoked_capability_token',
    created_at: '2026-02-02T07:00:00.000Z',
    credential_type: 'TRANSCRIPT',
  },
};

/** Mirrors the PostgREST builder chain the removed route used. */
function anchorsChain(): Record<string, unknown> {
  let requestedFingerprint: string | null = null;
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((_col: string, value: string) => {
      requestedFingerprint = value;
      return chain;
    }),
    is: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({
      data: requestedFingerprint ? (ROWS[requestedFingerprint] ?? null) : null,
      error: null,
    })),
  };
  return chain;
}

// ─── app under test: wired exactly as index.ts wires it ──────────────────────

const app = express();
app.use(express.json());
app.use('/api', anchorRouter); // index.ts:404
// index.ts:550 — JSON 404 fallback, after all route mounts.
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'not_found',
    message: 'The requested endpoint does not exist. See /api/docs for available endpoints.',
  });
});

const server = app.listen(0);
const { port } = server.address() as AddressInfo;

afterAll(() => {
  server.close();
});

interface Probe {
  status: number;
  body: unknown;
}

/** POST /api/verify-anchor with NO Authorization header — the pen-test caller. */
async function probeAnonymous(fingerprint: unknown): Promise<Probe> {
  const res = await fetch(`http://127.0.0.1:${port}/api/verify-anchor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprint }),
  });
  return { status: res.status, body: await res.json() };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('POST /api/verify-anchor — unauthenticated fingerprint oracle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Anonymous by construction: no bearer token resolves to a user.
    mockExtractAuthUserId.mockResolvedValue(null);
    mockFrom.mockImplementation(() => anchorsChain());
  });

  it('is indistinguishable between an existing SECURED anchor and a never-seen fingerprint', async () => {
    const hit = await probeAnonymous(FP_SECURED);
    const miss = await probeAnonymous(FP_NEVER_SEEN);

    expect(hit.status).toBe(miss.status);
    expect(hit.body).toEqual(miss.body);
  });

  it('is indistinguishable between a PENDING anchor and a never-seen fingerprint', async () => {
    const hit = await probeAnonymous(FP_PENDING);
    const miss = await probeAnonymous(FP_NEVER_SEEN);

    expect(hit.status).toBe(miss.status);
    expect(hit.body).toEqual(miss.body);
  });

  it('is indistinguishable between a REVOKED anchor and a never-seen fingerprint', async () => {
    const hit = await probeAnonymous(FP_REVOKED);
    const miss = await probeAnonymous(FP_NEVER_SEEN);

    expect(hit.status).toBe(miss.status);
    expect(hit.body).toEqual(miss.body);
  });

  it('is indistinguishable between a malformed fingerprint, a missing one, and a never-seen one', async () => {
    const malformed = await probeAnonymous(FP_MALFORMED);
    const missing = await probeAnonymous(undefined);
    const miss = await probeAnonymous(FP_NEVER_SEEN);

    expect(malformed.status).toBe(miss.status);
    expect(malformed.body).toEqual(miss.body);
    expect(missing.status).toBe(miss.status);
    expect(missing.body).toEqual(miss.body);
  });

  it('never discloses the public_id capability, on-chain receipt, timestamp or credential type', async () => {
    for (const fp of [FP_SECURED, FP_PENDING, FP_REVOKED]) {
      const { body } = await probeAnonymous(fp);
      const serialized = JSON.stringify(body ?? {});

      expect(serialized).not.toContain('capability_token'); // public_id / record_uri
      expect(serialized).not.toContain('DIPLOMA');
      expect(serialized).not.toContain('LICENSE');
      expect(serialized).not.toContain('TRANSCRIPT');
      expect(serialized).not.toContain('2026-01-15');
      expect(serialized).not.toContain('e4c1e4c1');
      expect(serialized).not.toContain('SECURED');
      expect(serialized).not.toContain('REVOKED');
    }
  });

  it('does not reach the anchors table at all, so there is no data-dependent timing either', async () => {
    // No DB round-trip on any path means no index-hit vs index-miss latency
    // differential — the timing channel is closed structurally, not tuned.
    await probeAnonymous(FP_SECURED);
    await probeAnonymous(FP_NEVER_SEEN);
    await probeAnonymous(FP_MALFORMED);

    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('registers no /verify-anchor route on the anchor router', async () => {
    interface RouteLayer {
      route?: { path: string };
    }
    const stack = (anchorRouter as unknown as { stack: RouteLayer[] }).stack;
    const paths = stack.map((entry) => entry.route?.path).filter(Boolean);

    expect(paths).not.toContain('/verify-anchor');
  });
});
