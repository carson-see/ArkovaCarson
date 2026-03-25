/**
 * X402-IMPL-003: x402 Payment Logger Tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildBillingEvent,
  logPaymentToBilling,
} from '../x402PaymentLogger.js';
import type { X402PaymentDetails, PaymentLogStore } from '../x402PaymentLogger.js';

const SAMPLE_PAYMENT: X402PaymentDetails = {
  txHash: '0xabc123def456',
  network: 'base-sepolia',
  amountUsd: 0.01,
  payerAddress: '0x1234567890abcdef',
  payeeAddress: '0xfedcba0987654321',
  endpoint: '/api/v1/verify',
  requestId: 'req-001',
  status: 'settled',
};

describe('X402-IMPL-003: buildBillingEvent', () => {
  it('builds settled payment event', () => {
    const event = buildBillingEvent(SAMPLE_PAYMENT);

    expect(event.event_type).toBe('x402_payment');
    expect(event.idempotency_key).toBe('x402:0xabc123def456');
    expect(event.payload.tx_hash).toBe('0xabc123def456');
    expect(event.payload.network).toBe('base-sepolia');
    expect(event.payload.amount_usd).toBe(0.01);
    expect(event.payload.payer_address).toBe('0x1234567890abcdef');
    expect(event.payload.payee_address).toBe('0xfedcba0987654321');
    expect(event.payload.endpoint).toBe('/api/v1/verify');
    expect(event.payload.request_id).toBe('req-001');
    expect(event.payload.recorded_at).toBeDefined();
  });

  it('builds refund event', () => {
    const refund: X402PaymentDetails = { ...SAMPLE_PAYMENT, status: 'refund_required' };
    const event = buildBillingEvent(refund);

    expect(event.event_type).toBe('x402_refund');
  });

  it('handles missing requestId', () => {
    const noReqId: X402PaymentDetails = { ...SAMPLE_PAYMENT, requestId: undefined };
    const event = buildBillingEvent(noReqId);

    expect(event.payload.request_id).toBeNull();
  });
});

describe('X402-IMPL-003: logPaymentToBilling', () => {
  it('successfully logs payment to billing events', async () => {
    const store: PaymentLogStore = {
      insertBillingEvent: vi.fn().mockResolvedValue({ success: true }),
    };

    const result = await logPaymentToBilling(store, SAMPLE_PAYMENT);

    expect(result).toBe(true);
    expect(store.insertBillingEvent).toHaveBeenCalledOnce();
    const insertedEvent = (store.insertBillingEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertedEvent.event_type).toBe('x402_payment');
  });

  it('returns true for duplicate payments (already logged)', async () => {
    const store: PaymentLogStore = {
      insertBillingEvent: vi.fn().mockResolvedValue({ success: false, error: 'duplicate key value violates unique constraint (23505)' }),
    };

    const result = await logPaymentToBilling(store, SAMPLE_PAYMENT);
    expect(result).toBe(true); // Duplicate is OK
  });

  it('returns false for other insert errors', async () => {
    const store: PaymentLogStore = {
      insertBillingEvent: vi.fn().mockResolvedValue({ success: false, error: 'connection timeout' }),
    };

    const result = await logPaymentToBilling(store, SAMPLE_PAYMENT);
    expect(result).toBe(false);
  });

  it('logs refund events correctly', async () => {
    const store: PaymentLogStore = {
      insertBillingEvent: vi.fn().mockResolvedValue({ success: true }),
    };

    const refund: X402PaymentDetails = { ...SAMPLE_PAYMENT, status: 'refund_required' };
    await logPaymentToBilling(store, refund);

    const insertedEvent = (store.insertBillingEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertedEvent.event_type).toBe('x402_refund');
  });

  it('uses tx_hash as idempotency key', async () => {
    const store: PaymentLogStore = {
      insertBillingEvent: vi.fn().mockResolvedValue({ success: true }),
    };

    await logPaymentToBilling(store, SAMPLE_PAYMENT);

    const insertedEvent = (store.insertBillingEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertedEvent.idempotency_key).toBe(`x402:${SAMPLE_PAYMENT.txHash}`);
  });
});
