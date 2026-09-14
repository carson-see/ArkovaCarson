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
import { beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ws from 'ws';
import { totp } from '../../../e2e/helpers/totp';

// Cast ws to satisfy Supabase's WebSocketLikeConstructor interface.
// The ws package is runtime-compatible but its TypeScript constructor
// signature includes extra options that don't match the narrower interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WebSocketTransport = ws as any;

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

const supabaseEndpoint = new URL(SUPABASE_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(supabaseEndpoint.hostname)) {
  throw new Error('RLS MFA fixtures may only enroll factors against an owned loopback Supabase stack');
}

interface SharedTotpFactor {
  factorId: string;
  secret: string;
}

const mfaCacheRoot = join(
  tmpdir(),
  'arkova-rls-mfa',
  createHash('sha256').update(SUPABASE_URL).digest('hex').slice(0, 16),
);

function readSharedFactor(path: string): SharedTotpFactor | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<SharedTotpFactor>;
    return typeof value.factorId === 'string' && typeof value.secret === 'string'
      ? { factorId: value.factorId, secret: value.secret }
      : null;
  } catch {
    return null;
  }
}

async function withUserMfaLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
  mkdirSync(mfaCacheRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(mfaCacheRoot, `${userId}.lock`);
  const startedAt = Date.now();

  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 60_000) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - startedAt > 20_000) {
        throw new Error(`Timed out waiting for the shared MFA fixture for ${userId}`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  try {
    return await work();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function assertAal2Token(accessToken: string, userId: string): void {
  const encodedClaims = accessToken.split('.')[1];
  const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (claims.sub !== userId || claims.role !== 'authenticated' || claims.aal !== 'aal2') {
    throw new Error(`GoTrue did not mint an authenticated/AAL2 RLS fixture session for ${userId}`);
  }
}

async function verifyTotpFactor(
  client: TypedClient,
  userId: string,
  factor: SharedTotpFactor,
): Promise<void> {
  // Avoid generating a code while the 30-second TOTP window is rolling over.
  const remainingMs = 30_000 - (Date.now() % 30_000);
  if (remainingMs < 2_000) await new Promise(resolve => setTimeout(resolve, remainingMs + 100));

  const challenged = await client.auth.mfa.challenge({ factorId: factor.factorId });
  if (challenged.error) throw new Error(`MFA challenge failed for ${userId}: ${challenged.error.message}`);
  const verified = await client.auth.mfa.verify({
    factorId: factor.factorId,
    challengeId: challenged.data.id,
    code: totp(factor.secret),
  });
  if (verified.error) throw new Error(`MFA verification failed for ${userId}: ${verified.error.message}`);
  assertAal2Token(verified.data.access_token, userId);
}

async function elevateRlsClientToAal2Unlocked(client: TypedClient, userId: string): Promise<void> {
  const cachePath = join(mfaCacheRoot, `${userId}.json`);
  const cached = readSharedFactor(cachePath);
  const listed = await client.auth.mfa.listFactors();
  if (listed.error) throw new Error(`MFA factor lookup failed for ${userId}: ${listed.error.message}`);

  const reusable = cached && listed.data.totp.some(
    factor => factor.id === cached.factorId && factor.status === 'verified',
  );
  if (reusable) {
    await verifyTotpFactor(client, userId, cached);
    return;
  }

  const enrolled = await client.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `RLS ${userId.slice(0, 8)}`,
  });
  if (enrolled.error) throw new Error(`MFA enrollment failed for ${userId}: ${enrolled.error.message}`);
  const factor = { factorId: enrolled.data.id, secret: enrolled.data.totp.secret };
  await verifyTotpFactor(client, userId, factor);

  const temporaryPath = `${cachePath}.${process.pid}`;
  writeFileSync(temporaryPath, JSON.stringify(factor), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, cachePath);
}

/** Raise a real GoTrue session to AAL2 for RLS positive controls. */
export async function elevateRlsClientToAal2(client: TypedClient, userId: string): Promise<void> {
  await withUserMfaLock(userId, async () => {
    await elevateRlsClientToAal2Unlocked(client, userId);
  });
}

export type TypedClient = SupabaseClient<Database>;

/**
 * Seed user credentials — must match supabase/seed.sql
 */
export const DEMO_CREDENTIALS = {
  // Platform admin / ORG_ADMIN (Arkova org) — Carson
  adminEmail: 'carson@arkova.ai',
  adminPassword: RLS_TEST_PASSWORD,
  adminId: '44444444-0000-4000-8000-000000000001',

  // INDIVIDUAL user (no org) — Jamie Demo-User
  userEmail: 'demo-user@arkova.local',
  userPassword: RLS_TEST_PASSWORD,
  userId: '55555555-0000-4000-8000-000000000002',

  // ORG_ADMIN (Acme Corp) — Alex Demo-Admin (second org for cross-tenant tests)
  betaAdminEmail: 'demo-admin@arkova.local',
  betaAdminPassword: RLS_TEST_PASSWORD,
  betaAdminId: '55555555-0000-4000-8000-000000000001',
};

/**
 * Organization IDs — must match supabase/seed.sql
 */
export const ORG_IDS = {
  arkova: 'aaaaaaaa-0000-4000-8000-000000000001',
  betaCorp: 'bbbbbbbb-0000-4000-8000-000000000001',
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
 * const adminClient = await withUser('carson@arkova.ai', 'ORG_ADMIN');
 * const userClient = await withUser('demo-user@arkova.local', 'INDIVIDUAL');
 */
export async function withUser(email: string, role: UserRole): Promise<TypedClient> {
  const password = getPasswordForEmail(email);
  const expectedUserId = getUserIdForEmail(email);

  const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storageKey: `test-user-${email}-${++clientCounter}`,
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: { transport: WebSocketTransport },
  });
  await withUserMfaLock(expectedUserId, async () => {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`Auth failed for ${email} (${role}): ${error.message}`);
    if (data.user.id !== expectedUserId) throw new Error(`Seed identity mismatch for ${email}`);
    await elevateRlsClientToAal2Unlocked(client, expectedUserId);
  });

  return client;
}

/**
 * Create a service role client (bypasses RLS)
 * Use only for test setup/teardown operations
 */
export function createServiceClient(): TypedClient {
  return createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { storageKey: `test-service-${++clientCounter}` },
    realtime: { transport: WebSocketTransport },
  });
}

/**
 * Create an unauthenticated (anon) client
 * Use to test anonymous access restrictions
 */
export function createAnonClient(): TypedClient {
  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storageKey: `test-anon-${++clientCounter}` },
    realtime: { transport: WebSocketTransport },
  });
}

/**
 * Sign out and clean up a client.
 *
 * Scope MUST stay 'local': supabase-js signOut() defaults to scope 'global',
 * which revokes EVERY session of that user server-side — and the demo users
 * are shared by many RLS suites running in parallel workers. A global
 * sign-out from one suite's afterAll poisons any other suite still holding a
 * session for the same user (auth.getUser() starts failing with "Auth session
 * missing!" and supabase-js then drops the local session, silently degrading
 * the client to anon). That was the SCRUM-3618 / SCRUM-3577 cross-file flake.
 */
export async function cleanupClient(client: TypedClient): Promise<void> {
  await client.auth.signOut({ scope: 'local' });
}

/**
 * Get password for seed email (all seed users share the same password)
 */
function getPasswordForEmail(email: string): string {
  const knownEmails = [
    DEMO_CREDENTIALS.adminEmail,
    DEMO_CREDENTIALS.userEmail,
    DEMO_CREDENTIALS.betaAdminEmail,
  ];

  if (!knownEmails.includes(email)) {
    throw new Error(
      `Unknown seed email: ${email}. Use one of: ${knownEmails.join(', ')}`
    );
  }

  return RLS_TEST_PASSWORD;
}

function getUserIdForEmail(email: string): string {
  const idsByEmail: Record<string, string> = {
    [DEMO_CREDENTIALS.adminEmail]: DEMO_CREDENTIALS.adminId,
    [DEMO_CREDENTIALS.userEmail]: DEMO_CREDENTIALS.userId,
    [DEMO_CREDENTIALS.betaAdminEmail]: DEMO_CREDENTIALS.betaAdminId,
  };
  return idsByEmail[email];
}

/**
 * Shorthand helpers for common test users
 */
export const withArkovaAdmin = () =>
  withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');

export const withIndividualUser = () =>
  withUser(DEMO_CREDENTIALS.userEmail, 'INDIVIDUAL');

export function setupRlsClients() {
  const c = {} as { anonClient: TypedClient; authClient: TypedClient; serviceClient: TypedClient };
  beforeAll(async () => {
    c.anonClient = createAnonClient();
    c.authClient = await withIndividualUser();
    c.serviceClient = createServiceClient();
  });
  return c;
}

export const withBetaAdmin = () =>
  withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
