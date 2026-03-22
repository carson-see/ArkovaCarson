/**
 * RLS Tests for public_records table
 *
 * Verifies that only service_role can access public_records.
 * Anon and authenticated users must be blocked.
 *
 * Note: Uses untyped clients because public_records is not yet in
 * database.types.ts (migration 0077 not applied locally).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_ANON_KEY = requireEnv('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const RLS_TEST_PASSWORD = requireEnv('RLS_TEST_PASSWORD');

describe('RLS: public_records', () => {
  let anonClient: ReturnType<typeof createClient>;
  let authClient: ReturnType<typeof createClient>;
  let serviceClient: ReturnType<typeof createClient>;

  beforeAll(async () => {
    anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storageKey: `rls-test-auth-pr-${Date.now()}` },
    });
    await authClient.auth.signInWithPassword({
      email: 'individual@demo.arkova.io',
      password: RLS_TEST_PASSWORD,
    });

    serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  afterAll(async () => {
    await authClient.auth.signOut();
  });

  it('anon client CANNOT select from public_records', async () => {
    const { data } = await anonClient.from('public_records').select('*');
    expect(data?.length ?? 0).toBe(0);
  });

  it('authenticated client CANNOT select from public_records', async () => {
    const { data } = await authClient.from('public_records').select('*');
    expect(data?.length ?? 0).toBe(0);
  });

  it('service_role client CAN insert and select from public_records', async () => {
    const testRecord = {
      source: 'test',
      source_id: `test-${Date.now()}`,
      source_url: 'https://example.com/test',
      record_type: '10-K',
      title: 'Test Record',
      content_hash: 'abc123def456',
      metadata: { test: true },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inserted, error: insertError } = await (serviceClient as any)
      .from('public_records')
      .insert(testRecord)
      .select()
      .single();

    expect(insertError).toBeNull();
    expect(inserted).toBeTruthy();
    expect(inserted.source).toBe('test');

    // Clean up
    if (inserted) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (serviceClient as any)
        .from('public_records')
        .delete()
        .eq('id', inserted.id);
    }
  });
});
