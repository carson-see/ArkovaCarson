import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  composeS33RigRReleaseEvidence,
  requireS33RigRReleaseEvidence,
  type S33RigRReleaseEvidenceInput,
} from './s33-rig-r-release-evidence';

const head = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const imageDigest = `sha256:${'c'.repeat(64)}`;
const clockStart = Date.parse('2026-07-16T18:00:00.000Z');

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function liveEvalRaw(): string {
  return Array.from({ length: 96 }, (_, index) => {
    const windowStartedAt = clockStart + index * 30 * 60_000;
    const evidence = {
      schemaVersion: 'arkova.s33.rig-r.live-eval-window/v1',
      receiptId: 'rig-r-release-start:approval-1:soak-1:lease-1',
      approvalId: 'approval-1',
      soakId: 'soak-1',
      leaseId: 'lease-1',
      candidateHeadSha: head,
      candidateTreeSha: tree,
      imageDigest,
      round: index + 1,
      windowStartedAt: new Date(windowStartedAt).toISOString(),
      windowEndsAt: new Date(windowStartedAt + 30 * 60_000).toISOString(),
      entries: 48,
      requestIntervalMs: 37_500,
      providersSeen: ['gemini'],
      merited: true,
      notes: [],
      record: {
        sampledAt: new Date(windowStartedAt + 29 * 60_000).toISOString(),
        apiBase: 'https://arkova-worker-s33-r-staging.example.run.app',
        provider: 'gemini',
        sampleCount: 48,
        gateSampleCount: 48,
        gate: { passed: true, matchingEntries: 48, minimumEntries: 48 },
      },
    };
    return JSON.stringify({ ...evidence, recordSha256: digest(JSON.stringify(evidence)) });
  }).join('\n') + '\n';
}

function fixture(): S33RigRReleaseEvidenceInput {
  const liveEvalEvidenceRaw = liveEvalRaw();
  return {
    receipt: {
      receiptId: 'rig-r-release-start:approval-1:soak-1:lease-1',
      approvalId: 'approval-1',
      soakId: 'soak-1',
      leaseId: 'lease-1',
      candidateHeadSha: head,
      candidateTreeSha: tree,
      imageDigest,
      serviceUrl: 'https://arkova-worker-s33-r-staging.example.run.app',
      startedAt: '2026-07-16T17:59:00.000Z',
      authorityExpiresAt: '2026-07-19T17:00:00.000Z',
    },
    harness: {
      completedAt: '2026-07-18T18:30:00.000Z',
      liveEvalRounds: 96,
      liveEvalMeritedRounds: 96,
      liveEvalEvidencePath: 'docs/staging/s33-rig-r/soak-1-live-eval.jsonl',
      liveEvalEvidenceSha256: digest(liveEvalEvidenceRaw),
    },
    soakEvidencePath: 'docs/staging/s33-rig-r/soak-1-ai-soak.json',
    soakEvidenceRaw: JSON.stringify({
      startedAt: '2026-07-16T18:00:00.000Z',
      endedAt: '2026-07-18T18:00:01.000Z',
      durationSec: 172_801,
      apiBase: 'https://arkova-worker-s33-r-staging.example.run.app',
      totalRequests: 249_600,
      achievedRequestsPerHour: 5_199.97,
      reliability: {
        rate429: 0,
        timeoutRate: 0,
        falseReadingRate: 0,
        serverErrorRate: 0,
        unreliableRate: 0,
      },
    }),
    liveEvalEvidenceRaw,
    smokeStdout: 'Endpoint: projects/arkova1/locations/us-central1/endpoints/733006\nSMOKE PASS',
    evalStdout: '=== VERDICT: DoD met — cleared for production cutover ===',
    evalJsonPath: 'services/worker/docs/eval/eval-gemini-2026-07-18T18-31-00.json',
    evalJsonRaw: JSON.stringify({
      timestamp: '2026-07-18T18:31:00.000Z',
      provider: 'gemini',
      totalEntries: 50,
      entryResults: Array.from({ length: 50 }, () => ({})),
      overall: { macroF1: 0.8, weightedF1: 0.85 },
    }),
    analysisPath: 'services/worker/docs/eval/eval-gemini-golden-v6-2026-07-18T18-31-00.md',
    analysisRaw: 'Overall verdict: ALL DoD TARGETS MET',
    composedAt: '2026-07-18T19:00:00.000Z',
  };
}

describe('RIG-R concrete release evidence', () => {
  it('brands only the exact load/live-eval/smoke/eval artifact chain', () => {
    const result = composeS33RigRReleaseEvidence(fixture());
    expect(result.status).toBe('RIG_R_SOAK_EVIDENCE_BOUND');
    expect(result.releaseAcceptance).toBe(false);
    expect(requireS33RigRReleaseEvidence(result)).toBe(result);
    expect(() => requireS33RigRReleaseEvidence(structuredClone(result))).toThrow(/in-process/i);
  });

  it('rejects a sub-5000/hour load even when all other evidence is exact', () => {
    const exact = fixture();
    const input = { ...exact, soakEvidenceRaw: JSON.stringify({
      ...JSON.parse(exact.soakEvidenceRaw) as Record<string, unknown>,
      totalRequests: 240_000,
      achievedRequestsPerHour: 4_999.99,
    }) };
    expect(() => composeS33RigRReleaseEvidence(input)).toThrow(/soak evidence|5000|greater/i);
  });
});
