/**
 * Unit tests for the anchoring RPC credential probe.
 *
 * TDD: written before the implementation.
 *
 * The regression under test is a VERIFIED production defect (2026-08-30):
 * the stored `bitcoin-rpc-url` GetBlock token was revoked and returned
 * HTTP 401 "Unknown token", yet prod `/health` kept reporting
 * `{"status":"healthy","checks":{"anchoring":"ok"}}`. `anchoring.status`
 * was a hardcoded literal in compact mode — it never contacted the RPC
 * provider at all, so a dead anchoring credential was invisible to every
 * monitor, alert and soak that trusts /health.
 *
 * Constitution refs:
 *   - 1.4: never leak secrets — prod BITCOIN_RPC_URL carries the access token
 *     in the URL PATH (`https://go.getblock.io/<TOKEN>`), so no probe output
 *     may contain the full URL.
 *   - 1.7: no real Bitcoin calls — fetch is injected and mocked.
 *   - 1.9: /health always available; the probe must never make it throw.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  createAnchoringRpcMonitor,
  probeAnchoringRpcOnce,
  evaluateAnchoringRpcHealth,
  ANCHORING_RPC_TTL_MS,
  ANCHORING_RPC_TIMEOUT_MS,
  type AnchoringRpcProbeResult,
} from './anchoring-rpc-probe.js';

const RPC_URL = 'https://go.getblock.io/super-secret-access-token';

function jsonResponse(status: number, body: unknown, ok = status >= 200 && status < 300) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('probeAnchoringRpcOnce', () => {
  it('returns ok when the RPC answers with a JSON-RPC result (probe 200 -> ok)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { jsonrpc: '2.0', id: 1, result: 913_244 }));

    const result = await probeAnchoringRpcOnce(
      { rpcUrl: RPC_URL, rpcAuth: undefined },
      { fetchImpl, now: () => 1_000 },
    );

    expect(result.state).toBe('ok');
    expect(result.blockHeight).toBe(913_244);
    expect(result.httpStatus).toBe(200);
    expect(result.checkedAtMs).toBe(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the cheapest read-only RPC method and never a wallet/write method', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { result: 1 }));

    await probeAnchoringRpcOnce({ rpcUrl: RPC_URL }, { fetchImpl, now: () => 0 });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    expect(body.method).toBe('getblockcount');
    expect(body.params).toEqual([]);
    expect(init.method).toBe('POST');
  });

  // ─── THE REGRESSION THAT HID THE 2026-08-30 OUTAGE ───
  it('returns unauthenticated (NOT ok) when the credential is revoked (probe 401)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'Unknown token' }, false));

    const result = await probeAnchoringRpcOnce({ rpcUrl: RPC_URL }, { fetchImpl, now: () => 5 });

    expect(result.state).toBe('unauthenticated');
    expect(result.state).not.toBe('ok');
    expect(result.httpStatus).toBe(401);
  });

  it('returns unauthenticated on 403 as well', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, {}, false));

    const result = await probeAnchoringRpcOnce({ rpcUrl: RPC_URL }, { fetchImpl, now: () => 5 });

    expect(result.state).toBe('unauthenticated');
  });

  it('returns unknown (NOT ok) when the probe times out', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });

    const result = await probeAnchoringRpcOnce({ rpcUrl: RPC_URL }, { fetchImpl, now: () => 7 });

    expect(result.state).toBe('unknown');
    expect(result.state).not.toBe('ok');
  });

  it('returns unreachable (NOT ok) on a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const result = await probeAnchoringRpcOnce({ rpcUrl: RPC_URL }, { fetchImpl, now: () => 9 });

    expect(result.state).toBe('unreachable');
    expect(result.state).not.toBe('ok');
  });

  it('returns unreachable (NOT ok) on a 5xx provider fault', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}, false));

    const result = await probeAnchoringRpcOnce({ rpcUrl: RPC_URL }, { fetchImpl, now: () => 9 });

    expect(result.state).toBe('unreachable');
  });

  it('returns not_configured without calling fetch when no RPC URL is set', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { result: 1 }));

    const result = await probeAnchoringRpcOnce({ rpcUrl: undefined }, { fetchImpl, now: () => 0 });

    expect(result.state).toBe('not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws — any failure becomes a state, not an exception', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('catastrophic');
    });

    await expect(
      probeAnchoringRpcOnce({ rpcUrl: RPC_URL }, { fetchImpl, now: () => 0 }),
    ).resolves.toMatchObject({ state: 'unreachable' });
  });

  // ─── §1.4: the URL carries the credential in its PATH ───
  it('never leaks the RPC URL or token in any field of the result', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'Unknown token' }, false));

    const result = await probeAnchoringRpcOnce({ rpcUrl: RPC_URL }, { fetchImpl, now: () => 0 });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret-access-token');
    expect(serialized).not.toContain(RPC_URL);
    expect(result.endpoint).toBe('https://go.getblock.io');
  });

  it('never leaks the rpcAuth basic-auth credential', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });

    const result = await probeAnchoringRpcOnce(
      { rpcUrl: RPC_URL, rpcAuth: 'rpcuser:hunter2' },
      { fetchImpl, now: () => 0 },
    );

    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('sends Basic auth when rpcAuth is configured', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { result: 1 }));

    await probeAnchoringRpcOnce(
      { rpcUrl: RPC_URL, rpcAuth: 'rpcuser:hunter2' },
      { fetchImpl, now: () => 0 },
    );

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('rpcuser:hunter2').toString('base64')}`);
  });

  // ─── F-D0-5 (feedback_bounded_body_reads, R0-7 / SCRUM-1253) ───
  // AbortSignal.timeout() bounds the REQUEST, not the body read. A provider
  // that sends headers and then stalls parks `await response.json()` forever;
  // undici's bodyTimeout only fires on TOTAL silence, so a trickling socket
  // holds it open indefinitely. That exact park (check-confirmations, fullsoak
  // 2026-08-12) suspended a run inside withRunLease whose heartbeat kept
  // renewing the lease, disabling SUBMITTED->SECURED for every tenant for 35+
  // minutes with zero warn/error logs.
  //
  // This probe refreshes on a 60s TTL against a public health endpoint, so a
  // wedged provider is re-contacted ~every minute. Bounding the read is not
  // enough on its own: the abandoned stream must also be cancelled, or each
  // refresh leaks another half-open socket for as long as the provider stays
  // wedged. Both properties are asserted here.
  it('bounds a stalled body read AND cancels the abandoned stream', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async (_reason?: unknown) => undefined);
      const stalled = {
        ok: true,
        status: 200,
        // Headers arrived; the body never does.
        json: () => new Promise<never>(() => {}),
        text: () => new Promise<never>(() => {}),
        body: { cancel },
      } as unknown as Response;

      const pending = probeAnchoringRpcOnce(
        { rpcUrl: RPC_URL },
        { fetchImpl: async () => stalled, now: () => 0 },
      );

      await vi.advanceTimersByTimeAsync(ANCHORING_RPC_TIMEOUT_MS + 1);
      const result = await pending;

      // Bounded: settles as an honest `unknown`, never a fabricated `ok`.
      expect(result.state).toBe('unknown');
      // Socket hygiene: the wedged stream is released, not leaked per refresh.
      expect(cancel).toHaveBeenCalledTimes(1);

      // §1.4: the timeout error embeds whatever label the caller passed. It
      // must be the sanitized ORIGIN, never the token-in-path URL.
      const cancelReason = cancel.mock.calls[0]?.[0] as Error | undefined;
      expect(String(cancelReason?.message ?? '')).not.toContain('super-secret-access-token');
      expect(JSON.stringify(result)).not.toContain('super-secret-access-token');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a hard timeout well under the Cloud Run probe budget', () => {
    expect(ANCHORING_RPC_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
    expect(ANCHORING_RPC_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('createAnchoringRpcMonitor (TTL cache)', () => {
  it('does not call the probe a second time inside the TTL', async () => {
    let now = 10_000;
    const probe = vi.fn(async (): Promise<AnchoringRpcProbeResult> => ({
      state: 'ok',
      endpoint: 'https://go.getblock.io',
      checkedAtMs: now,
    }));

    const monitor = createAnchoringRpcMonitor({ probe, ttlMs: 60_000, now: () => now });

    monitor.read();
    await monitor.settled();
    expect(probe).toHaveBeenCalledTimes(1);

    // Many reads inside the TTL — still exactly one network probe.
    now += 30_000;
    for (let i = 0; i < 50; i += 1) monitor.read();
    await monitor.settled();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(monitor.read().state).toBe('ok');
  });

  it('refreshes once the TTL has elapsed', async () => {
    let now = 0;
    const probe = vi.fn(async (): Promise<AnchoringRpcProbeResult> => ({
      state: 'ok',
      endpoint: 'https://go.getblock.io',
      checkedAtMs: now,
    }));

    const monitor = createAnchoringRpcMonitor({ probe, ttlMs: 60_000, now: () => now });

    monitor.read();
    await monitor.settled();
    expect(probe).toHaveBeenCalledTimes(1);

    now += 60_001;
    monitor.read();
    await monitor.settled();

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('returns unknown on a cold cache and never blocks the caller on the network', async () => {
    let resolveProbe: (r: AnchoringRpcProbeResult) => void = () => {};
    const probe = vi.fn(
      () => new Promise<AnchoringRpcProbeResult>((resolve) => {
        resolveProbe = resolve;
      }),
    );

    const monitor = createAnchoringRpcMonitor({ probe, ttlMs: 60_000, now: () => 0 });

    // Synchronous read while the probe is still in flight: must not hang,
    // must not lie. This is what keeps /health latency independent of the
    // provider — a stalled GetBlock can never slow or fail a health probe.
    const snapshot = monitor.read();
    expect(snapshot.state).toBe('unknown');

    resolveProbe({ state: 'ok', endpoint: 'https://go.getblock.io', checkedAtMs: 0 });
    await monitor.settled();

    expect(monitor.read().state).toBe('ok');
  });

  it('collapses concurrent refreshes into a single in-flight probe', async () => {
    let resolveProbe: (r: AnchoringRpcProbeResult) => void = () => {};
    const probe = vi.fn(
      () => new Promise<AnchoringRpcProbeResult>((resolve) => {
        resolveProbe = resolve;
      }),
    );

    const monitor = createAnchoringRpcMonitor({ probe, ttlMs: 60_000, now: () => 0 });

    for (let i = 0; i < 25; i += 1) monitor.read();

    expect(probe).toHaveBeenCalledTimes(1);

    resolveProbe({ state: 'ok', endpoint: null, checkedAtMs: 0 });
    await monitor.settled();
  });

  it('never throws or rejects when the probe itself rejects', async () => {
    const probe = vi.fn(async (): Promise<AnchoringRpcProbeResult> => {
      throw new Error('provider exploded');
    });

    const monitor = createAnchoringRpcMonitor({ probe, ttlMs: 60_000, now: () => 0 });

    expect(() => monitor.read()).not.toThrow();
    await expect(monitor.settled()).resolves.toBeUndefined();
    expect(monitor.read().state).toBe('unknown');
  });

  it('keeps serving the last known verdict while a refresh is in flight', async () => {
    let now = 0;
    let resolveProbe: (r: AnchoringRpcProbeResult) => void = () => {};
    const probe = vi
      .fn<() => Promise<AnchoringRpcProbeResult>>()
      .mockResolvedValueOnce({ state: 'unauthenticated', endpoint: null, checkedAtMs: 0 })
      .mockImplementationOnce(
        () => new Promise<AnchoringRpcProbeResult>((resolve) => {
          resolveProbe = resolve;
        }),
      );

    const monitor = createAnchoringRpcMonitor({ probe, ttlMs: 60_000, now: () => now });

    monitor.read();
    await monitor.settled();
    expect(monitor.read().state).toBe('unauthenticated');

    // TTL expires; a refresh starts but has not landed. A dead credential must
    // NOT silently revert to 'ok' just because the next probe is pending.
    now += 60_001;
    expect(monitor.read().state).toBe('unauthenticated');

    resolveProbe({ state: 'ok', endpoint: null, checkedAtMs: now });
    await monitor.settled();
    expect(monitor.read().state).toBe('ok');
  });

  // Regression: a rejecting probe used to leave checkedAtMs null, so `age`
  // stayed Infinity and EVERY read re-fired the probe — a hot loop against the
  // provider on an endpoint polled every 30s.
  it('still honours the TTL backoff after a rejecting probe (no hot loop)', async () => {
    let now = 0;
    const probe = vi.fn(async (): Promise<AnchoringRpcProbeResult> => {
      throw new Error('provider exploded');
    });

    const monitor = createAnchoringRpcMonitor({ probe, ttlMs: 60_000, now: () => now });

    monitor.read();
    await monitor.settled();
    expect(probe).toHaveBeenCalledTimes(1);

    // 100 reads inside the TTL after a FAILED probe: still no new calls.
    now += 30_000;
    for (let i = 0; i < 100; i += 1) monitor.read();
    await monitor.settled();
    expect(probe).toHaveBeenCalledTimes(1);

    now += 30_001;
    monitor.read();
    await monitor.settled();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not downgrade a known-dead credential when a later probe rejects', async () => {
    let now = 0;
    const probe = vi
      .fn<() => Promise<AnchoringRpcProbeResult>>()
      .mockResolvedValueOnce({ state: 'unauthenticated', endpoint: null, checkedAtMs: 0 })
      .mockRejectedValueOnce(new Error('provider exploded'));

    const monitor = createAnchoringRpcMonitor({ probe, ttlMs: 60_000, now: () => now });
    monitor.read();
    await monitor.settled();
    expect(monitor.read().state).toBe('unauthenticated');

    now += 60_001;
    monitor.read();
    await monitor.settled();

    // A revoked credential must not be laundered back into 'unknown' (and
    // certainly not 'ok') just because the confirming probe failed.
    expect(monitor.read().state).toBe('unauthenticated');
  });

  it('defaults to a TTL that keeps provider load trivial at min-instances 2', () => {
    expect(ANCHORING_RPC_TTL_MS).toBeGreaterThanOrEqual(30_000);
    expect(ANCHORING_RPC_TTL_MS).toBeLessThanOrEqual(120_000);
  });
});

describe('evaluateAnchoringRpcHealth', () => {
  it('degrades to warning ONLY on a definitive credential rejection', () => {
    expect(evaluateAnchoringRpcHealth({ state: 'unauthenticated', endpoint: null, checkedAtMs: 0 }).status)
      .toBe('warning');
  });

  it('stays ok for verified-healthy', () => {
    expect(evaluateAnchoringRpcHealth({ state: 'ok', endpoint: null, checkedAtMs: 0 }).status).toBe('ok');
  });

  it.each(['unknown', 'unreachable', 'not_configured'] as const)(
    'does not degrade on transient/unproven state %s (no deploy-gate flapping)',
    (state) => {
      expect(evaluateAnchoringRpcHealth({ state, endpoint: null, checkedAtMs: 0 }).status).toBe('ok');
    },
  );

  it('reports credentialVerified true only when the probe actually succeeded', () => {
    expect(evaluateAnchoringRpcHealth({ state: 'ok', endpoint: null, checkedAtMs: 0 }).credentialVerified)
      .toBe(true);
    for (const state of ['unknown', 'unreachable', 'not_configured', 'unauthenticated'] as const) {
      expect(evaluateAnchoringRpcHealth({ state, endpoint: null, checkedAtMs: 0 }).credentialVerified)
        .toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review findings (PR #2507 code review, 2026-08-31)
// ─────────────────────────────────────────────────────────────────────────────

describe('createAnchoringRpcMonitor — startup warm-up (HIGH)', () => {
  it('probes at construction so the first read is not a cold `unknown`', async () => {
    // The single-shot health curls in deploy-staging.yml / verify-worker-runtime.yml
    // always hit a freshly started revision. If the monitor only probes on first
    // read(), those gates evaluate a cold `unknown` -> compact `ok`, i.e. exactly
    // the manufactured-ok this PR exists to remove.
    const probe = vi.fn().mockResolvedValue({
      state: 'unauthenticated' as const, endpoint: 'https://p', checkedAtMs: 1, httpStatus: 401,
    });
    const monitor = createAnchoringRpcMonitor({ probe, ttlMs: 60_000, now: () => 1 });
    await monitor.settled();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(monitor.read().state).toBe('unauthenticated');
  });
});

describe('probeAnchoringRpcOnce — auth failures delivered as HTTP 200 (MEDIUM)', () => {
  it('classifies an auth-shaped JSON-RPC error envelope as unauthenticated', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { error: { code: -32001, message: 'Unknown token' } }),
    );
    const res = await probeAnchoringRpcOnce({ rpcUrl: RPC_URL }, { fetchImpl, now: () => 5 });
    expect(res.state).toBe('unauthenticated');
  });

  it('leaves a non-auth JSON-RPC error as unreachable', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { error: { code: -32601, message: 'Method not found' } }),
    );
    const res = await probeAnchoringRpcOnce({ rpcUrl: RPC_URL }, { fetchImpl, now: () => 5 });
    expect(res.state).toBe('unreachable');
  });
});

describe('probeAnchoringRpcOnce — `ok` must mean a verified call (LOW)', () => {
  it('does not report ok when the 200 body carries no numeric height', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { result: null }));
    const res = await probeAnchoringRpcOnce({ rpcUrl: RPC_URL }, { fetchImpl, now: () => 5 });
    expect(res.state).not.toBe('ok');
  });
});

describe('evaluateAnchoringRpcHealth — not_configured while prod anchoring is on (MEDIUM)', () => {
  it('degrades when the RPC URL is absent but prod anchoring is enabled', () => {
    const v = evaluateAnchoringRpcHealth(
      { state: 'not_configured', endpoint: null, checkedAtMs: 0 },
      { prodAnchoringEnabled: true },
    );
    expect(v.status).toBe('warning');
    expect(v.credentialVerified).toBe(false);
  });

  it('stays ok off-prod, where an unset RPC URL is expected', () => {
    expect(
      evaluateAnchoringRpcHealth(
        { state: 'not_configured', endpoint: null, checkedAtMs: 0 },
        { prodAnchoringEnabled: false },
      ).status,
    ).toBe('ok');
  });

  it('never degrades on transient states even with prod anchoring on', () => {
    for (const state of ['unreachable', 'unknown'] as const) {
      expect(
        evaluateAnchoringRpcHealth(
          { state, endpoint: null, checkedAtMs: 0 },
          { prodAnchoringEnabled: true },
        ).status,
      ).toBe('ok');
    }
  });
});
