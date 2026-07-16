import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  SOAK_WALL_FLOOR_MINUTES,
  SOAK_REQUIRED_UPTIME_MINUTES,
  createEvidenceEnvelopeVerifierForTest,
  createProductionEvidenceEnvelopeVerifier,
  deriveAndAssertLiveEvidence,
  getS33B1EvidenceVerificationAuthority,
  parseRawCaptureSet,
  type ImmutableRunDeclaration,
  type ParsedRawCaptureSet,
  type RawCaptureDigests,
  type RawCaptureTextSet,
} from './batch-drain-live-evidence';
import rigB1AdmissionFixture from './fixtures/rig-b1-admission-v2.json';

const BASE_SHA = '0'.repeat(40);
const HEAD_SHA = 'a'.repeat(40);
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
const PROJECT_REF = 'abcdefghijklmnopqrst';
const FP_DRAINED = '1'.repeat(64);
const FP_POISON = '2'.repeat(64);
const FP_DRAINED_SECOND_ORG = '3'.repeat(64);
const TX_ID = 'c'.repeat(64);
const TX_ID_SECOND_ORG = 'e'.repeat(64);
const SIGNED_HASH = 'd'.repeat(64);
const SIGNED_HASH_SECOND_ORG = 'f'.repeat(64);
const ANCHOR_DRAINED_ID = '60000000-0000-4000-8000-000000000001';
const ANCHOR_DRAINED_SECOND_ORG_ID = '60000000-0000-4000-8000-000000000002';
const JOURNAL_ID = '70000000-0000-4000-8000-000000000001';
const JOURNAL_SECOND_ORG_ID = '70000000-0000-4000-8000-000000000002';
const TEST_KEYPAIR = generateKeyPairSync('ed25519');
const TEST_PUBLIC_KEY_PEM = TEST_KEYPAIR.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const TEST_KEY_FINGERPRINT = createHash('sha256')
  .update(TEST_KEYPAIR.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const TEST_KEY_ID = 'arkova.test.s33.b1-evidence.ed25519.v1';
const TEST_VERIFIER = createEvidenceEnvelopeVerifierForTest({
  keyId: TEST_KEY_ID,
  publicKeyPem: TEST_PUBLIC_KEY_PEM,
  keyFingerprint: TEST_KEY_FINGERPRINT,
});

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function declarationValue(): Record<string, unknown> {
  const workerService = 'arkova-worker-rig-b1-staging';
  const infrastructure = structuredClone(rigB1AdmissionFixture.infrastructure);
  infrastructure.schedulerJobs = [
    'batch-anchors',
    'batch-anchors-forced-flush',
    'check-confirmations',
    'org-queue-scheduler',
    'populate-confirmation-proofs',
    'recover-broadcasts',
  ].map((suffix) => `${workerService}-${suffix}`);
  return {
    schemaVersion: 1,
    declarationId: 'decl-rig-b1-r3',
    gitBaseSha: BASE_SHA,
    gitHeadSha: HEAD_SHA,
    imageDigest: IMAGE_DIGEST,
    rigId: 'RIG-B1',
    gcpProjectId: 'arkova-rig-b1',
    projectRef: PROJECT_REF,
    soakId: 'soak-rig-b1-r3',
    leaseId: 'lease-rig-b1',
    cleanMirrorAttestationId: 'clean-mirror-rig-b1',
    workerService,
    workerRevision: 'arkova-worker-rig-b1-staging-00001',
    region: 'us-central1',
    infrastructure,
    soakStartedAt: '2026-07-13T12:00:00.000Z',
    soakEndedAt: '2026-07-15T12:30:00.000Z',
    recoveries: [],
    windows: [{
      scenarioId: 'poison-window',
      kind: 'poison-isolation',
      armedTrigger: 'org-scheduler',
      expectedInitialPending: 2,
      expectedFinalPending: 1,
      passes: [{
        batchId: 'batch-live-1',
        armedTrigger: 'org-scheduler',
        schedulerExecutionId: 'scheduler-live-1',
        faultWindow: {
          id: 'window-live-1',
          startsAt: '2026-07-13T12:00:00.000Z',
          endsAt: '2026-07-13T12:01:00.000Z',
        },
        claims: [
          { fingerprint: FP_DRAINED, orgId: 'org-healthy' },
          { fingerprint: FP_POISON, orgId: 'org-poison' },
        ],
      }],
    }],
  };
}

function immutable(value: Record<string, unknown> = declarationValue()): ImmutableRunDeclaration {
  const declarationRaw = JSON.stringify(value);
  const declarationSha256 = sha256(declarationRaw);
  const captures = rawCapturesForDeclaration(declarationSha256);
  return trust(value, captures);
}

function trust(value: Record<string, unknown>, captures: RawCaptureTextSet): ImmutableRunDeclaration {
  const signedPayloadRaw = JSON.stringify({
    schemaVersion: 1,
    envelopeId: 'trust-root-rig-b1-r3',
    declaration: value,
    rawCaptureDigests: digests(captures),
  });
  const envelopeRaw = JSON.stringify({
    schemaVersion: 1,
    envelopeId: 'trust-root-rig-b1-r3',
    keyId: TEST_KEY_ID,
    keyFingerprint: TEST_KEY_FINGERPRINT,
    signedPayloadRaw,
    signatureBase64: sign(null, Buffer.from(signedPayloadRaw), TEST_KEYPAIR.privateKey).toString('base64'),
  });
  return TEST_VERIFIER.verify(envelopeRaw);
}

function rawCaptures(declaration: ImmutableRunDeclaration): RawCaptureTextSet {
  return rawCapturesForDeclaration(declaration.contentSha256);
}

function rawCapturesForDeclaration(declarationSha256: string): RawCaptureTextSet {
  const common = (source: string, exportId: string) => ({
    schemaVersion: 1,
    source,
    exportId,
    declarationSha256,
    rigId: 'RIG-B1',
    soakId: 'soak-rig-b1-r3',
    gitHeadSha: HEAD_SHA,
    imageDigest: IMAGE_DIGEST,
    generatedAt: '2026-07-15T12:31:00.000Z',
  });
  return {
    scheduler: JSON.stringify({
      ...common('cloud-scheduler', 'export-scheduler'),
      records: [
        {
          recordId: 'scheduler-preclock-record', purpose: 'preclock',
          schedulerExecutionId: 'scheduler-preclock', gcpProjectId: 'arkova-rig-b1',
          correlatedDrainExecutionId: null, faultWindowId: null,
          workerRevision: 'arkova-worker-rig-b1-staging-00001', path: '/jobs/check-confirmations',
          workerId: 'worker-live-1',
          trigger: 'global-flush', statusCode: 200,
          firedAt: '2026-07-13T11:59:00.000Z', completedAt: '2026-07-13T11:59:01.000Z',
        },
        {
          recordId: 'scheduler-drain-record', purpose: 'drain',
          schedulerExecutionId: 'scheduler-live-1', gcpProjectId: 'arkova-rig-b1',
          correlatedDrainExecutionId: null, faultWindowId: 'window-live-1',
          workerRevision: 'arkova-worker-rig-b1-staging-00001', path: '/jobs/org-queue-scheduler',
          workerId: 'worker-live-1',
          trigger: 'org-scheduler', statusCode: 200,
          firedAt: '2026-07-13T12:00:05.000Z', completedAt: '2026-07-13T12:00:20.000Z',
        },
      ],
    }),
    workerLogs: JSON.stringify({
      ...common('cloud-logging', 'export-worker-logs'),
      records: [
        {
          recordId: 'log-trigger', insertId: 'insert-trigger', traceId: 'trace-live-1',
          workerId: 'worker-live-1',
          event: 'trigger-fired', schedulerExecutionId: 'scheduler-live-1', batchId: 'batch-live-1',
          trigger: 'org-scheduler', fingerprint: null, orgId: null, decision: null, reason: null,
          referenceId: null, requiredAmount: null, balanceBefore: null, balanceAfter: null,
          occurredAt: '2026-07-13T12:00:06.000Z',
        },
        {
          recordId: 'log-gate-healthy', insertId: 'insert-gate-healthy', traceId: 'trace-live-1',
          workerId: 'worker-live-1',
          event: 'credit-gate', schedulerExecutionId: 'scheduler-live-1', batchId: 'batch-live-1',
          trigger: 'org-scheduler', fingerprint: FP_DRAINED, orgId: 'org-healthy',
          decision: 'not-required', reason: null, referenceId: null, requiredAmount: 0,
          balanceBefore: null, balanceAfter: null, occurredAt: '2026-07-13T12:00:07.000Z',
        },
        {
          recordId: 'log-gate-poison', insertId: 'insert-gate-poison', traceId: 'trace-live-1',
          workerId: 'worker-live-1',
          event: 'credit-gate', schedulerExecutionId: 'scheduler-live-1', batchId: 'batch-live-1',
          trigger: 'org-scheduler', fingerprint: FP_POISON, orgId: 'org-poison',
          decision: 'denied', reason: 'insufficient_credits', referenceId: 'anchor-poison',
          requiredAmount: 1, balanceBefore: 0, balanceAfter: 0, occurredAt: '2026-07-13T12:00:08.000Z',
        },
      ],
    }),
    database: JSON.stringify({
      ...common('db-query-export', 'export-database'),
      projectRef: PROJECT_REF,
      queryId: 'repeatable-read-query-live-1',
      isolation: 'repeatable-read',
      executions: [{
        schedulerExecutionId: 'scheduler-live-1', armedTrigger: 'org-scheduler',
        workerId: 'worker-live-1',
        faultWindowId: 'window-live-1', startedAt: '2026-07-13T12:00:05.000Z',
        completedAt: '2026-07-13T12:00:20.000Z', pendingBefore: 2, pendingAfter: 1,
      }],
      passRows: [
        {
          fingerprint: FP_DRAINED, orgId: 'org-healthy', batchId: 'batch-live-1',
          schedulerExecutionId: 'scheduler-live-1', claimOrder: 1, status: 'SUBMITTED',
          chainTxId: TX_ID, merkleRoot: FP_DRAINED, creditDenialReason: null,
          queueCreditChargedAt: null, queueCreditDeniedAt: null,
        },
        {
          fingerprint: FP_POISON, orgId: 'org-poison', batchId: 'batch-live-1',
          schedulerExecutionId: 'scheduler-live-1', claimOrder: 2, status: 'PENDING',
          chainTxId: null, merkleRoot: null, creditDenialReason: 'insufficient_credits',
          queueCreditChargedAt: null, queueCreditDeniedAt: '2026-07-13T12:00:08.000Z',
        },
      ],
      transactions: [{
        txId: TX_ID, batchId: 'batch-live-1', merkleRoot: FP_DRAINED, signedBytesSha256: SIGNED_HASH,
      }],
      journalRows: [{
        journalId: JOURNAL_ID,
        batchId: 'batch-live-1',
        txId: TX_ID,
        fingerprintRoot: FP_DRAINED,
        anchorIds: [ANCHOR_DRAINED_ID],
        leafOrder: [{ anchorId: ANCHOR_DRAINED_ID, fingerprint: FP_DRAINED }],
        signedAt: '2026-07-13T12:00:09.000Z',
        recoveryStatus: 'PERSISTED',
        holdReason: null,
        heldAt: null,
        resolvedAt: '2026-07-13T12:00:15.000Z',
        createdAt: '2026-07-13T12:00:09.000Z',
        updatedAt: '2026-07-13T12:00:15.000Z',
      }],
      txLeaves: [{
        txId: TX_ID, batchId: 'batch-live-1', anchorId: ANCHOR_DRAINED_ID, fingerprint: FP_DRAINED,
        orgId: 'org-healthy', merkleIndex: 0,
      }],
      proofs: [{
        txId: TX_ID, batchId: 'batch-live-1', anchorId: ANCHOR_DRAINED_ID, fingerprint: FP_DRAINED,
        orgId: 'org-healthy', merkleIndex: 0, merkleRoot: FP_DRAINED,
        leafCount: 1, proofPath: [],
      }],
      creditLedgerEvents: [],
      orgBalances: [
        { schedulerExecutionId: 'scheduler-live-1', orgId: 'org-healthy', before: 10, after: 10 },
        { schedulerExecutionId: 'scheduler-live-1', orgId: 'org-poison', before: 0, after: 0 },
      ],
      ledgerDeltas: [
        { schedulerExecutionId: 'scheduler-live-1', orgId: 'org-healthy', delta: 0 },
        { schedulerExecutionId: 'scheduler-live-1', orgId: 'org-poison', delta: 0 },
      ],
    }),
    signet: JSON.stringify({
      ...common('signet-rpc', 'export-signet'),
      records: [{
        recordId: 'signet-record-1', rpcRequestId: 'rpc-request-1', rpcMethod: 'getrawtransaction',
        schedulerExecutionId: 'scheduler-live-1', workerId: 'worker-live-1',
        txId: TX_ID, batchId: 'batch-live-1', merkleRoot: FP_DRAINED,
        rawTxSha256: SIGNED_HASH, nodeId: 'signet-rig-b1', network: 'signet', state: 'mempool',
        observedAt: '2026-07-13T12:00:12.000Z',
      }],
    }),
    cloudRun: JSON.stringify({
      ...common('cloud-run-lifecycle', 'export-cloud-run'),
      gcpProjectId: 'arkova-rig-b1', workerService: 'arkova-worker-rig-b1-staging',
      workerRevision: 'arkova-worker-rig-b1-staging-00001', region: 'us-central1',
      records: [
        { recordId: 'cloud-run-start', workerId: 'worker-live-1', event: 'started', occurredAt: '2026-07-13T11:58:00.000Z' },
        ...Array.from({ length: 583 }, (_, index) => ({
          recordId: `cloud-run-heartbeat-${index}`,
          workerId: 'worker-live-1',
          event: 'heartbeat',
          occurredAt: new Date(Date.parse('2026-07-13T12:00:00.000Z') + index * 5 * 60_000).toISOString(),
        })),
        { recordId: 'cloud-run-stop', workerId: 'worker-live-1', event: 'stopped', occurredAt: '2026-07-15T12:30:00.000Z' },
      ],
    }),
    supervisor: JSON.stringify({
      ...common('supervisor-records', 'export-supervisor'),
      cleanMirror: {
        attestationId: 'clean-mirror-rig-b1', result: 'pass', projectRef: PROJECT_REF,
        gitBaseSha: BASE_SHA, gitHeadSha: HEAD_SHA, observedAt: '2026-07-13T11:58:00.000Z',
      },
      lease: {
        leaseId: 'lease-rig-b1', state: 'active', holder: 'lane1-rig-operator',
        acquiredAt: '2026-07-13T11:57:00.000Z', expiresAt: '2026-07-15T13:00:00.000Z',
      },
      runnerId: 'runner-rig-b1', supervisor: 'cloud-run-supervisor', mode: 'log-and-continue',
      records: [
        { recordId: 'runner-start', event: 'started', occurredAt: '2026-07-13T11:59:59.000Z' },
        ...Array.from({ length: 583 }, (_, index) => ({
          recordId: `runner-heartbeat-${index}`,
          event: 'heartbeat',
          occurredAt: new Date(Date.parse('2026-07-13T12:00:00.000Z') + index * 5 * 60_000).toISOString(),
        })),
        { recordId: 'runner-stop', event: 'stopped', occurredAt: '2026-07-15T12:30:01.000Z' },
      ],
    }),
  };
}

function digests(raw: RawCaptureTextSet): RawCaptureDigests {
  return {
    scheduler: sha256(raw.scheduler), workerLogs: sha256(raw.workerLogs), database: sha256(raw.database),
    signet: sha256(raw.signet), cloudRun: sha256(raw.cloudRun), supervisor: sha256(raw.supervisor),
  };
}

function deriveTrusted(raw: RawCaptureTextSet) {
  const declaration = trust(declarationValue(), raw);
  return deriveAndAssertLiveEvidence(declaration, parseRawCaptureSet(raw, declaration));
}

describe('deriveAndAssertLiveEvidence — independent strict raw-source replay', () => {
  it('activates only the code-bound B1 public authority while live execution remains separately gated', () => {
    expect(getS33B1EvidenceVerificationAuthority()).toEqual({
      keyId: 'arkova.s33.b1-evidence.ed25519.v1',
      purpose: 'B1_EVIDENCE',
      publicKeyFingerprintSha256: '8b7fbc51c74828dab2e1a3ca6f0c15069575bae8e4e190eaf3b165daea50d5c6',
      authorizedOperator: 'arkova.s33.operator.key-custodian.v1',
      activatedAtUtc: '2026-07-16T13:52:06Z',
      genesisRosterRootSha256: 'sha256:bb4d0bb56523b6cdb9701cf786d7f2828a571bd6c7fc32a247d93a2041efc51f',
    });
    expect(() => createProductionEvidenceEnvelopeVerifier()).not.toThrow();
    const signedPayloadRaw = JSON.stringify({
      schemaVersion: 1,
      envelopeId: 'trust-root-rig-b1-r3',
      declaration: declarationValue(),
      rawCaptureDigests: digests(rawCapturesForDeclaration(sha256(JSON.stringify(declarationValue())))),
    });
    const wrongAuthorityEnvelope = JSON.stringify({
      schemaVersion: 1,
      envelopeId: 'trust-root-rig-b1-r3',
      keyId: TEST_KEY_ID,
      keyFingerprint: TEST_KEY_FINGERPRINT,
      signedPayloadRaw,
      signatureBase64: sign(null, Buffer.from(signedPayloadRaw), TEST_KEYPAIR.privateKey).toString('base64'),
    });
    expect(() => createProductionEvidenceEnvelopeVerifier().verify(wrongAuthorityEnvelope))
      .toThrow(/untrusted key id|untrusted key fingerprint/i);
  });

  it('authenticates the six digests with Ed25519 and deeply freezes the parsed payload', () => {
    const declared = immutable();
    expect(Object.isFrozen(declared)).toBe(true);
    expect(Object.isFrozen(declared.value)).toBe(true);
    expect(Object.isFrozen(declared.value.windows)).toBe(true);
    expect(Object.isFrozen(declared.value.windows[0]!.passes[0]!.claims)).toBe(true);
    expect(Object.isFrozen(declared.rawCaptureDigests)).toBe(true);
    const forgedCopy = { ...declared, rawCaptureDigests: { ...declared.rawCaptureDigests } };
    expect(() => parseRawCaptureSet(rawCaptures(declared), forgedCopy)).toThrow(/verified signed.*envelope/i);
  });

  it('checks signed capture digests before parsing and rejects accessor/proxy capture containers', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    expect(() => parseRawCaptureSet({ ...raw, scheduler: '{"invalid":true}' }, declared)).toThrow(
      /raw export content digest does not match/i,
    );
    expect(() => parseRawCaptureSet(new Proxy(raw, {}) as RawCaptureTextSet, declared)).toThrow(/proxy/i);
    const accessorRaw = Object.defineProperty({ ...raw }, 'scheduler', {
      enumerable: true,
      get: () => raw.scheduler,
    }) as RawCaptureTextSet;
    expect(() => parseRawCaptureSet(accessorRaw, declared)).toThrow(/getter|accessor/i);
  });

  it('accepts exact verifier and capture key sets independent of insertion order', () => {
    expect(() => createEvidenceEnvelopeVerifierForTest({
      keyFingerprint: TEST_KEY_FINGERPRINT,
      keyId: TEST_KEY_ID,
      publicKeyPem: TEST_PUBLIC_KEY_PEM,
    })).not.toThrow();
    const declared = immutable();
    const raw = rawCaptures(declared);
    const reversed = Object.fromEntries(Object.entries(raw).reverse()) as unknown as RawCaptureTextSet;
    expect(() => parseRawCaptureSet(reversed, declared)).not.toThrow();
  });

  it.each([
    ['scheduler', 'recordId'],
    ['workerLogs', 'recordId'],
    ['database', 'schedulerExecutionId'],
    ['signet', 'recordId'],
    ['cloudRun', 'recordId'],
    ['supervisor', 'recordId'],
  ] as const)('rejects duplicate top-level and nested keys in signed %s raw bytes', (source, nestedKey) => {
    const initial = immutable();
    const base = rawCaptures(initial);
    const duplicateTopLevel = {
      ...base,
      [source]: base[source].replace('"schemaVersion":1,', '"schemaVersion":1,"schemaVersion":1,'),
    };
    const topLevelDeclaration = trust(declarationValue(), duplicateTopLevel);
    expect(() => parseRawCaptureSet(duplicateTopLevel, topLevelDeclaration)).toThrow(/duplicate.*schemaVersion/i);

    const nestedNeedle = `"${nestedKey}":`;
    const duplicateNested = {
      ...base,
      [source]: base[source].replace(nestedNeedle, `"${nestedKey}":"adversarial-duplicate",${nestedNeedle}`),
    };
    const nestedDeclaration = trust(declarationValue(), duplicateNested);
    expect(() => parseRawCaptureSet(duplicateNested, nestedDeclaration)).toThrow(
      new RegExp(`duplicate.*${nestedKey}`, 'i'),
    );
  });

  it('deeply freezes and provenance-binds a fully verified parsed capture set', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    const parsed = parseRawCaptureSet(raw, declared);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.scheduler.records)).toBe(true);
    expect(Object.isFrozen(parsed.scheduler.records[0])).toBe(true);
    expect(Object.isFrozen(parsed.database.journalRows[0]!.leafOrder)).toBe(true);
    expect(Object.isFrozen(parsed.database.journalRows[0]!.leafOrder[0])).toBe(true);
    expect(Object.isFrozen(parsed.database.proofs[0]!.proofPath)).toBe(true);
    expect(Object.isFrozen(parsed.database.proofs[0]!.proofPath[0])).toBe(true);
    expect(Object.isFrozen(parsed.supervisor.cleanMirror)).toBe(true);
    expect(Object.isFrozen(parsed.contentDigests)).toBe(true);
    expect(() => { parsed.scheduler.records[0]!.statusCode = 503; }).toThrow(TypeError);
    expect(() => { parsed.scheduler.records.push(parsed.scheduler.records[0]!); }).toThrow(TypeError);
    expect(() => { parsed.database.proofs[0]!.proofPath.push({ hash: '0'.repeat(64), position: 'left' }); }).toThrow(TypeError);
    expect(() => { (parsed.supervisor.cleanMirror as { result: string }).result = 'tampered'; }).toThrow(TypeError);
    expect(() => { parsed.contentDigests.scheduler = '0'.repeat(64); }).toThrow(TypeError);

    const fabricated = structuredClone(parsed) as ParsedRawCaptureSet;
    expect(() => deriveAndAssertLiveEvidence(declared, fabricated)).toThrow(/verified.*capture|provenance/i);
    const independentlyVerifiedDeclaration = trust(declarationValue(), raw);
    expect(() => deriveAndAssertLiveEvidence(independentlyVerifiedDeclaration, parsed)).toThrow(
      /verified.*capture|provenance/i,
    );
  });

  it('rejects a caller-recomputed six-digest envelope without the CTO signature', () => {
    const initial = immutable();
    const raw = rawCaptures(initial);
    const signet = JSON.parse(raw.signet) as { records: Array<{ nodeId: string }> };
    signet.records[0]!.nodeId = 'caller-rewritten-node';
    raw.signet = JSON.stringify(signet);
    const signedPayloadRaw = JSON.stringify({
      schemaVersion: 1,
      envelopeId: 'trust-root-rig-b1-r3',
      declaration: declarationValue(),
      rawCaptureDigests: digests(raw),
    });
    const forgedEnvelope = JSON.stringify({
      schemaVersion: 1,
      envelopeId: 'trust-root-rig-b1-r3',
      keyId: TEST_KEY_ID,
      keyFingerprint: TEST_KEY_FINGERPRINT,
      signedPayloadRaw,
      signatureBase64: Buffer.alloc(64).toString('base64'),
    });
    expect(() => TEST_VERIFIER.verify(forgedEnvelope)).toThrow(/signature/i);
  });

  it('rejects unknown/duplicate JSON ambiguity and non-primitive proxy input', () => {
    const duplicateOuter = '{"schemaVersion":1,"envelopeId":"one","envelopeId":"two",' +
      `"keyId":"${TEST_KEY_ID}","keyFingerprint":"${TEST_KEY_FINGERPRINT}",` +
      `"signedPayloadRaw":"{}","signatureBase64":"${Buffer.alloc(64).toString('base64')}"}`;
    expect(() => TEST_VERIFIER.verify(duplicateOuter)).toThrow(/duplicate/i);
    expect(() => TEST_VERIFIER.verify(new Proxy(new String('{}'), {}) as unknown as string)).toThrow(/primitive string/i);
    expect(() => createEvidenceEnvelopeVerifierForTest(new Proxy({
      publicKeyPem: TEST_PUBLIC_KEY_PEM,
      keyId: TEST_KEY_ID,
      keyFingerprint: TEST_KEY_FINGERPRINT,
    }, {}))).toThrow(/proxy/i);
    expect(() => createEvidenceEnvelopeVerifierForTest(Object.defineProperty({
      keyId: TEST_KEY_ID,
      keyFingerprint: TEST_KEY_FINGERPRINT,
    }, 'publicKeyPem', { enumerable: true, get: () => TEST_PUBLIC_KEY_PEM }))).toThrow(/getters/i);

    const captures = rawCapturesForDeclaration(sha256(JSON.stringify(declarationValue())));
    const payloadWithUnknown = JSON.stringify({
      schemaVersion: 1,
      envelopeId: 'trust-root-rig-b1-r3',
      declaration: declarationValue(),
      rawCaptureDigests: digests(captures),
      invented: true,
    });
    const envelope = JSON.stringify({
      schemaVersion: 1,
      envelopeId: 'trust-root-rig-b1-r3',
      keyId: TEST_KEY_ID,
      keyFingerprint: TEST_KEY_FINGERPRINT,
      signedPayloadRaw: payloadWithUnknown,
      signatureBase64: sign(null, Buffer.from(payloadWithUnknown), TEST_KEYPAIR.privateKey).toString('base64'),
    });
    expect(() => TEST_VERIFIER.verify(envelope)).toThrow(/unrecognized|unknown/i);

    const declarationJson = JSON.stringify(declarationValue());
    const duplicatePayload = `{"schemaVersion":1,"envelopeId":"trust-root-rig-b1-r3",` +
      `"envelopeId":"trust-root-rig-b1-r3","declaration":${declarationJson},` +
      `"rawCaptureDigests":${JSON.stringify(digests(captures))}}`;
    const duplicatePayloadEnvelope = JSON.stringify({
      schemaVersion: 1,
      envelopeId: 'trust-root-rig-b1-r3',
      keyId: TEST_KEY_ID,
      keyFingerprint: TEST_KEY_FINGERPRINT,
      signedPayloadRaw: duplicatePayload,
      signatureBase64: sign(null, Buffer.from(duplicatePayload), TEST_KEYPAIR.privateKey).toString('base64'),
    });
    expect(() => TEST_VERIFIER.verify(duplicatePayloadEnvelope)).toThrow(/duplicate/i);
  });

  it('derives a valid rig verdict and binds every exact raw digest', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    const actualDigests = digests(raw);
    const result = deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared));
    expect(result).toMatchObject({
      declarationSha256: declared.contentSha256,
      gitBaseSha: BASE_SHA,
      gitHeadSha: HEAD_SHA,
      imageDigest: IMAGE_DIGEST,
      workerUptimeMs: SOAK_WALL_FLOOR_MINUTES * 60_000,
      requiredWorkerUptimeMs: SOAK_REQUIRED_UPTIME_MINUTES * 60_000,
      windows: [{ drainedLeaves: 1, poisonLeaves: 1 }],
      sourceDigests: actualDigests,
    });
    expect(result.sourceExportIds).toHaveLength(6);
  });

  it('requires one exact final journal row per accepted transaction in the signed DB export', () => {
    const initial = immutable();

    const missing = rawCaptures(initial);
    const missingDb = JSON.parse(missing.database) as Record<string, unknown>;
    delete missingDb.journalRows;
    missing.database = JSON.stringify(missingDb);
    expect(() => parseRawCaptureSet(missing, trust(declarationValue(), missing))).toThrow(/journalRows|required/i);

    const unresolved = rawCaptures(initial);
    const unresolvedDb = JSON.parse(unresolved.database) as {
      journalRows: Array<Record<string, unknown>>;
    };
    Object.assign(unresolvedDb.journalRows[0]!, {
      recoveryStatus: 'HELD', holdReason: 'provider outage', heldAt: '2026-07-13T12:00:13.000Z', resolvedAt: null,
    });
    unresolved.database = JSON.stringify(unresolvedDb);
    expect(() => deriveTrusted(unresolved)).toThrow(/PERSISTED|hold state/i);

    const wrongCohort = rawCaptures(initial);
    const wrongCohortDb = JSON.parse(wrongCohort.database) as {
      journalRows: Array<{ anchorIds: string[]; leafOrder: Array<{ anchorId: string }> }>;
    };
    const unrelatedAnchor = '60000000-0000-4000-8000-000000000099';
    wrongCohortDb.journalRows[0]!.anchorIds = [unrelatedAnchor];
    wrongCohortDb.journalRows[0]!.leafOrder[0]!.anchorId = unrelatedAnchor;
    wrongCohort.database = JSON.stringify(wrongCohortDb);
    expect(() => deriveTrusted(wrongCohort)).toThrow(/cohort.*ordered leaves|transaction leaves/i);

    const impossibleChronology = rawCaptures(initial);
    const chronologyDb = JSON.parse(impossibleChronology.database) as {
      journalRows: Array<{ signedAt: string; createdAt: string }>;
    };
    chronologyDb.journalRows[0]!.signedAt = '2026-07-13T12:00:13.000Z';
    chronologyDb.journalRows[0]!.createdAt = '2026-07-13T12:00:13.000Z';
    impossibleChronology.database = JSON.stringify(chronologyDb);
    expect(() => deriveTrusted(impossibleChronology)).toThrow(/journal chronology|signing before acceptance/i);
  });

  it('accepts distinct transaction journals sharing one org-scheduler pass batch ID', () => {
    const value = declarationValue();
    const window = (value.windows as Array<{
      expectedInitialPending: number;
      passes: Array<{ claims: Array<{ fingerprint: string; orgId: string }> }>;
    }>)[0]!;
    window.expectedInitialPending = 3;
    window.passes[0]!.claims.push({ fingerprint: FP_DRAINED_SECOND_ORG, orgId: 'org-healthy-2' });

    const initial = immutable(value);
    const raw = rawCaptures(initial);
    const workerLogs = JSON.parse(raw.workerLogs) as { records: Array<Record<string, unknown>> };
    workerLogs.records.push({
      recordId: 'log-gate-healthy-2', insertId: 'insert-gate-healthy-2', traceId: 'trace-live-1',
      workerId: 'worker-live-1', event: 'credit-gate', schedulerExecutionId: 'scheduler-live-1',
      batchId: 'batch-live-1', trigger: 'org-scheduler', fingerprint: FP_DRAINED_SECOND_ORG,
      orgId: 'org-healthy-2', decision: 'not-required', reason: null, referenceId: null,
      requiredAmount: 0, balanceBefore: null, balanceAfter: null,
      occurredAt: '2026-07-13T12:00:07.500Z',
    });
    raw.workerLogs = JSON.stringify(workerLogs);

    const database = JSON.parse(raw.database) as {
      executions: Array<{ pendingBefore: number }>;
      passRows: Array<Record<string, unknown>>;
      transactions: Array<Record<string, unknown>>;
      journalRows: Array<Record<string, unknown>>;
      txLeaves: Array<Record<string, unknown>>;
      proofs: Array<Record<string, unknown>>;
      orgBalances: Array<Record<string, unknown>>;
      ledgerDeltas: Array<Record<string, unknown>>;
    };
    database.executions[0]!.pendingBefore = 3;
    database.passRows[1]!.claimOrder = 3;
    database.passRows.push({
      fingerprint: FP_DRAINED_SECOND_ORG, orgId: 'org-healthy-2', batchId: 'batch-live-1',
      schedulerExecutionId: 'scheduler-live-1', claimOrder: 2, status: 'SUBMITTED',
      chainTxId: TX_ID_SECOND_ORG, merkleRoot: FP_DRAINED_SECOND_ORG, creditDenialReason: null,
      queueCreditChargedAt: null, queueCreditDeniedAt: null,
    });
    database.transactions.push({
      txId: TX_ID_SECOND_ORG, batchId: 'batch-live-1', merkleRoot: FP_DRAINED_SECOND_ORG,
      signedBytesSha256: SIGNED_HASH_SECOND_ORG,
    });
    database.journalRows.push({
      journalId: JOURNAL_SECOND_ORG_ID, batchId: 'batch-live-1', txId: TX_ID_SECOND_ORG,
      fingerprintRoot: FP_DRAINED_SECOND_ORG, anchorIds: [ANCHOR_DRAINED_SECOND_ORG_ID],
      leafOrder: [{ anchorId: ANCHOR_DRAINED_SECOND_ORG_ID, fingerprint: FP_DRAINED_SECOND_ORG }],
      signedAt: '2026-07-13T12:00:10.000Z', recoveryStatus: 'PERSISTED', holdReason: null,
      heldAt: null, resolvedAt: '2026-07-13T12:00:16.000Z',
      createdAt: '2026-07-13T12:00:10.000Z', updatedAt: '2026-07-13T12:00:16.000Z',
    });
    database.txLeaves.push({
      txId: TX_ID_SECOND_ORG, batchId: 'batch-live-1', anchorId: ANCHOR_DRAINED_SECOND_ORG_ID,
      fingerprint: FP_DRAINED_SECOND_ORG, orgId: 'org-healthy-2', merkleIndex: 0,
    });
    database.proofs.push({
      txId: TX_ID_SECOND_ORG, batchId: 'batch-live-1', anchorId: ANCHOR_DRAINED_SECOND_ORG_ID,
      fingerprint: FP_DRAINED_SECOND_ORG, orgId: 'org-healthy-2', merkleIndex: 0,
      merkleRoot: FP_DRAINED_SECOND_ORG, leafCount: 1, proofPath: [],
    });
    database.orgBalances.push({
      schedulerExecutionId: 'scheduler-live-1', orgId: 'org-healthy-2', before: 10, after: 10,
    });
    database.ledgerDeltas.push({
      schedulerExecutionId: 'scheduler-live-1', orgId: 'org-healthy-2', delta: 0,
    });
    raw.database = JSON.stringify(database);

    const signet = JSON.parse(raw.signet) as { records: Array<Record<string, unknown>> };
    signet.records.push({
      recordId: 'signet-record-2', rpcRequestId: 'rpc-request-2', rpcMethod: 'getrawtransaction',
      schedulerExecutionId: 'scheduler-live-1', workerId: 'worker-live-1', txId: TX_ID_SECOND_ORG,
      batchId: 'batch-live-1', merkleRoot: FP_DRAINED_SECOND_ORG,
      rawTxSha256: SIGNED_HASH_SECOND_ORG, nodeId: 'signet-rig-b1', network: 'signet',
      state: 'mempool', observedAt: '2026-07-13T12:00:13.000Z',
    });
    raw.signet = JSON.stringify(signet);

    const declared = trust(value, raw);
    expect(() => deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared))).not.toThrow();
  });

  it('rejects caller-controlled floor fields in the immutable declaration', () => {
    expect(() => immutable({ ...declarationValue(), requiredFloorMinutes: 1 })).toThrow(/unrecognized/i);
  });

  it('keeps the worker clock fixed at 48h while wall time is fixed at +30m', () => {
    expect(SOAK_REQUIRED_UPTIME_MINUTES).toBe(2_880);
    expect(SOAK_WALL_FLOOR_MINUTES).toBe(2_910);
  });

  it('rejects missing, wrong-type, and unknown raw keys', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    const scheduler = JSON.parse(raw.scheduler) as Record<string, unknown>;
    delete scheduler.exportId;
    raw.scheduler = JSON.stringify(scheduler);
    expect(() => parseRawCaptureSet(raw, trust(declarationValue(), raw))).toThrow(/exportId|required/i);

    const wrongType = rawCaptures(declared);
    const db = JSON.parse(wrongType.database) as Record<string, unknown>;
    db.queryId = 42;
    wrongType.database = JSON.stringify(db);
    expect(() => parseRawCaptureSet(wrongType, trust(declarationValue(), wrongType))).toThrow(/queryId|string/i);

    const unknown = rawCaptures(declared);
    const signet = JSON.parse(unknown.signet) as Record<string, unknown>;
    signet.invented = true;
    unknown.signet = JSON.stringify(signet);
    expect(() => parseRawCaptureSet(unknown, trust(declarationValue(), unknown))).toThrow(/unrecognized/i);
  });

  it('rejects cross-source head and duplicate source IDs', () => {
    const declared = immutable();
    const wrongHead = rawCaptures(declared);
    const signet = JSON.parse(wrongHead.signet) as Record<string, unknown>;
    signet.gitHeadSha = 'e'.repeat(40);
    wrongHead.signet = JSON.stringify(signet);
    expect(() => deriveTrusted(wrongHead)).toThrow(/cross-head/);

    const duplicates = rawCaptures(declared);
    const supervisor = JSON.parse(duplicates.supervisor) as Record<string, unknown>;
    supervisor.exportId = 'export-signet';
    duplicates.supervisor = JSON.stringify(supervisor);
    expect(() => deriveTrusted(duplicates)).toThrow(/duplicate identities/);
  });

  it('rejects duplicate raw record IDs, undeclared rows, and inconsistent timestamps', () => {
    const declared = immutable();
    const duplicate = rawCaptures(declared);
    const signet = JSON.parse(duplicate.signet) as { records: Array<Record<string, unknown>> };
    signet.records.push({ ...signet.records[0]! });
    duplicate.signet = JSON.stringify(signet);
    expect(() => deriveTrusted(duplicate)).toThrow(/exactly one RPC result|duplicate|exact closed set/i);

    const undeclared = rawCaptures(declared);
    const db = JSON.parse(undeclared.database) as { ledgerDeltas: Array<Record<string, unknown>> };
    db.ledgerDeltas.push({ schedulerExecutionId: 'scheduler-invented', orgId: 'org-x', delta: 0 });
    undeclared.database = JSON.stringify(db);
    expect(() => deriveTrusted(undeclared)).toThrow(/undeclared or missing drain execution/);

    const chronology = rawCaptures(declared);
    const scheduler = JSON.parse(chronology.scheduler) as { records: Array<{ firedAt: string; completedAt: string }> };
    scheduler.records[0]!.completedAt = '2026-07-13T11:58:59.000Z';
    chronology.scheduler = JSON.stringify(scheduler);
    expect(() => deriveTrusted(chronology)).toThrow(/invalid chronology/);
  });

  it('rejects even a one-millisecond short worker-uptime clock', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    const cloudRun = JSON.parse(raw.cloudRun) as { records: Array<{ event: string; occurredAt: string }> };
    const shortEnd = '2026-07-15T11:59:59.999Z';
    cloudRun.records = cloudRun.records.filter((record) => record.event !== 'heartbeat' || record.occurredAt <= shortEnd);
    cloudRun.records.find((record) => record.event === 'stopped')!.occurredAt = shortEnd;
    raw.cloudRun = JSON.stringify(cloudRun);
    expect(() => deriveTrusted(raw)).toThrow(/fixed 48h worker-uptime floor/);
  });

  it('rejects tampering even when the caller recomputes the changed export digest', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    const signet = JSON.parse(raw.signet) as { records: Array<{ nodeId: string }> };
    signet.records[0]!.nodeId = 'caller-rewritten-node';
    raw.signet = JSON.stringify(signet);
    expect(digests(raw).signet).not.toBe(declared.rawCaptureDigests.signet);
    expect(() => parseRawCaptureSet(raw, declared)).toThrow(/trusted.*digest|content digest/i);
  });

  it('rejects pre-Scheduler signet acceptance even when independently committed', () => {
    const initial = immutable();
    const raw = rawCaptures(initial);
    const signet = JSON.parse(raw.signet) as { records: Array<{ observedAt: string }> };
    signet.records[0]!.observedAt = '2026-07-13T12:00:00.000Z';
    raw.signet = JSON.stringify(signet);
    const declared = trust(declarationValue(), raw);
    expect(() => deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared))).toThrow(
      /signet.*Scheduler execution|acceptance.*chronology/i,
    );
  });

  it('rejects every unconsumed or non-200 Scheduler recovery record', () => {
    const initial = immutable();
    const raw = rawCaptures(initial);
    const scheduler = JSON.parse(raw.scheduler) as { records: Array<Record<string, unknown>> };
    scheduler.records.push({
      recordId: 'unconsumed-recovery', purpose: 'recovery', schedulerExecutionId: 'unconsumed-recovery-execution',
      correlatedDrainExecutionId: 'scheduler-live-1', faultWindowId: 'window-live-1',
      gcpProjectId: 'arkova-rig-b1', workerRevision: 'arkova-worker-rig-b1-staging-00001', workerId: 'worker-live-1',
      path: '/jobs/recover-broadcasts', trigger: 'global-flush', statusCode: 500,
      firedAt: '2026-07-13T12:02:00.000Z', completedAt: '2026-07-13T12:02:01.000Z',
    });
    raw.scheduler = JSON.stringify(scheduler);
    const declared = trust(declarationValue(), raw);
    expect(() => deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared))).toThrow(
      /undeclared recovery|recovery.*200/i,
    );
  });

  it('rejects a recovery that cross-pairs one drain with another pass fault window', () => {
    const value = declarationValue();
    const windows = value.windows as Array<Record<string, unknown>>;
    const firstPass = (windows[0]!.passes as Array<Record<string, unknown>>)[0]!;
    windows.push({
      ...windows[0],
      scenarioId: 'second-window',
      passes: [{
        ...firstPass,
        batchId: 'batch-live-2',
        schedulerExecutionId: 'scheduler-live-2',
        faultWindow: {
          id: 'window-live-2',
          startsAt: '2026-07-13T12:10:00.000Z',
          endsAt: '2026-07-13T12:15:00.000Z',
        },
        claims: [{ fingerprint: '9'.repeat(64), orgId: 'org-second' }],
      }],
    });
    value.recoveries = [{
      schedulerExecutionId: 'scheduler-recovery-cross-pair',
      correlatedDrainExecutionId: 'scheduler-live-1',
      faultWindowId: 'window-live-2',
    }];
    expect(() => immutable(value)).toThrow(/recovery.*same.*fault|exact drain.*fault/i);
  });

  it('requires recovery strictly after its correlated drain and inside the exact fault/trigger timeline', () => {
    const value = declarationValue();
    value.recoveries = [{
      schedulerExecutionId: 'scheduler-recovery-live-1',
      correlatedDrainExecutionId: 'scheduler-live-1',
      faultWindowId: 'window-live-1',
    }];
    const initial = immutable(value);
    const makeRecoveryRaw = (firedAt: string, completedAt: string, trigger = 'org-scheduler'): RawCaptureTextSet => {
      const raw = rawCaptures(initial);
      const scheduler = JSON.parse(raw.scheduler) as { records: Array<Record<string, unknown>> };
      scheduler.records.push({
        recordId: 'scheduler-recovery-record', purpose: 'recovery',
        schedulerExecutionId: 'scheduler-recovery-live-1', correlatedDrainExecutionId: 'scheduler-live-1',
        faultWindowId: 'window-live-1', gcpProjectId: 'arkova-rig-b1',
        workerRevision: 'arkova-worker-rig-b1-staging-00001', workerId: 'worker-live-1',
        path: '/jobs/recover-broadcasts', trigger, statusCode: 200, firedAt, completedAt,
      });
      raw.scheduler = JSON.stringify(scheduler);
      return raw;
    };

    for (const [firedAt, completedAt, trigger] of [
      ['2026-07-13T12:00:19.000Z', '2026-07-13T12:00:21.000Z', 'org-scheduler'],
      ['2026-07-13T12:01:01.000Z', '2026-07-13T12:01:02.000Z', 'org-scheduler'],
      ['2026-07-13T12:00:21.000Z', '2026-07-13T12:00:22.000Z', 'global-flush'],
    ]) {
      const raw = makeRecoveryRaw(firedAt!, completedAt!, trigger!);
      const declared = trust(value, raw);
      expect(() => deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared))).toThrow(
        /recovery.*chronology|fault window|trigger/i,
      );
    }

    const valid = makeRecoveryRaw('2026-07-13T12:00:21.000Z', '2026-07-13T12:00:22.000Z');
    const declared = trust(value, valid);
    expect(() => deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(valid, declared))).not.toThrow();
  });

  it('rejects credit DB metadata outside its exact Scheduler execution', () => {
    const initial = immutable();
    const raw = rawCaptures(initial);
    const database = JSON.parse(raw.database) as { passRows: Array<{ queueCreditDeniedAt: string | null }> };
    database.passRows[1]!.queueCreditDeniedAt = '2026-07-15T12:00:00.000Z';
    raw.database = JSON.stringify(database);
    const declared = trust(declarationValue(), raw);
    expect(() => deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared))).toThrow(
      /credit.*outside.*Scheduler execution|queueCreditDeniedAt/i,
    );
  });

  it('accepts the serving worker starting before preclock but rejects sparse heartbeat proof', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    expect(() => deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared))).not.toThrow();

    const cloudRun = JSON.parse(raw.cloudRun) as { records: Array<{ event: string }> };
    cloudRun.records = cloudRun.records.filter((record, index) => record.event !== 'heartbeat' || index < 3);
    raw.cloudRun = JSON.stringify(cloudRun);
    const sparse = trust(declarationValue(), raw);
    expect(() => deriveAndAssertLiveEvidence(sparse, parseRawCaptureSet(raw, sparse))).toThrow(/heartbeat.*gap|continuous/i);
  });
});
