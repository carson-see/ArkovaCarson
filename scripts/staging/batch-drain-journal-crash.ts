/**
 * SCRUM-2692 B1-B4 journal-aware crash evidence contract.
 *
 * This module consumes already-captured facts only. It never controls a rig or
 * infers a verdict from filenames/log prose. The live/replay adapters own raw
 * collection; this pure boundary proves the exact journal/cohort transition.
 */

import { parseUtcTimestamp } from './batch-drain-time';

export const DEFAULT_JOURNAL_AMBIGUITY_WINDOW_MS = 30 * 60 * 1000;
export const PRIMARY_SIGNET_LOOKUP_SOURCE = 'bitcoin-core-signet-rpc' as const;
export const SECONDARY_SIGNET_LOOKUP_SOURCE = 'mempool-space' as const;
export const REQUIRED_SIGNET_LOOKUP_SOURCES = Object.freeze([
  PRIMARY_SIGNET_LOOKUP_SOURCE,
  SECONDARY_SIGNET_LOOKUP_SOURCE,
] as const);

export type JournalCrashCase = 'B1' | 'B2' | 'B3' | 'B4';
export type JournalRecoveryStatus = 'PENDING' | 'HELD' | 'ADOPTED' | 'REVERTED' | 'PERSISTED';
export type ChainLookupSource = typeof REQUIRED_SIGNET_LOOKUP_SOURCES[number];
export type ChainLookupOutcome = 'found' | 'not-found' | 'unavailable' | 'negative-confirmations';

export interface JournalRuntimeBinding {
  headSha: string;
  imageDigest: string;
}

export interface TxidJournalSnapshot {
  journalId: string;
  batchId: string;
  txId: string;
  fingerprintRoot: string;
  anchorIds: string[];
  createdAt: string;
  recoveryStatus: JournalRecoveryStatus;
  holdReason: string | null;
  heldAt: string | null;
  resolvedAt: string | null;
  observedAt: string;
}

export interface JournalChainLookupObservation {
  source: ChainLookupSource;
  outcome: ChainLookupOutcome;
  txId: string;
  confirmations: number | null;
  observedAt: string;
}

export interface JournalBroadcastAttempt {
  txId: string;
  signedBytesSha256: string;
}

export interface JournalAnchorObservation {
  anchorId: string;
  status: 'PENDING' | 'BROADCASTING' | 'SUBMITTED' | 'SECURED';
  chainTxId: string | null;
  creditDisposition: 'not-charged' | 'retained' | 'refunded';
}

export interface JournalCrashBarrierEvidence {
  observedAt: string;
  journal: TxidJournalSnapshot | null;
  networkTxIds: string[];
  broadcastAttempts: JournalBroadcastAttempt[];
}

export interface JournalCrashRecoveryEvidence {
  observedAt: string;
  journal: TxidJournalSnapshot | null;
  lookups: JournalChainLookupObservation[];
  anchors: JournalAnchorObservation[];
  networkTxIds: string[];
  broadcastAttempts: JournalBroadcastAttempt[];
}

export interface JournalCrashEvidence {
  schemaVersion: 1;
  crashCase: JournalCrashCase;
  runId: string;
  batchId: string;
  schedulerExecutionId: string;
  faultWindowId: string;
  runtime: JournalRuntimeBinding;
  txId: string | null;
  fingerprintRoot: string | null;
  anchorIds: string[];
  barrier: JournalCrashBarrierEvidence;
  recovery: JournalCrashRecoveryEvidence;
}

export interface JournalCrashEvidenceSummary {
  crashCase: JournalCrashCase;
  runId: string;
  batchId: string;
  resolution: 'NO_JOURNAL_SAFE_REVERT' | 'AFFIRMATIVE_ABSENCE_REVERT' | 'EXACT_TX_ADOPT' | 'POST_SUBMIT_PERSISTED';
  duplicateBroadcasts: 0;
  exactHeadSha: string;
  exactImageDigest: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function time(value: string, label: string): number {
  return parseUtcTimestamp(value, label);
}

function requireIdentity(value: string, label: string): void {
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!value || value.length > 200 || hasControlCharacter) {
    throw new Error(`${label} must be a bounded non-empty identity.`);
  }
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

function sameOrderedStrings(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length && expected.every((value, index) => value === actual[index]);
}

function exactSignetLookupPair(
  lookups: readonly JournalChainLookupObservation[],
): Map<ChainLookupSource, JournalChainLookupObservation> | null {
  if (lookups.length !== REQUIRED_SIGNET_LOOKUP_SOURCES.length) return null;
  const bySource = new Map(lookups.map((lookup) => [lookup.source, lookup]));
  if (
    bySource.size !== REQUIRED_SIGNET_LOOKUP_SOURCES.length
    || REQUIRED_SIGNET_LOOKUP_SOURCES.some((source) => !bySource.has(source))
  ) return null;
  return bySource;
}

function validateJournalShape(snapshot: TxidJournalSnapshot, label: string): void {
  if (!UUID.test(snapshot.journalId)) throw new Error(`${label} journal id must be a UUID.`);
  requireIdentity(snapshot.batchId, `${label} batchId`);
  if (!SHA256_HEX.test(snapshot.txId) || !SHA256_HEX.test(snapshot.fingerprintRoot)) {
    throw new Error(`${label} journal tx/root identity is invalid.`);
  }
  if (snapshot.anchorIds.length < 1 || snapshot.anchorIds.length > 10_000) {
    throw new Error(`${label} journal cohort must contain 1..10000 anchors.`);
  }
  requireUnique(snapshot.anchorIds, `${label} journal anchor ids`);
  if (snapshot.anchorIds.some((anchorId) => !UUID.test(anchorId))) {
    throw new Error(`${label} journal anchor ids must be UUIDs.`);
  }
  const createdAt = time(snapshot.createdAt, `${label} journal createdAt`);
  const observedAt = time(snapshot.observedAt, `${label} journal observedAt`);
  if (observedAt < createdAt) throw new Error(`${label} journal chronology is invalid.`);
  const unresolved = snapshot.recoveryStatus === 'PENDING' || snapshot.recoveryStatus === 'HELD';
  if (unresolved !== (snapshot.resolvedAt === null)) {
    throw new Error(`${label} journal resolution timestamp contradicts recovery status.`);
  }
  if (snapshot.recoveryStatus === 'HELD') {
    if (!snapshot.holdReason || snapshot.heldAt === null) throw new Error(`${label} HELD journal requires hold evidence.`);
    if (time(snapshot.heldAt, `${label} heldAt`) < createdAt) throw new Error(`${label} HELD chronology is invalid.`);
  } else if (snapshot.holdReason !== null || snapshot.heldAt !== null) {
    throw new Error(`${label} non-HELD snapshot cannot carry hold fields.`);
  }
  if (snapshot.resolvedAt !== null) {
    const resolvedAt = time(snapshot.resolvedAt, `${label} resolvedAt`);
    if (resolvedAt < createdAt || resolvedAt > observedAt) throw new Error(`${label} journal resolution chronology is invalid.`);
  }
}

function assertJournalIdentity(evidence: JournalCrashEvidence, snapshot: TxidJournalSnapshot, label: string): void {
  validateJournalShape(snapshot, label);
  if (
    evidence.txId === null
    || evidence.fingerprintRoot === null
    || snapshot.batchId !== evidence.batchId
    || snapshot.txId !== evidence.txId
    || snapshot.fingerprintRoot !== evidence.fingerprintRoot
    || !sameOrderedStrings(evidence.anchorIds, snapshot.anchorIds)
  ) throw new Error(`${label} journal identity does not match the exact batch, txid, root, and ordered cohort.`);
}

function assertExactCohort(evidence: JournalCrashEvidence): Map<string, JournalAnchorObservation> {
  if (evidence.recovery.anchors.length !== evidence.anchorIds.length) {
    throw new Error('Recovery must report the complete journal cohort exactly once.');
  }
  const byId = new Map(evidence.recovery.anchors.map((row) => [row.anchorId, row]));
  if (byId.size !== evidence.anchorIds.length || evidence.anchorIds.some((anchorId) => !byId.has(anchorId))) {
    throw new Error('Recovery must report the complete journal cohort exactly once.');
  }
  return byId;
}

function assertAttemptSet(evidence: JournalCrashEvidence, expectedCount: 0 | 1): void {
  const barrierAttempts = evidence.barrier.broadcastAttempts;
  const recoveryAttempts = evidence.recovery.broadcastAttempts;
  if (
    barrierAttempts.length !== expectedCount
    || recoveryAttempts.length !== expectedCount
    || evidence.barrier.networkTxIds.length !== expectedCount
    || evidence.recovery.networkTxIds.length !== expectedCount
  ) {
    throw new Error('Crash evidence contains a duplicate rebroadcast or an unexpected network transaction.');
  }
  if (expectedCount === 0) return;
  const expectedTxId = evidence.txId!;
  const barrier = barrierAttempts[0]!;
  const recovered = recoveryAttempts[0]!;
  if (
    barrier.txId !== expectedTxId
    || recovered.txId !== expectedTxId
    || barrier.signedBytesSha256 !== recovered.signedBytesSha256
    || !SHA256_HEX.test(barrier.signedBytesSha256)
    || evidence.barrier.networkTxIds[0] !== expectedTxId
    || evidence.recovery.networkTxIds[0] !== expectedTxId
  ) throw new Error('Crash evidence does not bind one exact signed transaction without rebroadcast.');
}

function assertPendingCompensated(cohort: Map<string, JournalAnchorObservation>): void {
  if ([...cohort.values()].some((row) => (
    row.status !== 'PENDING'
    || row.chainTxId !== null
    || row.creditDisposition === 'retained'
  ))) throw new Error('REVERT must atomically return the complete cohort to PENDING with credit compensation/refund for every charge.');
}

function assertSubmittedExact(evidence: JournalCrashEvidence, cohort: Map<string, JournalAnchorObservation>): void {
  if ([...cohort.values()].some((row) => (
    row.status !== 'SUBMITTED'
    || row.chainTxId !== evidence.txId
    || row.creditDisposition === 'refunded'
  ))) throw new Error('ADOPT/PERSISTED must leave the complete cohort SUBMITTED on the exact txid without refunds.');
}

function assertBaseEvidence(evidence: JournalCrashEvidence): Map<string, JournalAnchorObservation> {
  if (evidence.schemaVersion !== 1) throw new Error('Unsupported journal crash evidence schema version.');
  if (!['B1', 'B2', 'B3', 'B4'].includes(evidence.crashCase)) throw new Error('Unsupported journal crash case.');
  requireIdentity(evidence.runId, 'runId');
  requireIdentity(evidence.batchId, 'batchId');
  requireIdentity(evidence.schedulerExecutionId, 'schedulerExecutionId');
  requireIdentity(evidence.faultWindowId, 'faultWindowId');
  if (!HEAD_SHA.test(evidence.runtime.headSha) || !IMAGE_DIGEST.test(evidence.runtime.imageDigest)) {
    throw new Error('Journal crash evidence requires the exact lowercase tested head and image digest.');
  }
  if (evidence.anchorIds.length < 1 || evidence.anchorIds.length > 10_000) {
    throw new Error('Journal crash evidence requires 1..10000 anchor ids.');
  }
  requireUnique(evidence.anchorIds, 'anchor ids');
  if (evidence.anchorIds.some((anchorId) => !UUID.test(anchorId))) throw new Error('Anchor ids must be UUIDs.');
  const barrierAt = time(evidence.barrier.observedAt, 'barrier observedAt');
  const recoveryAt = time(evidence.recovery.observedAt, 'recovery observedAt');
  if (recoveryAt <= barrierAt) throw new Error('Crash recovery chronology must follow the exact barrier.');
  if (evidence.crashCase === 'B1' && evidence.barrier.journal !== null) {
    throw new Error('B1 pre-sign barrier must not contain a journal.');
  }
  if (evidence.barrier.journal) {
    assertJournalIdentity(evidence, evidence.barrier.journal, 'Barrier');
    if (time(evidence.barrier.journal.observedAt, 'barrier journal observedAt') > barrierAt) {
      throw new Error('Barrier journal chronology is invalid.');
    }
  }
  if (evidence.recovery.journal) {
    assertJournalIdentity(evidence, evidence.recovery.journal, 'Recovery');
    if (time(evidence.recovery.journal.observedAt, 'recovery journal observedAt') > recoveryAt) {
      throw new Error('Recovery journal chronology is invalid.');
    }
  }
  for (const lookup of evidence.recovery.lookups) {
    if (!(REQUIRED_SIGNET_LOOKUP_SOURCES as readonly string[]).includes(lookup.source)) {
      throw new Error('Lookup source is not an approved independent Signet observer.');
    }
    if (!SHA256_HEX.test(lookup.txId) || lookup.txId !== evidence.txId) {
      throw new Error('Lookup does not prove the exact journaled txid.');
    }
    const lookupAt = time(lookup.observedAt, 'lookup observedAt');
    if (lookupAt <= barrierAt || lookupAt > recoveryAt) throw new Error('Lookup chronology is outside crash recovery.');
    if (lookup.outcome === 'found' && (!Number.isInteger(lookup.confirmations) || lookup.confirmations! < 0)) {
      throw new Error('A found lookup requires non-negative confirmations.');
    }
    if (lookup.outcome !== 'found' && lookup.confirmations !== null) {
      throw new Error('A non-found lookup cannot claim confirmations.');
    }
  }
  return assertExactCohort(evidence);
}

export function assertJournalCrashEvidence(evidence: JournalCrashEvidence): JournalCrashEvidenceSummary {
  const cohort = assertBaseEvidence(evidence);
  let resolution: JournalCrashEvidenceSummary['resolution'];

  if (evidence.crashCase === 'B1') {
    if (evidence.txId !== null || evidence.fingerprintRoot !== null || evidence.barrier.journal !== null) {
      throw new Error('B1 must stop before signing and therefore has no txid, root, or journal.');
    }
    if (evidence.recovery.journal !== null || evidence.recovery.lookups.length !== 0) {
      throw new Error('B1 safe recovery cannot invent a journal or chain lookup.');
    }
    if (
      evidence.barrier.networkTxIds.length !== 0
      || evidence.barrier.broadcastAttempts.length !== 0
      || evidence.recovery.networkTxIds.length !== 0
      || evidence.recovery.broadcastAttempts.length !== 0
    ) throw new Error('B1 must contain no network transaction or broadcast attempt.');
    assertAttemptSet(evidence, 0);
    assertPendingCompensated(cohort);
    resolution = 'NO_JOURNAL_SAFE_REVERT';
  } else {
    if (!evidence.txId || !evidence.fingerprintRoot || !SHA256_HEX.test(evidence.txId) || !SHA256_HEX.test(evidence.fingerprintRoot)) {
      throw new Error(`${evidence.crashCase} requires exact journal txid and fingerprint root.`);
    }
    if (!evidence.barrier.journal || !evidence.recovery.journal) {
      throw new Error(`${evidence.crashCase} requires barrier and recovery journal snapshots.`);
    }
    if (
      evidence.barrier.journal.journalId !== evidence.recovery.journal.journalId
      || evidence.barrier.journal.createdAt !== evidence.recovery.journal.createdAt
    ) throw new Error(`${evidence.crashCase} recovery must preserve the same journal row and creation time.`);

    if (evidence.crashCase === 'B2') {
      if (evidence.barrier.journal.recoveryStatus !== 'PENDING') throw new Error('B2 barrier journal must be PENDING.');
      if (evidence.recovery.journal.recoveryStatus !== 'REVERTED') throw new Error('B2 recovery journal must be REVERTED.');
      const sources = exactSignetLookupPair(evidence.recovery.lookups);
      if (
        sources === null
        || sources.get(PRIMARY_SIGNET_LOOKUP_SOURCE)?.outcome !== 'not-found'
        || sources.get(SECONDARY_SIGNET_LOOKUP_SOURCE)?.outcome !== 'not-found'
      ) throw new Error('B2 REVERT requires exactly one distinct not-found from Bitcoin Core Signet RPC and mempool.space Signet.');
      const createdAt = time(evidence.barrier.journal.createdAt, 'B2 journal createdAt');
      const resolvedAt = time(evidence.recovery.journal.resolvedAt!, 'B2 journal resolvedAt');
      if ([...sources.values()].some((lookup) => (
        time(lookup.observedAt, 'B2 absence observedAt') - createdAt < DEFAULT_JOURNAL_AMBIGUITY_WINDOW_MS
        || time(lookup.observedAt, 'B2 absence observedAt') > resolvedAt
      ))) throw new Error('B2 affirmative absence must be observed after the ambiguity window and before REVERT resolution.');
      assertAttemptSet(evidence, 0);
      assertPendingCompensated(cohort);
      resolution = 'AFFIRMATIVE_ABSENCE_REVERT';
    } else if (evidence.crashCase === 'B3') {
      if (evidence.barrier.journal.recoveryStatus !== 'PENDING') throw new Error('B3 barrier journal must be PENDING.');
      if (evidence.recovery.journal.recoveryStatus !== 'ADOPTED') throw new Error('B3 recovery journal must be ADOPTED.');
      if (!evidence.recovery.lookups.some((lookup) => lookup.outcome === 'found' && lookup.txId === evidence.txId)) {
        throw new Error('B3 ADOPT requires an exact txid found lookup.');
      }
      assertAttemptSet(evidence, 1);
      assertSubmittedExact(evidence, cohort);
      resolution = 'EXACT_TX_ADOPT';
    } else {
      if (evidence.barrier.journal.recoveryStatus !== 'PERSISTED') throw new Error('B4 barrier journal must be PERSISTED.');
      if (evidence.recovery.journal.recoveryStatus !== 'PERSISTED') {
        throw new Error('B4 requires PERSISTED with no recovery mutation.');
      }
      const barrier = evidence.barrier.journal;
      const recovered = evidence.recovery.journal;
      if (
        barrier.journalId !== recovered.journalId
        || barrier.resolvedAt !== recovered.resolvedAt
        || barrier.createdAt !== recovered.createdAt
      ) throw new Error('B4 PERSISTED journal changed during recovery; no recovery mutation is allowed.');
      if (evidence.recovery.lookups.length !== 0) throw new Error('B4 PERSISTED requires no recovery lookup or mutation.');
      assertAttemptSet(evidence, 1);
      assertSubmittedExact(evidence, cohort);
      resolution = 'POST_SUBMIT_PERSISTED';
    }
  }

  return {
    crashCase: evidence.crashCase,
    runId: evidence.runId,
    batchId: evidence.batchId,
    resolution,
    duplicateBroadcasts: 0,
    exactHeadSha: evidence.runtime.headSha,
    exactImageDigest: evidence.runtime.imageDigest,
  };
}
