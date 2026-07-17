import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  B1_TREASURY_CONTINUITY_CONTROLLER_FILES,
  calculateB1TreasuryContinuityCompositeIdentity,
  calculateB1TreasuryContinuityRelevantFilesSha256,
  verifyB1TreasuryContinuityComposition,
  verifyB1TreasuryContinuityControllerSnapshot,
  type B1TreasuryContinuityCompositionInput,
} from './s33-b1-treasury-continuity';

const ORIGINAL_HEAD = 'c56c7729687602b980e2b03454588683a8c20d9b';
const ORIGINAL_TREE = '09f7d40d6b59b6afbe4979346e1d0d46f35ccd28';
const ORIGINAL_IMAGE = 'sha256:0162f4b840b12cd062eb43a2c05d4684bf5997e5f70297186c96a5aafc5ee105';
const SUCCESSOR_HEAD = 'd'.repeat(40);
const SUCCESSOR_TREE = 'e'.repeat(40);
const CONTROLLER_FILES = B1_TREASURY_CONTINUITY_CONTROLLER_FILES.map((path, index) => ({
  path,
  raw: Buffer.from(`controller-file-${index}\n`),
}));
const CONTROLLER_FILES_DIGEST = calculateB1TreasuryContinuityRelevantFilesSha256(CONTROLLER_FILES);
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const RETAIN_UNTIL = '2026-07-22T22:39:24Z';

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'scripts/fixtures', name), 'utf8').trimEnd();
}

function makeInput(): B1TreasuryContinuityCompositionInput {
  const continuity = {
    schemaVersion: 'arkova.s33.rig-b1.treasury-continuity-composition/v1',
    compositeIdentitySha256: ZERO_DIGEST,
    originalProvision: {
      approvalId: 'b1-provision-c56c7729-20260717t021606z',
      approvalEnvelopeSha256: 'sha256:95810a191bf7fdcd976aeaaa3d17241a8fc3cdc1bc1f235fd2dc806c98430805',
      signedPayloadSha256: 'sha256:06ef0449e975315ffbe3a6e8ba506150365c4784bf758ea6ecd12616a78185b6',
      sourceHeadSha: ORIGINAL_HEAD,
      sourceTreeSha: ORIGINAL_TREE,
      corpusDigest: 'sha256:7d6ffd131230d13483d3f1bacdb170b3cfcc53a4383d59f6689e415c99e6089e',
      releaseCandidateId: 's33-w3-b1-recovery-rc-c56c7729',
      soakId: 'soak-s33-rig-b1-c56c7729',
      leaseId: 'lease-s33-rig-b1-c56c7729',
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
      sourceHeadSha: SUCCESSOR_HEAD,
      sourceTreeSha: SUCCESSOR_TREE,
      relevantFilesSha256: CONTROLLER_FILES_DIGEST,
    },
  };
  const admissionRaw = JSON.stringify({
    schema_version: 2,
    sha: ORIGINAL_HEAD,
    image_digest: ORIGINAL_IMAGE,
    soak_id: continuity.originalProvision.soakId,
    lease_id: continuity.originalProvision.leaseId,
    treasury_continuity: continuity,
    infrastructure: {
      authority: {
        approvalId: continuity.originalProvision.approvalId,
        approvalEnvelopeSha256: continuity.originalProvision.approvalEnvelopeSha256,
        signedPayloadSha256: continuity.originalProvision.signedPayloadSha256,
        claim: continuity.originalProvision.claim,
      },
      nodeReadiness: {
        treasurySplitPlanDigest: continuity.originalTreasury.planDigest,
        confirmedOutputCount: continuity.originalTreasury.confirmedOutputCount,
        confirmedTotalSats: continuity.originalTreasury.confirmedTotalSats,
      },
      treasuryWatchOnly: {
        preSplitPlanDigest: continuity.originalTreasury.planDigest,
        expectedConfirmedOutputCount: continuity.originalTreasury.confirmedOutputCount,
        expectedTotalSats: continuity.originalTreasury.confirmedTotalSats,
      },
    },
  });
  return {
    refreshedAdmissionRaw: admissionRaw,
    currentTreasuryPlanInputRaw: fixture('s33-b1-post-probe-treasury-plan.fixture.txt'),
    originalClaim: {
      uri: continuity.originalProvision.claim.objectUri,
      generation: continuity.originalProvision.claim.generation,
      raw: fixture('s33-b1-c56c-provision-claim.fixture.txt'),
      retainUntilTime: RETAIN_UNTIL,
    },
    originalTopology: {
      uri: continuity.originalProvision.topology.objectUri,
      generation: continuity.originalProvision.topology.generation,
      raw: fixture('s33-b1-c56c-topology-ownership.fixture.txt'),
      retainUntilTime: RETAIN_UNTIL,
    },
    amendment: {
      uri: continuity.amendment.objectUri,
      generation: continuity.amendment.generation,
      raw: fixture('s33-b1-c56c-treasury-continuity-amendment.fixture.txt'),
      retainUntilTime: RETAIN_UNTIL,
    },
  };
}

function finalize(input: B1TreasuryContinuityCompositionInput): B1TreasuryContinuityCompositionInput {
  const composite = calculateB1TreasuryContinuityCompositeIdentity(input);
  const admission = JSON.parse(input.refreshedAdmissionRaw) as {
    treasury_continuity: { compositeIdentitySha256: string };
  };
  admission.treasury_continuity.compositeIdentitySha256 = composite;
  return { ...input, refreshedAdmissionRaw: JSON.stringify(admission) };
}

describe('B1 treasury-continuity composition', () => {
  it('accepts the exact locked original topology and signed -157 sat continuation', () => {
    const verified = verifyB1TreasuryContinuityComposition(finalize(makeInput()));
    expect(verified).toMatchObject({
      status: 'VERIFIED_B1_TREASURY_CONTINUITY',
      originalConfirmedTotalSats: 169_639,
      currentConfirmedTotalSats: 169_482,
      deltaSats: -157,
      controllerSourceHeadSha: SUCCESSOR_HEAD,
    });
    expect(verified.compositeIdentitySha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('rejects a missing continuity amendment', () => {
    const input = finalize(makeInput());
    expect(() => verifyB1TreasuryContinuityComposition({ ...input, amendment: undefined as never }))
      .toThrow(/amendment/i);
  });

  it('rejects tampered signed amendment bytes', () => {
    const input = finalize(makeInput());
    expect(() => verifyB1TreasuryContinuityComposition({
      ...input,
      amendment: { ...input.amendment, raw: input.amendment.raw.replace('169482', '169483') },
    })).toThrow(/amendment|signature|digest/i);
  });

  it('rejects a wrong original topology reference', () => {
    const input = finalize(makeInput());
    expect(() => verifyB1TreasuryContinuityComposition({
      ...input,
      originalTopology: { ...input.originalTopology, generation: '1784254616684050' },
    })).toThrow(/topology|generation/i);
  });

  it('rejects any delta other than the exact funded-probe fee', () => {
    const input = makeInput();
    const admission = JSON.parse(input.refreshedAdmissionRaw) as {
      treasury_continuity: { currentTreasury: { deltaSats: number } };
    };
    admission.treasury_continuity.currentTreasury.deltaSats = -156;
    const changed = { ...input, refreshedAdmissionRaw: JSON.stringify(admission) };
    expect(() => calculateB1TreasuryContinuityCompositeIdentity(changed)).toThrow(/delta|fee/i);
  });

  it('accepts only the exact committed controller snapshot', () => {
    const verified = verifyB1TreasuryContinuityComposition(finalize(makeInput()));
    expect(verifyB1TreasuryContinuityControllerSnapshot(verified, {
      sourceHeadSha: SUCCESSOR_HEAD,
      sourceTreeSha: SUCCESSOR_TREE,
      trackedWorktreeStatus: '',
      trackedPaths: [...B1_TREASURY_CONTINUITY_CONTROLLER_FILES],
      relevantFiles: CONTROLLER_FILES.map((file) => ({ ...file, matchesHeadBlob: true })),
    })).toEqual({
      status: 'VERIFIED_B1_TREASURY_CONTINUITY_CONTROLLER',
      sourceHeadSha: SUCCESSOR_HEAD,
      sourceTreeSha: SUCCESSOR_TREE,
      relevantFilesSha256: CONTROLLER_FILES_DIGEST,
    });
  });

  it('rejects dirty, byte-different, and forged controller snapshots', () => {
    const verified = verifyB1TreasuryContinuityComposition(finalize(makeInput()));
    const snapshot = {
      sourceHeadSha: SUCCESSOR_HEAD,
      sourceTreeSha: SUCCESSOR_TREE,
      trackedWorktreeStatus: '',
      trackedPaths: [...B1_TREASURY_CONTINUITY_CONTROLLER_FILES],
      relevantFiles: CONTROLLER_FILES.map((file) => ({ ...file, matchesHeadBlob: true })),
    };
    expect(() => verifyB1TreasuryContinuityControllerSnapshot(
      verified,
      { ...snapshot, trackedWorktreeStatus: ' M scripts/staging/s33-b1-start-approval.ts' },
    )).toThrow(/worktree|controller/i);
    expect(() => verifyB1TreasuryContinuityControllerSnapshot(verified, {
      ...snapshot,
      relevantFiles: snapshot.relevantFiles.map((file, index) => index === 0
        ? { ...file, raw: Buffer.from('tampered') }
        : file),
    })).toThrow(/byte digest/i);
    expect(() => verifyB1TreasuryContinuityControllerSnapshot(
      { ...verified },
      snapshot,
    )).toThrow(/opaque verified/i);
  });
});
