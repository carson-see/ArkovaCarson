/**
 * Barrel export surface tests (P5).
 *
 * `OrganizationDetails`, `RecordDetails`, `FingerprintDetails`, and
 * `DocumentDetails` are defined in `types.ts` and returned by
 * `Arkova#getOrganization` / `getRecord` / `getFingerprint` / `getDocument`
 * (client.ts), but were never re-exported from the package barrel — a
 * consumer could call the methods but not name the return types without
 * reaching into `arkova/dist/types` directly. This test pins the fix as a
 * type-level import: it fails to compile (and therefore fails `tsc
 * --noEmit`) if any of the four types are missing from `./index`.
 */

import { describe, it, expect } from 'vitest';
import type {
  OrganizationDetails,
  RecordDetails,
  FingerprintDetails,
  DocumentDetails,
} from './index';

describe('package barrel export surface', () => {
  it('exports OrganizationDetails, RecordDetails, FingerprintDetails, and DocumentDetails', () => {
    // Type-only import above is the real assertion (compiles only if the
    // barrel exports all four). This runtime check just gives the suite a
    // test to run.
    const org: OrganizationDetails = {
      publicId: 'org_1',
      displayName: 'Acme',
      domain: null,
      websiteUrl: null,
      verificationStatus: null,
      description: null,
      industryTag: null,
      orgType: null,
      location: null,
      logoUrl: null,
    };
    const record: RecordDetails = {
      publicId: null,
      verified: true,
      status: 'ACTIVE',
      fingerprint: null,
      title: null,
      description: null,
      issuerName: null,
      credentialType: null,
      subType: null,
      issuedDate: null,
      expiryDate: null,
      anchorTimestamp: null,
      networkReceiptId: null,
      recordUri: null,
    };
    const fingerprint: FingerprintDetails = { ...record, fingerprint: 'a'.repeat(64) };
    const document: DocumentDetails = record;

    expect(org.publicId).toBe('org_1');
    expect(record.status).toBe('ACTIVE');
    expect(fingerprint.fingerprint).toBe('a'.repeat(64));
    expect(document.status).toBe('ACTIVE');
  });
});
