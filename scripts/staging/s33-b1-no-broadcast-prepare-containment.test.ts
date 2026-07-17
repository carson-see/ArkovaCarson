import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT as CONTRACT,
  buildB1NoBroadcastPrepareContainmentSignedPayload,
  createB1NoBroadcastPrepareContainmentVerifierForTest,
  type B1NoBroadcastPrepareContainmentPayload,
  type B1NoBroadcastPrepareRecovery,
} from './s33-b1-no-broadcast-prepare-containment';

function digest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function fixtureIntent(): string {
  return readFileSync(join(
    process.cwd(),
    'scripts/fixtures/s33-b1-no-broadcast-preparation-intent.fixture.txt',
  ), 'utf8').trimEnd();
}

function payload(keyFingerprint: string): B1NoBroadcastPrepareContainmentPayload {
  return {
    schemaVersion: CONTRACT.payloadSchemaVersion,
    containmentId: 'b1-prepare-no-broadcast-containment-test',
    authority: {
      keyId: CONTRACT.keyId,
      keyFingerprint,
      approverIdentity: CONTRACT.approverIdentity,
      purpose: CONTRACT.purpose,
      signatureDomain: CONTRACT.signatureDomain,
    },
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
        observedAbsentAt: '2026-07-17T03:49:00.000Z',
      },
      fundedProbeRunId: CONTRACT.fundedProbeRunId,
      failureStage: 'TAGGED_URL_VALIDATION_BEFORE_HTTP',
    },
    observations: {
      observedAt: '2026-07-17T04:09:00.000Z',
      cloudRun: {
        requestCount: 0,
        filter: CONTRACT.cloudRunLogFilter,
        observationStartedAt: CONTRACT.cloudRunObservationStartedAt,
        observationEndedAt: CONTRACT.cloudRunObservationEndedAt,
        exportSha256: CONTRACT.cloudRunExportSha256,
      },
      treasury: {
        planInputSha256: CONTRACT.treasuryPlanInputSha256,
        planDigest: CONTRACT.treasuryPlanDigest,
        confirmedOutputCount: CONTRACT.confirmedOutputCount,
        confirmedTotalSats: CONTRACT.confirmedTotalSats,
        confirmedOutpointValueExportSha256: CONTRACT.confirmedOutpointValueExportSha256,
        confirmedOutpointValueSerialization: CONTRACT.confirmedOutpointValueSerialization,
        minimumConfirmationsFloor: CONTRACT.minimumConfirmationsFloor,
        unconfirmedOutputCount: 0,
        minconfZeroMatchesMinconfOne: true,
        exportSchemaVersion: CONTRACT.coreUtxoExportSchemaVersion,
        exportSha256: CONTRACT.coreUtxoExportSha256,
        observedStartedAt: CONTRACT.coreUtxoObservedStartedAt,
        observedEndedAt: CONTRACT.coreUtxoObservedEndedAt,
        changed: false,
      },
      supabase: {
        projectRef: CONTRACT.supabaseProjectRef,
        runOrgId: CONTRACT.runOrgId,
        anchors: 0,
        anchorProofs: 0,
        organizations: 0,
        orgCredits: 0,
        exportSha256: CONTRACT.supabaseZeroResidueExportSha256,
        observedAt: CONTRACT.supabaseZeroResidueObservedAt,
      },
      invocationLeaseRemoved: true,
      schedulerJobs: CONTRACT.schedulerJobNames.map((name) => ({
        name, state: 'PAUSED' as const, schedule: '*/5 * * * *' as const,
      })),
      allSixSchedulersPaused: true,
    },
    authorization: {
      successorPreparationId: 'b1-prepare-c56-successor-test',
      successorPrepareCount: 1,
    },
    issuedAt: '2026-07-17T04:09:00.000Z',
    expiresAt: '2026-07-17T04:39:00.000Z',
    verdict: 'NO_BROADCAST_PREPARE_CONTAINED_ONE_SUCCESSOR_AUTHORIZED',
  };
}

describe('RIG-B1 no-broadcast PREPARE containment', () => {
  it('rejects substituted Cloud Run, Core, or Supabase evidence digests', () => {
    const exact = payload(CONTRACT.keyFingerprint);
    for (const mutate of [
      (value: typeof exact) => { value.observations.cloudRun.exportSha256 = `sha256:${'d'.repeat(64)}` as never; },
      (value: typeof exact) => { value.observations.treasury.exportSha256 = `sha256:${'e'.repeat(64)}` as never; },
      (value: typeof exact) => { value.observations.supabase.exportSha256 = `sha256:${'f'.repeat(64)}` as never; },
    ]) {
      const substituted = structuredClone(exact);
      mutate(substituted);
      expect(() => buildB1NoBroadcastPrepareContainmentSignedPayload(substituted)).toThrow();
    }
  });

  it('verifies exact immutable evidence and authorizes one named successor only', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const fingerprint = createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    const signedPayloadRaw = buildB1NoBroadcastPrepareContainmentSignedPayload(
      payload(fingerprint),
    );
    const envelopeRaw = JSON.stringify({
      schemaVersion: 1,
      envelopeId: 'b1-prepare-no-broadcast-containment-test',
      keyId: CONTRACT.keyId,
      keyFingerprint: fingerprint,
      signedPayloadRaw,
      signature: sign(
        null,
        Buffer.from(`${CONTRACT.signatureDomain}${signedPayloadRaw}`),
        privateKey,
      ).toString('base64'),
    });
    const recovery: B1NoBroadcastPrepareRecovery = {
      schemaVersion: CONTRACT.recoverySchemaVersion,
      containment: {
        objectUri: 'gs://test-bucket/no-broadcast-containment.json',
        generation: '1',
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
      successorPreparationId: 'b1-prepare-c56-successor-test',
      successorPrepareCount: 1,
    };
    const intentRaw = fixtureIntent();
    expect(digest(intentRaw)).toBe(CONTRACT.failedPreparationIntentSha256);
    const verifier = createB1NoBroadcastPrepareContainmentVerifierForTest({
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
      verificationTime: new Date('2026-07-17T04:10:00.000Z'),
    })).toMatchObject({
      status: 'VERIFIED_NO_BROADCAST_PREPARE_CONTAINMENT',
      recovery: { successorPreparationId: 'b1-prepare-c56-successor-test' },
    });
    expect(() => verifier.verify({
      recovery: { ...recovery, successorPreparationId: 'another-successor' },
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
      verificationTime: new Date('2026-07-17T04:10:00.000Z'),
    })).toThrow(/identity|successor|chronology/i);
  });
});
