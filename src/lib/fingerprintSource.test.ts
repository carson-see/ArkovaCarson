/**
 * Fingerprint Source Utilities Tests (R19, CTO ruling 2026-07-28, advances SCRUM-2481)
 */

import { describe, it, expect } from 'vitest';
import {
  parseFingerprintSource,
  getFingerprintSourceLabel,
  getFingerprintSourceDescription,
  getFingerprintSourceTriad,
  isRecordDerived,
  isDocumentDerived,
  FINGERPRINT_SOURCE_VALUES,
} from './fingerprintSource';

describe('parseFingerprintSource', () => {
  it('parses both known values', () => {
    expect(parseFingerprintSource('document_bytes')).toBe('document_bytes');
    expect(parseFingerprintSource('issuer_record_attestation')).toBe('issuer_record_attestation');
  });

  it('returns null for unknown/null/undefined values — never guessed (§1.5)', () => {
    expect(parseFingerprintSource(null)).toBeNull();
    expect(parseFingerprintSource(undefined)).toBeNull();
    expect(parseFingerprintSource('')).toBeNull();
    expect(parseFingerprintSource('bogus')).toBeNull();
    expect(parseFingerprintSource('issuer_anchored')).toBeNull(); // EvidenceLevel tier, not FingerprintSource
  });

  it('exposes exactly the two evidence classes', () => {
    expect(FINGERPRINT_SOURCE_VALUES).toEqual(['document_bytes', 'issuer_record_attestation']);
  });
});

describe('getFingerprintSourceLabel / getFingerprintSourceDescription', () => {
  it('returns a label + description for both tiers', () => {
    expect(getFingerprintSourceLabel('document_bytes')).toBeTruthy();
    expect(getFingerprintSourceLabel('issuer_record_attestation')).toBeTruthy();
    expect(getFingerprintSourceDescription('document_bytes')).toBeTruthy();
    expect(getFingerprintSourceDescription('issuer_record_attestation')).toBeTruthy();
  });

  it('returns null for unclassified anchors', () => {
    expect(getFingerprintSourceLabel(null)).toBeNull();
    expect(getFingerprintSourceDescription(undefined)).toBeNull();
  });

  // R-7 claims gate: issuer_record_attestation must never claim or imply
  // Arkova received/reviewed a document.
  it('issuer_record_attestation description does not claim document receipt', () => {
    const description = getFingerprintSourceDescription('issuer_record_attestation') ?? '';
    expect(description.toLowerCase()).toContain('no source document was supplied');
  });
});

describe('getFingerprintSourceTriad — §1.5 measured/asserted/NOT-asserted', () => {
  it('document_bytes triad asserts document existence, not real-world facts', () => {
    const triad = getFingerprintSourceTriad('document_bytes');
    expect(triad).toBeTruthy();
    expect(triad?.measured).toBeTruthy();
    expect(triad?.asserted).toBeTruthy();
    expect(triad?.notAsserted).toBeTruthy();
  });

  it('issuer_record_attestation triad explicitly states NO document was asserted', () => {
    const triad = getFingerprintSourceTriad('issuer_record_attestation');
    expect(triad).toBeTruthy();
    // The core honesty guarantee: this tier must never assert document
    // existence — it must be listed under notAsserted.
    expect(triad?.notAsserted.toLowerCase()).toContain('document');
    expect(triad?.asserted.toLowerCase()).toContain('no source document');
  });

  it('returns null for unclassified', () => {
    expect(getFingerprintSourceTriad(null)).toBeNull();
  });
});

describe('isRecordDerived / isDocumentDerived', () => {
  it('correctly discriminates the two tiers', () => {
    expect(isRecordDerived('issuer_record_attestation')).toBe(true);
    expect(isRecordDerived('document_bytes')).toBe(false);
    expect(isDocumentDerived('document_bytes')).toBe(true);
    expect(isDocumentDerived('issuer_record_attestation')).toBe(false);
  });

  it('both are false for unclassified', () => {
    expect(isRecordDerived(null)).toBe(false);
    expect(isDocumentDerived(null)).toBe(false);
  });
});
