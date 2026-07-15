/**
 * SCRUM-2693 fee/provider/reorg fault orchestration contract.
 *
 * The port supplies independently captured observations. This pure layer
 * validates exact runtime identity, bounded chronology, journal protection,
 * and fail-closed outcomes; it performs no live fault or infrastructure work.
 */

import { parseUtcTimestamp } from './batch-drain-time';
import type {
  JournalChainLookupObservation,
  JournalRuntimeBinding,
  TxidJournalSnapshot,
} from './batch-drain-journal-crash';

export const FAULT_SCENARIOS = ['fee-ceiling', 'provider-outage', 'reorg'] as const;
export type FaultScenario = typeof FAULT_SCENARIOS[number];

export interface FaultWindow {
  id: string;
  startsAt: string;
  endsAt: string;
}

export interface FaultCaseInput {
  schemaVersion: 1;
  runId: string;
  scenario: FaultScenario;
  batchId: string;
  schedulerExecutionId: string;
  faultWindow: FaultWindow;
  runtime: JournalRuntimeBinding;
  anchorIds: string[];
  txId: string | null;
  fingerprintRoot: string | null;
  retryLimit: number;
}

export interface FaultAnchorObservation {
  anchorId: string;
  status: 'PENDING' | 'BROADCASTING' | 'SUBMITTED' | 'SECURED';
  chainTxId: string | null;
}

export interface FeeFaultObservation {
  estimateSatVb: number;
  ceilingSatVb: number;
  baseCeilingSatVb: number;
  oldestPendingAt: string;
  evaluatedBeforeClaim: boolean;
}

export interface ProviderFaultObservation {
  retryAttempts: number;
  lookups: JournalChainLookupObservation[];
}

export interface ReorgFaultObservation {
  priorBlockHash: string;
  observedBlockHash: string;
  proofStatus: 'stale';
  auditEvent: 'anchor.reorg_reverted';
}

export interface FaultObservation {
  schemaVersion: 1;
  runId: string;
  scenario: FaultScenario;
  phase: 'fault-active' | 'fault-cleared';
  batchId: string;
  schedulerExecutionId: string;
  faultWindowId: string;
  runtime: JournalRuntimeBinding;
  observedAt: string;
  journal: TxidJournalSnapshot | null;
  anchors: FaultAnchorObservation[];
  networkTxIds: string[];
  broadcastAttempts: number;
  refundAnchorIds: string[];
  fee: FeeFaultObservation | null;
  provider: ProviderFaultObservation | null;
  reorg: ReorgFaultObservation | null;
}

export interface FaultControlPort {
  readonly evidenceMode: 'offline-replay' | 'live-rig';
  arm(input: FaultCaseInput): Promise<void>;
  start(input: FaultCaseInput): Promise<void>;
  waitForFault(input: FaultCaseInput): Promise<FaultObservation>;
  clear(input: FaultCaseInput): Promise<void>;
  inspect(input: FaultCaseInput): Promise<FaultObservation>;
  disarm(input: FaultCaseInput): Promise<void>;
}

export interface FaultCaseSummary {
  verdict: 'pass';
  evidenceMode: 'offline-replay' | 'live-rig';
  runId: string;
  scenario: FaultScenario;
  resolution: 'FEE_DEFERRED_THEN_RECOVERED' | 'PROVIDER_HELD_THEN_ADOPTED' | 'REORG_REVERTED_TO_SUBMITTED';
  exactHeadSha: string;
  exactImageDigest: string;
  observedCeilingSatVb?: number;
}

export class FaultDisarmAggregateError extends AggregateError {
  readonly primaryError: unknown;
  readonly disarmError: unknown;

  constructor(primaryError: unknown, disarmError: unknown) {
    super([primaryError, disarmError], 'Fault orchestration failed and controller disarm also failed.');
    this.name = 'FaultDisarmAggregateError';
    this.primaryError = primaryError;
    this.disarmError = disarmError;
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const S33_CONFIGURED_BASE_FEE_CEILING_SAT_VB = 50;
const ABSOLUTE_FEE_CAP_SAT_VB = 200;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function time(value: string, label: string): number {
  return parseUtcTimestamp(value, label);
}

function identity(value: string, label: string): void {
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!value || value.length > 200 || hasControlCharacter) {
    throw new Error(`${label} must be a bounded non-empty identity.`);
  }
}

function sameRuntime(expected: JournalRuntimeBinding, actual: JournalRuntimeBinding, label: string): void {
  if (expected.headSha !== actual.headSha || expected.imageDigest !== actual.imageDigest) {
    throw new Error(`${label} does not match the exact tested head and image digest.`);
  }
}

function exactSet(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length
    && new Set(actual).size === actual.length
    && expected.every((value) => actual.includes(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotInput(input: FaultCaseInput): FaultCaseInput {
  return deepFreeze({
    schemaVersion: input.schemaVersion,
    runId: input.runId,
    scenario: input.scenario,
    batchId: input.batchId,
    schedulerExecutionId: input.schedulerExecutionId,
    faultWindow: { ...input.faultWindow },
    runtime: { ...input.runtime },
    anchorIds: [...input.anchorIds],
    txId: input.txId,
    fingerprintRoot: input.fingerprintRoot,
    retryLimit: input.retryLimit,
  });
}

function snapshotObservation(observation: FaultObservation): FaultObservation {
  return deepFreeze(structuredClone(observation));
}

function validateInput(input: FaultCaseInput): void {
  if (input.schemaVersion !== 1) throw new Error('Unsupported fault case schema version.');
  if (!(FAULT_SCENARIOS as readonly string[]).includes(input.scenario)) throw new Error('Unsupported fault scenario.');
  identity(input.runId, 'runId');
  identity(input.batchId, 'batchId');
  identity(input.schedulerExecutionId, 'schedulerExecutionId');
  identity(input.faultWindow.id, 'faultWindow.id');
  if (!HEAD_SHA.test(input.runtime.headSha) || !IMAGE_DIGEST.test(input.runtime.imageDigest)) {
    throw new Error('Fault case requires an exact lowercase head SHA and sha256 image digest.');
  }
  const startsAt = time(input.faultWindow.startsAt, 'faultWindow.startsAt');
  const endsAt = time(input.faultWindow.endsAt, 'faultWindow.endsAt');
  if (endsAt <= startsAt) throw new Error('Fault window must have positive duration.');
  if (input.anchorIds.length < 1 || input.anchorIds.length > 10_000 || !exactSet(input.anchorIds, input.anchorIds)) {
    throw new Error('Fault case requires 1..10000 unique anchors.');
  }
  if (input.anchorIds.some((anchorId) => !UUID.test(anchorId))) throw new Error('Fault anchor ids must be UUIDs.');
  if (!Number.isInteger(input.retryLimit) || input.retryLimit < 0 || input.retryLimit > 20) {
    throw new Error('Fault retry limit must be an integer from 0 through 20.');
  }
  if (input.scenario === 'fee-ceiling') {
    if (input.txId !== null || input.fingerprintRoot !== null || input.retryLimit !== 0) {
      throw new Error('Fee-ceiling input is pre-claim and cannot predeclare a tx, root, or retry budget.');
    }
  } else if (
    input.txId === null
    || input.fingerprintRoot === null
    || !SHA256_HEX.test(input.txId)
    || !SHA256_HEX.test(input.fingerprintRoot)
  ) throw new Error(`${input.scenario} requires exact txid and fingerprint-root identity.`);
  if (input.scenario === 'provider-outage' && input.retryLimit < 1) {
    throw new Error('Provider-outage input requires a positive bounded retry limit.');
  }
  if (input.scenario === 'reorg' && input.retryLimit !== 0) {
    throw new Error('Reorg evidence cannot predeclare provider retries.');
  }
}

function validateJournal(input: FaultCaseInput, journal: TxidJournalSnapshot, label: string): void {
  if (
    !UUID.test(journal.journalId)
    || journal.batchId !== input.batchId
    || !SHA256_HEX.test(journal.txId)
    || !SHA256_HEX.test(journal.fingerprintRoot)
    || !exactSet(input.anchorIds, journal.anchorIds)
  ) throw new Error(`${label} journal does not match the exact batch and complete cohort identity.`);
  if (input.txId !== null && journal.txId !== input.txId) throw new Error(`${label} journal txid is not the declared exact txid.`);
  if (input.fingerprintRoot !== null && journal.fingerprintRoot !== input.fingerprintRoot) {
    throw new Error(`${label} journal root is not the declared exact fingerprint root.`);
  }
  const createdAt = time(journal.createdAt, `${label} journal createdAt`);
  const observedAt = time(journal.observedAt, `${label} journal observedAt`);
  if (observedAt < createdAt) throw new Error(`${label} journal chronology is invalid.`);
  const unresolved = journal.recoveryStatus === 'PENDING' || journal.recoveryStatus === 'HELD';
  if (unresolved !== (journal.resolvedAt === null)) throw new Error(`${label} journal resolution shape is invalid.`);
  if (journal.recoveryStatus === 'HELD') {
    if (!journal.holdReason || journal.heldAt === null) throw new Error(`${label} HELD journal requires hold evidence.`);
  } else if (journal.holdReason !== null || journal.heldAt !== null) {
    throw new Error(`${label} non-HELD journal cannot carry hold fields.`);
  }
}

function validateObservation(input: FaultCaseInput, observation: FaultObservation, phase: FaultObservation['phase']): Map<string, FaultAnchorObservation> {
  if (
    observation.schemaVersion !== 1
    || observation.runId !== input.runId
    || observation.scenario !== input.scenario
    || observation.phase !== phase
    || observation.batchId !== input.batchId
    || observation.schedulerExecutionId !== input.schedulerExecutionId
    || observation.faultWindowId !== input.faultWindow.id
  ) throw new Error('Fault observation is cross-run, cross-scenario, or cross-execution.');
  sameRuntime(input.runtime, observation.runtime, 'Fault observation runtime');
  const observedAt = time(observation.observedAt, `${phase} observedAt`);
  if (
    observedAt < time(input.faultWindow.startsAt, 'faultWindow.startsAt')
    || observedAt > time(input.faultWindow.endsAt, 'faultWindow.endsAt')
  ) throw new Error('Fault observation is outside the declared fault window.');
  if (observation.journal) {
    validateJournal(input, observation.journal, phase);
    if (time(observation.journal.observedAt, `${phase} journal observedAt`) > observedAt) {
      throw new Error(`${phase} journal chronology is invalid.`);
    }
  }
  if (!exactSet(input.anchorIds, observation.anchors.map((row) => row.anchorId))) {
    throw new Error('Fault observation must contain the complete anchor cohort exactly once.');
  }
  if (!Number.isInteger(observation.broadcastAttempts) || observation.broadcastAttempts < 0) {
    throw new Error('Broadcast attempts must be a non-negative integer.');
  }
  if (!exactSet(observation.networkTxIds, observation.networkTxIds) || observation.networkTxIds.some((txId) => !SHA256_HEX.test(txId))) {
    throw new Error('Network txids must be unique lowercase SHA-256 identities.');
  }
  if (!exactSet(observation.refundAnchorIds, observation.refundAnchorIds)
    || observation.refundAnchorIds.some((anchorId) => !input.anchorIds.includes(anchorId))) {
    throw new Error('Refund evidence contains duplicate or foreign anchor ids.');
  }
  const typedSections = [observation.fee, observation.provider, observation.reorg].filter((value) => value !== null);
  if (typedSections.length !== 1) throw new Error('Fault observation requires exactly one scenario-specific section.');
  if ((input.scenario === 'fee-ceiling') !== (observation.fee !== null)
    || (input.scenario === 'provider-outage') !== (observation.provider !== null)
    || (input.scenario === 'reorg') !== (observation.reorg !== null)) {
    throw new Error('Fault observation scenario-specific section does not match the declared scenario.');
  }
  return new Map(observation.anchors.map((row) => [row.anchorId, row]));
}

function expectedFeeCeiling(fee: FeeFaultObservation, observedAt: string): number {
  if (
    !Number.isFinite(fee.estimateSatVb)
    || !Number.isFinite(fee.ceilingSatVb)
    || !Number.isFinite(fee.baseCeilingSatVb)
    || fee.estimateSatVb < 0
    || fee.ceilingSatVb < 0
    || fee.baseCeilingSatVb < 0
  ) throw new Error('Fee evidence values must be finite and non-negative.');
  if (fee.baseCeilingSatVb !== S33_CONFIGURED_BASE_FEE_CEILING_SAT_VB) {
    throw new Error('Fee evidence must bind the S3.3 configured 50 sat/vB base ceiling.');
  }
  const ageMs = time(observedAt, 'fee observedAt') - time(fee.oldestPendingAt, 'oldestPendingAt');
  if (ageMs < 0) throw new Error('Fee evidence oldestPendingAt is in the future.');
  let expected = fee.baseCeilingSatVb;
  if (ageMs > ONE_HOUR_MS) expected *= 4;
  else if (ageMs > THIRTY_MINUTES_MS) expected *= 2;
  return Math.min(expected, ABSOLUTE_FEE_CAP_SAT_VB);
}

function assertFeeCase(input: FaultCaseInput, active: FaultObservation, cleared: FaultObservation): FaultCaseSummary {
  const activeCohort = validateObservation(input, active, 'fault-active');
  const clearedCohort = validateObservation(input, cleared, 'fault-cleared');
  const activeFee = active.fee!;
  const clearedFee = cleared.fee!;
  if (expectedFeeCeiling(activeFee, active.observedAt) !== activeFee.ceilingSatVb) {
    throw new Error('Fee evidence does not match the exact age-derived dynamic ceiling.');
  }
  if (!activeFee.evaluatedBeforeClaim) throw new Error('Fee ceiling must be evaluated before claim.');
  if (activeFee.estimateSatVb <= activeFee.ceilingSatVb) throw new Error('Fault-active fee estimate must exceed its observed ceiling.');
  if (
    active.journal !== null
    || active.networkTxIds.length !== 0
    || active.broadcastAttempts !== 0
    || active.refundAnchorIds.length !== 0
    || [...activeCohort.values()].some((row) => row.status !== 'PENDING' || row.chainTxId !== null)
  ) throw new Error('Fee defer must occur before claim, journal persistence, broadcast, or refund.');
  if (expectedFeeCeiling(clearedFee, cleared.observedAt) !== clearedFee.ceilingSatVb) {
    throw new Error('Recovered fee evidence does not match the exact age-derived dynamic ceiling.');
  }
  if (clearedFee.estimateSatVb > clearedFee.ceilingSatVb) throw new Error('Fee case did not recover at or below the observed ceiling.');
  if (
    !cleared.journal
    || cleared.journal.recoveryStatus !== 'PERSISTED'
    || cleared.networkTxIds.length !== 1
    || cleared.broadcastAttempts !== 1
    || cleared.refundAnchorIds.length !== 0
    || [...clearedCohort.values()].some((row) => row.status !== 'SUBMITTED' || row.chainTxId !== cleared.journal!.txId)
  ) throw new Error('Fee case recovery must produce one PERSISTED/SUBMITTED transaction without refund.');
  return {
    verdict: 'pass', evidenceMode: 'offline-replay', runId: input.runId, scenario: input.scenario,
    resolution: 'FEE_DEFERRED_THEN_RECOVERED', exactHeadSha: input.runtime.headSha,
    exactImageDigest: input.runtime.imageDigest, observedCeilingSatVb: activeFee.ceilingSatVb,
  };
}

function assertProviderCase(input: FaultCaseInput, active: FaultObservation, cleared: FaultObservation): FaultCaseSummary {
  const activeCohort = validateObservation(input, active, 'fault-active');
  const clearedCohort = validateObservation(input, cleared, 'fault-cleared');
  if (!active.journal || active.journal.recoveryStatus !== 'HELD') {
    throw new Error('Provider outage/disagreement must leave the journal HELD.');
  }
  const provider = active.provider!;
  if (!Number.isInteger(provider.retryAttempts) || provider.retryAttempts < 1 || provider.retryAttempts > input.retryLimit) {
    throw new Error('Provider outage exceeded the declared bounded retry limit.');
  }
  if (provider.lookups.length < 1 || !provider.lookups.some((lookup) => lookup.outcome === 'unavailable')) {
    throw new Error('Provider outage evidence requires an unavailable source and cannot assert absence.');
  }
  if (
    active.refundAnchorIds.length !== 0
    || active.networkTxIds.length !== 0
    || active.broadcastAttempts !== 1
    || [...activeCohort.values()].some((row) => row.status !== 'BROADCASTING' || row.chainTxId !== input.txId)
  ) throw new Error('Provider outage must HOLD the protected cohort with no false SECURED, refund, or destructive revert.');
  if (
    !cleared.journal
    || cleared.journal.recoveryStatus !== 'ADOPTED'
    || cleared.provider!.retryAttempts !== provider.retryAttempts
    || !cleared.provider!.lookups.some((lookup) => lookup.outcome === 'found' && lookup.txId === input.txId)
    || cleared.networkTxIds.length !== 1
    || cleared.networkTxIds[0] !== input.txId
    || cleared.broadcastAttempts !== active.broadcastAttempts
    || cleared.refundAnchorIds.length !== 0
    || [...clearedCohort.values()].some((row) => row.status !== 'SUBMITTED' || row.chainTxId !== input.txId)
  ) throw new Error('Provider recovery must exact-tx ADOPT without rebroadcast, refund, or false SECURED.');
  return {
    verdict: 'pass', evidenceMode: 'offline-replay', runId: input.runId, scenario: input.scenario,
    resolution: 'PROVIDER_HELD_THEN_ADOPTED', exactHeadSha: input.runtime.headSha,
    exactImageDigest: input.runtime.imageDigest,
  };
}

function assertReorgCase(input: FaultCaseInput, active: FaultObservation, cleared: FaultObservation): FaultCaseSummary {
  const activeCohort = validateObservation(input, active, 'fault-active');
  const clearedCohort = validateObservation(input, cleared, 'fault-cleared');
  const reorg = active.reorg!;
  if (
    !SHA256_HEX.test(reorg.priorBlockHash)
    || !SHA256_HEX.test(reorg.observedBlockHash)
    || reorg.priorBlockHash === reorg.observedBlockHash
    || reorg.proofStatus !== 'stale'
    || reorg.auditEvent !== 'anchor.reorg_reverted'
  ) throw new Error('Reorg evidence requires a pinned block-hash conflict, stale proof, and reorg audit event.');
  if (
    !active.journal
    || active.journal.recoveryStatus !== 'ADOPTED'
    || active.networkTxIds.length !== 1
    || active.networkTxIds[0] !== input.txId
    || active.broadcastAttempts !== 1
    || active.refundAnchorIds.length !== 0
    || [...activeCohort.values()].some((row) => row.status !== 'SECURED' || row.chainTxId !== input.txId)
  ) throw new Error('Reorg fault must begin from the exact ADOPTED/SECURED chain fact.');
  if (
    !cleared.journal
    || cleared.journal.recoveryStatus !== 'ADOPTED'
    || cleared.journal.journalId !== active.journal.journalId
    || cleared.networkTxIds.length !== 1
    || cleared.networkTxIds[0] !== input.txId
    || cleared.broadcastAttempts !== active.broadcastAttempts
    || cleared.refundAnchorIds.length !== 0
    || [...clearedCohort.values()].some((row) => row.status !== 'SUBMITTED' || row.chainTxId !== input.txId)
  ) throw new Error('Reorg recovery must retract every anchor to SUBMITTED with no false SECURED, rebroadcast, or refund.');
  return {
    verdict: 'pass', evidenceMode: 'offline-replay', runId: input.runId, scenario: input.scenario,
    resolution: 'REORG_REVERTED_TO_SUBMITTED', exactHeadSha: input.runtime.headSha,
    exactImageDigest: input.runtime.imageDigest,
  };
}

function validateCase(input: FaultCaseInput, active: FaultObservation, cleared: FaultObservation): FaultCaseSummary {
  const activeAt = time(active.observedAt, 'fault-active observedAt');
  const clearedAt = time(cleared.observedAt, 'fault-cleared observedAt');
  if (clearedAt <= activeAt) throw new Error('Fault clear/inspection chronology must follow the active fault.');
  if (input.scenario === 'fee-ceiling') return assertFeeCase(input, active, cleared);
  if (input.scenario === 'provider-outage') return assertProviderCase(input, active, cleared);
  return assertReorgCase(input, active, cleared);
}

export async function orchestrateFaultCase(input: FaultCaseInput, port: FaultControlPort): Promise<FaultCaseSummary> {
  const capturedInput = snapshotInput(input);
  validateInput(capturedInput);
  let primaryError: unknown;
  let result: FaultCaseSummary | undefined;
  let disarmRequired = false;
  try {
    disarmRequired = true;
    await port.arm(capturedInput);
    await port.start(capturedInput);
    const active = snapshotObservation(await port.waitForFault(capturedInput));
    await port.clear(capturedInput);
    const cleared = snapshotObservation(await port.inspect(capturedInput));
    result = validateCase(capturedInput, active, cleared);
    result.evidenceMode = port.evidenceMode;
  } catch (error) {
    primaryError = error;
  }

  let disarmError: unknown;
  if (disarmRequired) {
    try {
      await port.disarm(capturedInput);
    } catch (error) {
      disarmError = error;
    }
  }
  if (primaryError !== undefined && disarmError !== undefined) {
    throw new FaultDisarmAggregateError(primaryError, disarmError);
  }
  if (primaryError !== undefined) throw primaryError;
  if (disarmError !== undefined) throw disarmError;
  if (!result) throw new Error('Fault orchestration completed without evidence.');
  return result;
}
