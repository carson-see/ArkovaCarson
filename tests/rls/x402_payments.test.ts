/**
 * RLS Integration Tests for x402_payments
 *
 * Verifies that:
 * - Anonymous clients cannot access x402_payments
 * - Authenticated clients cannot access x402_payments
 * - Only service_role can INSERT/SELECT
 *
 * Prerequisites:
 * - Supabase running locally (supabase start)
 * - Database reset with seed data (supabase db reset)
 */

import { describe, it, expect } from 'vitest';
import { setupRlsClients } from '../../src/tests/rls/helpers';

describe('RLS: x402_payments', () => {
  const c = setupRlsClients();

  it('anon client CANNOT select from x402_payments', async () => {
    const { data, error } = await c.anonClient
      .from('x402_payments')
      .select('id')
      .limit(1);

    // RLS blocks anon — either error or empty result
    if (error) {
      expect(error.code).toBeTruthy();
    } else {
      expect(data).toHaveLength(0);
    }
  });

  it('authenticated client CANNOT select from x402_payments', async () => {
    const { data, error } = await c.authClient
      .from('x402_payments')
      .select('id')
      .limit(1);

    // RLS blocks authenticated — either error or empty result
    if (error) {
      expect(error.code).toBeTruthy();
    } else {
      expect(data).toHaveLength(0);
    }
  });

  it('authenticated client CANNOT insert into x402_payments', async () => {
    const { error } = await c.authClient.from('x402_payments').insert({
      tx_hash: 'rls-test-hash',
      network: 'eip155:84532',
      amount_usd: 0.01,
      payer_address: '0x0000000000000000000000000000000000000001',
      payee_address: '0x0000000000000000000000000000000000000002',
      facilitator_url: 'https://x402.org/facilitator',
    });

    expect(error).not.toBeNull();
  });

  it('service_role client CAN insert and select from x402_payments', async () => {
    const testTxHash = `rls-test-${Date.now()}`;

    const { error: insertError } = await c.serviceClient
      .from('x402_payments')
      .insert({
        tx_hash: testTxHash,
        network: 'eip155:84532',
        amount_usd: 0.01,
        payer_address: '0x0000000000000000000000000000000000000001',
        payee_address: '0x0000000000000000000000000000000000000002',
        facilitator_url: 'https://x402.org/facilitator',
      });

    expect(insertError).toBeNull();

    const { data, error: selectError } = await c.serviceClient
      .from('x402_payments')
      .select('id, tx_hash')
      .eq('tx_hash', testTxHash)
      .limit(1);

    expect(selectError).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].tx_hash).toBe(testTxHash);

    // Cleanup
    await c.serviceClient
      .from('x402_payments')
      .delete()
      .eq('tx_hash', testTxHash);
  });
});
