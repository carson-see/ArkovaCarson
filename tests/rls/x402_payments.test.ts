/**
 * RLS Tests for x402_payments table
 *
 * Verifies that only service_role can access x402_payments.
 * Anon and authenticated users must be blocked.
 *
 * Note: Uses untyped clients because x402_payments is not yet in
 * database.types.ts (migration 0078 not applied locally).
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

describe('RLS: x402_payments', () => {
  let anonClient: ReturnType<typeof createClient>;
  let authClient: ReturnType<typeof createClient>;
  let serviceClient: ReturnType<typeof createClient>;

  beforeAll(async () => {
    anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storageKey: `rls-test-auth-x402-${Date.now()}` },
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

  it('anon client CANNOT select from x402_payments', async () => {
    const { data } = await anonClient.from('x402_payments').select('*');
    expect(data?.length ?? 0).toBe(0);
  });

  it('authenticated client CANNOT select from x402_payments', async () => {
    const { data } = await authClient.from('x402_payments').select('*');
    expect(data?.length ?? 0).toBe(0);
  });

  it('service_role client CAN insert and select from x402_payments', async () => {
    const testPayment = {
      tx_hash: `0xtest${Date.now()}`,
      network: 'eip155:84532',
      amount_usd: 0.01,
      payer_address: '0x1234567890abcdef1234567890abcdef12345678',
      payee_address: '0xabcdef1234567890abcdef1234567890abcdef12',
      token: 'USDC',
      facilitator_url: 'https://x402.org/facilitator',
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inserted, error: insertError } = await (serviceClient as any)
      .from('x402_payments')
      .insert(testPayment)
      .select()
      .single();

    expect(insertError).toBeNull();
    expect(inserted).toBeTruthy();
    expect(inserted.tx_hash).toBe(testPayment.tx_hash);

    // Clean up
    if (inserted) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (serviceClient as any)
        .from('x402_payments')
        .delete()
        .eq('id', inserted.id);
    }
  });
});
