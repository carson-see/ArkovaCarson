/**
 * Mock Stripe Client
 *
 * Mock implementation for testing. Per Constitution, mocks are
 * enforced for Stripe and chain APIs in test environments.
 */

import { logger } from '../utils/logger.js';

export interface MockStripeEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

export interface MockCheckoutSession {
  id: string;
  customer: string;
  subscription: string;
  metadata: Record<string, string>;
}

export interface MockSubscription {
  id: string;
  customer: string;
  status: 'active' | 'canceled' | 'past_due';
  items: {
    data: Array<{
      price: {
        id: string;
        product: string;
      };
    }>;
  };
}

export class MockStripeClient {
  private readonly sessions = new Map<string, MockCheckoutSession>();
  private readonly subscriptions = new Map<string, MockSubscription>();

  async createCheckoutSession(params: {
    customer?: string;
    line_items: Array<{ price: string; quantity: number }>;
    success_url: string;
    cancel_url: string;
    metadata?: Record<string, string>;
  }): Promise<{ id: string; url: string }> {
    const sessionId = `cs_mock_${Date.now()}`;
    const customerId = params.customer ?? `cus_mock_${Date.now()}`;

    const session: MockCheckoutSession = {
      id: sessionId,
      customer: customerId,
      subscription: `sub_mock_${Date.now()}`,
      metadata: params.metadata ?? {},
    };

    this.sessions.set(sessionId, session);

    logger.info({ sessionId }, 'Mock: Created checkout session');

    return {
      id: sessionId,
      url: `https://checkout.stripe.com/mock/${sessionId}`,
    };
  }

  async createBillingPortalSession(params: {
    customer: string;
    return_url: string;
  }): Promise<{ url: string }> {
    logger.info({ customer: params.customer }, 'Mock: Created billing portal session');

    return {
      url: `https://billing.stripe.com/mock/${params.customer}`,
    };
  }

  async getSubscription(subscriptionId: string): Promise<MockSubscription | null> {
    return this.subscriptions.get(subscriptionId) ?? null;
  }

  constructEvent(payload: string, signature: string, secret: string): MockStripeEvent {
    // In mock mode, just parse the payload
    logger.info('Mock: Constructing webhook event');
    return JSON.parse(payload) as MockStripeEvent;
  }
}

export const mockStripeClient = new MockStripeClient();
