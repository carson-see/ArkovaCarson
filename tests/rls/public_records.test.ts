/**
 * RLS Integration Tests for public_records
 *
 * Verifies that:
 * - Anonymous clients cannot access public_records
 * - Authenticated clients can SELECT (public records are public)
 * - Only service_role can INSERT/UPDATE/DELETE
 *
 * Prerequisites:
 * - Supabase running locally (supabase start)
 * - Database reset with seed data (supabase db reset)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createServiceClient,
  DEMO_CREDENTIALS,
  type TypedClient,
} from '../../src/tests/rls/helpers';
import { createAuthenticatedClient } from './rls.test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

describe('RLS: public_records', () => {
  let anonClient: ReturnType<typeof createClient>;
  let authClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    authClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.userEmail,
      DEMO_CREDENTIALS.userPassword,
    );
    serviceClient = createServiceClient();
  });

  it('anon client CANNOT select from public_records', async () => {
    const { data, error } = await anonClient
      .from('public_records')
      .select('id')
      .limit(1);

    // RLS blocks anon — either error or empty result
    if (error) {
      expect(error.code).toBeTruthy();
    } else {
      expect(data).toHaveLength(0);
    }
  });

  it('authenticated client CAN select from public_records (read-only)', async () => {
    // Authenticated users have SELECT via policy
    const { error } = await authClient
      .from('public_records')
      .select('id')
      .limit(1);

    expect(error).toBeNull();
  });

  it('authenticated client CANNOT insert into public_records', async () => {
    const { error } = await authClient.from('public_records').insert({
      source: 'test',
      source_id: 'rls-test-001',
      source_url: 'https://example.com',
      record_type: 'test',
      content_hash: 'a'.repeat(64),
    });

    expect(error).not.toBeNull();
  });

  it('service_role client CAN insert and select from public_records', async () => {
    const testSourceId = `rls-test-${Date.now()}`;

    const { error: insertError } = await serviceClient
      .from('public_records')
      .insert({
        source: 'test',
        source_id: testSourceId,
        source_url: 'https://example.com/rls-test',
        record_type: 'test',
        content_hash: 'b'.repeat(64),
        metadata: { test: true },
      });

    expect(insertError).toBeNull();

    const { data, error: selectError } = await serviceClient
      .from('public_records')
      .select('id, source_id')
      .eq('source_id', testSourceId)
      .limit(1);

    expect(selectError).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].source_id).toBe(testSourceId);

    // Cleanup
    await serviceClient
      .from('public_records')
      .delete()
      .eq('source_id', testSourceId);
  });
});
