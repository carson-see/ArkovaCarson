import { describe, expect, it } from 'vitest';
import {
  parseESignatureAuditTrail,
  validateProviderCertificateChain,
  verifyAdobeSignWebhookSignature,
  verifyDocuSignConnectSignature,
  type ESignatureProvider,
} from './e-signature-providers.js';

const SIGNED_FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);
const TRUSTED_ROOT = 'c'.repeat(64);

const samples: Array<{ provider: ESignatureProvider; text: string; envelopeId: string }> = [
  {
    provider: 'docusign',
    envelopeId: 'DS-ENV-100',
    text: `DocuSign Certificate Of Completion
Envelope ID: DS-ENV-100
Document SHA-256: ${SIGNED_FINGERPRINT}
Signer: role=Buyer; name=Jane Buyer; email=jane@example.test; signedAt=2026-04-24T14:00:00Z; ip=203.0.113.10; auth=email; location=Detroit, MI; consent=2026-04-24T13:55:00Z
Completed: 2026-04-24T14:02:00Z`,
  },
  {
    provider: 'adobe_sign',
    envelopeId: 'ADOBE-AGR-200',
    text: `Adobe Acrobat Sign Audit Report
Agreement ID: ADOBE-AGR-200
SHA-256 Digest: ${SIGNED_FINGERPRINT}
Participant: role=Counterparty; name=Alex Counter; email=alex@example.test; signedAt=2026-04-24T15:00:00Z; ip=203.0.113.20; auth=adobe-password
Completed At: 2026-04-24T15:01:00Z`,
  },
  {
    provider: 'dropbox_sign',
    envelopeId: 'DBX-SR-300',
    text: `Dropbox Sign / HelloSign Audit Trail
Signature Request ID: DBX-SR-300
PDF Hash: ${SIGNED_FINGERPRINT}
Signer: role=Legal; name=Lee Legal; email=lee@example.test; signedAt=2026-04-24T16:00:00Z; ip=203.0.113.30; auth=access-code
Completed: 2026-04-24T16:05:00Z`,
  },
  {
    provider: 'signnow',
    envelopeId: 'SN-DOC-400',
    text: `SignNow Document History
Document ID: SN-DOC-400
Document Hash: ${SIGNED_FINGERPRINT}
Signer: role=Owner; name=Owen Owner; email=owen@example.test; signedAt=2026-04-24T17:00:00Z; auth=sms
Completed: 2026-04-24T17:03:00Z`,
  },
  {
    provider: 'pandadoc',
    envelopeId: 'PD-DOC-500',
    text: `PandaDoc Audit Trail
Document ID: PD-DOC-500
Document SHA256: ${SIGNED_FINGERPRINT}
Recipient: role=Approver; name=Pat Approver; email=pat@example.test; signedAt=2026-04-24T18:00:00Z; ip=203.0.113.50; auth=email-link
Completed: 2026-04-24T18:04:00Z`,
  },
  {
    provider: 'notarize',
    envelopeId: 'PROOF-TXN-600',
    text: `Proof / Notarize Transaction-Level Audit Trail
Transaction ID: PROOF-TXN-600
Tamper-Sealed Document Hash: ${SIGNED_FINGERPRINT}
Signer: role=Principal; name=Nia Principal; email=nia@example.test; signedAt=2026-04-24T19:00:00Z; auth=knowledge-based-authentication; location=Ann Arbor, MI
Completed: 2026-04-24T19:10:00Z`,
  },
];

describe('parseESignatureAuditTrail', () => {
  it.each(samples)('normalizes %s audit trails into the unified schema', ({ provider, text, envelopeId }) => {
    const audit = parseESignatureAuditTrail(provider, text, {
      signedDocumentFingerprint: SIGNED_FINGERPRINT,
    });

    expect(audit.provider).toBe(provider);
    expect(audit.envelopeId).toBe(envelopeId);
    expect(audit.documentHash).toBe(SIGNED_FINGERPRINT);
    expect(audit.rawAuditPdfHash).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.signers).toHaveLength(1);
    expect(audit.signers[0].email).toContain('@example.test');
    expect(audit.signers[0].signedAt).toMatch(/^2026-04-24T/);
    expect(audit.completionDate).toMatch(/^2026-04-24T/);
    expect(audit.tampered).toBe(false);
  });

  it('flags tampering when the signed document fingerprint differs from the audit trail hash', () => {
    const audit = parseESignatureAuditTrail('docusign', samples[0].text, {
      signedDocumentFingerprint: OTHER_FINGERPRINT,
    });

    expect(audit.tampered).toBe(true);
    expect(audit.warnings).toContain('signed_document_hash_mismatch');
  });
});

describe('provider webhook verification', () => {
  it('verifies DocuSign Connect HMAC signatures over the exact raw body bytes', () => {
    const rawBody = Buffer.from('{"event":"envelope-completed","data":{"envelopeId":"DS-ENV-100"}}');
    const secret = 'docusign-connect-secret';
    const signature = '+TGjbJ8na9NAXrXcsA/7GKHHP103k6MkUWdO99ACGug=';

    expect(verifyDocuSignConnectSignature(rawBody, signature, secret)).toBe(true);
    expect(verifyDocuSignConnectSignature(Buffer.from(`${rawBody.toString()} `), signature, secret)).toBe(false);
  });

  it('verifies Adobe Acrobat Sign webhook intent with the registered client id', () => {
    expect(verifyAdobeSignWebhookSignature({
      rawBody: Buffer.from('{"event":"AGREEMENT_ACTION_COMPLETED"}'),
      headers: { 'x-adobesign-clientid': 'client-123' },
      expectedClientId: 'client-123',
    })).toBe(true);

    expect(verifyAdobeSignWebhookSignature({
      rawBody: Buffer.from('{"event":"AGREEMENT_ACTION_COMPLETED"}'),
      headers: { 'x-adobesign-clientid': 'other-client' },
      expectedClientId: 'client-123',
    })).toBe(false);
  });
});

describe('validateProviderCertificateChain', () => {
  it('accepts a trusted DocuSign root chain during its validity window', () => {
    const result = validateProviderCertificateChain('docusign', [
      {
        subject: 'CN=DocuSign Leaf',
        issuer: 'CN=DocuSign Root',
        sha256Fingerprint: 'd'.repeat(64),
        notBefore: '2026-01-01T00:00:00Z',
        notAfter: '2027-01-01T00:00:00Z',
      },
      {
        subject: 'CN=DocuSign Root',
        issuer: 'CN=DocuSign Root',
        sha256Fingerprint: TRUSTED_ROOT,
        notBefore: '2025-01-01T00:00:00Z',
        notAfter: '2030-01-01T00:00:00Z',
      },
    ], {
      trustedRootFingerprints: { docusign: [TRUSTED_ROOT] },
      validationTime: new Date('2026-04-24T00:00:00Z'),
    });

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('rejects untrusted Adobe roots', () => {
    const result = validateProviderCertificateChain('adobe_sign', [
      {
        subject: 'CN=Adobe Acrobat Sign Root',
        issuer: 'CN=Adobe Acrobat Sign Root',
        sha256Fingerprint: 'e'.repeat(64),
        notBefore: '2025-01-01T00:00:00Z',
        notAfter: '2030-01-01T00:00:00Z',
      },
    ], {
      trustedRootFingerprints: { adobe_sign: [TRUSTED_ROOT] },
      validationTime: new Date('2026-04-24T00:00:00Z'),
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('untrusted_root');
  });
});
