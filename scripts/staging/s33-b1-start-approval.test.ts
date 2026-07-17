import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  B1_START_APPROVAL_SIGNATURE_DOMAIN,
  B1_START_AUTHORITY_CONTRACT,
  buildB1StartAuthoritySignedPayload,
  createB1StartAuthorityVerifierForTest,
  parseB1StartAuthoritySignedPayload,
  type B1StartAuthorityPayload,
} from './s33-b1-start-approval';

const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = createHash('sha256')
  .update(keys.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const verifier = createB1StartAuthorityVerifierForTest({
  publicKeyPem,
  keyFingerprint: fingerprint,
});

const D = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const BASE = B1_START_AUTHORITY_CONTRACT.ledgerBaseUri;

function payload(): B1StartAuthorityPayload {
  return {
    schemaVersion: 1,
    startId: 'start-b1-s33-001',
    authority: {
      keyId: 'arkova.s33.b1-evidence.ed25519.v1',
      approverIdentity: 'arkova.s33.approver.founder-cto.v1',
      purpose: 'START_B1',
    },
    candidate: {
      sourceHeadSha: 'a'.repeat(40),
      sourceTreeSha: 'b'.repeat(40),
      workerImage:
        `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@${D('c')}`,
      workerImageDigest: D('c'),
      corpusDigest: D('d'),
      releaseCandidateId: 's33-final-rc-001',
    },
    prerequisites: {
      provision: {
        approvalId: 'b1-provision-001',
        approvalEnvelopeSha256: D('1'),
        signedPayloadSha256: D('2'),
        admissionSha256: D('3'),
        approvalClaim: {
          objectUri: `${BASE}/node-approval-claims/b1-provision-001.json`,
          generation: '1',
          sha256: D('4'),
        },
        topologyOwnership: {
          objectUri: `${BASE}/topology-ownership/b1-provision-001.json`,
          generation: '2',
          sha256: D('5'),
        },
      },
      preparation: {
        preparationId: 'b1-prepare-001',
        approvalEnvelopeSha256: D('6'),
        signedPayloadSha256: D('7'),
        intent: {
          objectUri: `${BASE}/preparation-intents/b1-prepare-001.json`,
          generation: '3',
          sha256: D('8'),
        },
        outcome: {
          objectUri: `${BASE}/preparation-outcomes/b1-prepare-001.json`,
          generation: '4',
          sha256: D('9'),
        },
        preclockArtifactSha256: D('e'),
      },
    },
    run: {
      rigName: 's33-rig-b1',
      soakId: 's33-b1-soak-001',
      leaseId: 's33-b1-lease-001',
      workerService: 'arkova-worker-s33-rig-b1-staging',
      workerRuntimeServiceAccount: 's33-rig-b1-runtime@arkova1.iam.gserviceaccount.com',
      schedulerOidcServiceAccount: 's33-rig-b1-cron@arkova1.iam.gserviceaccount.com',
      schedulerJobResources: [...B1_START_AUTHORITY_CONTRACT.schedulerJobResources] as [
        string, string, string, string, string, string,
      ],
      schedulerCadence: '*/5 * * * *',
      requiredWorkerUptimeMin: 2_880,
      requiredWallMin: 2_910,
      heartbeatIntervalMaxSeconds: 240,
      invocationLeaseMaxSeconds: 600,
      runHardStopAt: '2026-07-18T21:00:00.000Z',
    },
    issuedAt: '2026-07-16T20:00:00.000Z',
    expiresAt: '2026-07-16T20:10:00.000Z',
  };
}

function envelope(
  signedPayloadRaw: string,
  options: Readonly<{ envelopeId?: string; useDomain?: boolean }> = {},
): string {
  const bytes = Buffer.concat([
    Buffer.from(options.useDomain === false ? '' : B1_START_APPROVAL_SIGNATURE_DOMAIN),
    Buffer.from(signedPayloadRaw),
  ]);
  return JSON.stringify({
    schemaVersion: 1,
    envelopeId: options.envelopeId ?? 'start-b1-s33-001',
    keyId: B1_START_AUTHORITY_CONTRACT.keyId,
    keyFingerprint: fingerprint,
    signedPayloadRaw,
    signature: sign(null, bytes, keys.privateKey).toString('base64'),
  });
}

describe('distinct signed START_B1 authority', () => {
  it('round-trips canonical request bytes and verifies every prerequisite/final-run binding', () => {
    const request = payload();
    const signedPayloadRaw = buildB1StartAuthoritySignedPayload(request);
    expect(parseB1StartAuthoritySignedPayload(signedPayloadRaw)).toEqual(request);
    expect(verifier.verify(
      envelope(signedPayloadRaw),
      new Date('2026-07-16T20:05:00.000Z'),
    )).toMatchObject({
      status: 'VERIFIED',
      verifierIdentity: B1_START_AUTHORITY_CONTRACT.verifierIdentity,
      startId: request.startId,
      candidate: request.candidate,
      prerequisites: request.prerequisites,
      run: request.run,
    });
  });

  it('cryptographically binds continuity amendment and distinct controller identity', () => {
    const request = payload();
    request.prerequisites.continuity = {
      compositeIdentitySha256: D('a'),
      amendment: {
        objectUri: `${BASE}/recovery-amendments/b1-treasury-continuity.json`,
        generation: '5',
        sha256: D('b'),
      },
    };
    request.controller = {
      sourceHeadSha: 'c'.repeat(40),
      sourceTreeSha: 'd'.repeat(40),
      relevantFilesSha256: D('e'),
    };
    const signedPayloadRaw = buildB1StartAuthoritySignedPayload(request);
    expect(verifier.verify(
      envelope(signedPayloadRaw),
      new Date('2026-07-16T20:05:00.000Z'),
    )).toMatchObject({
      prerequisites: { continuity: request.prerequisites.continuity },
      controller: request.controller,
    });

    const tampered = signedPayloadRaw.replace(`"relevantFilesSha256":"${D('e')}"`,
      `"relevantFilesSha256":"${D('f')}"`);
    const tamperedEnvelope = JSON.parse(envelope(signedPayloadRaw)) as { signedPayloadRaw: string };
    tamperedEnvelope.signedPayloadRaw = tampered;
    expect(() => verifier.verify(
      JSON.stringify(tamperedEnvelope),
      new Date('2026-07-16T20:05:00.000Z'),
    )).toThrow(/signature/i);
  });

  it('rejects continuity and controller bindings unless both are present', () => {
    const missingController = payload();
    missingController.prerequisites.continuity = {
      compositeIdentitySha256: D('a'),
      amendment: { objectUri: `${BASE}/recovery-amendments/a.json`, generation: '5', sha256: D('b') },
    };
    expect(() => buildB1StartAuthoritySignedPayload(missingController)).toThrow(/controller|custom/i);

    const missingContinuity = payload();
    missingContinuity.controller = {
      sourceHeadSha: 'c'.repeat(40),
      sourceTreeSha: 'd'.repeat(40),
      relevantFilesSha256: D('e'),
    };
    expect(() => buildB1StartAuthoritySignedPayload(missingContinuity)).toThrow(/continuity|custom/i);
  });

  it('requires the START_B1 signature domain', () => {
    const raw = buildB1StartAuthoritySignedPayload(payload());
    expect(() => verifier.verify(
      envelope(raw, { useDomain: false }),
      new Date('2026-07-16T20:05:00.000Z'),
    )).toThrow(/signature/i);
  });

  it('binds the envelope id to the signed start id', () => {
    const raw = buildB1StartAuthoritySignedPayload(payload());
    expect(() => verifier.verify(
      envelope(raw, { envelopeId: 'different-start-id' }),
      new Date('2026-07-16T20:05:00.000Z'),
    )).toThrow(/envelope id|start id/i);
  });

  it('rejects duplicate JSON keys and unsigned schema extensions', () => {
    const raw = buildB1StartAuthoritySignedPayload(payload());
    const duplicate = raw.replace('{"schemaVersion":1,', '{"schemaVersion":1,"schemaVersion":1,');
    expect(() => parseB1StartAuthoritySignedPayload(duplicate)).toThrow(/duplicate/i);
    const extended = JSON.stringify({ ...payload(), unsignedOverride: true });
    expect(() => parseB1StartAuthoritySignedPayload(extended)).toThrow();
  });

  it('rejects a provision/PREPARE Locked URI not derived from the signed ids', () => {
    const request = payload();
    request.prerequisites.preparation.outcome.objectUri = `${BASE}/preparation-outcomes/other.json`;
    expect(() => buildB1StartAuthoritySignedPayload(request)).toThrow(/reference URI|custom/i);
  });

  it('rejects a worker image that does not bind the signed digest', () => {
    const request = payload();
    request.candidate.workerImageDigest = D('f');
    expect(() => buildB1StartAuthoritySignedPayload(request)).toThrow(/image|custom/i);
  });

  it('requires a short activation-use window', () => {
    const request = payload();
    request.expiresAt = '2026-07-16T20:10:00.001Z';
    const raw = buildB1StartAuthoritySignedPayload(request);
    expect(() => verifier.verify(
      envelope(raw),
      new Date('2026-07-16T20:05:00.000Z'),
    )).toThrow(/ten minutes/i);
  });

  it('requires the signed hard stop to cover 2910 minutes after the entire action window', () => {
    const request = payload();
    request.run.runHardStopAt = '2026-07-18T20:39:59.999Z';
    const raw = buildB1StartAuthoritySignedPayload(request);
    expect(() => verifier.verify(
      envelope(raw),
      new Date('2026-07-16T20:05:00.000Z'),
    )).toThrow(/hard stop|full wall/i);
  });

  it('rejects a signed hard stop beyond the bounded seven-day run window', () => {
    const request = payload();
    request.run.runHardStopAt = '2026-07-23T20:00:00.001Z';
    const raw = buildB1StartAuthoritySignedPayload(request);
    expect(() => verifier.verify(
      envelope(raw),
      new Date('2026-07-16T20:05:00.000Z'),
    )).toThrow(/seven days/i);
  });

  it('rejects replay after the signed activation-use expiry', () => {
    const raw = buildB1StartAuthoritySignedPayload(payload());
    expect(() => verifier.verify(
      envelope(raw),
      new Date('2026-07-16T20:10:00.000Z'),
    )).toThrow(/expired/i);
  });
});
