/**
 * Unit tests for Stripe client (webhook signature verification)
 *
 * HARDENING-3: Mock mode vs production mode, signature verification.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Hoisted mocks ----

const { mockConfig, mockConstructEvent, mockMockConstructEvent } = vi.hoisted(() => {
  const mockConstructEvent = vi.fn();
  const mockMockConstructEvent = vi.fn();

  const mockConfig = {
    stripeSecretKey: 'sk_test_mock_key',
    stripeWebhookSecret: 'whsec_test_mock_secret',
    useMocks: false,
    nodeEnv: 'test',
  };

  return { mockConfig, mockConstructEvent, mockMockConstructEvent };
});

// ---- Module mocks ----

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

vi.mock('./mock.js', () => ({
  mockStripeClient: {
    constructEvent: mockMockConstructEvent,
  },
}));

// Mock Stripe constructor so it doesn't try to initialize with invalid key
vi.mock('stripe', () => {
  const MockStripe = vi.fn(() => ({
    webhooks: {
      constructEvent: mockConstructEvent,
    },
  }));
  return { default: MockStripe };
});

// ---- System under test ----

import { verifyWebhookSignature } from './client.js';

// ---- Test fixtures ----

const MOCK_EVENT = {
  id: 'evt_test_123',
  type: 'checkout.session.completed',
  data: {
    object: {
      id: 'cs_test_123',
      customer: 'cus_test_123',
    },
  },
};

// ================================================================
// verifyWebhookSignature
// ================================================================

describe('verifyWebhookSignature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mock mode (useMocks=true)', () => {
    beforeEach(() => {
      mockConfig.useMocks = true;
    });

    afterEach(() => {
      mockConfig.useMocks = false;
    });

    it('uses mockStripeClient.constructEvent in mock mode', () => {
      const payload = JSON.stringify(MOCK_EVENT);
      mockMockConstructEvent.mockReturnValue(MOCK_EVENT);

      const result = verifyWebhookSignature(payload, 'mock-sig');

      expect(mockMockConstructEvent).toHaveBeenCalledOnce();
      expect(mockConstructEvent).not.toHaveBeenCalled();
      expect(result).toEqual(MOCK_EVENT);
    });

    it('passes payload as string to mock client', () => {
      const payload = JSON.stringify(MOCK_EVENT);
      mockMockConstructEvent.mockReturnValue(MOCK_EVENT);

      verifyWebhookSignature(payload, 'mock-sig');

      expect(mockMockConstructEvent).toHaveBeenCalledWith(
        payload,
        'mock-sig',
        mockConfig.stripeWebhookSecret,
      );
    });

    it('converts Buffer payload to string for mock client', () => {
      const payload = Buffer.from(JSON.stringify(MOCK_EVENT));
      mockMockConstructEvent.mockReturnValue(MOCK_EVENT);

      verifyWebhookSignature(payload, 'mock-sig');

      expect(mockMockConstructEvent).toHaveBeenCalledWith(
        payload.toString(),
        'mock-sig',
        mockConfig.stripeWebhookSecret,
      );
    });
  });

  describe('production mode (useMocks=false)', () => {
    beforeEach(() => {
      mockConfig.useMocks = false;
    });

    it('uses stripe.webhooks.constructEvent in production mode', () => {
      const payload = JSON.stringify(MOCK_EVENT);
      mockConstructEvent.mockReturnValue(MOCK_EVENT);

      const result = verifyWebhookSignature(payload, 'real-sig');

      expect(mockConstructEvent).toHaveBeenCalledOnce();
      expect(mockMockConstructEvent).not.toHaveBeenCalled();
      expect(result).toEqual(MOCK_EVENT);
    });

    it('passes payload, signature, and webhook secret to stripe SDK', () => {
      const payload = 'raw-body-string';
      mockConstructEvent.mockReturnValue(MOCK_EVENT);

      verifyWebhookSignature(payload, 'sig-header-value');

      expect(mockConstructEvent).toHaveBeenCalledWith(
        payload,
        'sig-header-value',
        mockConfig.stripeWebhookSecret,
      );
    });

    it('propagates StripeSignatureVerificationError', () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('Signature verification failed');
      });

      expect(() => verifyWebhookSignature('bad-payload', 'bad-sig')).toThrow(
        'Signature verification failed',
      );
    });

    it('passes Buffer payload directly to stripe SDK', () => {
      const payload = Buffer.from('raw-body');
      mockConstructEvent.mockReturnValue(MOCK_EVENT);

      verifyWebhookSignature(payload, 'sig');

      // In production mode, Buffer is passed directly (not converted)
      expect(mockConstructEvent).toHaveBeenCalledWith(
        payload,
        'sig',
        mockConfig.stripeWebhookSecret,
      );
    });
  });
});
