import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../utils/db.js', () => ({ db: {} }));
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../config.js', () => ({ config: { logLevel: 'info', nodeEnv: 'test', kRevision: 'test-revision' } }));
vi.mock('./revocation.js', () => ({ processRevokedAnchors: vi.fn() }));
vi.mock('./chain-maintenance.js', () => ({ rebroadcastDroppedTransactions: vi.fn() }));

import { createRunLeaseStore } from './__tests__/__testHelpers.js';
import {
  runLeasedRebroadcastSweep,
  runLeasedRevocationSweep,
} from './leased-chain-jobs.js';
import {
  CLOUD_RUN_REQUEST_TIMEOUT_MS,
  REBROADCAST_RUN_LEASE,
  REVOCATION_RUN_LEASE,
  RUN_LEASE_SPECS,
} from './run-lease.js';

describe('shared lease entry points for chain maintenance', () => {
  it.each(['scheduled.ts', 'cron.ts'])('%s routes every revocation and rebroadcast trigger through the shared entry points', (route) => {
    const source = readFileSync(resolve(import.meta.dirname, `../routes/${route}`), 'utf8');
    expect(source).toContain('runLeasedRevocationSweep');
    expect(source).toContain('runLeasedRebroadcastSweep');
    expect(source).not.toMatch(/\bprocessRevokedAnchors\s*\(/);
    expect(source).not.toMatch(/\brebroadcastDroppedTransactions\s*\(/);
  });

  it.each([
    ['revocation', REVOCATION_RUN_LEASE],
    ['rebroadcast', REBROADCAST_RUN_LEASE],
  ] as const)('%s lease has a unique identity and bounded recovery', (_name, spec) => {
    expect(spec.ttlMs).toBeLessThan(CLOUD_RUN_REQUEST_TIMEOUT_MS);
    expect(spec.maxRunMs).toBeGreaterThanOrEqual(spec.ttlMs);
    expect(spec.leaseId).not.toBe(REVOCATION_RUN_LEASE === spec ? REBROADCAST_RUN_LEASE.leaseId : REVOCATION_RUN_LEASE.leaseId);
  });

  it('records the five-minute revocation cadence in the shared lease invariants', () => {
    expect(REVOCATION_RUN_LEASE.slowestRecordedCadenceMs).toBe(5 * 60_000);
    expect(REVOCATION_RUN_LEASE.ttlMs).toBeGreaterThan(REVOCATION_RUN_LEASE.slowestRecordedCadenceMs);
    expect(RUN_LEASE_SPECS).toContain(REVOCATION_RUN_LEASE);
  });

  it('documents the six-hour rebroadcast cadence without violating the one-hour lease ceiling', () => {
    expect(REBROADCAST_RUN_LEASE.slowestRecordedCadenceMs).toBe(6 * 60 * 60_000);
    expect(RUN_LEASE_SPECS).not.toContain(REBROADCAST_RUN_LEASE);
  });

  it('runs only one revocation body for concurrent callers', async () => {
    const store = createRunLeaseStore(REVOCATION_RUN_LEASE, 'free');
    let release!: () => void;
    const parked = new Promise<void>((resolve) => { release = resolve; });
    const body = vi.fn(async () => { await parked; return { processed: 2, failed: 0 }; });
    const first = runLeasedRevocationSweep(store.client, body);
    await vi.waitFor(() => expect(body).toHaveBeenCalledTimes(1));
    await expect(runLeasedRevocationSweep(store.client, body)).resolves.toEqual({ processed: 0, failed: 0, skipped: 'run-lease-held' });
    release();
    await expect(first).resolves.toEqual({ processed: 2, failed: 0 });
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('runs only one rebroadcast body for concurrent callers', async () => {
    const store = createRunLeaseStore(REBROADCAST_RUN_LEASE, 'free');
    let release!: () => void;
    const parked = new Promise<void>((resolve) => { release = resolve; });
    const body = vi.fn(async () => { await parked; return { checked: 3, rebroadcast: 1, failed: 0, completed: true }; });
    const first = runLeasedRebroadcastSweep(store.client, body);
    await vi.waitFor(() => expect(body).toHaveBeenCalledTimes(1));
    await expect(runLeasedRebroadcastSweep(store.client, body)).resolves.toMatchObject({ skipped: 'run-lease-held' });
    release();
    await expect(first).resolves.toEqual({ checked: 3, rebroadcast: 1, failed: 0, completed: true });
    expect(body).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['revocation', REVOCATION_RUN_LEASE, runLeasedRevocationSweep, { processed: 1, failed: 0 }],
    ['rebroadcast', REBROADCAST_RUN_LEASE, runLeasedRebroadcastSweep, { checked: 1, rebroadcast: 0, failed: 0, completed: true }],
  ] as const)('%s recovers an expired holder and retries after a failed body', async (_name, spec, run, result) => {
    const store = createRunLeaseStore(spec, { held: { holder: 'dead-instance', expiresAt: '2000-01-01T00:00:00.000Z' } });
    const failing = vi.fn(async () => { throw new Error('simulated chain outage'); });
    await expect(run(store.client, failing as never)).rejects.toThrow('simulated chain outage');
    const retry = vi.fn(async () => result);
    await expect(run(store.client, retry as never)).resolves.toMatchObject(result);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
