import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT as FIRST } from './s33-b1-no-broadcast-prepare-containment';
import {
  B1_NO_BROADCAST_SUCCESSOR_CONTAINMENT_CONTRACT as SECOND,
  type B1NoBroadcastSuccessorRecovery,
} from './s33-b1-no-broadcast-successor-containment';
import {
  B1_NO_BROADCAST_THIRD_CONTAINMENT_CONTRACT as CONTRACT,
  assertB1NoBroadcastSuccessorRecoveryChain,
  buildB1NoBroadcastThirdContainmentSignedPayload,
  createB1NoBroadcastThirdContainmentVerifierForTest,
  type B1NoBroadcastThirdContainmentPayload,
  type B1NoBroadcastThirdRecovery,
} from './s33-b1-no-broadcast-third-containment';

function digest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function fixtureIntent(): string {
  return readFileSync(join(
    process.cwd(),
    'scripts/fixtures/s33-b1-no-broadcast-third-preparation-intent.fixture.txt',
  ), 'utf8').trimEnd();
}

function priorRecovery(): B1NoBroadcastSuccessorRecovery {
  return {
    schemaVersion: SECOND.recoverySchemaVersion,
    priorRecovery: {
      schemaVersion: FIRST.recoverySchemaVersion,
      containment: {
        objectUri: 'gs://test/first-containment.json',
        generation: '1',
        envelopeSha256: `sha256:${'1'.repeat(64)}`,
        signedPayloadSha256: `sha256:${'2'.repeat(64)}`,
      },
      failedPreparation: {
        preparationId: FIRST.failedPreparationId,
        intent: {
          objectUri: FIRST.failedPreparationIntentUri,
          generation: FIRST.failedPreparationIntentGeneration,
          sha256: FIRST.failedPreparationIntentSha256,
        },
        outcomeObjectUri: FIRST.failedPreparationOutcomeUri,
        fundedProbeRunId: FIRST.fundedProbeRunId,
      },
      successorPreparationId: SECOND.failedPreparationId,
      successorPrepareCount: 1,
    },
    containment: {
      objectUri: 'gs://test/second-containment.json',
      generation: '2',
      envelopeSha256: `sha256:${'3'.repeat(64)}`,
      signedPayloadSha256: `sha256:${'4'.repeat(64)}`,
    },
    failedPreparation: {
      preparationId: SECOND.failedPreparationId,
      intent: {
        objectUri: SECOND.failedPreparationIntentUri,
        generation: SECOND.failedPreparationIntentGeneration,
        sha256: SECOND.failedPreparationIntentSha256,
      },
      outcomeObjectUri: SECOND.failedPreparationOutcomeUri,
      fundedProbeRunId: SECOND.fundedProbeRunId,
    },
    successorPreparationId: CONTRACT.failedPreparationId,
    successorPrepareCount: 1,
  };
}

function payload(keyFingerprint: string): B1NoBroadcastThirdContainmentPayload {
  return {
    schemaVersion: CONTRACT.payloadSchemaVersion,
    containmentId: 'b1-third-no-broadcast-containment-test',
    authority: {
      keyId: CONTRACT.keyId,
      keyFingerprint,
      approverIdentity: CONTRACT.approverIdentity,
      purpose: CONTRACT.purpose,
      signatureDomain: CONTRACT.signatureDomain,
    },
    priorRecovery: priorRecovery(),
    candidate: {
      sourceHeadSha: CONTRACT.sourceHeadSha,
      sourceTreeSha: CONTRACT.sourceTreeSha,
      workerImageDigest: CONTRACT.workerImageDigest,
      revision: CONTRACT.revision,
      workerService: CONTRACT.workerService,
      canonicalServiceUrl: CONTRACT.canonicalServiceUrl,
      taggedServiceUrl: CONTRACT.taggedServiceUrl,
      trafficTag: CONTRACT.trafficTag,
      trafficPercent: 100,
    },
    failedPreparation: {
      preparationId: CONTRACT.failedPreparationId,
      intent: {
        objectUri: CONTRACT.failedPreparationIntentUri,
        generation: CONTRACT.failedPreparationIntentGeneration,
        sha256: CONTRACT.failedPreparationIntentSha256,
      },
      outcome: {
        objectUri: CONTRACT.failedPreparationOutcomeUri,
        observedAbsent: true,
        observedAbsentAt: '2026-07-17T04:48:56.000Z',
      },
      fundedProbeRunId: CONTRACT.fundedProbeRunId,
      failureStage: 'EVIDENCE_PATH_ALLOWLIST_BEFORE_POST',
    },
    observations: {
      observedAt: '2026-07-17T04:49:21.000Z',
      cloudRunPost: {
        requestCount: 0,
        filter: CONTRACT.postLogFilter,
        observationStartedAt: CONTRACT.postObservationStartedAt,
        observationEndedAt: CONTRACT.postObservationEndedAt,
        exportSha256: CONTRACT.postExportSha256,
      },
      taggedHealthGet: {
        requestMethod: 'GET',
        requestUrl: CONTRACT.healthUrl,
        status: 200,
        observedAt: CONTRACT.healthObservedAt,
      },
      treasury: {
        planInputSha256: CONTRACT.treasuryPlanInputSha256,
        planDigest: CONTRACT.treasuryPlanDigest,
        confirmedOutputCount: CONTRACT.confirmedOutputCount,
        confirmedTotalSats: CONTRACT.confirmedTotalSats,
        confirmedOutpointValueExportSha256: CONTRACT.confirmedOutpointValueExportSha256,
        unconfirmedOutputCount: 0,
        changed: false,
        observedAt: '2026-07-17T04:49:20.000Z',
      },
      supabase: {
        projectRef: CONTRACT.supabaseProjectRef,
        runOrgId: CONTRACT.runOrgId,
        anchors: 0,
        anchorProofs: 0,
        organizations: 0,
        orgCredits: 0,
        observedAt: '2026-07-17T04:49:20.000Z',
      },
      invocationLeaseRemoved: true,
      schedulerJobs: CONTRACT.schedulerJobNames.map((name) => ({
        name, state: 'PAUSED' as const, schedule: '*/5 * * * *' as const,
      })),
      allSixSchedulersPaused: true,
    },
    authorization: {
      successorPreparationId: 'b1-prepare-c56-third-successor-test',
      successorPrepareCount: 1,
    },
    issuedAt: '2026-07-17T04:49:21.000Z',
    expiresAt: '2026-07-17T05:19:21.000Z',
    verdict: 'THIRD_NO_BROADCAST_PREPARE_CONTAINED_ONE_SUCCESSOR_AUTHORIZED',
  };
}

describe('RIG-B1 third no-broadcast PREPARE containment', () => {
  it('requires exact POST-empty and tagged GET evidence', () => {
    const wrongPost = payload(CONTRACT.keyFingerprint);
    wrongPost.observations.cloudRunPost.requestCount = 1 as never;
    expect(() => buildB1NoBroadcastThirdContainmentSignedPayload(wrongPost)).toThrow();

    const wrongHealth = payload(CONTRACT.keyFingerprint);
    wrongHealth.observations.taggedHealthGet.status = 204 as never;
    expect(() => buildB1NoBroadcastThirdContainmentSignedPayload(wrongHealth)).toThrow();
  });

  it('verifies the exact immutable intent and authorizes one fresh successor', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const fingerprint = createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const signedPayloadRaw = buildB1NoBroadcastThirdContainmentSignedPayload(
      payload(fingerprint),
    );
    const envelopeRaw = JSON.stringify({
      schemaVersion: 1,
      envelopeId: 'b1-third-no-broadcast-containment-test',
      keyId: CONTRACT.keyId,
      keyFingerprint: fingerprint,
      signedPayloadRaw,
      signature: sign(
        null, Buffer.from(`${CONTRACT.signatureDomain}${signedPayloadRaw}`), privateKey,
      ).toString('base64'),
    });
    const recovery: B1NoBroadcastThirdRecovery = {
      schemaVersion: CONTRACT.recoverySchemaVersion,
      priorRecovery: priorRecovery(),
      containment: {
        objectUri: 'gs://test/third-containment.json',
        generation: '3',
        envelopeSha256: digest(envelopeRaw),
        signedPayloadSha256: digest(signedPayloadRaw),
      },
      failedPreparation: {
        preparationId: CONTRACT.failedPreparationId,
        intent: {
          objectUri: CONTRACT.failedPreparationIntentUri,
          generation: CONTRACT.failedPreparationIntentGeneration,
          sha256: CONTRACT.failedPreparationIntentSha256,
        },
        outcomeObjectUri: CONTRACT.failedPreparationOutcomeUri,
        fundedProbeRunId: CONTRACT.fundedProbeRunId,
      },
      successorPreparationId: 'b1-prepare-c56-third-successor-test',
      successorPrepareCount: 1,
    };
    const intentRaw = fixtureIntent();
    expect(digest(intentRaw)).toBe(CONTRACT.failedPreparationIntentSha256);
    assertB1NoBroadcastSuccessorRecoveryChain(priorRecovery(), recovery);
    const verifier = createB1NoBroadcastThirdContainmentVerifierForTest({
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      keyFingerprint: fingerprint,
    });
    expect(verifier.verify({
      recovery,
      containment: {
        uri: recovery.containment.objectUri,
        generation: recovery.containment.generation,
        raw: envelopeRaw,
        retainUntilTime: '2026-08-17T00:00:00.000Z',
      },
      intent: {
        uri: recovery.failedPreparation.intent.objectUri,
        generation: recovery.failedPreparation.intent.generation,
        raw: intentRaw,
        retainUntilTime: '2026-08-17T00:00:00.000Z',
      },
      verificationTime: new Date('2026-07-17T04:50:00.000Z'),
    })).toMatchObject({
      status: 'VERIFIED_THIRD_NO_BROADCAST_PREPARE_CONTAINMENT',
      recovery: { successorPreparationId: 'b1-prepare-c56-third-successor-test' },
    });
  });
});
