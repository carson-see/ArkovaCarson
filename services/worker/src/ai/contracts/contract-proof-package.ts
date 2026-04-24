import AdmZip from 'adm-zip';

export interface ContractProofPackageInput {
  preSigningAnchor: Record<string, unknown>;
  postSigningAnchor: Record<string, unknown>;
  auditTrail: Record<string, unknown>;
  validationReport: Record<string, unknown>;
  originalDocumentFingerprint: string;
  signedDocumentFingerprint: string;
}

export function buildContractProofPackageZip(input: ContractProofPackageInput): Buffer {
  const zip = new AdmZip();
  const generatedAt = new Date().toISOString();

  zip.addFile('README.txt', Buffer.from([
    'Arkova contract proof package',
    '',
    'Documents never leave the user device. This package intentionally contains',
    'fingerprints, Bitcoin anchor receipts, the e-signature audit trail metadata,',
    'and the validation report. Attach the original and signed PDFs from the',
    'customer document system of record when producing a legal exhibit.',
    '',
    `Generated at: ${generatedAt}`,
    '',
  ].join('\n')));

  zip.addFile('document-fingerprints.json', jsonBuffer({
    generated_at: generatedAt,
    original_document_fingerprint: input.originalDocumentFingerprint,
    signed_document_fingerprint: input.signedDocumentFingerprint,
  }));
  zip.addFile('anchors.json', jsonBuffer({
    generated_at: generatedAt,
    pre_signing_anchor: input.preSigningAnchor,
    post_signing_anchor: input.postSigningAnchor,
  }));
  zip.addFile('audit-trail.json', jsonBuffer(input.auditTrail));
  zip.addFile('validation-report.json', jsonBuffer(input.validationReport));

  return zip.toBuffer();
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
