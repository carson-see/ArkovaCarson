import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  parseESignatureAuditTrail,
  type ESignatureAuditTrail,
  type ESignatureProvider,
} from './e-signature-providers.js';
import { buildContractProofPackageZip } from './contract-proof-package.js';

const fingerprintSchema = z.string().regex(/^[a-fA-F0-9]{64}$/).transform((value) => value.toLowerCase());
const extractionSnapshotSchema = z.object({
  generatedAt: z.string(),
  modelVersion: z.string().optional(),
  documentFingerprint: fingerprintSchema,
  terms: z.record(z.unknown()).default({}),
}).passthrough();

const preSigningSchema = z.object({
  documentFingerprint: fingerprintSchema.optional(),
  pdfFingerprint: fingerprintSchema.optional(),
  extractionSnapshot: extractionSnapshotSchema,
}).passthrough();

const postSigningSchema = z.object({
  provider: z.enum(['docusign', 'adobe_sign', 'dropbox_sign', 'signnow', 'pandadoc', 'notarize']),
  signedDocumentFingerprint: fingerprintSchema,
  auditTrail: z.union([z.string(), z.record(z.unknown())]),
  preSigningAnchor: z.object({
    anchor_id: z.string().min(1),
    documentFingerprint: fingerprintSchema,
    extraction_snapshot: extractionSnapshotSchema.optional(),
  }),
  postSigningExtractionSnapshot: extractionSnapshotSchema,
}).passthrough();

const proofPackageSchema = z.object({
  preSigningAnchor: z.record(z.unknown()),
  postSigningAnchor: z.record(z.unknown()),
  auditTrail: z.record(z.unknown()),
  validationReport: z.record(z.unknown()),
  originalDocumentFingerprint: fingerprintSchema,
  signedDocumentFingerprint: fingerprintSchema,
});

export interface FingerprintAnchorInput {
  fingerprint: string;
  phase: 'pre_signing' | 'post_signing';
  orgId: string | null;
  userId: string;
  description: string;
  metadata: Record<string, unknown>;
}

export interface FingerprintAnchorReceipt {
  anchorId: string;
  txId: string | null;
  timestamp: string;
  fingerprint: string;
}

export interface ContractAnchorStore {
  submitFingerprintAnchor(input: FingerprintAnchorInput): Promise<FingerprintAnchorReceipt>;
}

export interface CreateContractsRouterOptions {
  store?: ContractAnchorStore;
}

export interface ContractValidationReport {
  prePostHashDiffer: boolean;
  termsMatch: boolean;
  auditTrailValid: boolean;
  auditTrail: Pick<ESignatureAuditTrail, 'provider' | 'envelopeId' | 'documentHash' | 'certificateValid' | 'tampered' | 'rawAuditPdfHash' | 'warnings'>;
  comparedAt: string;
}

export function createContractsRouter(options: CreateContractsRouterOptions = {}) {
  const router = Router();
  const store = options.store ?? createDatabaseContractAnchorStore();

  router.post('/anchor-pre-signing', async (req: Request, res: Response) => {
    if (!req.apiKey) {
      res.status(401).json({ error: 'API key required. Include X-API-Key header.' });
      return;
    }
    if (containsRawDocumentPayload(req.body)) {
      res.status(400).json({
        error: 'privacy_boundary_violation',
        message: 'Submit a client-side SHA-256 fingerprint, not raw PDF bytes.',
      });
      return;
    }

    const parsed = preSigningSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
      return;
    }

    const fingerprint = parsed.data.documentFingerprint ?? parsed.data.pdfFingerprint;
    if (!fingerprint) {
      res.status(400).json({ error: 'invalid_request', message: 'documentFingerprint or pdfFingerprint is required.' });
      return;
    }

    try {
      const receipt = await store.submitFingerprintAnchor({
        fingerprint,
        phase: 'pre_signing',
        orgId: req.apiKey.orgId ?? null,
        userId: req.apiKey.userId,
        description: 'Contract pre-signing anchor',
        metadata: {
          contract_phase: 'pre_signing',
          extraction_snapshot: parsed.data.extractionSnapshot,
        },
      });

      res.status(201).json({
        anchor_id: receipt.anchorId,
        tx_id: receipt.txId,
        timestamp: receipt.timestamp,
        extraction_snapshot: parsed.data.extractionSnapshot,
      });
    } catch (error) {
      void logContractError({ error }, 'Contract pre-signing anchor failed');
      res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/anchor-post-signing', async (req: Request, res: Response) => {
    if (!req.apiKey) {
      res.status(401).json({ error: 'API key required. Include X-API-Key header.' });
      return;
    }
    if (containsRawDocumentPayload(req.body)) {
      res.status(400).json({
        error: 'privacy_boundary_violation',
        message: 'Submit a client-side SHA-256 fingerprint, not raw PDF bytes.',
      });
      return;
    }

    const parsed = postSigningSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
      return;
    }

    try {
      const auditTrail = parseESignatureAuditTrail(
        parsed.data.provider as ESignatureProvider,
        parsed.data.auditTrail,
        { signedDocumentFingerprint: parsed.data.signedDocumentFingerprint },
      );
      const validationReport = buildValidationReport({
        provider: parsed.data.provider,
        auditTrail,
        preDocumentFingerprint: parsed.data.preSigningAnchor.documentFingerprint,
        signedDocumentFingerprint: parsed.data.signedDocumentFingerprint,
        preExtractionSnapshot: parsed.data.preSigningAnchor.extraction_snapshot,
        postExtractionSnapshot: parsed.data.postSigningExtractionSnapshot,
      });

      const receipt = await store.submitFingerprintAnchor({
        fingerprint: parsed.data.signedDocumentFingerprint,
        phase: 'post_signing',
        orgId: req.apiKey.orgId ?? null,
        userId: req.apiKey.userId,
        description: 'Contract post-signing anchor',
        metadata: {
          contract_phase: 'post_signing',
          pre_signing_anchor_id: parsed.data.preSigningAnchor.anchor_id,
          validation_report: validationReport,
          raw_audit_pdf_hash: auditTrail.rawAuditPdfHash,
        },
      });

      res.status(201).json({
        second_anchor_id: receipt.anchorId,
        validation_report: validationReport,
      });
    } catch (error) {
      void logContractError({ error }, 'Contract post-signing anchor failed');
      res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/proof-package', (req: Request, res: Response) => {
    if (!req.apiKey) {
      res.status(401).json({ error: 'API key required. Include X-API-Key header.' });
      return;
    }
    if (containsRawDocumentPayload(req.body)) {
      res.status(400).json({
        error: 'privacy_boundary_violation',
        message: 'Proof packages contain fingerprints and evidence metadata only.',
      });
      return;
    }

    const parsed = proofPackageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
      return;
    }

    const zipBuffer = buildContractProofPackageZip(parsed.data);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="arkova-contract-proof-package.zip"');
    res.send(zipBuffer);
  });

  return router;
}

export const contractsRouter = createContractsRouter();

export function buildValidationReport(input: {
  provider: ESignatureProvider;
  auditTrail: ESignatureAuditTrail;
  preDocumentFingerprint: string;
  signedDocumentFingerprint: string;
  preExtractionSnapshot?: z.infer<typeof extractionSnapshotSchema>;
  postExtractionSnapshot: z.infer<typeof extractionSnapshotSchema>;
}): ContractValidationReport {
  return {
    prePostHashDiffer: input.preDocumentFingerprint !== input.signedDocumentFingerprint,
    termsMatch: normalizedTerms(input.preExtractionSnapshot?.terms ?? {}) === normalizedTerms(input.postExtractionSnapshot.terms),
    auditTrailValid: input.auditTrail.signers.length > 0 && !input.auditTrail.tampered && input.auditTrail.documentHash === input.signedDocumentFingerprint,
    auditTrail: {
      provider: input.provider,
      envelopeId: input.auditTrail.envelopeId,
      documentHash: input.auditTrail.documentHash,
      certificateValid: input.auditTrail.certificateValid,
      tampered: input.auditTrail.tampered,
      rawAuditPdfHash: input.auditTrail.rawAuditPdfHash,
      warnings: input.auditTrail.warnings,
    },
    comparedAt: new Date().toISOString(),
  };
}

export function createDatabaseContractAnchorStore(): ContractAnchorStore {
  return {
    async submitFingerprintAnchor(input: FingerprintAnchorInput): Promise<FingerprintAnchorReceipt> {
      const { db } = await import('../../utils/db.js');
      const dbAny = db as unknown as {
        from: (table: string) => {
          select: (columns: string) => {
            eq: (column: string, value: string) => {
              is: (column: string, value: null) => {
                maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: unknown }>;
              };
            };
          };
          insert: (value: Record<string, unknown>) => {
            select: (columns: string) => {
              single: () => Promise<{ data: Record<string, unknown> | null; error: unknown }>;
            };
          };
        };
      };

      const { data: existing } = await dbAny
        .from('anchors')
        .select('public_id, fingerprint, chain_tx_id, created_at')
        .eq('fingerprint', input.fingerprint)
        .is('deleted_at', null)
        .maybeSingle();

      if (existing) {
        return {
          anchorId: String(existing.public_id ?? ''),
          txId: existing.chain_tx_id ? String(existing.chain_tx_id) : null,
          timestamp: String(existing.created_at),
          fingerprint: String(existing.fingerprint),
        };
      }

      const shortId = randomUUID().slice(0, 8).toUpperCase();
      const publicId = `ARK-${new Date().getFullYear()}-${shortId}`;
      const { data, error } = await dbAny
        .from('anchors')
        .insert({
          fingerprint: input.fingerprint,
          public_id: publicId,
          status: 'PENDING',
          org_id: input.orgId,
          user_id: input.userId,
          filename: `contract-${input.phase}-${input.fingerprint.slice(0, 12)}`,
          credential_type: 'OTHER',
          description: input.description,
          metadata: input.metadata,
        })
        .select('public_id, fingerprint, chain_tx_id, created_at')
        .single();

      if (error || !data) {
        void logContractError(
          { error, phase: input.phase, fingerprintPrefix: input.fingerprint.slice(0, 12) },
          'Failed to create contract anchor',
        );
        throw new Error('Failed to create contract anchor');
      }

      return {
        anchorId: String(data.public_id ?? publicId),
        txId: data.chain_tx_id ? String(data.chain_tx_id) : null,
        timestamp: String(data.created_at),
        fingerprint: String(data.fingerprint),
      };
    },
  };
}

function containsRawDocumentPayload(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  return Object.keys(body as Record<string, unknown>).some((key) => {
    const normalized = key.toLowerCase();
    return normalized.includes('pdfbase64')
      || normalized === 'pdf'
      || normalized === 'file'
      || normalized === 'documentbytes'
      || normalized === 'signedpdfbase64';
  });
}

function normalizedTerms(terms: Record<string, unknown>): string {
  const filtered = Object.entries(terms)
    .filter(([key]) => !/(signature|signer|signed|audit|certificate|completion)/i.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(filtered));
}

async function logContractError(context: Record<string, unknown>, message: string): Promise<void> {
  try {
    const { logger } = await import('../../utils/logger.js');
    logger.error(context, message);
  } catch {
    // Config may be unavailable in isolated unit tests; never let logging mask the API error response.
  }
}
