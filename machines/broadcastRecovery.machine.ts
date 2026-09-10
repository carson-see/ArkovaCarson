import {
  defineMachine, variable, scalarVar, mapVar, enumType, boolType, rangeType,
  optionType, domainType, lit, param, index, eq, and, or, not, lte, forall,
  setVar, setMap, ids,
} from 'tla-precheck';

const phase = variable('phase');
const pass = variable('pass');
const target = variable('target');
const incomplete = variable('incomplete');
const status = variable('status');
const protectedRow = variable('protectedRow');
const resets = variable('resets');
const claimPresent = variable('claimPresent');
const a = param('a');
const eligible = and(eq(index(status, a), lit('stale')), not(index(protectedRow, a)));

/**
 * Two anchors, one row per bounded SQL batch, two-pass invocation budget.
 * Repeated ticks retain database state. Production uses 500 rows / 40 passes;
 * this finite tier checks safety boundaries, not performance or fair liveness.
 * sqlCommit represents 0442/0449's locked predicate/update; protect represents a
 * txid or journal winning before that lock. lostReply preserves the commit
 * without acknowledging it. start is enabled only while idle (invocation guard).
 * Reconciliation/chain behavior remains a collaborator of bitcoinAnchor.
 * This multi-row RPC plus network reply cannot use the single-table adapter.
 * Interpreter traces are compared to actual SQL; no generated SQL is deployed.
 */
export const broadcastRecoveryMachine = defineMachine({
  version: 2,
  moduleName: 'BroadcastRecovery',
  variables: {
    phase: scalarVar(enumType('idle', 'rpc', 'reply', 'done'), lit('idle')),
    pass: scalarVar(enumType('zero', 'one', 'two'), lit('zero')),
    target: scalarVar(optionType(domainType('Anchors')), lit(null)),
    incomplete: scalarVar(boolType(), lit(false)),
    status: mapVar('Anchors', enumType('stale', 'pending', 'resumed'), lit('stale')),
    protectedRow: mapVar('Anchors', boolType(), lit(false)),
    resets: mapVar('Anchors', rangeType(0, 2), lit(0)),
    claimPresent: mapVar('Anchors', boolType(), lit(true)),
  },
  actions: {
    start: { params: {}, guard: eq(phase, lit('idle')),
      updates: [setVar('phase', lit('rpc')), setVar('pass', lit('one')), setVar('target', lit(null)), setVar('incomplete', lit(false))] },
    protect: { params: { a: 'Anchors' }, guard: and(eq(index(status, a), lit('stale')), not(index(protectedRow, a))),
      updates: [setMap('protectedRow', a, lit(true))] },
    sqlCommit: { params: { a: 'Anchors' }, guard: and(eq(phase, lit('rpc')), eligible, eq(index(resets, a), lit(0))),
      updates: [setMap('status', a, lit('pending')), setMap('claimPresent', a, lit(false)), setMap('resets', a, lit(1)), setVar('target', a), setVar('phase', lit('reply'))] },
    sqlEmpty: { params: {}, guard: and(eq(phase, lit('rpc')), forall('Anchors', 'a', not(eligible))),
      updates: [setVar('target', lit(null)), setVar('phase', lit('reply'))] },
    acknowledgeFirst: { params: { a: 'Anchors' }, guard: and(eq(phase, lit('reply')), eq(target, a), eq(pass, lit('one'))),
      updates: [setVar('target', lit(null)), setVar('pass', lit('two')), setVar('phase', lit('rpc'))] },
    acknowledgeLast: { params: { a: 'Anchors' }, guard: and(eq(phase, lit('reply')), eq(target, a), eq(pass, lit('two'))),
      updates: [setVar('target', lit(null)), setVar('incomplete', lit(true)), setVar('phase', lit('done'))] },
    acknowledgeEmpty: { params: {}, guard: and(eq(phase, lit('reply')), eq(target, lit(null))),
      updates: [setVar('phase', lit('done')), setVar('incomplete', lit(false))] },
    lostReply: { params: {}, guard: eq(phase, lit('reply')),
      updates: [setVar('phase', lit('done')), setVar('target', lit(null)), setVar('incomplete', lit(true))] },
    requestFailed: { params: {}, guard: eq(phase, lit('rpc')),
      updates: [setVar('phase', lit('done')), setVar('incomplete', lit(true))] },
    budgetExpired: { params: {}, guard: or(eq(phase, lit('rpc')), eq(phase, lit('reply'))),
      updates: [setVar('phase', lit('done')), setVar('target', lit(null)), setVar('incomplete', lit(true))] },
    nextTick: { params: {}, guard: eq(phase, lit('done')),
      updates: [setVar('phase', lit('idle')), setVar('pass', lit('zero')), setVar('target', lit(null))] },
    resumeAnchoring: { params: { a: 'Anchors' }, guard: eq(index(status, a), lit('pending')),
      updates: [setMap('status', a, lit('resumed')), setMap('claimPresent', a, lit(true))] },
  },
  invariants: {
    pendingHasNoOldClaim: { description: 'Reset removes reserved old claim metadata before re-claim.',
      formula: forall('Anchors', 'a', or(not(eq(index(status, a), lit('pending'))), not(index(claimPresent, a)))) },
    protectedAnchorsNeverReset: { description: 'A persisted txid or journal cannot be reset by generic recovery.',
      formula: forall('Anchors', 'a', or(not(index(protectedRow, a)), eq(index(resets, a), lit(0)))) },
    resetAtMostOnce: { description: 'Retry after a lost reply cannot repeat a committed reset of this claim.',
      formula: forall('Anchors', 'a', lte(index(resets, a), lit(1))) },
    acknowledgementRequiresCommit: { description: 'Only actual committed reset rows count as recovered.',
      formula: forall('Anchors', 'a', or(not(eq(target, a)), eq(index(resets, a), lit(1)))) },
    lostRepliesPreserveWork: { description: 'A committed reset remains pending or has resumed anchoring.',
      formula: forall('Anchors', 'a', or(eq(index(resets, a), lit(0)), not(eq(index(status, a), lit('stale'))))) },
    completeRequiresNoEligibleRows: { description: 'Unknown replies cannot report an eligible cohort clean.',
      formula: or(not(and(eq(phase, lit('done')), not(incomplete))), forall('Anchors', 'a', not(eligible))) },
  },
  proof: { defaultTier: 'pr', tiers: { pr: {
    domains: { Anchors: ids({ prefix: 'a', size: 2 }) },
    budgets: { maxEstimatedStates: 100_000 }, graphEquivalence: true,
    checks: { deadlock: true },
  } } },
});
export default broadcastRecoveryMachine;
