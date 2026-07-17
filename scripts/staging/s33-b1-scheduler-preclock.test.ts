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
import {
  B1_TREASURY_CONTINUITY_CONTRACT,
  calculateB1TreasuryContinuityCompositeIdentity,
} from './s33-b1-treasury-continuity';

const TREASURY = 'tb1qxca7ke7hgguarqxkwwydrfenn8ymnspxq765eq';
const OBSERVED_AT = '2026-07-16T19:55:00.000Z';
const CONTINUITY_NOW = '2026-07-17T02:30:00.000Z';
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

function textFixture(name: string): string {
  return readFileSync(join(process.cwd(), 'scripts/fixtures', name), 'utf8').trimEnd();
}

function continuityPlanRaw(): string {
  return textFixture('s33-b1-post-probe-treasury-plan.fixture.txt');
}

function continuityPlanInput(): TreasuryPresplitPlanInput {
  return JSON.parse(continuityPlanRaw()) as TreasuryPresplitPlanInput;
}

function continuityPreparationOverrides() {
  return {
    sourceTreeSha: '09f7d40d6b59b6afbe4979346e1d0d46f35ccd28',
    corpusDigest: 'sha256:7d6ffd131230d13483d3f1bacdb170b3cfcc53a4383d59f6689e415c99e6089e',
    releaseCandidateId: 's33-w3-b1-recovery-rc-c56c7729',
    issuedAt: '2026-07-17T02:25:00.000Z',
    expiresAt: '2026-07-17T02:35:00.000Z',
  };
}

function continuityAdmissionRaw(): string {
  const base = JSON.parse(readFileSync(
    join(process.cwd(), 'scripts/staging/fixtures/rig-b1-admission-v2.json'),
    'utf8',
  )) as Record<string, unknown> & {
    infrastructure: {
      authority: Record<string, unknown>;
      nodeReadiness: Record<string, unknown>;
      treasuryWatchOnly: Record<string, unknown>;
      secretReferences: unknown;
    };
  };
  base.infrastructure = JSON.parse(
    textFixture('s33-b1-c56c-infrastructure.fixture.txt'),
  ) as typeof base.infrastructure;
  const claimRaw = textFixture('s33-b1-c56c-provision-claim.fixture.txt');
  const topologyRaw = textFixture('s33-b1-c56c-topology-ownership.fixture.txt');
  const amendmentRaw = textFixture('s33-b1-c56c-treasury-continuity-amendment.fixture.txt');
  const claim = JSON.parse(claimRaw) as Record<string, string>;
  const topology = JSON.parse(topologyRaw) as Record<string, unknown> & {
    nodeReadiness: Record<string, unknown>;
    secretReferences: unknown;
    supabaseProjectRef: string;
    cloudRunServiceUrl: string;
  };
  const runtimeHead = 'c56c7729687602b980e2b03454588683a8c20d9b';
  const runtimeImageDigest =
    'sha256:0162f4b840b12cd062eb43a2c05d4684bf5997e5f70297186c96a5aafc5ee105';
  const runtimeImage =
    `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@${runtimeImageDigest}`;
  Object.assign(base, {
    sha: runtimeHead,
    declared_source_head: runtimeHead,
    deployed_source_head: runtimeHead,
    image: runtimeImage,
    image_digest: runtimeImageDigest,
    deployed_image_ref: runtimeImage,
    deployed_image_digest: runtimeImageDigest,
    source_head_image_ref:
      `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:${runtimeHead}`,
    source_head_image_digest: runtimeImageDigest,
    soak_id: claim.soakId,
    lease_id: claim.leaseId,
    deployed_revision: 'arkova-worker-s33-rig-b1-staging-b1hdr2-021254',
    tag_url: topology.cloudRunServiceUrl,
    supabase_project_ref: topology.supabaseProjectRef,
  });
  const continuity = {
    schemaVersion: 'arkova.s33.rig-b1.treasury-continuity-composition/v1',
    compositeIdentitySha256: `sha256:${'0'.repeat(64)}`,
    originalProvision: {
      approvalId: claim.approvalId,
      approvalEnvelopeSha256: claim.envelopeSha256,
      signedPayloadSha256: claim.signedPayloadSha256,
      sourceHeadSha: claim.sourceHeadSha,
      sourceTreeSha: claim.sourceTreeSha,
      corpusDigest: claim.corpusDigest,
      releaseCandidateId: claim.releaseCandidateId,
      soakId: claim.soakId,
      leaseId: claim.leaseId,
      claim: {
        objectUri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/node-approval-claims/b1-provision-c56c7729-20260717t021606z.json',
        generation: '1784254587600385',
        sha256: 'sha256:2b24c08b9e924d2e649242c5c36ca27ec56c1aa742080e3ff1eee7ab1056875d',
      },
      topology: {
        objectUri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/topology-ownership/b1-provision-c56c7729-20260717t021606z.json',
        generation: '1784254616684049',
        sha256: 'sha256:d408b454bc0b5382d64c7e7de38bb0a21ede88b3b14487e84616d24955c456f7',
      },
    },
    amendment: {
      objectUri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/recovery-amendments/b1-treasury-continuity-c56c7729-20260717t022339z.json',
      generation: '1784255027455134',
      envelopeSha256: 'sha256:d046785a0157d7017d59f7a9cd3005644c2d5e3006b95a810fe4d6748240cca0',
      signedPayloadSha256: 'sha256:2a2f2cb4dd647044fbdcc80a1a87283257f769fdeac50a62ec6b9de095173e02',
    },
    originalTreasury: {
      confirmedOutputCount: 32,
      confirmedTotalSats: 169_639,
      planDigest: 'sha256:ab70ac7cf0ef1b371258c86ee4d967fec199b156156fe214238440429df794d8',
    },
    currentTreasury: {
      confirmedOutputCount: 32,
      confirmedTotalSats: 169_482,
      planDigest: 'sha256:9808e07f3b2329488e5dc5f2658a2224937f3c950fd7322b9a5a227ff34fc034',
      planInputSha256: 'sha256:1c952e7e6ee5d668f663eaec4fd62d5df83ee9f30778d57c07b3d03b1a8e4485',
      deltaSats: -157,
      fundedProbeFeeSats: 157,
    },
    controllerCandidate: {
      sourceHeadSha: 'd'.repeat(40),
      sourceTreeSha: 'e'.repeat(40),
      relevantFilesSha256: `sha256:${'f'.repeat(64)}`,
    },
  };
  base.treasury_continuity = continuity;
  let raw = JSON.stringify(base);
  continuity.compositeIdentitySha256 = calculateB1TreasuryContinuityCompositeIdentity({
    verificationTime: new Date('2026-07-17T02:30:00.000Z'),
    refreshedAdmissionRaw: raw,
    currentTreasuryPlanInputRaw: continuityPlanRaw(),
    originalClaim: {
      uri: continuity.originalProvision.claim.objectUri,
      generation: continuity.originalProvision.claim.generation,
      raw: claimRaw,
      retainUntilTime: '2026-07-22T22:39:24Z',
    },
    originalTopology: {
      uri: continuity.originalProvision.topology.objectUri,
      generation: continuity.originalProvision.topology.generation,
      raw: topologyRaw,
      retainUntilTime: '2026-07-22T22:39:24Z',
    },
    amendment: {
      uri: continuity.amendment.objectUri,
      generation: continuity.amendment.generation,
      raw: amendmentRaw,
      retainUntilTime: '2026-07-22T22:39:24Z',
    },
    historicalPreparationIntent: {
      uri: B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationIntentUri,
      generation: B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationIntentGeneration,
      raw: textFixture('s33-b1-historical-preparation-intent.fixture.txt'),
      retainUntilTime: '2026-07-22T22:39:24Z',
    },
    historicalPreparationOutcome: {
      uri: B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationOutcomeUri,
      generation: B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationOutcomeGeneration,
      raw: textFixture('s33-b1-historical-preparation-outcome.fixture.txt'),
      retainUntilTime: '2026-07-22T22:39:24Z',
    },
    failedStartContainment: {
      uri: B1_TREASURY_CONTINUITY_CONTRACT.failedStartContainmentUri,
      generation: B1_TREASURY_CONTINUITY_CONTRACT.failedStartContainmentGeneration,
      raw: textFixture('s33-b1-failed-start-containment.fixture.txt'),
      retainUntilTime: '2026-07-22T22:39:24Z',
    },
  });
  raw = JSON.stringify(base);
  return raw;
}

function observation(
  rawAdmission = admissionRaw(),
  treasuryPlanInput: TreasuryPresplitPlanInput = inputs(),
): RigB1PreClockObservation {
  const admission = JSON.parse(rawAdmission) as {
    infrastructure: {
      nodeReadiness: { blocks: number; headers: number; txindexBestBlockHeight: number };
    };
  };
  const node = admission.infrastructure.nodeReadiness;
  const split = planTreasuryPresplit(treasuryPlanInput);
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
      headers: node.headers,
      blocks: node.blocks,
      bestBlockHash,
      genesisHash: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
      observedAt: OBSERVED_AT,
    },
    txindex: {
      rpcMethod: 'getindexinfo',
      synced: true,
      bestBlockHeight: node.txindexBestBlockHeight,
      observedAt: OBSERVED_AT,
    },
    watchOnlyWallet: {
      walletName: 'arkova-watch-only',
      privateKeysEnabled: false,
      descriptors: true,
      treasuryAddress: TREASURY,
      treasuryDescriptor: readiness.infrastructure.treasuryWatchOnly.descriptor,
      descriptorImported: true,
      rescanComplete: true,
      confirmedUtxos: 32,
      confirmedTotalSats: treasuryPlanInput.inputs
        .reduce((total, candidate) => total + candidate.valueSats, 0) - treasuryPlanInput.feeSats,
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
      tipHeight: node.blocks, tipHash: bestBlockHash, txId: broadcastTxId, txOutcome: 'found',
      observedAt: OBSERVED_AT,
    },
    nodeCron: { mode: 'disabled', observedAt: OBSERVED_AT },
  };
}

describe('RIG-B1 augmented Scheduler-start pre-clock generator', () => {
  it('accepts top-level continuity while rejecting mutation of original c56 infrastructure', () => {
    const raw = continuityAdmissionRaw();
    expect(() => projectAdmissionV2ToPreClockIdentity(raw)).not.toThrow();
    const mutated = JSON.parse(raw) as {
      infrastructure: { nodeReadiness: { confirmedTotalSats: number } };
    };
    mutated.infrastructure.nodeReadiness.confirmedTotalSats = 169_482;
    expect(() => projectAdmissionV2ToPreClockIdentity(JSON.stringify(mutated)))
      .toThrow(/continuity|infrastructure|original|treasury/i);
  });

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

  it('binds the continuity composite and distinct controller into PREPARE authority', () => {
    const request = preparationRequest();
    request.candidate.continuityCompositeIdentitySha256 = `sha256:${'e'.repeat(64)}`;
    request.controller = {
      sourceHeadSha: 'f'.repeat(40),
      sourceTreeSha: '1'.repeat(40),
      relevantFilesSha256: `sha256:${'2'.repeat(64)}`,
    };
    const raw = buildB1PreparationAuthoritySignedPayload(request);
    expect(verifier.verify(preparationEnvelope(raw), new Date(OBSERVED_AT))).toMatchObject({
      continuityCompositeIdentitySha256: request.candidate.continuityCompositeIdentitySha256,
      controllerSourceHeadSha: request.controller.sourceHeadSha,
      controllerSourceTreeSha: request.controller.sourceTreeSha,
      controllerRelevantFilesSha256: request.controller.relevantFilesSha256,
    });

    const missingController = preparationRequest();
    missingController.candidate.continuityCompositeIdentitySha256 = `sha256:${'e'.repeat(64)}`;
    expect(() => buildB1PreparationAuthoritySignedPayload(missingController))
      .toThrow(/continuity|controller|custom/i);
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
  coreObservations: number;
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

function liveCollectorPort(
  rawAdmission: string,
  treasuryPlanInput: TreasuryPresplitPlanInput = inputs(),
): TestCollectorPort {
  const live = observation(rawAdmission, treasuryPlanInput);
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
    treasury_continuity?: {
      originalProvision: {
        claim: { objectUri: string; generation: string };
        topology: { objectUri: string; generation: string };
      };
      amendment: { objectUri: string; generation: string };
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
    coreObservations: 0,
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
    verifyControllerIdentity: async () => {
      testState.operations.push('verify-controller');
    },
    hasLockedObject: async (uri) => locked.has(uri),
    readLockedObject: async (uri, generation) => {
      const continuity = admission.treasury_continuity;
      const continuityObject = continuity === undefined ? undefined : [
        {
          reference: continuity.originalProvision.claim,
          raw: textFixture('s33-b1-c56c-provision-claim.fixture.txt'),
        },
        {
          reference: continuity.originalProvision.topology,
          raw: textFixture('s33-b1-c56c-topology-ownership.fixture.txt'),
        },
        {
          reference: continuity.amendment,
          raw: textFixture('s33-b1-c56c-treasury-continuity-amendment.fixture.txt'),
        },
        {
          reference: {
            objectUri: B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationIntentUri,
            generation: B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationIntentGeneration,
          },
          raw: textFixture('s33-b1-historical-preparation-intent.fixture.txt'),
        },
        {
          reference: {
            objectUri: B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationOutcomeUri,
            generation: B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationOutcomeGeneration,
          },
          raw: textFixture('s33-b1-historical-preparation-outcome.fixture.txt'),
        },
        {
          reference: {
            objectUri: B1_TREASURY_CONTINUITY_CONTRACT.failedStartContainmentUri,
            generation: B1_TREASURY_CONTINUITY_CONTRACT.failedStartContainmentGeneration,
          },
          raw: textFixture('s33-b1-failed-start-containment.fixture.txt'),
        },
      ].find(({ reference }) => reference.objectUri === uri);
      if (continuityObject !== undefined) {
        return {
          uri,
          generation: generation ?? continuityObject.reference.generation,
          retainUntilTime: '2026-07-22T22:39:24Z',
          raw: continuityObject.raw,
        };
      }
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
    observeCore: async () => {
      testState.coreObservations += 1;
      testState.operations.push('observe-core');
      return {
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
      confirmedOutputs: treasuryPlanInput.inputs.map((candidate) => ({
        txId: candidate.txId,
        vout: candidate.vout,
        valueSats: candidate.valueSats,
        confirmations: candidate.confirmations,
      })),
      minimumConfirmations: live.watchOnlyWallet.minimumConfirmations,
      splitTransactionObserved: admission.infrastructure.treasuryWatchOnly.splitTransactionId,
      capabilities: Object.fromEntries(RIG_B1_REQUIRED_RPC_CAPABILITIES.map((method) => [method, true])) as Record<typeof RIG_B1_REQUIRED_RPC_CAPABILITIES[number], boolean>,
      observedAt: OBSERVED_AT,
      };
    },
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
      tipHeight: live.getBlockchainInfo.blocks,
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

  it('uses original c56 infrastructure plus effective continuity and persists controller bindings', async () => {
    const admission = continuityAdmissionRaw();
    const plan = continuityPlanRaw();
    const port = liveCollectorPort(admission, continuityPlanInput());
    port.testState.now = CONTINUITY_NOW;
    const artifact = JSON.parse(await collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorizeB1PreclockMutationForTest(admission, plan, continuityPreparationOverrides()),
      port,
    )) as Record<string, unknown>;
    const parsedAdmission = JSON.parse(admission) as {
      treasury_continuity: {
        compositeIdentitySha256: string;
        controllerCandidate: {
          sourceHeadSha: string;
          sourceTreeSha: string;
          relevantFilesSha256: string;
        };
      };
    };
    expect(artifact.continuityCompositeIdentitySha256)
      .toBe(parsedAdmission.treasury_continuity.compositeIdentitySha256);
    const intent = JSON.parse([...port.testState.locked.entries()]
      .find(([uri]) => uri.includes('/preparation-intents/'))![1].raw) as Record<string, unknown>;
    expect(intent).toMatchObject({
      continuityCompositeIdentitySha256:
        parsedAdmission.treasury_continuity.compositeIdentitySha256,
      controllerSourceHeadSha:
        parsedAdmission.treasury_continuity.controllerCandidate.sourceHeadSha,
      controllerSourceTreeSha:
        parsedAdmission.treasury_continuity.controllerCandidate.sourceTreeSha,
      controllerRelevantFilesSha256:
        parsedAdmission.treasury_continuity.controllerCandidate.relevantFilesSha256,
    });
    expect(port.testState.operations.indexOf('verify-controller'))
      .toBeLessThan(port.testState.operations.findIndex((operation) => operation.startsWith('persist:')));
    expect(port.testState.funded).toBe(1);
  });

  it('performs zero mutation when the locked continuity amendment differs', async () => {
    const admission = continuityAdmissionRaw();
    const plan = continuityPlanRaw();
    const port = liveCollectorPort(admission, continuityPlanInput());
    port.testState.now = CONTINUITY_NOW;
    const readLockedObject = port.readLockedObject.bind(port);
    port.readLockedObject = async (uri, generation) => {
      const object = await readLockedObject(uri, generation);
      return uri.includes('/recovery-amendments/')
        ? { ...object, raw: object.raw.replace('169482', '169483') }
        : object;
    };
    await expect(collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorizeB1PreclockMutationForTest(admission, plan, continuityPreparationOverrides()),
      port,
    )).rejects.toThrow(/amendment|digest|signature/i);
    expect(port.testState.funded).toBe(0);
    expect(port.testState.installed).toBe(0);
    expect(port.testState.locked.size).toBe(0);
  });

  it('performs zero mutation for a same-count/same-total live outpoint substitution', async () => {
    const admission = continuityAdmissionRaw();
    const plan = continuityPlanRaw();
    const port = liveCollectorPort(admission, continuityPlanInput());
    port.testState.now = CONTINUITY_NOW;
    const observeCore = port.observeCore.bind(port);
    port.observeCore = async (input) => {
      const observed = await observeCore(input);
      return {
        ...observed,
        confirmedOutputs: observed.confirmedOutputs.map((candidate, index) => index === 0
          ? { ...candidate, txId: '8'.repeat(64) }
          : candidate),
      };
    };
    await expect(collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorizeB1PreclockMutationForTest(admission, plan, continuityPreparationOverrides()),
      port,
    )).rejects.toThrow(/outpoint|signed plan|confirmation floor/i);
    expect(port.testState.funded).toBe(0);
    expect(port.testState.installed).toBe(0);
    expect(port.testState.locked.size).toBe(0);
  });

  it('performs zero mutation when the exact UTXO set drifts only at the final pre-intent read', async () => {
    const admission = continuityAdmissionRaw();
    const plan = continuityPlanRaw();
    const port = liveCollectorPort(admission, continuityPlanInput());
    port.testState.now = CONTINUITY_NOW;
    const observeCore = port.observeCore.bind(port);
    let calls = 0;
    port.observeCore = async (input) => {
      const observed = await observeCore(input);
      calls += 1;
      return calls === 2
        ? {
          ...observed,
          confirmedOutputs: observed.confirmedOutputs.map((candidate, index) => index === 0
            ? { ...candidate, txId: '9'.repeat(64) }
            : candidate),
        }
        : observed;
    };
    await expect(collectB1SchedulerPreclockArtifact(
      admission,
      plan,
      authorizeB1PreclockMutationForTest(admission, plan, continuityPreparationOverrides()),
      port,
    )).rejects.toThrow(/outpoint|signed plan|confirmation floor/i);
    expect(port.testState.coreObservations).toBe(2);
    expect(port.testState.funded).toBe(0);
    expect(port.testState.installed).toBe(0);
    expect(port.testState.locked.size).toBe(0);
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
