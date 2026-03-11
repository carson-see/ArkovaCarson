/**
 * Supabase E2E Test Helpers
 *
 * Centralized Supabase service client for E2E test data setup/teardown.
 * Uses env vars — never hardcode credentials in spec files.
 *
 * @updated 2026-03-10 10:30 PM EST
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Default to local Supabase instance if env vars not set
const SUPABASE_URL = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_KEY =
  process.env.E2E_SUPABASE_SERVICE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

/**
 * Service-role Supabase client for E2E test setup/teardown.
 * Bypasses RLS — use only for test data management, never in app code.
 */
export function getServiceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// ── Seed User Constants ─────────────────────────────────────────────────────

export const SEED_USERS = {
  /** ORG_ADMIN at University of Michigan demo org */
  orgAdmin: {
    id: '11111111-0000-0000-0000-000000000001',
    email: 'admin@umich-demo.arkova.io',
    password: 'Demo1234!',
    role: 'ORG_ADMIN' as const,
  },
  /** ORG_MEMBER at University of Michigan demo org */
  registrar: {
    id: '11111111-0000-0000-0000-000000000002',
    email: 'registrar@umich-demo.arkova.io',
    password: 'Demo1234!',
    role: 'ORG_MEMBER' as const,
  },
  /** ORG_ADMIN at Midwest Medical (second org — RLS isolation) */
  orgBAdmin: {
    id: '22222222-0000-0000-0000-000000000001',
    email: 'admin@midwest-medical.arkova.io',
    password: 'Demo1234!',
    role: 'ORG_ADMIN' as const,
  },
  /** INDIVIDUAL user (no org) */
  individual: {
    id: '33333333-0000-0000-0000-000000000001',
    email: 'individual@demo.arkova.io',
    password: 'Demo1234!',
    role: 'INDIVIDUAL' as const,
  },
} as const;

// ── Test Data Helpers ───────────────────────────────────────────────────────

/**
 * Create a test anchor via service client. Returns anchor with public_id if SECURED.
 * Caller is responsible for cleanup via `deleteTestAnchor()`.
 */
export async function createTestAnchor(
  serviceClient: SupabaseClient,
  overrides: {
    userId?: string;
    status?: 'PENDING' | 'SECURED' | 'REVOKED' | 'EXPIRED';
    filename?: string;
    fingerprint?: string;
  } = {}
) {
  const timestamp = Date.now();
  const defaults = {
    user_id: overrides.userId ?? SEED_USERS.individual.id,
    fingerprint: overrides.fingerprint ?? `e2e_test_${timestamp}_${'a'.repeat(44)}`,
    filename: overrides.filename ?? `e2e_test_${timestamp}.pdf`,
    file_size: 12345,
    status: 'PENDING' as const,
  };

  // Insert as PENDING first
  const { data: anchor, error: insertError } = await serviceClient
    .from('anchors')
    .insert(defaults)
    .select()
    .single();

  if (insertError || !anchor) {
    throw new Error(`Failed to create test anchor: ${insertError?.message}`);
  }

  // If requested status is not PENDING, update it
  const targetStatus = overrides.status ?? 'PENDING';
  if (targetStatus !== 'PENDING') {
    const updateFields: Record<string, unknown> = { status: targetStatus };

    if (targetStatus === 'SECURED') {
      updateFields.chain_tx_id = `e2e_receipt_${timestamp}`;
      updateFields.chain_block_height = 99999;
      updateFields.chain_timestamp = new Date().toISOString();
    }

    if (targetStatus === 'REVOKED') {
      updateFields.revocation_reason = 'E2E test revocation';
    }

    await serviceClient
      .from('anchors')
      .update(updateFields)
      .eq('id', anchor.id);
  }

  // Re-fetch to get generated fields (public_id, updated status)
  const { data: final } = await serviceClient
    .from('anchors')
    .select('*')
    .eq('id', anchor.id)
    .single();

  return final!;
}

/**
 * Delete a test anchor by ID. Safe to call even if anchor doesn't exist.
 */
export async function deleteTestAnchor(
  serviceClient: SupabaseClient,
  anchorId: string
) {
  // Delete related audit events first (FK constraint)
  await serviceClient
    .from('audit_events')
    .delete()
    .eq('anchor_id', anchorId);

  await serviceClient
    .from('anchors')
    .delete()
    .eq('id', anchorId);
}
