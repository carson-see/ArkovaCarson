import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  S33_SCOPED_CARRY_FORWARD,
  S33_SCOPED_CARRY_FORWARD_SIGNATURE_DOMAIN,
  assembleS33ScopedCarryForwardEnvelope,
  buildS33ScopedCarryForwardSigningRequest,
  composeS33ScopedCarryForwardBinding,
  createS33ScopedCarryForwardVerifierForTest,
  type S33ScopedCarryForwardPayloadInput,
} from './s33-scoped-carry-forward';

const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const publicKeyFingerprintSha256 = createHash('sha256')
  .update(keys.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');

const D = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

function payload(): S33ScopedCarryForwardPayloadInput {
  const old = S33_SCOPED_CARRY_FORWARD.preservedCandidate;
  return {
    schemaVersion: 'arkova.s33.scoped-carry-forward/v1',
    artifactType: 'arkova-s33-scoped-carry-forward-payload',
    decisionId: S33_SCOPED_CARRY_FORWARD.decisionId,
    decision: 'PRESERVE_ACTIVE_G1_R_CLOCKS_WHILE_B1_ADVANCES',
    authority: {
      approverIdentity: 'arkova.s33.approver.founder-cto.v1',
      signerIdentity: 'arkova-s33-cto-release',
      signingKeyId: 'arkova.s33.release-corpus.ed25519.v1',
      authorizedAtUtc: '2026-07-17T01:40:00.000Z',
      authorityReceipt: 'codex-thread:019f65ca-fdfc-7652-bd86-7be6c7463d34:cto-scoped-carry-forward-ruling',
    },
    scope: {
      releaseAcceptance: false,
      purpose: 'CLOCK_ADMISSIBILITY_ONLY',
      rationale: 'B1 delta is isolated from the active AI-only G1/R rails; preserve their uninterrupted clocks.',
      residualRisk: 'The mixed-version release evidence must remain split until the downstream B1 start binding is composed.',
    },
    candidates: {
      preserved: old,
      advancedB1: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate,
      deltaChain: [
        {
          baseHeadSha: old.headSha,
          headSha: S33_SCOPED_CARRY_FORWARD.b1ProvisioningHeadSha,
          classification: 'B1_PROVISIONING_ONLY',
          changedPaths: [...S33_SCOPED_CARRY_FORWARD.b1ProvisioningChangedPaths],
        },
        {
          baseHeadSha: S33_SCOPED_CARRY_FORWARD.b1ProvisioningHeadSha,
          headSha: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate.headSha,
          classification: 'B1_BATCH_RUNTIME_FIX_AND_TEST',
          changedPaths: [...S33_SCOPED_CARRY_FORWARD.b1RuntimeFixChangedPaths],
        },
      ],
    },
    preservedRigs: [
      {
        rigId: 'RIG-G1-A', tier: 'T2', service: 'arkova-worker-s33-g1-a-staging',
        revision: 'arkova-worker-s33-g1-a-staging-00003-st9',
        runtimeServiceAccount: 's33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com',
        supabaseProjectRef: 'xexeyggjmiljsxnbgwyw',
        headSha: old.headSha, treeSha: old.treeSha, imageDigest: old.imageDigest,
      },
      {
        rigId: 'RIG-G1-B', tier: 'T2', service: 'arkova-worker-s33-g1-b-staging',
        revision: 'arkova-worker-s33-g1-b-staging-00003-82m',
        runtimeServiceAccount: 's33-rig-g1-b-runtime@arkova1.iam.gserviceaccount.com',
        supabaseProjectRef: 'kbyzdzwsxfkrgtotafab',
        headSha: old.headSha, treeSha: old.treeSha, imageDigest: old.imageDigest,
      },
      {
        rigId: 'RIG-R', tier: 'T3', service: 'arkova-worker-s33-r-staging',
        revision: 'arkova-worker-s33-r-staging-00006-9rc',
        runtimeServiceAccount: 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
        supabaseProjectRef: 'kzvibjvehqoiqvjkodoj',
        headSha: old.headSha, treeSha: old.treeSha, imageDigest: old.imageDigest,
      },
    ],
    evidence: {
      callGraphProofSha256: D('1'),
      beforeReadbackSha256: D('2'),
      afterReadbackSha256: D('3'),
      cloudAuditNoMutationSha256: D('4'),
      heartbeatSnapshotSha256: D('5'),
      g1PairedStartReceipt: {
        uri: S33_SCOPED_CARRY_FORWARD.g1StartReceipt.uri,
        generation: S33_SCOPED_CARRY_FORWARD.g1StartReceipt.generation,
        rawSha256: S33_SCOPED_CARRY_FORWARD.g1StartReceipt.rawSha256,
      },
      rigRStartReceipt: {
        uri: S33_SCOPED_CARRY_FORWARD.rigRStartReceipt.uri,
        generation: S33_SCOPED_CARRY_FORWARD.rigRStartReceipt.generation,
        rawSha256: S33_SCOPED_CARRY_FORWARD.rigRStartReceipt.rawSha256,
      },
      observationWindow: {
        startedAtUtc: '2026-07-17T00:00:43.242Z',
        endedAtUtc: '2026-07-17T01:40:00.000Z',
        cloudRunMutationCount: 0,
        vertexEndpointMutationCount: 0,
      },
    },
    downstreamBinding: {
      requiredArtifactType: 'arkova-s33-scoped-carry-forward-binding/v1',
      requiredB1StartReceipt: true,
      requiredB1Heartbeat: true,
      requiredPreservedRigHeartbeatRecheck: true,
      releaseAcceptance: false,
    },
  } as S33ScopedCarryForwardPayloadInput;
}

function signedEnvelope(input = payload()) {
  const request = buildS33ScopedCarryForwardSigningRequest(input);
  const signature = sign(
    null,
    Buffer.from(request.signingBytesBase64Url, 'base64url'),
    keys.privateKey,
  ).toString('base64url');
  return assembleS33ScopedCarryForwardEnvelope(request, signature, {
    publicKeyPem,
    publicKeyFingerprintSha256,
  });
}

describe('S3.3 scoped mixed-version carry-forward', () => {
  it('emits canonical domain-separated signing bytes and verifies the CTO envelope', () => {
    const request = buildS33ScopedCarryForwardSigningRequest(payload());
    expect(Buffer.from(request.signingBytesBase64Url, 'base64url').toString())
      .toBe(`${S33_SCOPED_CARRY_FORWARD_SIGNATURE_DOMAIN}${request.payloadCanonicalJson}`);

    const envelope = signedEnvelope();
    const verifier = createS33ScopedCarryForwardVerifierForTest({
      publicKeyPem,
      publicKeyFingerprintSha256,
    });
    expect(verifier.verify(envelope)).toMatchObject({
      artifactType: 'arkova-s33-scoped-carry-forward-envelope',
      payload: {
        decisionId: S33_SCOPED_CARRY_FORWARD.decisionId,
        candidates: {
          preserved: S33_SCOPED_CARRY_FORWARD.preservedCandidate,
          advancedB1: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate,
        },
      },
    });
  });

  it('rejects tuple drift, omitted evidence, and cross-domain signatures', () => {
    const drifted = structuredClone(payload());
    drifted.preservedRigs[2].revision = 'arkova-worker-s33-r-staging-00007-bad';
    expect(() => buildS33ScopedCarryForwardSigningRequest(drifted)).toThrow(/revision|literal/i);

    const missing = structuredClone(payload()) as unknown as Record<string, unknown>;
    delete (missing.evidence as Record<string, unknown>).cloudAuditNoMutationSha256;
    expect(() => buildS33ScopedCarryForwardSigningRequest(missing as never)).toThrow(/evidence|invalid/i);

    const request = buildS33ScopedCarryForwardSigningRequest(payload());
    const wrongSignature = sign(null, Buffer.from(request.payloadCanonicalJson), keys.privateKey)
      .toString('base64url');
    expect(() => assembleS33ScopedCarryForwardEnvelope(request, wrongSignature, {
      publicKeyPem,
      publicKeyFingerprintSha256,
    })).toThrow(/signature/i);
  });

  it('binds only an exact new-B1 start receipt and fresh old-rail heartbeat recheck', () => {
    const envelope = signedEnvelope();
    const verifiedEnvelope = createS33ScopedCarryForwardVerifierForTest({
      publicKeyPem,
      publicKeyFingerprintSha256,
    }).verify(envelope);
    const result = composeS33ScopedCarryForwardBinding({
      verifiedEnvelope,
      composedAtUtc: '2026-07-17T02:00:00.000Z',
      b1StartReceipt: {
        headSha: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate.headSha,
        treeSha: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate.treeSha,
        imageIndexDigest: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate.imageIndexDigest,
        imageLinuxAmd64Digest: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate.imageLinuxAmd64Digest,
        rawSha256: D('6'),
        uri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/start-receipts/receipt.json',
        generation: '1784247000000000',
      },
      b1HeartbeatSha256: D('7'),
      preservedRigHeartbeatRecheckSha256: D('8'),
      preservedRigHeartbeatRecheckedAtUtc: '2026-07-17T01:59:30.000Z',
    });
    expect(result).toMatchObject({
      status: 'SCOPED_CARRY_FORWARD_BOUND',
      releaseAcceptance: false,
      b1Candidate: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate,
      preservedCandidate: S33_SCOPED_CARRY_FORWARD.preservedCandidate,
    });

    const wrong = structuredClone(result.b1StartReceipt);
    wrong.headSha = S33_SCOPED_CARRY_FORWARD.preservedCandidate.headSha as never;
    expect(() => composeS33ScopedCarryForwardBinding({
      verifiedEnvelope,
      composedAtUtc: '2026-07-17T02:00:00.000Z',
      b1StartReceipt: wrong,
      b1HeartbeatSha256: D('7'),
      preservedRigHeartbeatRecheckSha256: D('8'),
      preservedRigHeartbeatRecheckedAtUtc: '2026-07-17T01:59:30.000Z',
    })).toThrow(/B1 start receipt|head/i);
  });

  it('rejects duplicate-key JSON and fabricated verifier results at the compositor boundary', () => {
    const envelope = signedEnvelope();
    const verifier = createS33ScopedCarryForwardVerifierForTest({
      publicKeyPem,
      publicKeyFingerprintSha256,
    });
    const raw = JSON.stringify(envelope);
    expect(verifier.verifyJson(raw)).toMatchObject({
      artifactDigestSha256: envelope.artifactDigestSha256,
    });
    expect(() => verifier.verifyJson(raw.replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    ))).toThrow(/duplicate/i);

    const fabricated = structuredClone(verifier.verify(envelope));
    expect(() => composeS33ScopedCarryForwardBinding({
      verifiedEnvelope: fabricated,
      composedAtUtc: '2026-07-17T02:00:00.000Z',
      b1StartReceipt: {
        headSha: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate.headSha,
        treeSha: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate.treeSha,
        imageIndexDigest: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate.imageIndexDigest,
        imageLinuxAmd64Digest: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate.imageLinuxAmd64Digest,
        rawSha256: D('6'),
        uri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/start-receipts/receipt.json',
        generation: '1784247000000000',
      },
      b1HeartbeatSha256: D('7'),
      preservedRigHeartbeatRecheckSha256: D('8'),
      preservedRigHeartbeatRecheckedAtUtc: '2026-07-17T01:59:30.000Z',
    })).toThrow(/provenance-verified/i);
  });
});
