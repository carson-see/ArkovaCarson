/**
 * Unit tests for Stripe client
 *
 * HARDENING-3: Mock mode vs production mode, signature verification.
 * Coverage: verifyWebhookSignature, createCheckoutSession, createBillingPortalSession.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Hoisted mocks ----

const {
  mockConfig,
  mockConstructEvent,
  mockMockConstructEvent,
  mockMockCreateCheckoutSession,
  mockMockCreateBillingPortalSession,
  mockStripeCheckoutCreate,
  mockStripeBillingPortalCreate,
} = vi.hoisted(() => {
  const mockConstructEvent = vi.fn();
  const mockMockConstructEvent = vi.fn();
  const mockMockCreateCheckoutSession = vi.fn();
  const mockMockCreateBillingPortalSession = vi.fn();
  const mockStripeCheckoutCreate = vi.fn();
  const mockStripeBillingPortalCreate = vi.fn();

  const mockConfig = {
    stripeSecretKey: 'sk_test_mock_key',
    stripeWebhookSecret: 'whsec_test_mock_secret',
    useMocks: false,
    nodeEnv: 'test',
  };

  return {
    mockConfig,
    mockConstructEvent,
    mockMockConstructEvent,
    mockMockCreateCheckoutSession,
    mockMockCreateBillingPortalSession,
    mockStripeCheckoutCreate,
    mockStripeBillingPortalCreate,
  };
});

// ---- Module mocks ----

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

vi.mock('./mock.js', () => ({
  mockStripeClient: {
    constructEvent: mockMockConstructEvent,
    createCheckoutSession: mockMockCreateCheckoutSession,
    createBillingPortalSession: mockMockCreateBillingPortalSession,
  },
}));

// Mock Stripe constructor so it doesn't try to initialize with invalid key
vi.mock('stripe', async () => {
  function MockStripe() {
    return {
      webhooks: {
        constructEvent: mockConstructEvent,
      },
      checkout: { sessions: { create: mockStripeCheckoutCreate } },
      billingPortal: { sessions: { create: mockStripeBillingPortalCreate } },
    };
  }
  return { default: MockStripe, Stripe: MockStripe };
});

// ---- System under test ----

import { verifyWebhookSignature, createCheckoutSession, createBillingPortalSession } from './client.js';

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

// ================================================================
// createCheckoutSession
// ================================================================

const CHECKOUT_PARAMS = {
  priceId: 'price_test_123',
  userId: 'user-uuid-001',
  customerEmail: 'user@example.com',
  successUrl: 'https://app.example.com/billing/success',
  cancelUrl: 'https://app.example.com/billing/cancel',
};

describe('createCheckoutSession', () => {
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

    it('uses mockStripeClient.createCheckoutSession in mock mode', async () => {
      mockMockCreateCheckoutSession.mockResolvedValue({
        id: 'cs_mock_123',
        url: 'https://checkout.stripe.com/mock/cs_mock_123',
      });

      const result = await createCheckoutSession(CHECKOUT_PARAMS);

      expect(mockMockCreateCheckoutSession).toHaveBeenCalledOnce();
      expect(mockStripeCheckoutCreate).not.toHaveBeenCalled();
      expect(result).toEqual({
        sessionId: 'cs_mock_123',
        url: 'https://checkout.stripe.com/mock/cs_mock_123',
      });
    });

    it('passes correct params to mock client', async () => {
      mockMockCreateCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://x' });

      await createCheckoutSession(CHECKOUT_PARAMS);

      expect(mockMockCreateCheckoutSession).toHaveBeenCalledWith({
        line_items: [{ price: 'price_test_123', quantity: 1 }],
        success_url: CHECKOUT_PARAMS.successUrl,
        cancel_url: CHECKOUT_PARAMS.cancelUrl,
        metadata: { user_id: 'user-uuid-001', price_id: 'price_test_123' },
        mode: 'subscription',
      });
    });

    it('SCRUM-1265: pipes mode=payment through to mock client (credit-pack purchase)', async () => {
      mockMockCreateCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://x' });

      await createCheckoutSession({ ...CHECKOUT_PARAMS, mode: 'payment' });

      expect(mockMockCreateCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'payment' }),
      );
    });
  });

  describe('production mode (useMocks=false)', () => {
    beforeEach(() => {
      mockConfig.useMocks = false;
    });

    it('uses stripe.checkout.sessions.create in production mode', async () => {
      mockStripeCheckoutCreate.mockResolvedValue({
        id: 'cs_live_456',
        url: 'https://checkout.stripe.com/pay/cs_live_456',
      });

      const result = await createCheckoutSession(CHECKOUT_PARAMS);

      expect(mockStripeCheckoutCreate).toHaveBeenCalledOnce();
      expect(mockMockCreateCheckoutSession).not.toHaveBeenCalled();
      expect(result).toEqual({
        sessionId: 'cs_live_456',
        url: 'https://checkout.stripe.com/pay/cs_live_456',
      });
    });

    it('passes subscription mode and metadata to Stripe SDK', async () => {
      mockStripeCheckoutCreate.mockResolvedValue({ id: 'cs_1', url: 'https://x' });

      await createCheckoutSession(CHECKOUT_PARAMS);

      expect(mockStripeCheckoutCreate).toHaveBeenCalledWith({
        mode: 'subscription',
        line_items: [{ price: 'price_test_123', quantity: 1 }],
        success_url: CHECKOUT_PARAMS.successUrl,
        cancel_url: CHECKOUT_PARAMS.cancelUrl,
        customer_email: 'user@example.com',
        metadata: { user_id: 'user-uuid-001', price_id: 'price_test_123' },
        subscription_data: {
          metadata: { user_id: 'user-uuid-001', price_id: 'price_test_123' },
        },
      });
    });

    it('throws when Stripe returns no URL', async () => {
      mockStripeCheckoutCreate.mockResolvedValue({ id: 'cs_no_url', url: null });

      await expect(createCheckoutSession(CHECKOUT_PARAMS)).rejects.toThrow(
        'Stripe did not return a checkout URL'
      );
    });

    it('propagates Stripe SDK errors', async () => {
      mockStripeCheckoutCreate.mockRejectedValue(new Error('Stripe API error'));

      await expect(createCheckoutSession(CHECKOUT_PARAMS)).rejects.toThrow('Stripe API error');
    });

    // ---- SCRUM-1265 (R2-2) — mode pipe-through ----

    it('SCRUM-1265: passes mode=payment to Stripe SDK and omits subscription_data', async () => {
      mockStripeCheckoutCreate.mockResolvedValue({ id: 'cs_pmt', url: 'https://x' });

      await createCheckoutSession({ ...CHECKOUT_PARAMS, mode: 'payment' });

      const call = mockStripeCheckoutCreate.mock.calls[0]?.[0] as {
        mode: string;
        subscription_data?: unknown;
      };
      expect(call.mode).toBe('payment');
      // subscription_data on payment-mode sessions is a Stripe API error.
      expect(call.subscription_data).toBeUndefined();
    });

    it('SCRUM-1265: defaults to mode=subscription when mode is not provided', async () => {
      mockStripeCheckoutCreate.mockResolvedValue({ id: 'cs_sub', url: 'https://x' });

      await createCheckoutSession(CHECKOUT_PARAMS);

      const call = mockStripeCheckoutCreate.mock.calls[0]?.[0] as {
        mode: string;
        subscription_data?: { metadata?: Record<string, string> };
      };
      expect(call.mode).toBe('subscription');
      expect(call.subscription_data?.metadata).toEqual(
        expect.objectContaining({ user_id: 'user-uuid-001' }),
      );
    });
  });
});

// ================================================================
// createBillingPortalSession
// ================================================================

const PORTAL_PARAMS = {
  customerId: 'cus_test_789',
  returnUrl: 'https://app.example.com/settings',
};

describe('createBillingPortalSession', () => {
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

    it('uses mockStripeClient.createBillingPortalSession in mock mode', async () => {
      mockMockCreateBillingPortalSession.mockResolvedValue({
        url: 'https://billing.stripe.com/mock/cus_test_789',
      });

      const result = await createBillingPortalSession(PORTAL_PARAMS);

      expect(mockMockCreateBillingPortalSession).toHaveBeenCalledOnce();
      expect(mockStripeBillingPortalCreate).not.toHaveBeenCalled();
      expect(result).toEqual({
        url: 'https://billing.stripe.com/mock/cus_test_789',
      });
    });

    it('passes correct params to mock client', async () => {
      mockMockCreateBillingPortalSession.mockResolvedValue({ url: 'https://x' });

      await createBillingPortalSession(PORTAL_PARAMS);

      expect(mockMockCreateBillingPortalSession).toHaveBeenCalledWith({
        customer: 'cus_test_789',
        return_url: 'https://app.example.com/settings',
      });
    });
  });

  describe('production mode (useMocks=false)', () => {
    beforeEach(() => {
      mockConfig.useMocks = false;
    });

    it('uses stripe.billingPortal.sessions.create in production mode', async () => {
      mockStripeBillingPortalCreate.mockResolvedValue({
        url: 'https://billing.stripe.com/session/bps_live_123',
      });

      const result = await createBillingPortalSession(PORTAL_PARAMS);

      expect(mockStripeBillingPortalCreate).toHaveBeenCalledOnce();
      expect(mockMockCreateBillingPortalSession).not.toHaveBeenCalled();
      expect(result).toEqual({
        url: 'https://billing.stripe.com/session/bps_live_123',
      });
    });

    it('passes customer and return_url to Stripe SDK', async () => {
      mockStripeBillingPortalCreate.mockResolvedValue({ url: 'https://x' });

      await createBillingPortalSession(PORTAL_PARAMS);

      expect(mockStripeBillingPortalCreate).toHaveBeenCalledWith({
        customer: 'cus_test_789',
        return_url: 'https://app.example.com/settings',
      });
    });

    it('propagates Stripe SDK errors', async () => {
      mockStripeBillingPortalCreate.mockRejectedValue(new Error('Portal API error'));

      await expect(createBillingPortalSession(PORTAL_PARAMS)).rejects.toThrow('Portal API error');
    });
  });
});
