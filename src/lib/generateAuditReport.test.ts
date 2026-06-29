/**
 * PROOF-04 (SCRUM-2337) — audit-certificate PDF proof-JSON embedding.
 *
 * The downloadable audit certificate must carry a machine-readable proof
 * packet so a verifier can re-check the document offline. The embedded packet
 * is the CANONICAL `proof_bundle` shape (PROOF-05 / SCRUM-2338 emits it, the
 * PROOF-07 reference CLI parses it) — they must match field-for-field. We
 * assert that:
 *  - the embedded JSON is present in the PDF output and parses back to the
 *    exact proof_bundle fields,
 *  - `merkle_proof` is the structured `{ hash, position }[]` branch (NOT a
 *    flattened string[]), so the offline verifier can recompute the root,
 *  - the machine field is `block_timestamp` (not `observed_time`),
 *  - `proof_schema_version` is a non-null number (default 1),
 *  - `merkle_index` and `leaf_count` are present,
 *  - only proof-packet fields (never document bytes / PII) are embedded,
 *  - the human-readable proof fields + the offline-verify instructions render,
 *  - the generator stays pure / client-side (returns a jsPDF instance for
 *    inspection, no DOM, no network).
 */
import { describe, expect, it } from 'vitest';
import {
  buildAuditReport,
  buildProofPacket,
  type AuditReportData,
  type MerkleProofEntry,
  type ProofPacket,
} from './generateAuditReport';

const BRANCH: MerkleProofEntry[] = [
  { hash: 'c'.repeat(64), position: 'left' },
  { hash: 'e'.repeat(64), position: 'right' },
];

function securedData(overrides: Partial<AuditReportData> = {}): AuditReportData {
  return {
    publicId: 'rec_abc123',
    filename: 'diploma.pdf',
    fingerprint: 'a'.repeat(64),
    status: 'SECURED',
    fileSize: 12345,
    credentialType: 'DIPLOMA',
    issuerName: 'Acme University',
    createdAt: '2026-06-01T10:00:00Z',
    issuedAt: '2026-06-01T10:00:00Z',
    securedAt: '2026-06-02T03:00:00Z',
    networkReceipt: 'd'.repeat(64),
    blockHeight: 850123,
    proof: {
      fingerprint: 'a'.repeat(64),
      merkle_root: 'b'.repeat(64),
      merkle_proof: BRANCH,
      merkle_index: 3,
      leaf_count: 8,
      tx_id: 'd'.repeat(64),
      block_height: 850123,
      block_hash: 'f'.repeat(64),
      block_header: '0'.repeat(160),
      op_return_payload: '6a20' + 'b'.repeat(64),
      proof_schema_version: 1,
      block_timestamp: '2026-06-02T03:00:00Z',
      signature: { alg: 'Ed25519', signing_key_id: 'treasury-ed25519-1' },
    },
    ...overrides,
  };
}

describe('PROOF-04 buildProofPacket — canonical proof_bundle shape', () => {
  it('emits exactly the canonical proof_bundle field set (matches PROOF-05 / CLI)', () => {
    const data = securedData();
    const packet = buildProofPacket(data);
    expect(packet).not.toBeNull();
    const keys = Object.keys(packet!).sort();
    expect(keys).toEqual(
      [
        'block_hash',
        'block_header',
        'block_height',
        'block_timestamp',
        'fingerprint',
        'leaf_count',
        'merkle_index',
        'merkle_proof',
        'merkle_root',
        'op_return_payload',
        'proof_schema_version',
        'signature',
        'tx_id',
      ].sort(),
    );
    // No legacy observed_time field on the machine packet.
    expect(keys).not.toContain('observed_time');
  });

  it('preserves the structured { hash, position } Merkle branch (never flattens to strings)', () => {
    const packet = buildProofPacket(securedData());
    expect(Array.isArray(packet!.merkle_proof)).toBe(true);
    expect(packet!.merkle_proof).toEqual(BRANCH);
    for (const entry of packet!.merkle_proof!) {
      expect(typeof entry.hash).toBe('string');
      expect(entry.position === 'left' || entry.position === 'right').toBe(true);
    }
  });

  it('maps block_timestamp (renamed from observed_time)', () => {
    const packet = buildProofPacket(securedData());
    expect(packet!.block_timestamp).toBe('2026-06-02T03:00:00Z');
  });

  it('defaults proof_schema_version to a non-null 1 when absent', () => {
    const data = securedData();
    data.proof!.proof_schema_version = null;
    const packet = buildProofPacket(data);
    expect(packet!.proof_schema_version).toBe(1);
    expect(packet!.proof_schema_version).not.toBeNull();
  });

  it('carries merkle_index and leaf_count', () => {
    const packet = buildProofPacket(securedData());
    expect(packet!.merkle_index).toBe(3);
    expect(packet!.leaf_count).toBe(8);
  });

  it('signature is null when no signer metadata is present', () => {
    const data = securedData();
    delete data.proof!.signature;
    const packet = buildProofPacket(data);
    expect(packet!.signature).toBeNull();
  });

  it('never carries document bytes, PII, filename, or issuer name', () => {
    const packet = buildProofPacket(securedData());
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain('diploma.pdf');
    expect(serialized).not.toContain('Acme University');
    expect(serialized).not.toContain('rec_abc123'); // public_id is record metadata, not proof
    expect(serialized).not.toMatch(/file_?size/i);
    expect(serialized).not.toMatch(/document_bytes|raw_bytes|content/i);
    expect(serialized).not.toMatch(/\bfilename\b|\bissuer/i);
  });

  it('returns null when the record is not SECURED', () => {
    expect(buildProofPacket(securedData({ status: 'PENDING' }))).toBeNull();
  });

  it('returns null when no proof data is present even if SECURED', () => {
    const { proof: _proof, ...rest } = securedData();
    expect(buildProofPacket(rest as AuditReportData)).toBeNull();
  });
});

describe('PROOF-04 buildAuditReport — embedded machine-readable JSON', () => {
  it('embeds the proof packet as parseable JSON and exposes it on the result', () => {
    const r = buildAuditReport(securedData());
    expect(r.embeddedProofJson).toBeTruthy();
    const parsed = JSON.parse(r.embeddedProofJson!) as ProofPacket;
    expect(parsed.merkle_root).toBe('b'.repeat(64));
    expect(parsed.merkle_proof).toEqual(BRANCH);
    expect(parsed.merkle_index).toBe(3);
    expect(parsed.leaf_count).toBe(8);
    expect(parsed.block_timestamp).toBe('2026-06-02T03:00:00Z');
    expect(parsed.proof_schema_version).toBe(1);
    expect(parsed.signature?.alg).toBe('Ed25519');
  });

  it('writes the JSON into the PDF document metadata stream', () => {
    const r = buildAuditReport(securedData());
    const output = r.doc.output();
    // The proof packet is embedded verbatim in PDF metadata so an offline
    // verifier can extract it. The merkle root is a distinctive marker.
    expect(output).toContain('b'.repeat(64));
  });

  it('renders human-readable proof fields and the offline-verify block', () => {
    const r = buildAuditReport(securedData());
    const output = r.doc.output();
    expect(output).toContain('Cryptographic Proof');
    expect(output).toContain('Verify This Certificate Offline');
    // reference verifier URL must be present
    expect(output).toMatch(/arkova\.(ai|io)\/verify/);
  });

  it('omits proof sections gracefully for a non-SECURED record', () => {
    const r = buildAuditReport(securedData({ status: 'PENDING', proof: undefined }));
    expect(r.embeddedProofJson).toBeNull();
    // Still produces a valid single-or-more page certificate.
    expect(r.doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('uses the §1.3-compliant status label from getStatusDisplay (never a raw enum)', () => {
    const output = buildAuditReport(securedData()).doc.output();
    expect(output).toContain('Verified'); // SECURED → "Verified"
    expect(output).not.toMatch(/Status:\s*SECURED/);
  });
});
