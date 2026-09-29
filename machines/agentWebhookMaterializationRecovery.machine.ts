import {
  and, boolType, defineMachine, enumType, eq, lit, not, or, scalarVar, setVar, variable,
} from 'tla-precheck';

const outbox = variable('outbox');
const request = variable('request');
const snapshot = variable('snapshot');
const audit = variable('audit');
const recoveryCount = variable('recoveryCount');

/**
 * AR20-13 terminal materialization recovery. Rejected concurrent/different
 * requests are absent transitions: PostgreSQL serializes on the outbox row and
 * the unique outbox ledger key permits only the first recovery.
 */
export const agentWebhookMaterializationRecoveryMachine = defineMachine({
  version: 2,
  moduleName: 'AgentWebhookMaterializationRecovery',
  variables: {
    outbox: scalarVar(enumType('TERMINAL', 'PENDING', 'PROGRESSED'), lit('TERMINAL')),
    request: scalarVar(enumType('NONE', 'R1', 'R2'), lit('NONE')),
    snapshot: scalarVar(boolType(), lit(false)),
    audit: scalarVar(boolType(), lit(false)),
    recoveryCount: scalarVar(enumType('ZERO', 'ONE', 'TWO'), lit('ZERO')),
  },
  actions: {
    recoverR1: {
      params: {}, guard: and(eq(outbox, lit('TERMINAL')), eq(request, lit('NONE'))),
      updates: [setVar('outbox', lit('PENDING')), setVar('request', lit('R1')),
        setVar('snapshot', lit(true)), setVar('audit', lit(true)), setVar('recoveryCount', lit('ONE'))],
    },
    recoverR2: {
      params: {}, guard: and(eq(outbox, lit('TERMINAL')), eq(request, lit('NONE'))),
      updates: [setVar('outbox', lit('PENDING')), setVar('request', lit('R2')),
        setVar('snapshot', lit(true)), setVar('audit', lit(true)), setVar('recoveryCount', lit('ONE'))],
    },
    materializerProgresses: {
      params: {}, guard: and(eq(outbox, lit('PENDING')), not(eq(request, lit('NONE')))),
      updates: [setVar('outbox', lit('PROGRESSED'))],
    },
  },
  invariants: {
    atMostOneRecovery: {
      description: 'A logical outbox has either no recovery request or exactly one immutable request identity',
      formula: not(eq(recoveryCount, lit('TWO'))),
    },
    recoveryPreservesEvidence: {
      description: 'Any re-armed or progressed outbox has both its private terminal snapshot and audit event',
      formula: or(eq(outbox, lit('TERMINAL')), and(snapshot, audit)),
    },
    terminalHasNoRecoverySideEffects: {
      description: 'Before recovery, no snapshot or audit side effect exists',
      formula: or(not(eq(outbox, lit('TERMINAL'))), and(eq(request, lit('NONE')),
        eq(recoveryCount, lit('ZERO')), not(snapshot), not(audit))),
    },
  },
  proof: {
    defaultTier: 'pr',
    tiers: { pr: { domains: {}, budgets: { maxEstimatedStates: 100_000 }, checks: { deadlock: false } } },
  },
});

export default agentWebhookMaterializationRecoveryMachine;
