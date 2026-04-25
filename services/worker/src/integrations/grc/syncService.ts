/**
 * GRC Sync Service (CML-05)
 *
 * Orchestrates evidence push to connected GRC platforms when anchors reach SECURED.
 * Called from the anchor confirmation job after status transitions.
 *
 * Flow:
 *   1. Anchor status → SECURED
 *   2. Query active GRC connections for the anchor's org
 *   3. Build evidence payload with compliance controls
 *   4. Push to each connected platform via adapter
 *   5. Log results in grc_sync_logs
 *
 * Constitution refs:
 *   - 1.4: OAuth tokens server-side only, never logged
 *   - 1.5: All timestamps UTC
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GrcConnection, GrcEvidencePayload, GrcPlatform } from './types.js';
import { createGrcAdapter, loadGrcCredentials, type GrcPlatformCredentials } from './adapters.js';
import { getComplianceControlIds } from '../../utils/complianceMapping.js';
import { createDefaultKmsClient, decryptTokens } from '../oauth/crypto.js';

// Note: grc_connections and grc_sync_logs not yet in database.types.ts (migration 0139)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrcSupabase = any;

export interface SyncResult {
  platform: GrcPlatform;
  success: boolean;
  external_evidence_id?: string;
  error?: string;
  duration_ms: number;
}

interface AnchorForSync {
  id: string;
  public_id: string;
  filename: string;
  fingerprint: string;
  credential_type: string | null;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  compliance_controls: string[] | null;
  created_at: string;
  user_id: string;
}

/**
 * Sync a SECURED anchor to all connected GRC platforms for its org.
 *
 * @param db - Service-role Supabase client
 * @param anchor - The anchor that just reached SECURED
 * @param orgId - The org owning this anchor
 * @param creds - GRC platform credentials (from env)
 * @returns Array of sync results per platform
 */
export async function syncAnchorToGrc(
  db: SupabaseClient,
  anchor: AnchorForSync,
  orgId: string,
  creds?: GrcPlatformCredentials,
): Promise<SyncResult[]> {
  const platformCreds = creds ?? loadGrcCredentials();
  const grcDb = db as GrcSupabase;

  // Find active GRC connections for this org
  const { data: connections, error: connError } = await grcDb
    .from('grc_connections')
    .select('*')
    .eq('org_id', orgId)
    .eq('is_active', true);

  if (connError || !connections?.length) {
    return [];
  }

  // Build evidence payload
  const controlIds = anchor.compliance_controls ?? getComplianceControlIds(anchor.credential_type ?? undefined);
  const frameworks = [...new Set(controlIds.map(c => c.split('-')[0]))];

  const evidence: GrcEvidencePayload = {
    verification_id: anchor.public_id,
    title: anchor.filename,
    fingerprint: anchor.fingerprint,
    credential_type: anchor.credential_type,
    status: anchor.status,
    network_receipt: anchor.chain_tx_id,
    block_height: anchor.chain_block_height,
    chain_timestamp: anchor.chain_timestamp,
    compliance_controls: controlIds,
    frameworks,
    created_at: anchor.created_at,
    secured_at: anchor.chain_timestamp,
  };

  // Push to each connected platform
  const results: SyncResult[] = [];

  for (const conn of connections as GrcConnection[]) {
    const start = Date.now();
    let result: SyncResult;

    try {
      if (!conn.access_token_encrypted || !conn.token_kms_key_id) {
        throw new Error('No encrypted access token stored for connection');
      }

      const kms = await createDefaultKmsClient();
      const ct = typeof conn.access_token_encrypted === 'string'
        ? Buffer.from(conn.access_token_encrypted.replace(/^\\x/, ''), 'hex')
        : Buffer.from(conn.access_token_encrypted);
      const tokens = await decryptTokens(ct, { kms, keyName: conn.token_kms_key_id });

      const adapter = createGrcAdapter(conn.platform, platformCreds);
      const pushResult = await adapter.pushEvidence(tokens.access_token, evidence);
      const duration = Date.now() - start;

      result = {
        platform: conn.platform,
        success: pushResult.success,
        external_evidence_id: pushResult.external_evidence_id,
        error: pushResult.error,
        duration_ms: duration,
      };

      // Log sync result
      await grcDb.from('grc_sync_logs').insert({
        connection_id: conn.id,
        anchor_id: anchor.id,
        status: pushResult.success ? 'success' : 'failed',
        evidence_type: 'anchor_secured',
        external_evidence_id: pushResult.external_evidence_id,
        error_message: pushResult.error,
        request_payload: { verification_id: evidence.verification_id, controls: controlIds },
        response_payload: pushResult.response ?? null,
        duration_ms: duration,
      });

      // Update connection metadata
      await grcDb.from('grc_connections').update({
        last_sync_at: new Date().toISOString(),
        last_sync_status: pushResult.success ? 'success' : 'failed',
        last_sync_error: pushResult.error ?? null,
        sync_count: conn.sync_count + 1,
      }).eq('id', conn.id);

    } catch (err) {
      const duration = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);

      result = {
        platform: conn.platform,
        success: false,
        error: errorMsg,
        duration_ms: duration,
      };

      // Log failure
      await grcDb.from('grc_sync_logs').insert({
        connection_id: conn.id,
        anchor_id: anchor.id,
        status: 'failed',
        evidence_type: 'anchor_secured',
        error_message: errorMsg,
        duration_ms: duration,
      });

      await grcDb.from('grc_connections').update({
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'failed',
        last_sync_error: errorMsg,
      }).eq('id', conn.id);
    }

    results.push(result);
  }

  return results;
}

/**
 * Check if an org has any active GRC connections.
 * Lightweight query to avoid unnecessary evidence payload construction.
 */
export async function hasActiveGrcConnections(
  db: SupabaseClient,
  orgId: string,
): Promise<boolean> {
  const grcDb = db as GrcSupabase;
  const { count } = await grcDb
    .from('grc_connections')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('is_active', true);

  return (count ?? 0) > 0;
}
