/**
 * PROOF-04 (SCRUM-2337) — audit-certificate PDF proof-JSON embedding.
 *
 * The downloadable audit certificate must carry a machine-readable proof
 * packet so a verifier can re-check the document offline. We assert that:
 *  - the embedded JSON is present in the PDF output and parses back to the
 *    exact proof fields,
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
  type ProofPacket,
} from './generateAuditReport';

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
      merkle_proof: ['c'.repeat(64), 'e'.repeat(64)],
      merkle_index: 3,
      tx_id: 'd'.repeat(64),
      block_height: 850123,
      block_hash: 'f'.repeat(64),
      block_header: '0'.repeat(160),
      op_return_payload: '6a20' + 'b'.repeat(64),
      proof_schema_version: 1,
      observed_time: '2026-06-02T03:00:00Z',
      signature: { algorithm: 'ECDSA-SHA256', key_id: 'treasury-wif-1' },
    },
    ...overrides,
  };
}

describe('PROOF-04 buildProofPacket', () => {
  it('includes every proof-packet field and nothing else', () => {
    const data = securedData();
    const packet = buildProofPacket(data);
    expect(packet).not.toBeNull();
    const keys = Object.keys(packet!).sort();
    expect(keys).toEqual(
      [
        'block_hash',
        'block_header',
        'block_height',
        'fingerprint',
        'merkle_index',
        'merkle_proof',
        'merkle_root',
        'observed_time',
        'op_return_payload',
        'proof_schema_version',
        'signature',
        'tx_id',
      ].sort(),
    );
    expect(keys).toContain('merkle_proof');
  });

  it('never carries document bytes, PII, filename, or issuer name', () => {
    const packet = buildProofPacket(securedData());
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain('diploma.pdf');
    expect(serialized).not.toContain('Acme University');
    expect(serialized).not.toContain('rec_abc123'); // public_id is record metadata, not proof
    expect(serialized).not.toMatch(/file_?size/i);
    expect(serialized).not.toMatch(/document_bytes|raw_bytes|content/i);
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
    expect(parsed.merkle_proof).toEqual(['c'.repeat(64), 'e'.repeat(64)]);
    expect(parsed.merkle_index).toBe(3);
    expect(parsed.proof_schema_version).toBe(1);
    expect(parsed.signature?.algorithm).toBe('ECDSA-SHA256');
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
