/**
 * Tests for the maintenance-pause allowlist (SCRUM-2900 dead-man wiring).
 *
 * A job observed PAUSED in Cloud Scheduler is sanctioned ONLY when either
 * (a) the manifest codifies the pause (enabled:false + attribution), or
 * (b) an ACTIVE maintenance-pause allowlist entry covers it. Every entry
 * carries a reason + approver + a hard expiry (review marker) so a
 * "temporary" pause can never rot silently — an expired entry stops
 * sanctioning the pause AND fails allowlist validation until renewed or
 * removed.
 */

import { describe, it, expect } from 'vitest';
import {
  MAINTENANCE_PAUSE_ALLOWLIST,
  lookupMaintenancePause,
  validateMaintenancePauseAllowlist,
  type MaintenancePauseAllowlistEntry,
} from './scheduler-pause-allowlist.js';

const NOW = Date.parse('2026-07-21T12:00:00Z');

const activeEntry: MaintenancePauseAllowlistEntry = {
  jobId: 'fetch-edgar',
  reason: 'founder-gated feeder drain rehearsal',
  approvedBy: 'carson (founder)',
  expiresAt: '2026-08-01T00:00:00Z',
};

const expiredEntry: MaintenancePauseAllowlistEntry = {
  jobId: 'anchor-public-records',
  reason: 'rig maintenance window',
  approvedBy: 'lane-3',
  expiresAt: '2026-07-01T00:00:00Z', // long past NOW
};

describe('lookupMaintenancePause', () => {
  it('returns active for a job covered by an unexpired entry', () => {
    const result = lookupMaintenancePause('fetch-edgar', NOW, [activeEntry]);
    expect(result.status).toBe('active');
    if (result.status === 'active') {
      expect(result.entry.reason).toMatch(/founder-gated/);
      expect(result.entry.approvedBy).toMatch(/carson/);
    }
  });

  it('returns expired (NOT active) for an entry past its expiry — sanction does not rot', () => {
    const result = lookupMaintenancePause('anchor-public-records', NOW, [expiredEntry]);
    expect(result.status).toBe('expired');
  });

  it('returns absent for a job with no entry', () => {
    const result = lookupMaintenancePause('batch-anchors', NOW, [activeEntry]);
    expect(result.status).toBe('absent');
  });

  it('treats the exact expiry instant as expired (boundary: sanction ends AT expiresAt)', () => {
    const boundary: MaintenancePauseAllowlistEntry = {
      ...activeEntry,
      expiresAt: '2026-07-21T12:00:00Z', // === NOW
    };
    const result = lookupMaintenancePause('fetch-edgar', NOW, [boundary]);
    expect(result.status).toBe('expired');
  });

  it('an unparseable expiry NEVER sanctions a pause (fail closed)', () => {
    const broken: MaintenancePauseAllowlistEntry = {
      ...activeEntry,
      expiresAt: 'not-a-date',
    };
    const result = lookupMaintenancePause('fetch-edgar', NOW, [broken]);
    expect(result.status).not.toBe('active');
  });
});

describe('validateMaintenancePauseAllowlist', () => {
  it('accepts a clean allowlist', () => {
    expect(validateMaintenancePauseAllowlist([activeEntry], NOW)).toEqual([]);
  });

  it('rejects duplicate jobIds', () => {
    const errors = validateMaintenancePauseAllowlist([activeEntry, { ...activeEntry }], NOW);
    expect(errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });

  it('rejects an entry with an empty reason', () => {
    const errors = validateMaintenancePauseAllowlist([{ ...activeEntry, reason: '  ' }], NOW);
    expect(errors.some((e) => /reason/i.test(e))).toBe(true);
  });

  it('rejects an entry with an empty approver', () => {
    const errors = validateMaintenancePauseAllowlist([{ ...activeEntry, approvedBy: '' }], NOW);
    expect(errors.some((e) => /approvedBy|approver/i.test(e))).toBe(true);
  });

  it('rejects an unparseable expiry', () => {
    const errors = validateMaintenancePauseAllowlist(
      [{ ...activeEntry, expiresAt: 'whenever' }],
      NOW,
    );
    expect(errors.some((e) => /expiresAt|expiry/i.test(e))).toBe(true);
  });

  it('flags an EXPIRED entry as a validation error — rot must be renewed or removed', () => {
    const errors = validateMaintenancePauseAllowlist([expiredEntry], NOW);
    expect(errors.some((e) => /expired/i.test(e))).toBe(true);
  });
});

describe('shipped MAINTENANCE_PAUSE_ALLOWLIST', () => {
  it('is valid against the real clock (an expired shipped entry turns this red until reviewed)', () => {
    expect(validateMaintenancePauseAllowlist(MAINTENANCE_PAUSE_ALLOWLIST, Date.now())).toEqual([]);
  });

  it('is empty today — no sanctioned live pause exists in prod (§1.5: state what IS)', () => {
    expect(MAINTENANCE_PAUSE_ALLOWLIST).toEqual([]);
  });
});
