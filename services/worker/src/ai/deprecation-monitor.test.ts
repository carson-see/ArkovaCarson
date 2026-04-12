/**
 * GME-05: Deprecation Monitoring Tests
 *
 * Verifies that the deprecation monitor correctly tracks model deprecation dates
 * and emits warnings when models approach their sunset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkDeprecationStatus,
  getDeprecationWarnings,
  MODEL_DEPRECATION_DATES,
} from './deprecation-monitor.js';

describe('deprecation-monitor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('exports known deprecation dates', () => {
    expect(MODEL_DEPRECATION_DATES).toBeDefined();
    expect(MODEL_DEPRECATION_DATES['gemini-2.5-flash']).toBe('2026-06-17');
    expect(MODEL_DEPRECATION_DATES['gemini-2.0-flash']).toBe('2026-06-01');
    expect(MODEL_DEPRECATION_DATES['gemini-embedding-001']).toBe('2026-07-14');
  });

  it('returns no warnings for non-deprecated models', () => {
    const warnings = getDeprecationWarnings(['gemini-3-flash-preview', 'text-embedding-004']);
    expect(warnings).toHaveLength(0);
  });

  it('returns warning for deprecated model', () => {
    const warnings = getDeprecationWarnings(['gemini-2.5-flash']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      model: 'gemini-2.5-flash',
      shutdownDate: '2026-06-17',
      severity: expect.stringMatching(/warning|critical/),
    });
  });

  it('checkDeprecationStatus returns structured status', () => {
    const status = checkDeprecationStatus();
    expect(status).toHaveProperty('activeModels');
    expect(status).toHaveProperty('warnings');
    expect(status).toHaveProperty('checkedAt');
    expect(status.activeModels).toContain('gemini-3-flash-preview');
    expect(status.activeModels).toContain('text-embedding-004');
  });

  it('severity is critical when < 30 days to shutdown', () => {
    // Mock Date to be June 1, 2026 (16 days before gemini-2.5-flash shutdown)
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const warnings = getDeprecationWarnings(['gemini-2.5-flash']);
    expect(warnings[0].severity).toBe('critical');
    vi.useRealTimers();
  });

  it('severity is warning when > 30 days to shutdown', () => {
    // Mock Date to be April 12, 2026 (66 days before gemini-2.5-flash shutdown)
    vi.setSystemTime(new Date('2026-04-12T00:00:00Z'));
    const warnings = getDeprecationWarnings(['gemini-2.5-flash']);
    expect(warnings[0].severity).toBe('warning');
    vi.useRealTimers();
  });
});
