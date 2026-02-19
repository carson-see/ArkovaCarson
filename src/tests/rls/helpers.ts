/**
 * RLS Test Helpers
 *
 * Provides helper functions for testing Row Level Security policies.
 * These helpers create authenticated Supabase clients for different user contexts.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

// Test configuration
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

export type TypedClient = SupabaseClient<Database>;

/**
 * Demo user credentials from seed data
 */
export const DEMO_CREDENTIALS = {
  // ORG_ADMIN user (Arkova org)
  adminEmail: 'admin_demo@arkova.local',
  adminPassword: 'demo_password_123',
  adminId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',

  // INDIVIDUAL user (no org)
  userEmail: 'user_demo@arkova.local',
  userPassword: 'demo_password_123',
  userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',

  // ORG_ADMIN user (Beta Corp org)
  betaAdminEmail: 'beta_admin@betacorp.local',
  betaAdminPassword: 'demo_password_123',
  betaAdminId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
};

/**
 * Organization IDs from seed data
 */
export const ORG_IDS = {
  arkova: '11111111-1111-1111-1111-111111111111',
  betaCorp: '22222222-2222-2222-2222-222222222222',
};

/**
 * Role types for withUser helper
 */
export type UserRole = 'INDIVIDUAL' | 'ORG_ADMIN';

/**
 * Create an authenticated Supabase client for a user
 *
 * @param email - User email (must exist in seed data)
 * @param role - User role (for documentation/validation)
 * @returns Promise resolving to authenticated Supabase client
 *
 * @example
 * const adminClient = await withUser('admin_demo@arkova.local', 'ORG_ADMIN');
 * const userClient = await withUser('user_demo@arkova.local', 'INDIVIDUAL');
 */
export async function withUser(email: string, role: UserRole): Promise<TypedClient> {
  // Get password based on email (all demo users have same password)
  const password = getPasswordForEmail(email);

  const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error } = await client.auth.signInWithPassword({ email, password });

  if (error) {
    throw new Error(`Auth failed for ${email} (${role}): ${error.message}`);
  }

  return client;
}

/**
 * Create a service role client (bypasses RLS)
 * Use only for test setup/teardown operations
 */
export function createServiceClient(): TypedClient {
  return createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

/**
 * Create an unauthenticated (anon) client
 * Use to test anonymous access restrictions
 */
export function createAnonClient(): TypedClient {
  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/**
 * Sign out and clean up a client
 */
export async function cleanupClient(client: TypedClient): Promise<void> {
  await client.auth.signOut();
}

/**
 * Get password for demo email (all use same password)
 */
function getPasswordForEmail(email: string): string {
  // All demo users have the same password
  const knownEmails = [
    DEMO_CREDENTIALS.adminEmail,
    DEMO_CREDENTIALS.userEmail,
    DEMO_CREDENTIALS.betaAdminEmail,
  ];

  if (!knownEmails.includes(email)) {
    throw new Error(
      `Unknown demo email: ${email}. Use one of: ${knownEmails.join(', ')}`
    );
  }

  return 'demo_password_123';
}

/**
 * Shorthand helpers for common test users
 */
export const withArkovaAdmin = () =>
  withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');

export const withIndividualUser = () =>
  withUser(DEMO_CREDENTIALS.userEmail, 'INDIVIDUAL');

export const withBetaAdmin = () =>
  withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
