/**
 * @arkova/sdk — Arkova Verification SDK (PH1-SDK-01 + INT-01)
 *
 * SDK for anchoring, verifying, and managing webhook endpoints via the
 * Arkova API. Supports both API key auth and x402 micropayments.
 *
 * @example
 *   import { Arkova } from '@arkova/sdk';
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
 *   // Manage webhooks
 *   const webhook = await arkova.webhooks.create({
 *     url: 'https://api.example.com/hooks/arkova',
 *     events: ['anchor.secured', 'anchor.revoked'],
 *   });
 */

export { Arkova, ArkovaError } from './client';
export type {
  ArkovaConfig,
  AnchorReceipt,
  VerificationResult,
  NessieQueryResult,
  NessieContextResult,
  WebhookEventType,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  CreateWebhookInput,
  UpdateWebhookInput,
  PaginatedWebhooks,
} from './types';
