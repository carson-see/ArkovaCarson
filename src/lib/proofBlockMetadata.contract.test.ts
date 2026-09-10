import { describe, expect, it } from 'vitest';
import { resolveMachine } from 'tla-precheck/proof';
import { buildInitialState, enabled, exploreGraph, step, type MachineState } from 'tla-precheck/interpreter';
import machine from '../../machines/proofBlockMetadata.machine';
import { resolveProofBlockMetadata } from './proofBlockMetadata';

const resolved = resolveMachine(machine, 'pr');
const hash = (value: unknown) => value === 'unknown' ? null : String(value).repeat(64);
const decisions = { useAnchor: 'anchor', retainProof: 'proof', rejectMismatch: 'rejected' } as const;

function modelDecision(state: MachineState) {
  const actions = Object.keys(decisions).filter((action) => enabled(resolved, state, action, {}));
  expect(actions).toHaveLength(1);
  return decisions[actions[0] as keyof typeof decisions];
}

describe('proof metadata — finite DSL/runtime contract', () => {
  it('matches the interpreter in every reachable decision state and metadata availability combination', () => {
    const graph = exploreGraph(resolved);
    let comparisons = 0;
    let rejected = 0;
    for (const state of graph.states.values()) {
      if (state.phase !== 'proof_read') continue;
      const expected = modelDecision(state);
      for (const anchorHeight of [100, null]) for (const proofHeight of [90, null]) {
        for (const anchorTime of ['2026-09-02T02:58:11Z', null]) for (const proofTime of ['2026-09-02T02:01:28Z', null]) {
          const result = resolveProofBlockMetadata(
            { hash: hash(state.capturedAnchor), height: anchorHeight, timestamp: anchorTime },
            { hash: hash(state.capturedProof), height: proofHeight, timestamp: proofTime },
          );
          expect(result?.source ?? 'rejected').toBe(expected);
          if (expected === 'rejected') {
            rejected++;
            expect(result).toBeNull();
          } else {
            expect(result?.height).toBe(expected === 'anchor' ? anchorHeight ?? proofHeight : proofHeight);
            expect(result?.timestamp).toBe(expected === 'anchor' ? anchorTime ?? proofTime : proofTime);
          }
          comparisons++;
        }
      }
    }
    expect(comparisons).toBeGreaterThanOrEqual(144);
    expect(rejected).toBeGreaterThan(0);
  });

  it('rejects a proof changed between independent reads; the old unconditional preference disagrees', () => {
    let state = buildInitialState(resolved);
    for (const [action, args] of [
      ['updateAnchor', { block: 'a' }], ['updateProof', { block: 'a' }],
      ['readAnchor', {}], ['updateAnchor', { block: 'b' }],
      ['updateProof', { block: 'b' }], ['readProof', {}],
    ] as const) {
      const next = step(resolved, state, action, args);
      expect(next).not.toBeNull();
      state = next!;
    }
    expect(modelDecision(state)).toBe('rejected');
    expect(resolveProofBlockMetadata(
      { hash: hash(state.capturedAnchor), height: 100 },
      { hash: hash(state.capturedProof), height: 101 },
    )).toBeNull();
    expect('anchor').not.toBe(modelDecision(state));
  });

  it('treats a malformed identity as unknown instead of establishing a match', () => {
    expect(resolveProofBlockMetadata(
      { hash: 'not-a-block', height: 100 }, { hash: 'not-a-block', height: 90 },
    )).toEqual({ source: 'proof', height: 90, timestamp: null });
  });

  it('does not publish invalid block heights from either source', () => {
    for (const height of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
      expect(resolveProofBlockMetadata(
        { hash: 'a'.repeat(64), height: height as number },
        { hash: 'a'.repeat(64), height: height as number },
      )?.height).toBeNull();
    }
  });
});
