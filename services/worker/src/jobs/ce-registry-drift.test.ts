/**
 * CE Registry drift reconciliation — tests for the pure decision function and
 * the bounded reconciliation pass.
 */
import { describe, expect, it, vi } from 'vitest';

// Importing the real config.js eagerly runs loadConfig(), which throws without a
// full worker env. The module under test only reads one flag, and every test
// here injects its own `enabled`, so a minimal stand-in is enough.
vi.mock('../config.js', () => ({ config: { enableCeRegistryDriftCheck: false } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn() } }));

import {
  CE_REGISTRY_DRIFT_MAX_BATCH,
  decideCeRegistryDrift,
  reconcileCeRegistryDrift,
  type AnchoredCeRecord,
  type CeRegistryDriftDeps,
} from './ce-registry-drift.js';

const CHECKED_AT = new Date('2026-08-01T12:00:00.000Z');

function record(overrides: Partial<AnchoredCeRecord> = {}): AnchoredCeRecord {
  return {
    anchorId: '11111111-1111-4111-8111-111111111111',
    publicId: 'ARK-2026-CE-001',
    orgId: '22222222-2222-4222-8222-222222222222',
    ctid: 'ce-a4c0a549-aed3-4704-ade2-e81a5d76865b',
    anchoredSha256: 'a'.repeat(64),
    anchoredAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('decideCeRegistryDrift', () => {
  it('reports MATCH when the observed bytes hash to the anchored fingerprint', () => {
    const finding = decideCeRegistryDrift(
      record(),
      { kind: 'fetched', sha256: 'a'.repeat(64) },
      CHECKED_AT,
    );
    expect(finding.verdict).toBe('MATCH');
    expect(finding.observedSha256).toBe('a'.repeat(64));
  });

  it('reports DRIFTED when the registry record content changed', () => {
    const finding = decideCeRegistryDrift(
      record(),
      { kind: 'fetched', sha256: 'b'.repeat(64) },
      CHECKED_AT,
    );
    expect(finding.verdict).toBe('DRIFTED');
    expect(finding.anchoredSha256).toBe('a'.repeat(64));
    expect(finding.observedSha256).toBe('b'.repeat(64));
  });

  it('reports WITHDRAWN when the registry no longer serves the CTID', () => {
    const finding = decideCeRegistryDrift(record(), { kind: 'not_found' }, CHECKED_AT);
    expect(finding.verdict).toBe('WITHDRAWN');
    expect(finding.observedSha256).toBeNull();
  });

  // THE load-bearing distinction. A network failure is NOT evidence that the
  // registry changed; conflating them would make every finding untrustworthy.
  it('reports UNREACHABLE — never DRIFTED — when the fetch failed', () => {
    for (const code of ['registry_timeout', 'registry_bad_gateway', 'registry_record_too_large']) {
      const finding = decideCeRegistryDrift(record(), { kind: 'unreachable', code }, CHECKED_AT);
      expect(finding.verdict).toBe('UNREACHABLE');
      expect(finding.observedSha256).toBeNull();
      expect(finding.detail).toContain(code);
    }
  });

  it('is case-insensitive on the anchored hash but never on its value', () => {
    const finding = decideCeRegistryDrift(
      record({ anchoredSha256: 'A'.repeat(64) }),
      { kind: 'fetched', sha256: 'a'.repeat(64) },
      CHECKED_AT,
    );
    expect(finding.verdict).toBe('MATCH');
  });

  it('stamps the injected clock, never Date.now()', () => {
    const finding = decideCeRegistryDrift(record(), { kind: 'not_found' }, CHECKED_AT);
    expect(finding.checkedAt).toBe('2026-08-01T12:00:00.000Z');
  });

  it('carries no raw registry content on any verdict', () => {
    const serialized = JSON.stringify([
      decideCeRegistryDrift(record(), { kind: 'fetched', sha256: 'b'.repeat(64) }, CHECKED_AT),
      decideCeRegistryDrift(record(), { kind: 'not_found' }, CHECKED_AT),
      decideCeRegistryDrift(record(), { kind: 'unreachable', code: 'registry_timeout' }, CHECKED_AT),
    ]);
    expect(serialized).not.toContain('ceterms:');
    expect(serialized).not.toContain('@graph');
  });
});

describe('reconcileCeRegistryDrift', () => {
  function deps(overrides: Partial<CeRegistryDriftDeps> = {}): CeRegistryDriftDeps {
    return {
      enabled: true,
      now: () => CHECKED_AT,
      loadAnchoredRecords: vi.fn().mockResolvedValue([record()]),
      observeRegistryState: vi.fn().mockResolvedValue({ kind: 'fetched', sha256: 'a'.repeat(64) }),
      reportFinding: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('no-ops when the flag is off — no load, no outbound fetch', async () => {
    const d = deps({ enabled: false });
    const result = await reconcileCeRegistryDrift(d);

    expect(result.skipped).toBe(true);
    expect(d.loadAnchoredRecords).not.toHaveBeenCalled();
    expect(d.observeRegistryState).not.toHaveBeenCalled();
  });

  // A failed LOAD must never be indistinguishable from "nothing to reconcile" —
  // this folder's agents.md records a 70-hour prod outage from that conflation.
  it('reports loadFailed instead of a silent empty pass when the load throws', async () => {
    const d = deps({
      loadAnchoredRecords: vi.fn().mockRejectedValue(new Error('statement timeout')),
    });

    const result = await reconcileCeRegistryDrift(d);

    expect(result).toMatchObject({ skipped: false, loadFailed: true, checked: 0 });
    expect(d.observeRegistryState).not.toHaveBeenCalled();
  });

  it('does not set loadFailed for a genuinely empty cohort', async () => {
    const d = deps({ loadAnchoredRecords: vi.fn().mockResolvedValue([]) });
    const result = await reconcileCeRegistryDrift(d);
    expect(result).toMatchObject({ checked: 0, loadFailed: false, truncated: false });
  });

  // The job's value is COMPLETENESS of the read-back, so a coverage cap must be
  // reported rather than silently swallowed.
  it('flags truncated when the loader returns a full batch', async () => {
    const many = Array.from({ length: CE_REGISTRY_DRIFT_MAX_BATCH }, (_, i) => record({ anchorId: `a${i}` }));
    const d = deps({ loadAnchoredRecords: vi.fn().mockResolvedValue(many) });

    const result = await reconcileCeRegistryDrift(d);

    expect(result.truncated).toBe(true);
    expect(result.checked).toBe(CE_REGISTRY_DRIFT_MAX_BATCH);
  });

  it('does not flag truncated for a partial batch', async () => {
    const result = await reconcileCeRegistryDrift(deps());
    expect(result.truncated).toBe(false);
  });

  it('reports only non-MATCH findings', async () => {
    const d = deps({
      loadAnchoredRecords: vi.fn().mockResolvedValue([
        record({ anchorId: 'match', ctid: 'ce-11111111-1111-4111-8111-111111111111' }),
        record({ anchorId: 'drift', ctid: 'ce-22222222-2222-4222-8222-222222222222' }),
      ]),
      observeRegistryState: vi.fn()
        .mockResolvedValueOnce({ kind: 'fetched', sha256: 'a'.repeat(64) })
        .mockResolvedValueOnce({ kind: 'fetched', sha256: 'c'.repeat(64) }),
    });

    const result = await reconcileCeRegistryDrift(d);

    expect(result).toMatchObject({ skipped: false, checked: 2, match: 1, drifted: 1, withdrawn: 0, unreachable: 0 });
    expect(d.reportFinding).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.reportFinding).mock.calls[0][0]).toMatchObject({ anchorId: 'drift', verdict: 'DRIFTED' });
  });

  it('counts UNREACHABLE separately from DRIFTED in the summary', async () => {
    const d = deps({
      observeRegistryState: vi.fn().mockResolvedValue({ kind: 'unreachable', code: 'registry_timeout' }),
    });

    const result = await reconcileCeRegistryDrift(d);

    expect(result).toMatchObject({ checked: 1, drifted: 0, unreachable: 1 });
  });

  // One bad record must not abort the pass — the remaining anchors still get
  // reconciled, and the failure is surfaced as UNREACHABLE rather than lost.
  it('isolates a per-record failure and keeps going', async () => {
    const d = deps({
      loadAnchoredRecords: vi.fn().mockResolvedValue([
        record({ anchorId: 'boom' }),
        record({ anchorId: 'fine' }),
      ]),
      observeRegistryState: vi.fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce({ kind: 'fetched', sha256: 'a'.repeat(64) }),
    });

    const result = await reconcileCeRegistryDrift(d);

    expect(result).toMatchObject({ checked: 2, match: 1, unreachable: 1 });
  });

  it('never lets a reporting failure abort the pass', async () => {
    const d = deps({
      observeRegistryState: vi.fn().mockResolvedValue({ kind: 'fetched', sha256: 'z'.repeat(64) }),
      reportFinding: vi.fn().mockRejectedValue(new Error('audit insert failed')),
    });

    await expect(reconcileCeRegistryDrift(d)).resolves.toMatchObject({ checked: 1, drifted: 1 });
  });

  it('caps the batch so one pass cannot hammer the public registry', async () => {
    const many = Array.from({ length: CE_REGISTRY_DRIFT_MAX_BATCH + 25 }, (_, i) =>
      record({ anchorId: `a${i}` }));
    const d = deps({ loadAnchoredRecords: vi.fn().mockResolvedValue(many) });

    const result = await reconcileCeRegistryDrift(d);

    expect(result.checked).toBe(CE_REGISTRY_DRIFT_MAX_BATCH);
    expect(d.observeRegistryState).toHaveBeenCalledTimes(CE_REGISTRY_DRIFT_MAX_BATCH);
  });

  it('passes the requested limit down to the loader, clamped to the cap', async () => {
    const d = deps();
    await reconcileCeRegistryDrift(d, { limit: 5 });
    expect(d.loadAnchoredRecords).toHaveBeenCalledWith(5);

    await reconcileCeRegistryDrift(d, { limit: CE_REGISTRY_DRIFT_MAX_BATCH + 500 });
    expect(d.loadAnchoredRecords).toHaveBeenLastCalledWith(CE_REGISTRY_DRIFT_MAX_BATCH);
  });
});
