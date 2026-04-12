/**
 * Arkova–Bullhorn Integration (INT-07)
 *
 * Integrates Arkova's credential verification with Bullhorn's
 * staffing and recruitment platform. Provides:
 * - Custom tab: "Credential Verification" on candidate records
 * - Credential list with verification status
 * - Client-side hash + POST /anchor for new documents
 * - Status sync to custom field on candidate record
 * - Bullhorn Marketplace listing configuration
 */

export { BullhornConnector } from './connector';
export { CandidateVerificationTab } from './candidate-tab';
export { BullhornWebhookHandler } from './webhook-handler';
export type {
  BullhornConfig,
  BullhornCandidate,
  BullhornCredential,
  CandidateVerificationSummary,
  BullhornCustomFieldMapping,
} from './types';
