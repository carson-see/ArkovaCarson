/**
 * RLS Test Helpers
 *
 * Provides helper functions for testing Row Level Security policies.
 * These helpers create authenticated Supabase clients for different user contexts.
 *
 * IMPORTANT: Credentials here MUST match supabase/seed.sql.
 * If you change seed data, update these constants to match.
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
 * Demo user credentials — must match supabase/seed.sql
 */
export const DEMO_CREDENTIALS = {
  // ORG_ADMIN user (UMich Registrar org)
  adminEmail: 'admin@umich-demo.arkova.io',
  adminPassword: 'Demo1234!',
  adminId: '11111111-0000-0000-0000-000000000001',

  // INDIVIDUAL user (no org)
  userEmail: 'individual@demo.arkova.io',
  userPassword: 'Demo1234!',
  userId: '33333333-0000-0000-0000-000000000001',

  // ORG_ADMIN user (Midwest Medical Board org)
  betaAdminEmail: 'admin@midwest-medical.arkova.io',
  betaAdminPassword: 'Demo1234!',
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
 * Get password for demo email (all use same password: Demo1234!)
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

  return 'Demo1234!';
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
