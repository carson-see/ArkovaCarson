/**
 * Seed SECURED Anchors Fixture (QA-E2E-07)
 *
 * Creates a reusable set of SECURED anchors for E2E tests that need
 * pre-existing verified records (proof downloads, record detail, etc.).
 *
 * These fixtures insert anchors via the service client (bypasses RLS)
 * and clean them up after the test suite completes.
 *
 * Usage:
 *   import { seedAnchors, cleanupSeedAnchors, SeedAnchorSet } from './fixtures/seed-anchors';
 *
 *   let anchors: SeedAnchorSet;
 *   test.beforeAll(async () => { anchors = await seedAnchors(); });
 *   test.afterAll(async () => { await cleanupSeedAnchors(anchors); });
 *
 * @created 2026-03-29
 */

import { getServiceClient, SEED_USERS } from './supabase';

export interface SeedAnchor {
  id: string;
  public_id: string;
  fingerprint: string;
  filename: string;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  credential_type: string | null;
}

export interface SeedAnchorSet {
  /** A SECURED anchor with all chain fields populated */
  secured: SeedAnchor;
  /** A second SECURED anchor for list/pagination tests */
  securedAlt: SeedAnchor;
  /** A PENDING anchor (not yet confirmed on chain) */
  pending: SeedAnchor;
  /** A REVOKED anchor (previously secured, then revoked) */
  revoked: SeedAnchor;
  /** All anchors as an array for bulk cleanup */
  all: SeedAnchor[];
}

/**
 * Seed a comprehensive set of anchors in various states.
 * Uses service client to bypass RLS and status transition triggers.
 */
export async function seedAnchors(): Promise<SeedAnchorSet> {
  const client = getServiceClient();
  const userId = SEED_USERS.individual.id;
  const ts = Date.now();

  const anchorsToCreate = [
    {
      key: 'secured' as const,
      fingerprint: `e2e_seed_secured_${ts}_${'a'.repeat(40)}`,
      filename: 'e2e_seed_secured_diploma.pdf',
      status: 'SECURED' as const,
      credential_type: 'DEGREE',
      chain_tx_id: `e2e_mainnet_tx_${ts}_001`,
      chain_block_height: 942500,
      chain_timestamp: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
    },
    {
      key: 'securedAlt' as const,
      fingerprint: `e2e_seed_secured_alt_${ts}_${'b'.repeat(40)}`,
      filename: 'e2e_seed_secured_certificate.pdf',
      status: 'SECURED' as const,
      credential_type: 'CERTIFICATE',
      chain_tx_id: `e2e_mainnet_tx_${ts}_002`,
      chain_block_height: 942501,
      chain_timestamp: new Date(Date.now() - 43200000).toISOString(), // 12 hours ago
    },
    {
      key: 'pending' as const,
      fingerprint: `e2e_seed_pending_${ts}_${'c'.repeat(40)}`,
      filename: 'e2e_seed_pending_license.pdf',
      status: 'PENDING' as const,
      credential_type: 'LICENSE',
      chain_tx_id: null,
      chain_block_height: null,
      chain_timestamp: null,
    },
    {
      key: 'revoked' as const,
      fingerprint: `e2e_seed_revoked_${ts}_${'d'.repeat(40)}`,
      filename: 'e2e_seed_revoked_transcript.pdf',
      status: 'REVOKED' as const,
      credential_type: 'TRANSCRIPT',
      chain_tx_id: `e2e_mainnet_tx_${ts}_003`,
      chain_block_height: 942400,
      chain_timestamp: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
    },
  ];

  const results: Record<string, SeedAnchor> = {};

  for (const spec of anchorsToCreate) {
    // Insert as PENDING first (status transition triggers require this)
    const { data: anchor, error: insertError } = await client
      .from('anchors')
      .insert({
        user_id: userId,
        fingerprint: spec.fingerprint,
        filename: spec.filename,
        file_size: 12345,
        status: 'PENDING',
        credential_type: spec.credential_type,
      })
      .select()
      .single();

    if (insertError || !anchor) {
      throw new Error(`seedAnchors: failed to create ${spec.key}: ${insertError?.message}`);
    }

    // Transition to target status if not PENDING
    if (spec.status !== 'PENDING') {
      const updateFields: Record<string, unknown> = { status: spec.status };

      if (spec.chain_tx_id) updateFields.chain_tx_id = spec.chain_tx_id;
      if (spec.chain_block_height) updateFields.chain_block_height = spec.chain_block_height;
      if (spec.chain_timestamp) updateFields.chain_timestamp = spec.chain_timestamp;
      if (spec.status === 'REVOKED') updateFields.revocation_reason = 'E2E test revocation';

      const { error: updateError } = await client
        .from('anchors')
        .update(updateFields)
        .eq('id', anchor.id);

      if (updateError) {
        throw new Error(`seedAnchors: failed to update ${spec.key} to ${spec.status}: ${updateError.message}`);
      }
    }

    // Re-fetch to get generated fields (public_id)
    const { data: final, error: fetchError } = await client
      .from('anchors')
      .select('id, public_id, fingerprint, filename, status, chain_tx_id, chain_block_height, chain_timestamp, credential_type')
      .eq('id', anchor.id)
      .single();

    if (fetchError || !final) {
      throw new Error(`seedAnchors: failed to fetch ${spec.key}: ${fetchError?.message}`);
    }

    results[spec.key] = final as SeedAnchor;
  }

  return {
    secured: results.secured,
    securedAlt: results.securedAlt,
    pending: results.pending,
    revoked: results.revoked,
    all: Object.values(results),
  };
}

/**
 * Clean up all seed anchors. Safe to call even if some are already deleted.
 */
export async function cleanupSeedAnchors(anchors: SeedAnchorSet): Promise<void> {
  const client = getServiceClient();

  for (const anchor of anchors.all) {
    if (!anchor?.id) continue;

    // Delete related audit events first (FK constraint)
    await client.from('audit_events').delete().eq('anchor_id', anchor.id);
    await client.from('anchors').delete().eq('id', anchor.id);
  }
}
