/**
 * Tests for the compliance-mapping mirror guard.
 *
 * The guard's job is to make the EU-US DPF failure structurally impossible to
 * repeat: a control ID retired from the canonical frontend registry must not
 * survive in the worker mirror, where it would keep being written onto anchors
 * and served to auditors.
 *
 * Two layers here:
 *   1. the pure set-difference, including the directionality that makes the
 *      guard usable at all;
 *   2. a live assertion over the REAL mappings, so the guard is exercised
 *      against the actual catalogues on every test run and not only in CI.
 */

import { describe, it, expect } from 'vitest';

import { findOrphanedControlIds } from './check-compliance-mapping-mirror.js';
import { COMPLIANCE_CONTROLS } from '../../src/lib/complianceMapping.js';
import { getComplianceControlIds } from '../../services/worker/src/utils/complianceMapping.js';

const CREDENTIAL_TYPES = [
  'DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT',
  'PROFESSIONAL', 'CLE', 'SEC_FILING', 'PATENT',
  'REGULATION', 'PUBLICATION', 'BADGE', 'ATTESTATION',
  'FINANCIAL', 'LEGAL', 'INSURANCE', 'OTHER',
] as const;

function frontendIdSet(): Set<string> {
  const ids = new Set<string>();
  for (const [key, control] of Object.entries(COMPLIANCE_CONTROLS)) {
    ids.add(key);
    if (control && typeof control.id === 'string') ids.add(control.id);
  }
  return ids;
}

function workerIdSet(): Set<string> {
  const ids = new Set<string>();
  for (const type of [undefined, ...CREDENTIAL_TYPES]) {
    for (const id of getComplianceControlIds(type)) ids.add(id);
  }
  return ids;
}

describe('findOrphanedControlIds', () => {
  it('flags a worker ID the frontend registry does not define', () => {
    const orphaned = findOrphanedControlIds(
      ['SOC2-CC6.1', 'DPF-NOTICE'],
      new Set(['SOC2-CC6.1']),
    );
    expect(orphaned).toEqual(['DPF-NOTICE']);
  });

  it('reproduces the exact SCRUM-2283 drift that shipped to production', () => {
    // The worker kept both IDs for weeks after the frontend dropped them.
    const orphaned = findOrphanedControlIds(
      ['SOC2-CC6.1', 'GDPR-25', 'DPF-NOTICE', 'DPF-ACCOUNTABILITY'],
      new Set(['SOC2-CC6.1', 'GDPR-25']),
    );
    expect(orphaned).toEqual(['DPF-ACCOUNTABILITY', 'DPF-NOTICE']);
  });

  it('is DIRECTIONAL — frontend-only IDs are not drift', () => {
    // The registry legitimately carries jurisdiction controls (LGPD, PDPA,
    // POPIA…) that no credential type maps to yet. Flagging those would make
    // the guard fire constantly and get disabled.
    const orphaned = findOrphanedControlIds(
      ['SOC2-CC6.1'],
      new Set(['SOC2-CC6.1', 'LGPD-6', 'PDPA-24', 'POPIA-19']),
    );
    expect(orphaned).toEqual([]);
  });

  it('passes when the mirrors agree exactly', () => {
    expect(findOrphanedControlIds(['A', 'B'], new Set(['A', 'B']))).toEqual([]);
  });

  it('returns a sorted, stable list so CI output does not churn', () => {
    const orphaned = findOrphanedControlIds(['Z-1', 'A-1', 'M-1'], new Set());
    expect(orphaned).toEqual(['A-1', 'M-1', 'Z-1']);
  });

  it('reports every orphan, not just the first', () => {
    const orphaned = findOrphanedControlIds(['A', 'B', 'C'], new Set(['B']));
    expect(orphaned).toEqual(['A', 'C']);
  });
});

describe('live mapping mirror (the actual guarantee)', () => {
  it('every control ID the worker can emit is defined in the frontend registry', () => {
    const orphaned = findOrphanedControlIds(workerIdSet(), frontendIdSet());
    expect(
      orphaned,
      `Worker emits control ID(s) absent from src/lib/complianceMapping.ts: ${orphaned.join(', ')}. `
      + 'A retired claim must not survive in the mirror — remove it from the worker catalogue, '
      + 'and do NOT re-add it to the frontend to silence this.',
    ).toEqual([]);
  });

  it('the retired EU-US DPF identifiers are absent from BOTH mappings', () => {
    const worker = workerIdSet();
    const frontend = frontendIdSet();
    for (const retired of ['DPF-NOTICE', 'DPF-ACCOUNTABILITY']) {
      expect(worker.has(retired), `${retired} must not be emittable by the worker`).toBe(false);
      expect(frontend.has(retired), `${retired} must not be in the frontend registry`).toBe(false);
    }
  });

  it('reads a non-empty set from both sides (guard would be vacuous otherwise)', () => {
    expect(workerIdSet().size).toBeGreaterThan(0);
    expect(frontendIdSet().size).toBeGreaterThan(0);
  });
});
