/**
 * GRC Integration — Barrel Export (CML-05)
 */
export type { IGrcAdapter, GrcPlatform, GrcConnection, GrcSyncLog, GrcEvidencePayload, GrcOAuthTokens, GrcPushResult, GrcSyncStatus } from './types.js';
export { VantaAdapter, DrataAdapter, AnecdotesAdapter, createGrcAdapter, loadGrcCredentials } from './adapters.js';
export type { GrcPlatformCredentials } from './adapters.js';
export { syncAnchorToGrc, hasActiveGrcConnections } from './syncService.js';
export type { SyncResult } from './syncService.js';
