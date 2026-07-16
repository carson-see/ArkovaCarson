import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicaliseJson } from '../../utils/canonical-json.js';

const RECEIPT_PATH = resolve(
  __dirname,
  '../../../../../docs/lane3/evidence/s33-public-authority-genesis-receipt.json',
);
const ROSTER_ROOT = 'sha256:bb4d0bb56523b6cdb9701cf786d7f2828a571bd6c7fc32a247d93a2041efc51f';
const ACTIVATED_AT_UTC = '2026-07-16T13:52:06Z';
const OPERATOR = 'arkova.s33.operator.key-custodian.v1';
const APPROVER = 'arkova.s33.approver.founder-cto.v1';
const FOUNDER_COMMAND_RECEIPT =
  'codex-thread:019f65ca-fdfc-7652-bd86-7be6c7463d34:founder-provision-and-soak-command';

interface GenesisKey {
  keyId: string;
  publicKeyFingerprintSha256: string;
  publicKeySpkiPem: string;
  purpose: string;
  secretVersionResource: string;
}

interface GenesisRoster {
  activatedAtUtc: string;
  artifactType: string;
  authorityReceipt: string;
  genesisException: {
    laterChangesRequireSeparateOperatorAndApprover: boolean;
    oneTime: boolean;
    scope: string;
  };
  identities: { approver: string; operator: string; verifier: string };
  keys: GenesisKey[];
  schemaVersion: number;
}

interface ReceiptSignature {
  keyId: string;
  purpose: string;
  signatureBase64: string;
}

interface GenesisReceipt {
  artifactType: string;
  schemaVersion: number;
  selfPinned: boolean;
  bindingContext: {
    evidenceCommitPolicy: string;
    founderCommandReceipt: string;
    genesisRosterCanonicalization: string;
    genesisRosterRootSha256: string;
  };
  pins: {
    genesisRoster: GenesisRoster;
    signatures: ReceiptSignature[];
  };
  report: {
    bootstrapOnly: boolean;
    laterChangesRequireSeparateOperatorAndApprover: boolean;
    liveExecutionAuthorized: boolean;
    oneTimeGenesisException: boolean;
    privateKeyMaterialPresent: boolean;
    publicMaterialOnly: boolean;
    secretValuesPresent: boolean;
    spendAuthorized: boolean;
  };
}

function readReceipt(): { raw: string; value: GenesisReceipt } {
  const raw = readFileSync(RECEIPT_PATH, 'utf8');
  return { raw, value: JSON.parse(raw) as GenesisReceipt };
}

describe('S3.3 public authority genesis receipt', () => {
  it('binds the exact founder/CTO bootstrap roster and public-only limitations', () => {
    const { raw, value } = readReceipt();
    expect(Object.keys(value).sort()).toEqual([
      'artifactType', 'bindingContext', 'pins', 'report', 'schemaVersion', 'selfPinned',
    ]);
    expect(value).toMatchObject({
      artifactType: 'arkova-s33-public-authority-genesis-receipt',
      schemaVersion: 1,
      selfPinned: false,
      bindingContext: {
        founderCommandReceipt: FOUNDER_COMMAND_RECEIPT,
        genesisRosterCanonicalization: 'UTF-8 sorted-key compact JSON with one terminal LF',
        genesisRosterRootSha256: ROSTER_ROOT,
      },
      report: {
        bootstrapOnly: true,
        laterChangesRequireSeparateOperatorAndApprover: true,
        liveExecutionAuthorized: false,
        oneTimeGenesisException: true,
        privateKeyMaterialPresent: false,
        publicMaterialOnly: true,
        secretValuesPresent: false,
        spendAuthorized: false,
      },
    });
    expect(value.pins.genesisRoster).toMatchObject({
      activatedAtUtc: ACTIVATED_AT_UTC,
      artifactType: 'arkova-s33-authority-genesis-roster',
      authorityReceipt: FOUNDER_COMMAND_RECEIPT,
      genesisException: {
        laterChangesRequireSeparateOperatorAndApprover: true,
        oneTime: true,
        scope: 'INITIAL_S33_PUBLIC_AUTHORITY_BOOTSTRAP',
      },
      identities: {
        approver: APPROVER,
        operator: OPERATOR,
        verifier: 'arkova.s33.verifier.public-ed25519.v1',
      },
      schemaVersion: 1,
    });
    expect(raw).not.toMatch(/-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/u);
    expect(raw).not.toContain('"secretValue"');
    expect(raw).not.toContain('"privateKey"');
  });

  it('recomputes the canonical roster root and verifies all three Ed25519 signatures', () => {
    const { value } = readReceipt();
    const canonicalRoster = `${canonicaliseJson(value.pins.genesisRoster)}\n`;
    expect(`sha256:${createHash('sha256').update(canonicalRoster).digest('hex')}`).toBe(ROSTER_ROOT);

    const expectedKeys = [
      {
        keyId: 'arkova.s33.release-corpus.ed25519.v1',
        purpose: 'RELEASE_CORPUS',
        fingerprint: 'b5f6445ae954ac1f29b504fdc890dedefda23beb6300f35d99cd2c9d2eeb9e59',
        secretVersionResource:
          'projects/270018525501/secrets/arkova-s33-release-corpus-ed25519-pkcs8-v1/versions/2',
      },
      {
        keyId: 'arkova.s33.b1-evidence.ed25519.v1',
        purpose: 'B1_EVIDENCE',
        fingerprint: '8b7fbc51c74828dab2e1a3ca6f0c15069575bae8e4e190eaf3b165daea50d5c6',
        secretVersionResource:
          'projects/270018525501/secrets/arkova-s33-b1-evidence-ed25519-pkcs8-v1/versions/1',
      },
      {
        keyId: 'arkova.s33.g1-spend.ed25519.v1',
        purpose: 'G1_SPEND',
        fingerprint: '6ece5cea2d35423aab35a23f6292fd769c6d839ac03ba7860a973d4febd5d987',
        secretVersionResource:
          'projects/270018525501/secrets/arkova-s33-g1-spend-ed25519-pkcs8-v1/versions/1',
      },
    ];
    expect(value.pins.genesisRoster.keys).toHaveLength(3);
    expect(value.pins.signatures).toHaveLength(3);

    for (const expected of expectedKeys) {
      const key = value.pins.genesisRoster.keys.find(({ keyId }) => keyId === expected.keyId);
      const signature = value.pins.signatures.find(({ keyId }) => keyId === expected.keyId);
      expect(key).toMatchObject({
        keyId: expected.keyId,
        purpose: expected.purpose,
        publicKeyFingerprintSha256: expected.fingerprint,
        secretVersionResource: expected.secretVersionResource,
      });
      expect(signature).toMatchObject({ keyId: expected.keyId, purpose: expected.purpose });
      if (!key || !signature) throw new Error(`Missing genesis authority material for ${expected.keyId}`);
      const publicKey = createPublicKey(key.publicKeySpkiPem);
      expect(publicKey.asymmetricKeyType).toBe('ed25519');
      expect(createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex')).toBe(expected.fingerprint);
      expect(verifyEd25519(
        null,
        Buffer.from(canonicalRoster),
        publicKey,
        Buffer.from(signature.signatureBase64, 'base64'),
      )).toBe(true);
    }
  });
});
