import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createContractsRouter, type ContractAnchorStore } from './contract-anchor-workflow.js';

const PRE_FINGERPRINT = '1'.repeat(64);
const SIGNED_FINGERPRINT = '2'.repeat(64);

function testApp(store: ContractAnchorStore) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.apiKey = {
      keyId: 'key-1',
      orgId: 'org-1',
      userId: 'user-1',
      scopes: ['write:anchors'],
      rateLimitTier: 'paid',
      keyPrefix: 'ak_test',
    };
    next();
  });
  app.use('/api/v1/contracts', createContractsRouter({ store }));
  return app;
}

function fakeStore(): ContractAnchorStore {
  let count = 0;
  return {
    async submitFingerprintAnchor(input) {
      count += 1;
      return {
        anchorId: `ARK-2026-CONTRACT-${count}`,
        txId: null,
        timestamp: '2026-04-24T20:00:00.000Z',
        fingerprint: input.fingerprint,
      };
    },
  };
}

const extractionSnapshot = {
  generatedAt: '2026-04-24T19:59:00.000Z',
  modelVersion: 'arkova-gemini-contracts-expert-v1-candidate',
  documentFingerprint: PRE_FINGERPRINT,
  terms: {
    governingLaw: 'Michigan',
    autoRenewal: 'false',
    terminationNoticeDays: '30',
    signerSignatureBlock: 'ignored',
  },
};

describe('contracts anchor API', () => {
  it('creates a pre-signing anchor from a client-side fingerprint and extraction snapshot', async () => {
    const res = await request(testApp(fakeStore()))
      .post('/api/v1/contracts/anchor-pre-signing')
      .send({ documentFingerprint: PRE_FINGERPRINT, extractionSnapshot })
      .expect(201);

    expect(res.body).toEqual({
      anchor_id: 'ARK-2026-CONTRACT-1',
      tx_id: null,
      timestamp: '2026-04-24T20:00:00.000Z',
      extraction_snapshot: extractionSnapshot,
    });
  });

  it('rejects raw PDF bytes to preserve Arkova client-side document processing', async () => {
    const res = await request(testApp(fakeStore()))
      .post('/api/v1/contracts/anchor-pre-signing')
      .send({ pdfBase64: Buffer.from('%PDF-1.7').toString('base64'), extractionSnapshot })
      .expect(400);

    expect(res.body.error).toBe('privacy_boundary_violation');
  });

  it('creates the post-signing anchor and reports hash, term, and e-sign audit checks', async () => {
    const app = testApp(fakeStore());
    const auditTrail = `DocuSign Certificate Of Completion
Envelope ID: DS-ENV-100
Document SHA-256: ${SIGNED_FINGERPRINT}
Signer: role=Buyer; name=Jane Buyer; email=jane@example.test; signedAt=2026-04-24T14:00:00Z; auth=email
Completed: 2026-04-24T14:02:00Z`;

    const res = await request(app)
      .post('/api/v1/contracts/anchor-post-signing')
      .send({
        provider: 'docusign',
        signedDocumentFingerprint: SIGNED_FINGERPRINT,
        auditTrail,
        preSigningAnchor: {
          anchor_id: 'ARK-2026-CONTRACT-PRE',
          documentFingerprint: PRE_FINGERPRINT,
          extraction_snapshot: extractionSnapshot,
        },
        postSigningExtractionSnapshot: {
          ...extractionSnapshot,
          documentFingerprint: SIGNED_FINGERPRINT,
          terms: {
            governingLaw: 'Michigan',
            autoRenewal: 'false',
            terminationNoticeDays: '30',
            signerSignatureBlock: 'Jane Buyer',
          },
        },
      })
      .expect(201);

    expect(res.body.second_anchor_id).toBe('ARK-2026-CONTRACT-1');
    expect(res.body.validation_report.prePostHashDiffer).toBe(true);
    expect(res.body.validation_report.termsMatch).toBe(true);
    expect(res.body.validation_report.auditTrailValid).toBe(true);
    expect(res.body.validation_report.auditTrail.tampered).toBe(false);
  });
});
