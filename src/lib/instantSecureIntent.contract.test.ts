import { describe, expect, it } from 'vitest';
import { resolveMachine } from 'tla-precheck/proof';
import { buildInitialState, step } from 'tla-precheck/interpreter';
import { instantSecureIntentMachine } from '../../machines/instantSecureIntent.machine';

const resolved = resolveMachine(instantSecureIntentMachine, 'pr');

describe('instant secure intent credit recovery model', () => {
  it('reaches an exact reserved claim after insufficient credit, purchase, and explicit rearm', () => {
    let state = buildInitialState(resolved);
    for (const [action, args] of [
      ['enqueueInstant', { i: 'i1' }],
      ['claimInsufficientCredit', { i: 'i1', w: 'w1' }],
      ['purchaseCredit', { i: 'i1' }],
      ['rearmAfterPurchase', { i: 'i1' }],
      ['claimAndReserveExact', { i: 'i1', w: 'w2' }],
    ] as const) {
      const next = step(resolved, state, action, args);
      expect(next, `${action} must be reachable`).not.toBeNull();
      state = next!;
    }

    expect(state.phase).toEqual({ i1: 'CLAIMED' });
    expect(state.credit).toEqual({ i1: 'RESERVED' });
    expect(state.debitEverApplied).toEqual({ i1: true });
    expect(state.job).toEqual({ i1: 'NONE' });
  });

  it('keeps a safely refunded attempt terminal', () => {
    let state = buildInitialState(resolved);
    for (const [action, args] of [
      ['fundBeforeSubmit', { i: 'i1' }],
      ['enqueueInstant', { i: 'i1' }],
      ['claimAndReserveExact', { i: 'i1', w: 'w1' }],
      ['rejectBeforeJournalAndRefund', { i: 'i1' }],
    ] as const) {
      const next = step(resolved, state, action, args);
      expect(next, `${action} must be reachable`).not.toBeNull();
      state = next!;
    }

    expect(state.phase).toEqual({ i1: 'FAILED' });
    expect(step(resolved, state, 'rearmAfterPurchase', { i: 'i1' })).toBeNull();
  });
});
