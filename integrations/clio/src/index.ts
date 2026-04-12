/**
 * Arkova–Clio Integration (INT-06)
 *
 * Integrates Arkova's credential verification with Clio's law firm DMS.
 * Provides:
 * - OAuth2 connector for Clio API
 * - Sidebar widget: "Anchor with Arkova" on any document
 * - Client-side SHA-256 hash + POST /anchor
 * - CLE compliance tab (bar number lookup via Arkova CLE data)
 * - Verification badge renderer for Clio document list
 * - Auto-anchor webhook listener for new Clio documents
 */

export { ClioConnector } from './connector';
export { ClioSidebarWidget } from './sidebar-widget';
export { CleComplianceTab } from './cle-compliance';
export { ClioWebhookHandler } from './webhook-handler';
export type { ClioConfig, ClioDocument, ClioContact, CleStatus } from './types';
