/**
 * arkova — Arkova Verification SDK (PH1-SDK-01 + INT-01)
 *
 * SDK for anchoring, verifying, and managing webhook endpoints via the
 * Arkova API. Supports both API key auth and x402 micropayments.
 *
 * @example
 *   import { Arkova } from 'arkova';
 *
 *   const arkova = new Arkova({ apiKey: 'ak_live_...' });
 *
 *   // Anchor a document
 *   const receipt = await arkova.anchor('document content');
 *
 *   // Verify by public ID
 *   const result = await arkova.verify(receipt.publicId);
 *
 *   // Batch verify
 *   const results = await arkova.verifyBatch(['ARK-2026-001', 'ARK-2026-002']);
 *
 *   // Bulk anchor (up to 1000 rows per call)
 *   const bulk = await arkova.anchorBulk([
 *     { fingerprint: 'abc123...64hex', externalId: 'invoice-001' },
 *     { data: fileBytes, documentType: 'contract' },
 *   ], { duplicateStrategy: 'skip' });
 *
 *   // Manage webhooks
 *   const webhook = await arkova.webhooks.create({
 *     url: 'https://api.example.com/hooks/arkova',
 *     events: ['anchor.secured', 'anchor.revoked'],
 *   });
 */

export { Arkova, ArkovaError, VERIFY_BATCH_SYNC_LIMIT, BULK_ANCHOR_MAX_ROWS } from './client';
export { BULK_ANCHOR_CREDENTIAL_TYPES } from './types';
export type {
  ArkovaConfig,
  AnchorReceipt,
  RichVerificationFields,
  VerificationResult,
  BulkAnchorInput,
  AnchorBulkOptions,
  BulkAnchorResponse,
  BulkAnchorDuplicate,
  BulkAnchorRowError,
  BulkAnchorResultRow,
  BulkAnchorCredentialType,
  BulkAnchorDuplicateStrategy,
  NessieQueryResult,
  NessieContextResult,
  WebhookEventType,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  CreateWebhookInput,
  UpdateWebhookInput,
  PaginatedWebhooks,
  RetryConfig,
  ProblemDetail,
  SearchType,
  SearchOptions,
  SearchResult,
  SearchResponse,
  FingerprintVerification,
  AnchorDetails,
  AttestationDetails,
  AttestationEvidence,
  AttestorCredential,
  OrganizationSummary,
  MerkleProofEntry,
  MerkleProofResponse,
  ProofBundle,
  ProofBundleSignature,
} from './types';
