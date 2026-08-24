/**
 * Edge MCP server — `oracle_batch_verify` envelope tests (DI-038 / SCRUM-3398).
 *
 * Plain-node Vitest, same harness as `mcp-tools.test.ts`: `fetch` is mocked
 * per-test and RPC-shaped rows come ONLY from the migration-pinned
 * `__fixtures__/publicAnchor` fixture, never hand-authored.
 *
 * WHAT THESE PIN (DI-038): `oracle_batch_verify` used to fan out through
 * `handleVerifyCredential` and then `JSON.parse(result.content[0].text)`.
 * The handler's catch branches return BARE PROSE (`errorResult`), not JSON —
 * `'Verification lookup timed out'` / `'Verification lookup failed: …'` — so
 * `JSON.parse` threw a SyntaxError, rejected the whole `Promise.all`, and the
 * outer catch returned `safeErrorText(...)`. One transient per-credential
 * timeout therefore discarded EVERY successfully-verified credential in the
 * batch, on a public agent-facing tool documented for bulk (max-25) workflows.
 *
 * The per-member degradation shape asserted here is the one `handleVerifyBatch`
 * already uses — `{ public_id, verified: false, error }` — so the two batch
 * paths cannot drift.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { buildOracleBatchEnvelope } from './mcp-server.js';
import type { SupabaseConfig } from './mcp-tools.js';
import type { Env } from './env.js';
import { realPublicAnchorRow } from './__fixtures__/publicAnchor.js';

const CONFIG: SupabaseConfig = {
  supabaseUrl: 'https://test.supabase.co',
  supabaseKey: 'test-key',
  userId: 'test-user-id',
};

/** Minimal Env — same `as unknown as Env` shape used by src/tests/edge/mcp-security.test.ts. */
function envWith(overrides: Partial<Env> = {}): Env {
  return { ...overrides } as unknown as Env;
}

type RpcRoute = () => Promise<{ ok: boolean; json?: () => Promise<unknown> }>;

/** A member whose RPC lookup succeeds. */
function ok(overrides: Parameters<typeof realPublicAnchorRow>[0] = {}): RpcRoute {
  return async () => ({ ok: true, json: async () => realPublicAnchorRow(overrides) });
}

/** A member the RPC has no row for (PostgREST non-2xx). */
function notFound(): RpcRoute {
  return async () => ({ ok: false });
}

/** A member whose lookup exceeds SUPABASE_FETCH_TIMEOUT_MS and is aborted. */
function timesOut(): RpcRoute {
  return async () => {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    throw err;
  };
}

/** A member whose lookup fails at the transport layer, with internal detail in the message. */
function networkFailure(): RpcRoute {
  return async () => {
    throw new TypeError('fetch failed: connect ECONNREFUSED 10.11.12.13:5432');
  };
}

/** Dispatch each mocked RPC call by the `p_public_id` in its request body. */
function routeByPublicId(routes: Record<string, RpcRoute>) {
  return async (_url: string, init?: { body?: string }) => {
    const pid = (JSON.parse(String(init?.body ?? '{}')) as { p_public_id?: string }).p_public_id;
    const route = pid ? routes[pid] : undefined;
    if (!route) throw new Error(`test bug: unrouted public_id ${String(pid)}`);
    return route();
  };
}

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  // buildOracleBatchEnvelope warns once per isolate when MCP_SIGNING_KEY is
  // unset; keep the suite output clean without asserting on it.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** Unwrap the unsigned-envelope body an unsigned dev/preview call returns. */
function payloadOf(result: { content: { text: string }[] }): {
  query_id: string;
  queried_at: string;
  results: Record<string, unknown>[];
} {
  return JSON.parse(result.content[0].text).payload;
}

describe('buildOracleBatchEnvelope — DI-038 partial results survive a per-credential failure', () => {
  it('keeps every successful credential when one member times out', async () => {
    mockFetch.mockImplementation(
      routeByPublicId({
        'ARK-2026-001': ok({ public_id: 'ARK-2026-001', network_receipt_id: 'tx-1' }),
        'ARK-2026-002': timesOut(),
        'ARK-2026-003': ok({ public_id: 'ARK-2026-003', network_receipt_id: 'tx-3' }),
      }),
    );

    const result = await buildOracleBatchEnvelope(
      ['ARK-2026-001', 'ARK-2026-002', 'ARK-2026-003'],
      CONFIG,
      envWith(),
    );

    // The whole point: a transient timeout is NOT a batch-wide failure.
    expect(result.isError).toBeFalsy();

    const payload = payloadOf(result);
    expect(payload.results).toHaveLength(3);
    // Input order is part of the documented contract.
    expect(payload.results.map((r) => r.public_id)).toEqual([
      'ARK-2026-001',
      'ARK-2026-002',
      'ARK-2026-003',
    ]);
    expect(payload.results[0]).toMatchObject({ verified: true, network_receipt_id: 'tx-1' });
    expect(payload.results[1]).toEqual({
      public_id: 'ARK-2026-002',
      verified: false,
      error: 'Verification lookup timed out',
    });
    expect(payload.results[2]).toMatchObject({ verified: true, network_receipt_id: 'tx-3' });
  });

  it('keeps successful credentials when a member fails at the transport layer', async () => {
    mockFetch.mockImplementation(
      routeByPublicId({
        'ARK-2026-001': ok({ public_id: 'ARK-2026-001' }),
        'ARK-2026-002': networkFailure(),
      }),
    );

    const result = await buildOracleBatchEnvelope(
      ['ARK-2026-001', 'ARK-2026-002'],
      CONFIG,
      envWith(),
    );

    expect(result.isError).toBeFalsy();
    const payload = payloadOf(result);
    expect(payload.results).toHaveLength(2);
    expect(payload.results[0]).toMatchObject({ public_id: 'ARK-2026-001', verified: true });
    expect(payload.results[1]).toEqual({
      public_id: 'ARK-2026-002',
      verified: false,
      error: 'Verification lookup failed',
    });
  });

  it('does not leak transport-error internals (host/port) into the public envelope', async () => {
    mockFetch.mockImplementation(
      routeByPublicId({
        'ARK-2026-001': ok({ public_id: 'ARK-2026-001' }),
        'ARK-2026-002': networkFailure(),
      }),
    );

    const result = await buildOracleBatchEnvelope(
      ['ARK-2026-001', 'ARK-2026-002'],
      CONFIG,
      envWith(),
    );

    expect(result.content[0].text).not.toContain('ECONNREFUSED');
    expect(result.content[0].text).not.toContain('10.11.12.13');
  });

  it('degrades an unknown public_id to verified:false without discarding the batch', async () => {
    mockFetch.mockImplementation(
      routeByPublicId({
        'ARK-2026-001': ok({ public_id: 'ARK-2026-001' }),
        'ARK-NOPE-999': notFound(),
      }),
    );

    const result = await buildOracleBatchEnvelope(
      ['ARK-2026-001', 'ARK-NOPE-999'],
      CONFIG,
      envWith(),
    );

    expect(result.isError).toBeFalsy();
    const payload = payloadOf(result);
    expect(payload.results[1]).toEqual({
      public_id: 'ARK-NOPE-999',
      verified: false,
      error: 'Credential "ARK-NOPE-999" not found.',
    });
  });

  it('still fails the batch loudly when every member fails', async () => {
    mockFetch.mockImplementation(
      routeByPublicId({
        'ARK-2026-001': timesOut(),
        'ARK-2026-002': timesOut(),
      }),
    );

    const result = await buildOracleBatchEnvelope(
      ['ARK-2026-001', 'ARK-2026-002'],
      CONFIG,
      envWith(),
    );

    // Not an MCP-level error — the envelope is still well-formed — but every
    // row reports its own failure, which is what an agent can act on.
    const payload = payloadOf(result);
    expect(payload.results.every((r) => r.verified === false)).toBe(true);
    expect(payload.results.every((r) => r.error === 'Verification lookup timed out')).toBe(true);
  });
});

describe('buildOracleBatchEnvelope — envelope contract (unchanged by DI-038)', () => {
  it('emits query_id + queried_at and the explicit signed:false marker when unsigned', async () => {
    mockFetch.mockImplementation(routeByPublicId({ 'ARK-2026-001': ok() }));

    const result = await buildOracleBatchEnvelope(['ARK-2026-001'], CONFIG, envWith());

    const body = JSON.parse(result.content[0].text);
    expect(body.signed).toBe(false);
    expect(body.signature).toBeNull();
    expect(typeof body.payload.query_id).toBe('string');
    expect(Number.isNaN(Date.parse(body.payload.queried_at))).toBe(false);
  });

  it('signs the envelope when MCP_SIGNING_KEY is provisioned', async () => {
    mockFetch.mockImplementation(routeByPublicId({ 'ARK-2026-001': ok() }));

    const result = await buildOracleBatchEnvelope(
      ['ARK-2026-001'],
      CONFIG,
      envWith({ MCP_SIGNING_KEY: 'test-signing-key' }),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.alg).toBe('HMAC-SHA256');
    expect(typeof body.signature).toBe('string');
  });

  it('fails closed when EDGE_REQUIRE_MCP_SIGNING is "true" and no key is provisioned', async () => {
    mockFetch.mockImplementation(routeByPublicId({ 'ARK-2026-001': ok() }));

    const result = await buildOracleBatchEnvelope(
      ['ARK-2026-001'],
      CONFIG,
      envWith({ EDGE_REQUIRE_MCP_SIGNING: 'true' }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('signing_key_missing');
  });
});
