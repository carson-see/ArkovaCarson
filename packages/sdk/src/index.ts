/**
 * @arkova/sdk — Arkova Verification SDK (PH1-SDK-01)
 *
 * Minimal SDK for anchoring and verifying documents via the Arkova API.
 * Supports both API key auth and x402 micropayments.
 *
 * Usage:
 *   import { Arkova } from '@arkova/sdk';
 *   const arkova = new Arkova({ apiKey: 'ak_...' });
 *   const receipt = await arkova.anchor(data);
 *   const result = await arkova.verify(data, receipt);
 */

export { Arkova } from './client';
export type {
  ArkovaConfig,
  AnchorReceipt,
  VerificationResult,
  NessieQueryResult,
  NessieContextResult,
} from './types';
