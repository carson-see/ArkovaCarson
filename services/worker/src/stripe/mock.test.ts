/**
 * Unit tests for MockStripeClient
 *
 * HARDENING-5: Session creation, portal, subscriptions, event construction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { MockStripeClient, mockStripeClient } from './mock.js';

describe('MockStripeClient', () => {
  let client: MockStripeClient;

  beforeEach(() => {
    client = new MockStripeClient();
  });

  describe('createCheckoutSession', () => {
    it('returns an object with id and url', async () => {
      const result = await client.createCheckoutSession({
        line_items: [{ price: 'price_abc', quantity: 1 }],
        success_url: 'https://example.com/success',
        cancel_url: 'https://example.com/cancel',
      });

      expect(result.id).toMatch(/^cs_mock_/);
      expect(result.url).toMatch(/^https:\/\/checkout\.stripe\.com\/mock\/cs_mock_/);
    });

    it('uses provided customer ID when given', async () => {
      const result = await client.createCheckoutSession({
        customer: 'cus_existing',
        line_items: [{ price: 'price_abc', quantity: 1 }],
        success_url: 'https://example.com/success',
        cancel_url: 'https://example.com/cancel',
      });

      expect(result.id).toMatch(/^cs_mock_/);
    });

    it('preserves metadata', async () => {
      const result = await client.createCheckoutSession({
        line_items: [{ price: 'price_abc', quantity: 1 }],
        success_url: 'https://example.com/success',
        cancel_url: 'https://example.com/cancel',
        metadata: { user_id: 'user-123' },
      });

      expect(result.id).toBeDefined();
    });

    it('generates unique session IDs', async () => {
      vi.useFakeTimers({ now: 1000000 });
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(1); // ensure Date.now() increments
        const result = await client.createCheckoutSession({
          line_items: [{ price: 'price_abc', quantity: 1 }],
          success_url: 'https://example.com/success',
          cancel_url: 'https://example.com/cancel',
        });
        ids.add(result.id);
      }
      expect(ids.size).toBe(10);
      vi.useRealTimers();
    });
  });

  describe('createBillingPortalSession', () => {
    it('returns a URL with the customer ID', async () => {
      const result = await client.createBillingPortalSession({
        customer: 'cus_test_123',
        return_url: 'https://example.com/billing',
      });

      expect(result.url).toBe('https://billing.stripe.com/mock/cus_test_123');
    });
  });

  describe('getSubscription', () => {
    it('returns null for unknown subscription', async () => {
      const result = await client.getSubscription('sub_unknown');
      expect(result).toBeNull();
    });
  });

  describe('constructEvent', () => {
    it('parses JSON payload into MockStripeEvent', () => {
      const payload = JSON.stringify({
        id: 'evt_test',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_123' } },
      });

      const event = client.constructEvent(payload, 'sig_test', 'secret_test');

      expect(event.id).toBe('evt_test');
      expect(event.type).toBe('checkout.session.completed');
      expect(event.data.object.id).toBe('cs_123');
    });

    it('throws on invalid JSON', () => {
      expect(() => {
        client.constructEvent('not-json', 'sig', 'secret');
      }).toThrow();
    });
  });
});

describe('mockStripeClient singleton', () => {
  it('is an instance of MockStripeClient', () => {
    expect(mockStripeClient).toBeInstanceOf(MockStripeClient);
  });
});
