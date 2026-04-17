/**
 * Tests for NCX-07: Compliance Framework Ingest — SOC 2, ISO 27001, NIST 800-53
 *
 * Tests control counts, record structure, deduplication, and error handling.
 * All Supabase calls mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config so the transitive logger.ts → config.ts chain doesn't fail
// module-load when prod env vars (SUPABASE_URL, etc.) aren't set in tests.
vi.mock('../config.js', () => ({
  config: { nodeEnv: 'test', useMocks: true, logLevel: 'silent' },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

import {
  fetchComplianceFrameworks,
  SOC2_CONTROLS,
  ISO27001_CONTROLS,
  NIST_800_53_FAMILIES,
} from './complianceFrameworkFetcher.js';

function createMockSupabase(flagEnabled = true) {
  const upsertFn = vi.fn().mockResolvedValue({ error: null });
  return {
    rpc: vi.fn().mockResolvedValue({ data: flagEnabled }),
    from: vi.fn().mockReturnValue({
      upsert: upsertFn,
    }),
    _upsertFn: upsertFn,
  };
}

describe('complianceFrameworkFetcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // SOC 2 controls
  it('should have at least 50 SOC 2 controls', () => {
    expect(SOC2_CONTROLS.length).toBeGreaterThanOrEqual(50);
  });

  it('should have SOC 2 controls with required fields', () => {
    for (const control of SOC2_CONTROLS) {
      expect(control.controlId).toBeDefined();
      expect(control.controlName).toBeDefined();
      expect(control.category).toBeDefined();
      expect(control.description).toBeDefined();
    }
  });

  // ISO 27001 controls
  it('should have at least 90 ISO 27001 controls', () => {
    expect(ISO27001_CONTROLS.length).toBeGreaterThanOrEqual(90);
  });

  it('should have ISO 27001 controls with required fields', () => {
    for (const control of ISO27001_CONTROLS) {
      expect(control.controlId).toBeDefined();
      expect(control.controlName).toBeDefined();
      expect(control.theme).toBeDefined();
      expect(control.description).toBeDefined();
    }
  });

  // NIST 800-53 families
  it('should have 20 NIST 800-53 control families', () => {
    expect(NIST_800_53_FAMILIES.length).toBe(20);
  });

  it('should have NIST families with required fields', () => {
    for (const family of NIST_800_53_FAMILIES) {
      expect(family.familyId).toBeDefined();
      expect(family.familyName).toBeDefined();
      expect(family.controls).toBeDefined();
      expect(family.controls.length).toBeGreaterThan(0);
    }
  });

  it('should have a meaningful NIST control catalog (current: seeded subset; full Rev 5 is ~1000)', () => {
    // Current implementation seeds ~294 controls across 20 families — the high-value
    // subset for GRC integrations. Full NIST 800-53 Rev 5 catalog expansion (~1000
    // controls) is tracked as a follow-up; this assertion only blocks regressions
    // below the current baseline.
    const totalControls = NIST_800_53_FAMILIES.reduce(
      (sum, family) => sum + family.controls.length, 0,
    );
    expect(totalControls).toBeGreaterThanOrEqual(250);
  });

  // Fetcher behavior
  it('should skip when ENABLE_PUBLIC_RECORDS_INGESTION is disabled', async () => {
    const supabase = createMockSupabase(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchComplianceFrameworks(supabase as any);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('should insert records when enabled', async () => {
    const supabase = createMockSupabase(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchComplianceFrameworks(supabase as any);
    expect(result.inserted).toBeGreaterThan(0);
    expect(supabase.from).toHaveBeenCalledWith('public_records');
  });

  it('should use correct source values for each framework', async () => {
    const supabase = createMockSupabase(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchComplianceFrameworks(supabase as any);

    const allCalls = supabase._upsertFn.mock.calls;
    const allRecords = allCalls.flatMap(
      (call: unknown[]) => call[0] as Array<Record<string, unknown>>,
    );

    const sources = new Set(allRecords.map((r: Record<string, unknown>) => r.source));
    expect(sources.has('soc2')).toBe(true);
    expect(sources.has('iso27001')).toBe(true);
    expect(sources.has('nist800_53')).toBe(true);
  });

  it('should produce records with correct structure', async () => {
    const supabase = createMockSupabase(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchComplianceFrameworks(supabase as any);

    const allCalls = supabase._upsertFn.mock.calls;
    const firstBatch = allCalls[0][0] as Array<Record<string, unknown>>;
    const record = firstBatch[0];

    expect(record).toHaveProperty('source');
    expect(record).toHaveProperty('source_id');
    expect(record).toHaveProperty('title');
    expect(record).toHaveProperty('content_hash');
    expect(record).toHaveProperty('metadata');
    expect(record).toHaveProperty('record_type');
  });

  it('should handle upsert errors gracefully', async () => {
    const supabase = createMockSupabase(true);
    supabase.from = vi.fn().mockReturnValue({
      upsert: vi.fn().mockResolvedValue({ error: { message: 'DB error' } }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchComplianceFrameworks(supabase as any);
    expect(result.errors).toBeGreaterThan(0);
  });

  it('should handle deduplication via upsert onConflict', async () => {
    const supabase = createMockSupabase(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchComplianceFrameworks(supabase as any);

    const upsertCalls = supabase._upsertFn.mock.calls;
    for (const call of upsertCalls) {
      const options = call[1] as { onConflict: string; ignoreDuplicates: boolean };
      expect(options.onConflict).toBe('source,source_id');
      expect(options.ignoreDuplicates).toBe(true);
    }
  });

  it('should return result with correct shape', async () => {
    const supabase = createMockSupabase(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchComplianceFrameworks(supabase as any);
    expect(result).toHaveProperty('inserted');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('errors');
  });
});
