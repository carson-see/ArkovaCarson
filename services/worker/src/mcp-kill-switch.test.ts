/**
 * MCP kill-switch tests — MCP-SEC-10 / SCRUM-929.
 *
 * The flag fetcher + clock are injected so every branch (enabled,
 * disabled, cache hit, cache expiry, fail-open on RPC failure) is
 * covered without a live DB.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  isMcpEnabled,
  mcpDisabledResponse,
  __resetKillSwitchCache,
} from '../../edge/src/mcp-kill-switch.js';

const BASE_ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };

beforeEach(() => {
  __resetKillSwitchCache();
});

describe('isMcpEnabled', () => {
  it('returns true when the flag resolves true', async () => {
    const result = await isMcpEnabled({
      env: BASE_ENV,
      fetchFlag: async () => true,
    });
    expect(result).toBe(true);
  });

  it('returns false when the flag resolves false', async () => {
    const result = await isMcpEnabled({
      env: BASE_ENV,
      fetchFlag: async () => false,
    });
    expect(result).toBe(false);
  });

  it('caches the flag for 30s inside the isolate', async () => {
    const fetchSpy = vi.fn(async () => true);
    let t = 1_000_000;
    const deps = { env: BASE_ENV, fetchFlag: fetchSpy, now: () => t };

    await isMcpEnabled(deps);
    await isMcpEnabled(deps);
    t += 25_000;
    await isMcpEnabled(deps);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the TTL expires', async () => {
    const fetchSpy = vi.fn(async () => true);
    let t = 1_000_000;
    const deps = { env: BASE_ENV, fetchFlag: fetchSpy, now: () => t };

    await isMcpEnabled(deps);
    t += 31_000;
    await isMcpEnabled(deps);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('fail-opens on RPC non-OK response via the default fetcher', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 500 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchSpy;
    const result = await isMcpEnabled({ env: BASE_ENV });
    expect(result).toBe(true);
  });

  it('fail-opens on null flag value', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify(null), { status: 200 }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchSpy;
    const result = await isMcpEnabled({ env: BASE_ENV });
    expect(result).toBe(true);
  });

  it('does not cache the fail-open result when the fetcher signals failure (null)', async () => {
    const fetchSpy = vi.fn(async () => null);
    const deps = { env: BASE_ENV, fetchFlag: fetchSpy };

    const a = await isMcpEnabled(deps);
    const b = await isMcpEnabled(deps);

    expect(a).toBe(true);
    expect(b).toBe(true);
    // Uncached — next request should re-try the flag read.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('mcpDisabledResponse', () => {
  it('returns a 503 with Retry-After + standard envelope', async () => {
    const res = mcpDisabledResponse('https://app.arkova.ai');
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.arkova.ai');
    const body = (await res.json()) as { error: string; retry_after_seconds: number };
    expect(body.error).toBe('mcp_disabled');
    expect(body.retry_after_seconds).toBe(60);
  });
});
