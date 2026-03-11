/**
 * RLS Test Helpers
 *
 * Provides helper functions for testing Row Level Security policies.
 * These helpers create authenticated Supabase clients for different user contexts.
 *
 * IMPORTANT: Credentials here MUST match supabase/seed.sql.
 * If you change seed data, update these constants to match.
 *
 * Required env vars (set in .env.test or shell):
 *   RLS_TEST_PASSWORD — seed user password (must match seed.sql)
 *   SUPABASE_ANON_KEY — local Supabase anon JWT (optional, defaults to local dev key)
 *   SUPABASE_SERVICE_ROLE_KEY — local Supabase service role JWT (optional, defaults to local dev key)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

// Counter to generate unique storage keys per client instance.
// Without this, multiple GoTrueClient instances share the same storage key
// and the last signInWithPassword overwrites all previous sessions.
let clientCounter = 0;

// Require seed password via environment variable — never hardcode secrets
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Set it in .env.test or your shell before running RLS tests.`
    );
  }
  return value;
}

// Test configuration — all credentials loaded from environment variables.
// For local dev, set these in .env.test. See Supabase docs for default local dev JWTs.
const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_ANON_KEY = requireEnv('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const RLS_TEST_PASSWORD = requireEnv('RLS_TEST_PASSWORD');

export type TypedClient = SupabaseClient<Database>;

/**
 * Demo user credentials — must match supabase/seed.sql
 */
export const DEMO_CREDENTIALS = {
  // ORG_ADMIN user (UMich Registrar org)
  adminEmail: 'admin@umich-demo.arkova.io',
  adminPassword: RLS_TEST_PASSWORD,
  adminId: '11111111-0000-0000-0000-000000000001',

  // INDIVIDUAL user (no org)
  userEmail: 'individual@demo.arkova.io',
  userPassword: RLS_TEST_PASSWORD,
  userId: '33333333-0000-0000-0000-000000000001',

  // ORG_ADMIN user (Midwest Medical Board org)
  betaAdminEmail: 'admin@midwest-medical.arkova.io',
  betaAdminPassword: RLS_TEST_PASSWORD,
  betaAdminId: '22222222-0000-0000-0000-000000000001',
};

/**
 * Organization IDs — must match supabase/seed.sql
 */
export const ORG_IDS = {
  arkova: 'aaaaaaaa-0000-0000-0000-000000000001',
  betaCorp: 'bbbbbbbb-0000-0000-0000-000000000001',
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
 * const adminClient = await withUser('admin@umich-demo.arkova.io', 'ORG_ADMIN');
 * const userClient = await withUser('individual@demo.arkova.io', 'INDIVIDUAL');
 */
export async function withUser(email: string, role: UserRole): Promise<TypedClient> {
  // Get password based on email (all demo users have same password)
  const password = getPasswordForEmail(email);

  const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storageKey: `test-user-${email}-${++clientCounter}` },
  });
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
  return createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { storageKey: `test-service-${++clientCounter}` },
  });
}

/**
 * Create an unauthenticated (anon) client
 * Use to test anonymous access restrictions
 */
export function createAnonClient(): TypedClient {
  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storageKey: `test-anon-${++clientCounter}` },
  });
}

/**
 * Sign out and clean up a client
 */
export async function cleanupClient(client: TypedClient): Promise<void> {
  await client.auth.signOut();
}

/**
 * Get password for demo email (all seed users share the same password)
 */
function getPasswordForEmail(email: string): string {
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

  return RLS_TEST_PASSWORD;
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
