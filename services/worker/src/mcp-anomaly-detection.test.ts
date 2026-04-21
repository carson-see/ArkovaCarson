/**
 * MCP anomaly detection tests — MCP-SEC-09 / SCRUM-987.
 *
 * Pure function tests — clock + Sentry emitter are injected.
 */

import { describe, expect, it, vi } from 'vitest';

// @ts-nocheck — edge source is outside worker rootDir; Vitest resolves at runtime
import {
  createAnomalyDetector,
  sendToSentry,
  type AnomalyAlert,
  type AnomalyEvent,
} from '../../edge/src/mcp-anomaly-detection.js';

function makeEvent(over: Partial<AnomalyEvent> = {}): AnomalyEvent {
  return {
    toolName: 'verify_credential',
    apiKeyId: 'key-1',
    userId: 'user-1',
    orgId: 'org-1',
    clientIp: '10.0.0.5',
    outcome: 'success',
    argsBytes: 42,
    timestamp: 1_000_000,
    ...over,
  };
}

describe('rapid_tool_cycling', () => {
  it('fires when one key hits ≥ threshold distinct tools in the window', () => {
    const alerts: AnomalyAlert[] = [];
    const det = createAnomalyDetector({
      windowMs: 60_000,
      rapidToolCycleThreshold: 4,
      now: () => 1_000_000,
      emit: (a) => alerts.push(a),
    });
    ['a', 'b', 'c', 'd', 'e'].forEach((t, i) =>
      det.ingest(makeEvent({ toolName: t, timestamp: 1_000_000 - (5 - i) * 100 })),
    );
    const signals = alerts.map((a) => a.signal);
    expect(signals).toContain('rapid_tool_cycling');
  });

  it('does not fire below threshold', () => {
    const alerts: AnomalyAlert[] = [];
    const det = createAnomalyDetector({
      rapidToolCycleThreshold: 10,
      now: () => 1_000_000,
      emit: (a) => alerts.push(a),
    });
    ['a', 'b'].forEach((t) => det.ingest(makeEvent({ toolName: t })));
    expect(alerts).toHaveLength(0);
  });

  it('resets after the window expires', () => {
    const alerts: AnomalyAlert[] = [];
    let t = 1_000_000;
    const det = createAnomalyDetector({
      windowMs: 1_000,
      rapidToolCycleThreshold: 3,
      dedupeMs: 100,
      now: () => t,
      emit: (a) => alerts.push(a),
    });
    ['a', 'b'].forEach((tool) => det.ingest(makeEvent({ toolName: tool, timestamp: t })));
    t += 2_000;
    // Only one new tool in the new window; threshold = 3.
    det.ingest(makeEvent({ toolName: 'c', timestamp: t }));
    expect(alerts).toHaveLength(0);
  });
});

describe('auth_failure_burst', () => {
  it('fires when > threshold auth failures from the same actor', () => {
    const alerts: AnomalyAlert[] = [];
    const det = createAnomalyDetector({
      authFailureThreshold: 3,
      now: () => 1_000_000,
      emit: (a) => alerts.push(a),
    });
    for (let i = 0; i < 4; i++) det.ingest(makeEvent({ outcome: 'auth_failed' }));
    expect(alerts.some((a) => a.signal === 'auth_failure_burst')).toBe(true);
  });

  it('counts by clientIp when apiKeyId is null', () => {
    const alerts: AnomalyAlert[] = [];
    const det = createAnomalyDetector({
      authFailureThreshold: 2,
      now: () => 1_000_000,
      emit: (a) => alerts.push(a),
    });
    for (let i = 0; i < 3; i++) {
      det.ingest(makeEvent({ apiKeyId: null, clientIp: '1.2.3.4', outcome: 'auth_failed' }));
    }
    expect(alerts.some((a) => a.signal === 'auth_failure_burst')).toBe(true);
  });
});

describe('cross_tenant_access', () => {
  it('fires when one key touches ≥ threshold orgs', () => {
    const alerts: AnomalyAlert[] = [];
    const det = createAnomalyDetector({
      crossTenantThreshold: 3,
      now: () => 1_000_000,
      emit: (a) => alerts.push(a),
    });
    ['org-a', 'org-b', 'org-c'].forEach((org) =>
      det.ingest(makeEvent({ orgId: org })),
    );
    expect(alerts.some((a) => a.signal === 'cross_tenant_access')).toBe(true);
  });
});

describe('oversized_args', () => {
  it('fires when payload exceeds threshold', () => {
    const alerts: AnomalyAlert[] = [];
    const det = createAnomalyDetector({
      oversizedArgsThreshold: 1024,
      now: () => 1_000_000,
      emit: (a) => alerts.push(a),
    });
    det.ingest(makeEvent({ argsBytes: 2048 }));
    expect(alerts.some((a) => a.signal === 'oversized_args')).toBe(true);
  });
});

describe('rate_limit_storm', () => {
  it('fires when same actor hits rate limit ≥ threshold times', () => {
    const alerts: AnomalyAlert[] = [];
    const det = createAnomalyDetector({
      rateLimitStormThreshold: 3,
      now: () => 1_000_000,
      emit: (a) => alerts.push(a),
    });
    for (let i = 0; i < 4; i++) det.ingest(makeEvent({ outcome: 'rate_limited' }));
    expect(alerts.some((a) => a.signal === 'rate_limit_storm')).toBe(true);
  });
});

describe('dedupe', () => {
  it('does not re-emit the same fingerprint within dedupeMs', () => {
    const alerts: AnomalyAlert[] = [];
    const det = createAnomalyDetector({
      oversizedArgsThreshold: 10,
      dedupeMs: 10 * 60_000,
      now: () => 1_000_000,
      emit: (a) => alerts.push(a),
    });
    det.ingest(makeEvent({ argsBytes: 100 }));
    det.ingest(makeEvent({ argsBytes: 200 }));
    expect(alerts.filter((a) => a.signal === 'oversized_args')).toHaveLength(1);
  });

  it('re-emits after dedupeMs passes', () => {
    const alerts: AnomalyAlert[] = [];
    let t = 1_000_000;
    const det = createAnomalyDetector({
      oversizedArgsThreshold: 10,
      dedupeMs: 1_000,
      windowMs: 60_000,
      now: () => t,
      emit: (a) => alerts.push(a),
    });
    det.ingest(makeEvent({ argsBytes: 100, timestamp: t }));
    t += 2_000;
    det.ingest(makeEvent({ argsBytes: 100, timestamp: t }));
    expect(alerts.filter((a) => a.signal === 'oversized_args').length).toBeGreaterThanOrEqual(2);
  });
});

describe('sendToSentry', () => {
  it('rejects malformed DSNs', async () => {
    await expect(sendToSentry('not-a-dsn', {} as AnomalyAlert)).rejects.toThrow();
  });

  it('POSTs a minimal envelope to Sentry', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchSpy;
    await sendToSentry(
      'https://abc@o123.ingest.sentry.io/4567',
      {
        signal: 'oversized_args',
        fingerprint: 'x',
        severity: 'warning',
        summary: 'big payload',
        detail: {},
      },
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = fetchSpy.mock.calls[0];
    expect(String(call[0])).toContain('/api/4567/store/');
    expect((call[1] as RequestInit).headers).toMatchObject({
      'X-Sentry-Auth': expect.stringContaining('sentry_key=abc'),
    });
  });
});
