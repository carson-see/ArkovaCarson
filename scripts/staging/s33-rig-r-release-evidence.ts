/** In-process provenance brand for the exact RIG-R soak/smoke/eval outputs. */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { LIVE_PROVIDERS } from './ai-eval/eval-core';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';

const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);

const soakSummarySchema = z.object({
  startedAt: timestamp,
  endedAt: timestamp,
  durationSec: z.number().finite().min(172_800).max(172_860),
  apiBase: z.string().url(),
  totalRequests: z.number().int().min(240_000),
  achievedRequestsPerHour: z.number().finite().min(5_000),
  reliability: z.object({
    rate429: z.number().min(0).max(1),
    timeoutRate: z.number().min(0).max(1),
    falseReadingRate: z.number().min(0).max(1),
    serverErrorRate: z.number().min(0).max(1),
    unreliableRate: z.number().min(0).max(1),
  }).passthrough(),
}).passthrough();

const liveEvalLineSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-r.live-eval-window/v1'),
  receiptId: boundedId,
  approvalId: boundedId,
  soakId: boundedId,
  leaseId: boundedId,
  candidateHeadSha: gitSha,
  candidateTreeSha: gitSha,
  imageDigest: sha256,
  round: z.number().int().min(1).max(96),
  windowStartedAt: timestamp,
  windowEndsAt: timestamp,
  entries: z.literal(48),
  requestIntervalMs: z.literal(37_500),
  providersSeen: z.array(z.string().min(1)).min(1),
  merited: z.literal(true),
  notes: z.array(z.string()),
  record: z.object({
    sampledAt: timestamp,
    apiBase: z.string().url(),
    provider: z.string().min(1),
    sampleCount: z.literal(48),
    gateSampleCount: z.literal(48),
    gate: z.object({
      passed: z.literal(true),
      matchingEntries: z.literal(48),
      minimumEntries: z.literal(48),
    }).passthrough(),
  }).passthrough(),
  recordSha256: sha256,
}).strict();

const evalSummarySchema = z.object({
  timestamp,
  provider: z.literal('gemini'),
  totalEntries: z.literal(50),
  entryResults: z.array(z.unknown()).length(50),
  overall: z.object({
    macroF1: z.number().min(0.75).max(1),
    weightedF1: z.number().min(0.8).max(1),
  }).passthrough(),
}).passthrough();

export interface S33RigRReleaseEvidenceInput {
  readonly receipt: Readonly<{
    receiptId: string;
    approvalId: string;
    soakId: string;
    leaseId: string;
    candidateHeadSha: string;
    candidateTreeSha: string;
    imageDigest: string;
    serviceUrl: string;
    startedAt: string;
    authorityExpiresAt: string;
  }>;
  readonly harness: Readonly<{
    completedAt: string;
    liveEvalRounds: number;
    liveEvalMeritedRounds: number;
    liveEvalEvidencePath: string;
    liveEvalEvidenceSha256: string;
  }>;
  readonly soakEvidencePath: string;
  readonly soakEvidenceRaw: string;
  readonly liveEvalEvidenceRaw: string;
  readonly smokeStdout: string;
  readonly evalStdout: string;
  readonly evalJsonPath: string;
  readonly evalJsonRaw: string;
  readonly analysisPath: string;
  readonly analysisRaw: string;
  readonly composedAt: string;
}

export interface S33RigRReleaseEvidence {
  readonly schemaVersion: 'arkova.s33.rig-r.release-evidence/v1';
  readonly status: 'RIG_R_SOAK_EVIDENCE_BOUND';
  readonly releaseAcceptance: false;
  readonly exactHeadSha: string;
  readonly exactTreeSha: string;
  readonly imageDigest: string;
  readonly receiptId: string;
  readonly soakId: string;
  readonly composedAt: string;
  readonly artifacts: Readonly<{
    soakEvidencePath: string;
    soakEvidenceSha256: string;
    liveEvalEvidencePath: string;
    liveEvalEvidenceSha256: string;
    smokeStdoutSha256: string;
    evalStdoutSha256: string;
    evalJsonPath: string;
    evalJsonSha256: string;
    analysisPath: string;
    analysisSha256: string;
  }>;
  readonly resultDigestSha256: string;
}

const RESULTS = new WeakSet<S33RigRReleaseEvidence>();

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseLines(raw: string, input: S33RigRReleaseEvidenceInput): void {
  if (digest(raw) !== input.harness.liveEvalEvidenceSha256) {
    throw new Error('RIG-R live-eval JSONL digest differs from the supervised harness result.');
  }
  const lines = raw.split('\n').filter((line) => line.length > 0);
  if (lines.length !== 96 || input.harness.liveEvalRounds !== 96
    || input.harness.liveEvalMeritedRounds !== 96) {
    throw new Error('RIG-R release evidence requires exactly 96 merited live-eval windows.');
  }
  let firstWindow = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = liveEvalLineSchema.parse(parseJsonRejectingDuplicateKeys(
      lines[index]!, `RIG-R live-eval line ${index + 1}`,
    ));
    const { recordSha256, ...unsigned } = line;
    if (recordSha256 !== digest(JSON.stringify(unsigned))) {
      throw new Error(`RIG-R live-eval line ${index + 1} digest differs.`);
    }
    const expected = {
      receiptId: input.receipt.receiptId,
      approvalId: input.receipt.approvalId,
      soakId: input.receipt.soakId,
      leaseId: input.receipt.leaseId,
      candidateHeadSha: input.receipt.candidateHeadSha,
      candidateTreeSha: input.receipt.candidateTreeSha,
      imageDigest: input.receipt.imageDigest,
      round: index + 1,
    };
    if (Object.entries(expected).some(([key, value]) => line[key as keyof typeof line] !== value)
      || line.record.apiBase !== input.receipt.serviceUrl
      || line.providersSeen.some((provider) => !LIVE_PROVIDERS.has(provider))) {
      throw new Error(`RIG-R live-eval line ${index + 1} identity/provider differs.`);
    }
    const windowStart = Date.parse(line.windowStartedAt);
    const windowEnd = Date.parse(line.windowEndsAt);
    if (index === 0) firstWindow = windowStart;
    if (windowStart !== firstWindow + index * 30 * 60_000
      || windowEnd !== windowStart + 30 * 60_000
      || Date.parse(line.record.sampledAt) < windowStart
      || Date.parse(line.record.sampledAt) >= windowEnd) {
      throw new Error(`RIG-R live-eval line ${index + 1} is outside its absolute window.`);
    }
  }
  if (firstWindow < Date.parse(input.receipt.startedAt)
    || firstWindow + 48 * 60 * 60_000 > Date.parse(input.harness.completedAt)) {
    throw new Error('RIG-R live-eval windows do not cover one complete counted 48-hour interval.');
  }
}

export function composeS33RigRReleaseEvidence(
  input: S33RigRReleaseEvidenceInput,
): S33RigRReleaseEvidence {
  const composedAt = Date.parse(timestamp.parse(input.composedAt));
  const completedAt = Date.parse(timestamp.parse(input.harness.completedAt));
  const authorityExpiresAt = Date.parse(timestamp.parse(input.receipt.authorityExpiresAt));
  if (composedAt < completedAt || composedAt >= authorityExpiresAt) {
    throw new Error('RIG-R evidence composition falls outside completion/authority chronology.');
  }
  const soak = soakSummarySchema.parse(parseJsonRejectingDuplicateKeys(
    input.soakEvidenceRaw, 'RIG-R soak evidence',
  ));
  if (soak.apiBase !== input.receipt.serviceUrl
    || Date.parse(soak.startedAt) < Date.parse(input.receipt.startedAt)
    || Date.parse(soak.endedAt) > completedAt) {
    throw new Error('RIG-R soak evidence differs from the counted service/clock.');
  }
  parseLines(input.liveEvalEvidenceRaw, input);
  if (!input.smokeStdout.includes('SMOKE PASS')
    || !input.smokeStdout.includes('projects/arkova1/locations/us-central1/endpoints/733014')) {
    throw new Error('RIG-R smoke output does not prove the exact endpoint PASS.');
  }
  const evalSummary = evalSummarySchema.parse(parseJsonRejectingDuplicateKeys(
    input.evalJsonRaw, 'RIG-R supplemental eval JSON',
  ));
  if (!input.evalStdout.includes('VERDICT: DoD met')
    || !input.analysisRaw.includes('ALL DoD TARGETS MET')
    || Date.parse(evalSummary.timestamp) < completedAt) {
    throw new Error('RIG-R supplemental eval/analyzer evidence is missing, stale, or failed.');
  }
  const artifacts = {
    soakEvidencePath: input.soakEvidencePath,
    soakEvidenceSha256: digest(input.soakEvidenceRaw),
    liveEvalEvidencePath: input.harness.liveEvalEvidencePath,
    liveEvalEvidenceSha256: digest(input.liveEvalEvidenceRaw),
    smokeStdoutSha256: digest(input.smokeStdout),
    evalStdoutSha256: digest(input.evalStdout),
    evalJsonPath: input.evalJsonPath,
    evalJsonSha256: digest(input.evalJsonRaw),
    analysisPath: input.analysisPath,
    analysisSha256: digest(input.analysisRaw),
  };
  if (artifacts.liveEvalEvidenceSha256 !== input.harness.liveEvalEvidenceSha256) {
    throw new Error('RIG-R live-eval evidence digest changed during composition.');
  }
  const withoutDigest = {
    schemaVersion: 'arkova.s33.rig-r.release-evidence/v1' as const,
    status: 'RIG_R_SOAK_EVIDENCE_BOUND' as const,
    releaseAcceptance: false as const,
    exactHeadSha: gitSha.parse(input.receipt.candidateHeadSha),
    exactTreeSha: gitSha.parse(input.receipt.candidateTreeSha),
    imageDigest: sha256.parse(input.receipt.imageDigest),
    receiptId: boundedId.parse(input.receipt.receiptId),
    soakId: boundedId.parse(input.receipt.soakId),
    composedAt: input.composedAt,
    artifacts,
  };
  const result = freeze<S33RigRReleaseEvidence>({
    ...withoutDigest,
    resultDigestSha256: digest(JSON.stringify(withoutDigest)),
  });
  RESULTS.add(result);
  return result;
}

export function requireS33RigRReleaseEvidence(candidate: unknown): S33RigRReleaseEvidence {
  if (!candidate || typeof candidate !== 'object' || !RESULTS.has(candidate as S33RigRReleaseEvidence)) {
    throw new Error('RIG-R release evidence requires an in-process production-composed result.');
  }
  return candidate as S33RigRReleaseEvidence;
}
