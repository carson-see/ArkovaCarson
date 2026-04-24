import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { buildContractProofPackageZip } from './contract-proof-package.js';

describe('buildContractProofPackageZip', () => {
  it('bundles anchors, audit trail, validation report, and privacy-boundary README without document bytes', () => {
    const zipBuffer = buildContractProofPackageZip({
      preSigningAnchor: { anchor_id: 'ARK-2026-PRE', tx_id: null, timestamp: '2026-04-24T20:00:00Z' },
      postSigningAnchor: { anchor_id: 'ARK-2026-POST', tx_id: null, timestamp: '2026-04-24T21:00:00Z' },
      auditTrail: { provider: 'docusign', envelopeId: 'DS-ENV-100' },
      validationReport: { prePostHashDiffer: true, termsMatch: true, auditTrailValid: true },
      originalDocumentFingerprint: '1'.repeat(64),
      signedDocumentFingerprint: '2'.repeat(64),
    });

    const zip = new AdmZip(zipBuffer);
    const entryNames = zip.getEntries().map((entry) => entry.entryName).sort();

    expect(entryNames).toEqual([
      'README.txt',
      'anchors.json',
      'audit-trail.json',
      'document-fingerprints.json',
      'validation-report.json',
    ]);
    expect(entryNames.some((name) => name.endsWith('.pdf'))).toBe(false);
    expect(zip.readAsText('README.txt')).toContain('Documents never leave the user device');
  });
});
