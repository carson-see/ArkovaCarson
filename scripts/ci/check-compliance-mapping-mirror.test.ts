/**
 * Tests for the compliance-mapping mirror guard.
 *
 * The guard's job is to make the EU-US DPF failure structurally impossible to
 * repeat: a control ID retired from the canonical frontend catalogue must not
 * survive in the worker mirror, where it would keep being written onto anchors
 * and served to auditors.
 *
 * These tests exercise `runMirrorCheck` — the SAME function `main()` calls —
 * rather than re-implementing its logic, so an inversion or a deleted
 * fail-closed branch in the real code path shows up here. Every advertised
 * property is asserted, including the vacuity guards, because a guard's
 * failure modes are the part that actually has to work.
 */

import { describe, it, expect } from 'vitest';

import { runMirrorCheck } from './check-compliance-mapping-mirror.js';
import {
  COMPLIANCE_CONTROLS,
  EMITTABLE_CONTROL_IDS as FRONTEND_EMITTABLE,
} from '../../src/lib/complianceMapping.js';
import { EMITTABLE_CONTROL_IDS as WORKER_EMITTABLE } from '../../services/worker/src/utils/complianceMapping.js';

const DEFINED = new Set(['SOC2-CC6.1', 'GDPR-25', 'DPF-NOTICE', 'DPF-ACCOUNTABILITY', 'FERPA-99.31']);

function check(worker: string[], frontend: string[], defined: string[] = [...DEFINED]) {
  return runMirrorCheck({
    workerEmitted: new Set(worker),
    frontendEmitted: new Set(frontend),
    definedIds: new Set(defined),
  });
}

describe('runMirrorCheck — the retired-claim direction', () => {
  it('fails when the worker emits an ID the frontend retired', () => {
    const result = check(['SOC2-CC6.1', 'DPF-NOTICE'], ['SOC2-CC6.1']);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('DPF-NOTICE');
  });

  it('replays the exact SCRUM-2283 drift that shipped to production', () => {
    const result = check(
      ['SOC2-CC6.1', 'GDPR-25', 'DPF-NOTICE', 'DPF-ACCOUNTABILITY'],
      ['SOC2-CC6.1', 'GDPR-25'],
    );
    expect(result.ok).toBe(false);
    const output = result.lines.join('\n');
    expect(output).toContain('DPF-ACCOUNTABILITY, DPF-NOTICE');
    // The message must point at the worker, never at "re-add it to the frontend".
    expect(output).toContain('removing the ID(s) from services/worker');
    expect(output).toContain('Do NOT');
  });

  it('catches an INCOMPLETE retirement — ID pulled from the emitted arrays but left in the registry', () => {
    // The minimal, most likely frontend fix. A guard that compared against the
    // definitions registry instead of the emitted union would pass here while
    // the worker kept serving the retired claim.
    const result = check(['SOC2-CC6.1', 'DPF-NOTICE'], ['SOC2-CC6.1'], [...DEFINED]);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('DPF-NOTICE');
  });
});

describe('runMirrorCheck — the other direction and definitions', () => {
  it('fails when the frontend emits an ID the worker does not', () => {
    const result = check(['SOC2-CC6.1'], ['SOC2-CC6.1', 'FERPA-99.31']);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('FERPA-99.31');
  });

  it('fails when an emitted ID has no definition in COMPLIANCE_CONTROLS', () => {
    const result = check(['SOC2-CC6.1', 'GHOST-1'], ['SOC2-CC6.1', 'GHOST-1']);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('GHOST-1');
  });

  it('passes when both sides match exactly and all IDs are defined', () => {
    const result = check(['SOC2-CC6.1', 'GDPR-25'], ['SOC2-CC6.1', 'GDPR-25']);
    expect(result.ok).toBe(true);
  });

  it('reports every orphan, not just the first, sorted for stable CI output', () => {
    const result = check(
      ['SOC2-CC6.1', 'DPF-NOTICE', 'DPF-ACCOUNTABILITY'],
      ['SOC2-CC6.1'],
    );
    expect(result.lines.join('\n')).toContain('DPF-ACCOUNTABILITY, DPF-NOTICE');
  });
});

describe('runMirrorCheck — fails CLOSED, never vacuously green', () => {
  it('fails on an empty frontend set rather than passing everything', () => {
    const result = check(['SOC2-CC6.1'], []);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/EMPTY set/i);
  });

  it('fails on an empty worker set rather than reporting no drift', () => {
    const result = check([], ['SOC2-CC6.1']);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/EMPTY set/i);
  });

  it('fails on an empty definitions registry', () => {
    const result = check(['SOC2-CC6.1'], ['SOC2-CC6.1'], []);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/EMPTY registry/i);
  });

  it('a both-empty world is a failure, not a trivially satisfied mirror', () => {
    const result = check([], []);
    expect(result.ok).toBe(false);
  });
});

describe('live mappings (the actual guarantee)', () => {
  it('the real worker and frontend catalogues match exactly', () => {
    const result = runMirrorCheck({
      workerEmitted: WORKER_EMITTABLE,
      frontendEmitted: FRONTEND_EMITTABLE,
      definedIds: new Set(Object.keys(COMPLIANCE_CONTROLS)),
    });
    expect(result.ok, result.lines.join('\n')).toBe(true);
  });

  it('the retired EU-US DPF identifiers are emitted by neither side', () => {
    for (const retired of ['DPF-NOTICE', 'DPF-ACCOUNTABILITY']) {
      expect(WORKER_EMITTABLE.has(retired), `${retired} must not be emittable by the worker`).toBe(false);
      expect(FRONTEND_EMITTABLE.has(retired), `${retired} must not be emittable by the frontend`).toBe(false);
    }
  });

  it('both live sets are non-empty, so the live assertion is not vacuous', () => {
    expect(WORKER_EMITTABLE.size).toBeGreaterThan(0);
    expect(FRONTEND_EMITTABLE.size).toBeGreaterThan(0);
  });
});
