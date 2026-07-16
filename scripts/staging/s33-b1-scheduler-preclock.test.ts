import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectAdmissionV2ToPreClockIdentity } from './batch-drain-admission-adapter';
import {
  RIG_B1_REQUIRED_RPC_CAPABILITIES,
  buildRigB1ReadinessPlan,
  type RigB1PreClockObservation,
} from './batch-drain-chain-readiness';
import { planTreasuryPresplit, type TreasuryPresplitPlanInput } from './batch-drain-utxo-fanout';
import {
  collectB1SchedulerPreclockArtifact,
  authorizeB1PreclockMutationForTest,
  b1PreparationFundedProbeRunId,
  proveB1WifChallenge,
  requireExactB1ServiceRouting,
  type B1PreclockCollectorPort,
} from './s33-b1-scheduler-preclock-production-adapter';
import { buildB1SchedulerStartPreclockArtifact } from './s33-b1-scheduler-start-driver';
import { runS33B1SchedulerPreclockCliForTest } from './s33-b1-scheduler-preclock';
import {
  B1_PREPARATION_CONTRACT,
  buildB1PreparationAuthoritySignedPayload,
  createB1PreparationAuthorityVerifierForTest,
  parseB1PreparationAuthoritySignedPayload,
} from './s33-b1-preparation-approval';

const TREASURY = 'tb1qxca7ke7hgguarqxkwwydrfenn8ymnspxq765eq';
const OBSERVED_AT = '2026-07-16T19:55:00.000Z';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function compressedSignetWif(privateKey: Buffer): string {
  const payload = Buffer.concat([Buffer.from([0xef]), privateKey, Buffer.from([0x01])]);
  const checksum = createHash('sha256').update(
    createHash('sha256').update(payload).digest(),
  ).digest().subarray(0, 4);
  const encoded = Buffer.concat([payload, checksum]);
  let value = BigInt(`0x${encoded.toString('hex')}`);
  let result = '';
  while (value > 0n) {
    result = BASE58[Number(value % 58n)]! + result;
    value /= 58n;
  }
  for (const byte of encoded) {
    if (byte !== 0) break;
    result = `1${result}`;
  }
  return result;
}

function inputs(): TreasuryPresplitPlanInput {
  return {
    planId: 's33-b1-counted-start-split',
    network: 'signet',
    treasuryAddress: TREASURY,
    inputs: [{ txId: '7'.repeat(64), vout: 0, valueSats: 170_639, confirmations: 6 }],
    outputCount: 32,
    feeSats: 1_000,
    minOutputSats: 1_000,
  };
}

function admissionRaw(): string {
  const value = JSON.parse(readFileSync(
    join(process.cwd(), 'scripts/staging/fixtures/rig-b1-admission-v2.json'),
    'utf8',
  )) as {
    infrastructure: {
      treasuryWatchOnly: { preSplitPlanDigest: string; expectedTotalSats: number };
      nodeReadiness: { treasurySplitPlanDigest: string; confirmedTotalSats: number };
    };
  };
  const split = planTreasuryPresplit(inputs());
  value.infrastructure.treasuryWatchOnly.preSplitPlanDigest = split.planDigest;
  value.infrastructure.treasuryWatchOnly.expectedTotalSats = 169_639;
  value.infrastructure.nodeReadiness.treasurySplitPlanDigest = split.planDigest;
  value.infrastructure.nodeReadiness.confirmedTotalSats = 169_639;
  return JSON.stringify(value);
}

function observation(rawAdmission = admissionRaw()): RigB1PreClockObservation {
  const split = planTreasuryPresplit(inputs());
  const readiness = buildRigB1ReadinessPlan(
    projectAdmissionV2ToPreClockIdentity(rawAdmission),
    { treasurySplitPlan: split },
  );
  const bestBlockHash = 'a'.repeat(64);
  const broadcastTxId = '6'.repeat(64);
  return {
    admissionSha256: readiness.admissionSha256,
    gitHeadSha: readiness.gitHeadSha,
    imageDigest: readiness.imageDigest,
    cleanMirrorAttestationId: readiness.cleanMirrorAttestationId,
    secretVersions: readiness.secretReferences.map((reference) => ({ ...reference })),
    schedulerPolicy: {
      ...readiness.schedulerPolicy,
      productionCadenceMutationAttempted: false,
      productionTopologyMutationAttempted: false,
      cleanMirrorAdmissionComplete: true,
      evidencePhaseAuthorized: false,
      observedAt: OBSERVED_AT,
    },
    schedulerJobs: readiness.schedulerJobs.map((job) => ({
      ...job,
      state: 'PAUSED' as const,
      createdPaused: true,
      pausedThroughCleanMirror: true,
      enabledAt: null,
    })),
    getBlockchainInfo: {
      provider: 'bitcoin-core-signet-rpc',
      rpcMethod: 'getblockchaininfo',
      chain: 'signet',
      initialBlockDownload: false,
      headers: 100,
      blocks: 100,
      bestBlockHash,
      genesisHash: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
      observedAt: OBSERVED_AT,
    },
    txindex: { rpcMethod: 'getindexinfo', synced: true, bestBlockHeight: 100, observedAt: OBSERVED_AT },
    watchOnlyWallet: {
      walletName: 'arkova-watch-only',
      privateKeysEnabled: false,
      descriptors: true,
      treasuryAddress: TREASURY,
      treasuryDescriptor: readiness.infrastructure.treasuryWatchOnly.descriptor,
      descriptorImported: true,
      rescanComplete: true,
      confirmedUtxos: 32,
      confirmedTotalSats: 169_639,
      minimumConfirmations: 1,
      observedAt: OBSERVED_AT,
    },
    capabilityProbes: RIG_B1_REQUIRED_RPC_CAPABILITIES.map((rpcMethod) => ({
      rpcMethod, available: true, nonBroadcastProbe: true, observedAt: OBSERVED_AT,
    })),
    signerReadiness: {
      algorithm: 'secp256k1',
      treasuryAddress: TREASURY,
      challengeSha256: readiness.signerChallengeSha256,
      signatureSha256: '5'.repeat(64),
      verified: true,
      observedAt: OBSERVED_AT,
    },
    treasurySplit: {
      planDigest: split.planDigest,
      treasuryAddress: TREASURY,
      confirmedUtxos: 32,
      minimumConfirmations: 1,
      observedAt: OBSERVED_AT,
    },
    fundedBroadcast: {
      network: 'signet', txId: broadcastTxId, spentFromTreasuryAddress: TREASURY,
      accepted: true, observedAt: OBSERVED_AT,
    },
    mempoolCorroboration: {
      provider: 'mempool-space-signet', baseUrl: 'https://mempool.space/signet/api',
      tipHeight: 100, tipHash: bestBlockHash, txId: broadcastTxId, txOutcome: 'found',
      observedAt: OBSERVED_AT,
    },
    nodeCron: { mode: 'disabled', observedAt: OBSERVED_AT },
  };
}

describe('RIG-B1 augmented Scheduler-start pre-clock generator', () => {
  it('emits admission/head/image/readiness hashes only after full readiness validation', () => {
    const admission = admissionRaw();
    const artifact = JSON.parse(buildB1SchedulerStartPreclockArtifact(
      admission,
      JSON.stringify(inputs()),
      JSON.stringify(observation(admission)),
    ));
    expect(artifact).toMatchObject({
      schemaVersion: 'arkova.s33.rig-b1.scheduler-start-preclock/v1',
      status: 'PRE_CLOCK_READY',
      sourceHeadSha: 'a'.repeat(40),
      workerImageDigest: `sha256:${'b'.repeat(64)}`,
      observedAt: OBSERVED_AT,
      schedulerJobsPaused: 6,
      schedulerCadence: '*/5 * * * *',
      sourceEvidence: { treasuryPlanInput: inputs() },
    });
    expect(artifact.admissionSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(artifact.nodeReadinessSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('rejects forged readiness instead of emitting an augmented artifact', () => {
    const admission = admissionRaw();
    const forged = observation(admission);
    forged.schedulerJobs[0]!.state = 'ENABLED';
    expect(() => buildB1SchedulerStartPreclockArtifact(
      admission,
      JSON.stringify(inputs()),
      JSON.stringify(forged),
    )).toThrow(/PAUSED|scheduler/i);
  });

  it('writes once and byte-for-byte verifies the operator artifact', async () => {
    const files = new Map<string, string>([
      ['admission.json', 'admission'], ['plan.json', 'plan'], ['prepare.json', 'prepare'],
    ]);
    const result = await runS33B1SchedulerPreclockCliForTest([
      '--admission', 'admission.json', '--treasury-plan', 'plan.json',
      '--preparation-authority', 'prepare.json',
      '--cto-preparation-confirmation', 'PREPARE_B1:test',
      '--output', 'preclock.json',
    ], {
      readText: async (path) => files.get(path)!,
      writeExclusive: async (path, raw) => {
        if (files.has(path)) throw new Error('exists');
        files.set(path, raw);
      },
      readBack: async (path) => files.get(path)!,
      collect: async () => '{"safe":"artifact"}',
    });
    expect(result).toEqual({ status: 'PRECLOCK_ARTIFACT_WRITTEN', output: 'preclock.json', bytes: 19 });
    expect(files.get('preclock.json')).toBe('{"safe":"artifact"}');
  });

  it('rejects a caller-supplied observation before collection', async () => {
    let collected = false;
    await expect(runS33B1SchedulerPreclockCliForTest([
      '--admission', 'admission.json', '--treasury-plan', 'plan.json',
      '--observation', 'forged.json', '--output', 'preclock.json',
    ], {
      readText: async () => 'unused',
      writeExclusive: async () => undefined,
      readBack: async () => 'unused',
      collect: async () => { collected = true; return '{}'; },
    })).rejects.toThrow(/observation|unknown option/i);
    expect(collected).toBe(false);
  });
});

const PREPARE_TEST_KEYS = generateKeyPairSync('ed25519');
const PREPARE_TEST_PUBLIC_KEY = PREPARE_TEST_KEYS.publicKey
  .export({ type: 'spki', format: 'pem' }).toString();
const PREPARE_TEST_FINGERPRINT = createHash('sha256')
  .update(PREPARE_TEST_KEYS.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');

function preparationRequest(): Parameters<typeof buildB1PreparationAuthoritySignedPayload>[0] {
  const admission = JSON.parse(admissionRaw()) as {
    sha: string;
    image_digest: string;
    rig_name: string;
    soak_id: string;
    lease_id: string;
    cloud_run_service: string;
    infrastructure: {
      authority: { approvalEnvelopeSha256: string; signedPayloadSha256: string };
    };
  };
  const planRaw = JSON.stringify(inputs());
  return {
    schemaVersion: 1,
    preparationId: 'prepare-b1-test-001',
    authority: {
      keyId: B1_PREPARATION_CONTRACT.keyId,
      approverIdentity: B1_PREPARATION_CONTRACT.approverIdentity,
      purpose: 'PREPARE_B1',
    },
    candidate: {
      admissionSha256: `sha256:${createHash('sha256').update(admissionRaw()).digest('hex')}`,
      treasuryPlanSha256: `sha256:${createHash('sha256').update(planRaw).digest('hex')}`,
      sourceHeadSha: admission.sha,
      sourceTreeSha: 'c'.repeat(40),
      workerImageDigest: admission.image_digest,
      corpusDigest: `sha256:${'d'.repeat(64)}`,
      releaseCandidateId: 's33-test-rc',
      provisionApprovalEnvelopeSha256: admission.infrastructure.authority.approvalEnvelopeSha256,
      provisionSignedPayloadSha256: admission.infrastructure.authority.signedPayloadSha256,
    },
    run: {
      rigName: 's33-rig-b1',
      soakId: admission.soak_id,
      leaseId: admission.lease_id,
      workerService: 'arkova-worker-s33-rig-b1-staging',
      schedulerOidcServiceAccount: 's33-rig-b1-cron@arkova1.iam.gserviceaccount.com',
    },
    limits: { maxFundedBroadcasts: 1, invocationLeaseMaxSeconds: 600 },
    issuedAt: '2026-07-16T19:50:00.000Z',
    expiresAt: '2026-07-16T20:00:00.000Z',
  };
}

function preparationEnvelope(signedPayloadRaw: string, envelopeId = 'prepare-b1-test-001'): string {
  return JSON.stringify({
    schemaVersion: 1,
    envelopeId,
    keyId: B1_PREPARATION_CONTRACT.keyId,
    keyFingerprint: PREPARE_TEST_FINGERPRINT,
    signedPayloadRaw,
    signature: sign(null, Buffer.from(signedPayloadRaw), PREPARE_TEST_KEYS.privateKey).toString('base64'),
  });
}

describe('distinct signed PREPARE_B1 action authority', () => {
  const verifier = createB1PreparationAuthorityVerifierForTest({
    publicKeyPem: PREPARE_TEST_PUBLIC_KEY,
    keyFingerprint: PREPARE_TEST_FINGERPRINT,
  });

  it('round-trips the canonical request bytes and verifies the signed final candidate bindings', () => {
    const raw = buildB1PreparationAuthoritySignedPayload(preparationRequest());
    expect(parseB1PreparationAuthoritySignedPayload(raw)).toEqual(preparationRequest());
    expect(verifier.verify(preparationEnvelope(raw), new Date(OBSERVED_AT))).toMatchObject({
      status: 'VERIFIED',
      preparationId: 'prepare-b1-test-001',
      sourceTreeSha: 'c'.repeat(40),
      corpusDigest: `sha256:${'d'.repeat(64)}`,
      maxFundedBroadcasts: 1,
      invocationLeaseMaxSeconds: 600,
    });
  });

  it('rejects an unsigned envelope identity even when the payload signature is valid', () => {
    const raw = buildB1PreparationAuthoritySignedPayload(preparationRequest());
    expect(() => verifier.verify(
      preparationEnvelope(raw, 'different-envelope-id'),
      new Date(OBSERVED_AT),
    )).toThrow(/envelope id|preparation id/i);
  });

  it('rejects a signed authority whose action TTL exceeds ten minutes', () => {
    const request = preparationRequest();
    const raw = JSON.stringify({ ...request, expiresAt: '2026-07-16T20:00:01.000Z' });
    expect(() => verifier.verify(preparationEnvelope(raw), new Date(OBSERVED_AT)))
      .toThrow(/ten-minute TTL/i);
  });

  it('rejects a valid signature over any purpose other than PREPARE_B1', () => {
    const request = preparationRequest();
    const raw = JSON.stringify({
      ...request,
      authority: { ...request.authority, purpose: 'RIG_B1_BITCOIN_CORE_PROVISION' },
    });
    expect(() => verifier.verify(preparationEnvelope(raw), new Date(OBSERVED_AT))).toThrow();
  });
});

interface TestCollectorState {
  now: string;
  installed: number;
  removed: number;
  funded: number;
  schedulerObservations: number;
  readonly leaseInputs: Array<Readonly<{
    preparationId: string;
    expiresAt: string;
    authorityExpiresAt: string;
  }>>;
  readonly operations: string[];
  readonly locked: Map<string, { raw: string; retainUntilTime: string }>;
}

interface TestCollectorPort extends B1PreclockCollectorPort {
  readonly testState: TestCollectorState;
}

function liveCollectorPort(rawAdmission: string): TestCollectorPort {
  const live = observation(rawAdmission);
  const admission = JSON.parse(rawAdmission) as {
    sha: string;
    image_digest: string;
    tag_url: string;
    soak_id: string;
    lease_id: string;
    infrastructure: {
      treasuryWatchOnly: { splitTransactionId: string };
      secretReferences: { env: string; secretName: string; version: string }[];
      authority: {
        approvalId: string;
        approvalEnvelopeSha256: string;
        signedPayloadSha256: string;
        claim: { objectUri: string; generation: string };
      };
    };
  };
  const wif = admission.infrastructure.secretReferences.find(({ env }) => env === 'BITCOIN_TREASURY_WIF')!;
  const locked = new Map<string, { raw: string; retainUntilTime: string }>();
  const testState: TestCollectorState = {
    now: OBSERVED_AT,
    installed: 0,
    removed: 0,
    funded: 0,
    schedulerObservations: 0,
    leaseInputs: [],
    operations: [],
    locked,
  };
  const claimRaw = JSON.stringify({
    schemaVersion: 'arkova.s33.rig-b1.node-approval-claim/v1',
    approvalId: admission.infrastructure.authority.approvalId,
    envelopeSha256: admission.infrastructure.authority.approvalEnvelopeSha256,
    signedPayloadSha256: admission.infrastructure.authority.signedPayloadSha256,
    sourceHeadSha: admission.sha,
    sourceTreeSha: 'c'.repeat(40),
    corpusDigest: `sha256:${'d'.repeat(64)}`,
    releaseCandidateId: 's33-test-rc',
    soakId: admission.soak_id,
    leaseId: admission.lease_id,
    spendCapUsd: 200,
    claimedAt: OBSERVED_AT,
  });
  return {
    testState,
    now: () => new Date(testState.now),
    hasLockedObject: async (uri) => locked.has(uri),
    readLockedObject: async (uri, generation) => {
      if (uri === admission.infrastructure.authority.claim.objectUri) {
        return {
          uri,
          generation: generation ?? admission.infrastructure.authority.claim.generation,
          retainUntilTime: '2030-01-01T00:00:00.000Z',
          raw: claimRaw,
        };
      }
      const value = locked.get(uri);
      if (value === undefined) throw new Error(`missing locked test object ${uri}`);
      return { uri, generation: '2', retainUntilTime: value.retainUntilTime, raw: value.raw };
    },
    persistLockedObject: async (uri, raw, retainUntilTime) => {
      if (locked.has(uri)) throw new Error('generation-zero write collision');
      testState.operations.push(`persist:${uri}`);
      locked.set(uri, { raw, retainUntilTime });
    },
    installInvocationLease: async (input) => {
      testState.installed += 1;
      testState.leaseInputs.push(input);
      testState.operations.push('install-lease');
    },
    removeInvocationLease: async () => {
      testState.removed += 1;
      testState.operations.push('remove-lease');
    },
    observeRevision: async () => ({
      sourceHeadSha: admission.sha,
      imageDigest: admission.image_digest,
      runtimeServiceAccount: 's33-rig-b1-runtime@arkova1.iam.gserviceaccount.com',
      serviceUrl: admission.tag_url,
      inProcessCronDisabled: true,
      secrets: {
        supabaseUrl: { secret: 'rig-b1-supabase-url', version: '1' },
        supabaseServiceRole: { secret: 'rig-b1-supabase-role', version: '1' },
        cron: { secret: 'rig-b1-cron', version: '7' },
        treasuryWif: { secret: wif.secretName, version: wif.version },
      },
    }),
    observeSchedulerJobs: async () => {
      testState.schedulerObservations += 1;
      testState.operations.push('observe-paused-scheduler');
      return live.schedulerJobs.map((job) => ({
        name: job.name,
        path: job.path,
        cadence: job.cadence,
        state: job.state,
        observedAt: OBSERVED_AT,
      }));
    },
    observeCore: async () => ({
      chain: 'signet',
      initialBlockDownload: false,
      headers: live.getBlockchainInfo.headers,
      blocks: live.getBlockchainInfo.blocks,
      bestBlockHash: live.getBlockchainInfo.bestBlockHash,
      genesisHash: live.getBlockchainInfo.genesisHash,
      txindexSynced: true,
      txindexBestBlockHeight: live.txindex.bestBlockHeight,
      privateKeysEnabled: false,
      descriptors: true,
      descriptorImported: true,
      rescanComplete: true,
      confirmedUtxos: live.watchOnlyWallet.confirmedUtxos,
      confirmedTotalSats: live.watchOnlyWallet.confirmedTotalSats,
      minimumConfirmations: live.watchOnlyWallet.minimumConfirmations,
      splitTransactionObserved: admission.infrastructure.treasuryWatchOnly.splitTransactionId,
      capabilities: Object.fromEntries(RIG_B1_REQUIRED_RPC_CAPABILITIES.map((method) => [method, true])) as Record<typeof RIG_B1_REQUIRED_RPC_CAPABILITIES[number], boolean>,
      observedAt: OBSERVED_AT,
    }),
    proveSigner: async () => {
      testState.operations.push('prove-signer');
      return {
        treasuryAddress: TREASURY,
        signatureSha256: '5'.repeat(64),
        verified: true,
        observedAt: OBSERVED_AT,
      };
    },
    runFundedProbe: async () => {
      testState.funded += 1;
      testState.operations.push('funded-probe');
      return {
        txId: '6'.repeat(64),
        evidenceSha256: `sha256:${'4'.repeat(64)}`,
        observedAt: OBSERVED_AT,
      };
    },
    observeMempool: async ({ txId, coreTipHash }) => ({
      txId,
      tipHeight: 100,
      tipHash: coreTipHash,
      spentOutpoints: [{
        txId: admission.infrastructure.treasuryWatchOnly.splitTransactionId,
        vout: 0,
        address: TREASURY,
      }],
      observedAt: OBSERVED_AT,
    }),
  };
}

describe('RIG-B1 production pre-clock collector boundary', () => {
  it('builds a start-consumable artifact only from port-collected live facts', async () => {
    const admission = admissionRaw();
    const plan = JSON.stringify(inputs());
    const port = liveCollectorPort(admission);
    const artifact = JSON.parse(await collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorizeB1PreclockMutationForTest(admission, plan),
      port,
    ));
    expect(artifact).toMatchObject({
      status: 'PRE_CLOCK_READY',
      schedulerJobsPaused: 6,
      sourceEvidence: { readinessObservation: { nodeCron: { mode: 'disabled' } } },
    });
    expect(port.testState.funded).toBe(1);
    expect(port.testState.installed).toBe(1);
    expect(port.testState.removed).toBe(1);
    expect(port.testState.leaseInputs).toEqual([{
      preparationId: 'test-only-preclock',
      expiresAt: '2026-07-16T20:00:00.000Z',
      authorityExpiresAt: '2026-07-16T20:00:00.000Z',
    }]);
    expect(port.testState.operations.indexOf('install-lease'))
      .toBeLessThan(port.testState.operations.indexOf('funded-probe'));
    expect(port.testState.operations.indexOf('funded-probe'))
      .toBeLessThan(port.testState.operations.indexOf('remove-lease'));
    expect([...port.testState.locked.keys()].filter((uri) => uri.includes('/preparation-intents/')))
      .toHaveLength(1);
    expect([...port.testState.locked.keys()].filter((uri) => uri.includes('/preparation-outcomes/')))
      .toHaveLength(1);
  });

  it('returns the immutable completed outcome on replay without a second funded broadcast', async () => {
    const admission = admissionRaw();
    const plan = JSON.stringify(inputs());
    const port = liveCollectorPort(admission);
    const authorization = authorizeB1PreclockMutationForTest(admission, plan);
    const first = await collectB1SchedulerPreclockArtifact(admission, plan, authorization, port);
    const second = await collectB1SchedulerPreclockArtifact(admission, plan, authorization, port);
    expect(second).toBe(first);
    expect(port.testState.funded).toBe(1);
    expect(port.testState.installed).toBe(1);
    expect(port.testState.removed).toBe(2);
  });

  it('rejects a replay intent whose full signed candidate binding differs', async () => {
    const admission = admissionRaw();
    const plan = JSON.stringify(inputs());
    const port = liveCollectorPort(admission);
    const authorization = authorizeB1PreclockMutationForTest(admission, plan);
    await collectB1SchedulerPreclockArtifact(admission, plan, authorization, port);
    const intentEntry = [...port.testState.locked.entries()]
      .find(([uri]) => uri.includes('/preparation-intents/'))!;
    const outcomeEntry = [...port.testState.locked.entries()]
      .find(([uri]) => uri.includes('/preparation-outcomes/'))!;
    const intent = JSON.parse(intentEntry[1].raw) as Record<string, unknown>;
    intent.sourceTreeSha = 'e'.repeat(40);
    const tamperedIntentRaw = JSON.stringify(intent);
    intentEntry[1].raw = tamperedIntentRaw;
    const outcome = JSON.parse(outcomeEntry[1].raw) as Record<string, unknown>;
    outcome.intentSha256 = `sha256:${createHash('sha256').update(tamperedIntentRaw).digest('hex')}`;
    outcomeEntry[1].raw = JSON.stringify(outcome);

    await expect(collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorization,
      port,
    )).rejects.toThrow(/complete signed authority bindings/i);
    expect(port.testState.funded).toBe(1);
  });

  it('rejects replay objects without the required Locked audit retention', async () => {
    const admission = admissionRaw();
    const plan = JSON.stringify(inputs());
    const port = liveCollectorPort(admission);
    const authorization = authorizeB1PreclockMutationForTest(admission, plan);
    await collectB1SchedulerPreclockArtifact(admission, plan, authorization, port);
    const outcomeEntry = [...port.testState.locked.entries()]
      .find(([uri]) => uri.includes('/preparation-outcomes/'))!;
    outcomeEntry[1].retainUntilTime = '2026-07-16T20:01:00.000Z';
    await expect(collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorization,
      port,
    )).rejects.toThrow(/generation-zero Locked readback/i);
    expect(port.testState.funded).toBe(1);
  });

  it('refuses a second funded broadcast when a Locked intent has no outcome', async () => {
    const admission = admissionRaw();
    const plan = JSON.stringify(inputs());
    const port = liveCollectorPort(admission);
    const authorization = authorizeB1PreclockMutationForTest(admission, plan);
    await collectB1SchedulerPreclockArtifact(admission, plan, authorization, port);
    const outcomeUri = [...port.testState.locked.keys()]
      .find((uri) => uri.includes('/preparation-outcomes/'))!;
    port.testState.locked.delete(outcomeUri);

    await expect(collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorization,
      port,
    )).rejects.toThrow(/intent without an outcome|second funded/i);
    expect(port.testState.funded).toBe(1);
    expect(port.testState.removed).toBe(2);
  });

  it('rechecks short PREPARE authority after slow observations and before any secret or spend', async () => {
    const admission = admissionRaw();
    const plan = JSON.stringify(inputs());
    const port = liveCollectorPort(admission);
    port.testState.now = '2026-07-16T20:00:00.000Z';
    await expect(collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorizeB1PreclockMutationForTest(admission, plan),
      port,
    )).rejects.toThrow(/expired/i);
    expect(port.testState.funded).toBe(0);
    expect(port.testState.operations).toContain('prove-signer');
    expect(port.testState.installed).toBe(0);
    expect(port.testState.locked.size).toBe(0);
  });

  it('removes any partial invocation lease and keeps Scheduler PAUSED when funded probe fails', async () => {
    const admission = admissionRaw();
    const plan = JSON.stringify(inputs());
    const port = liveCollectorPort(admission);
    port.runFundedProbe = async () => {
      port.testState.funded += 1;
      throw new Error('injected funded probe failure');
    };
    await expect(collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorizeB1PreclockMutationForTest(admission, plan),
      port,
    )).rejects.toThrow(/funded probe failure/i);
    expect(port.testState.installed).toBe(1);
    expect(port.testState.removed).toBeGreaterThanOrEqual(1);
    expect(port.testState.schedulerObservations).toBeGreaterThanOrEqual(3);
    expect([...port.testState.locked.keys()].some((uri) => uri.includes('/preparation-outcomes/')))
      .toBe(false);
  });

  it('fails closed when live Scheduler is not fully PAUSED', async () => {
    const admission = admissionRaw();
    const plan = JSON.stringify(inputs());
    const base = liveCollectorPort(admission);
    base.observeSchedulerJobs = async () => (await liveCollectorPort(admission).observeSchedulerJobs())
      .map((job, index) => index === 0 ? { ...job, state: 'ENABLED' as const } : job);
    await expect(collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorizeB1PreclockMutationForTest(admission, plan),
      base,
    )).rejects.toThrow(/PAUSED|Scheduler/i);
  });

  it('fails closed when the live worker signer does not own the admitted treasury', async () => {
    const admission = admissionRaw();
    const plan = JSON.stringify(inputs());
    const base = liveCollectorPort(admission);
    base.proveSigner = async () => ({
      treasuryAddress: `tb1q${'z'.repeat(38)}`,
      signatureSha256: '5'.repeat(64),
      verified: true,
      observedAt: OBSERVED_AT,
    });
    await expect(collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorizeB1PreclockMutationForTest(admission, plan),
      base,
    )).rejects.toThrow(/signer|treasury/i);
  });

  it('fails closed when the funded transaction does not spend an admitted treasury split output', async () => {
    const admission = admissionRaw();
    const plan = JSON.stringify(inputs());
    const base = liveCollectorPort(admission);
    base.observeMempool = async ({ txId, coreTipHash }) => ({
      txId,
      tipHeight: 100,
      tipHash: coreTipHash,
      spentOutpoints: [{ txId: '9'.repeat(64), vout: 0, address: TREASURY }],
      observedAt: OBSERVED_AT,
    });
    await expect(collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorizeB1PreclockMutationForTest(admission, plan),
      base,
    )).rejects.toThrow(/mempool|treasury|split/i);
  });

  it('accepts only a service routing 100% to the exact admitted revision and URL', () => {
    const service = {
      status: {
        url: 'https://rig-b1.example.run.app',
        latestReadyRevisionName: 'rig-b1-00001',
        traffic: [{ revisionName: 'rig-b1-00001', percent: 100 }],
      },
    };
    expect(requireExactB1ServiceRouting(JSON.stringify(service), {
      revision: 'rig-b1-00001',
      serviceUrl: 'https://rig-b1.example.run.app',
    })).toBe('https://rig-b1.example.run.app');
    service.status.traffic = [{ revisionName: 'rig-b1-00002', percent: 100 }];
    expect(() => requireExactB1ServiceRouting(JSON.stringify(service), {
      revision: 'rig-b1-00001',
      serviceUrl: 'https://rig-b1.example.run.app',
    })).toThrow(/100%|revision|routing/i);
  });

  it('proves a compressed Signet WIF using only the root Node runtime', () => {
    const privateKey = Buffer.alloc(32);
    privateKey[31] = 1;
    const proof = proveB1WifChallenge(compressedSignetWif(privateKey), 'a'.repeat(64));
    expect(proof).toEqual({
      treasuryAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      signatureSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      verified: true,
    });
  });

  it('derives one stable funded-probe run identity from the signed preparation idempotency key', () => {
    const input = {
      preparationId: 'prepare-b1-test-001',
      idempotencyKey: `sha256:${'9'.repeat(64)}`,
    };
    const first = b1PreparationFundedProbeRunId(input);
    expect(b1PreparationFundedProbeRunId(input)).toBe(first);
    expect(first).toMatch(/^b1-preclock-[0-9a-f]{32}$/u);
    expect(b1PreparationFundedProbeRunId({
      ...input,
      idempotencyKey: `sha256:${'8'.repeat(64)}`,
    })).not.toBe(first);
  });
});
