/**
 * x402 Payment Logger (X402-IMPL-003)
 *
 * Logs x402 payments to billing_events table alongside x402_payments.
 * Provides a dual-insert function that records payment in both tables
 * within error boundaries (billing_events failure should not block
 * the payment flow).
 *
 * billing_events schema:
 *   - event_type: 'x402_payment' | 'x402_refund'
 *   - payload: JSON with tx_hash, network, amount, payer, payee, endpoint
 *   - idempotency_key: tx_hash (prevents duplicate billing events)
 */

/** Payment details for logging */
export interface X402PaymentDetails {
  txHash: string;
  network: string;
  amountUsd: number;
  payerAddress: string;
  payeeAddress: string;
  endpoint: string;
  requestId?: string;
  status: 'settled' | 'refund_required';
}

/** Billing event to insert */
export interface BillingEventInsert {
  event_type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
}

/** Injectable DB layer for testing */
export interface PaymentLogStore {
  insertBillingEvent(event: BillingEventInsert): Promise<{ success: boolean; error?: string }>;
}

/**
 * Build a billing event from x402 payment details.
 */
export function buildBillingEvent(details: X402PaymentDetails): BillingEventInsert {
  const eventType = details.status === 'settled' ? 'x402_payment' : 'x402_refund';

  return {
    event_type: eventType,
    payload: {
      tx_hash: details.txHash,
      network: details.network,
      amount_usd: details.amountUsd,
      payer_address: details.payerAddress,
      payee_address: details.payeeAddress,
      endpoint: details.endpoint,
      request_id: details.requestId ?? null,
      recorded_at: new Date().toISOString(),
    },
    // Use tx_hash as idempotency key to prevent duplicate billing events
    idempotency_key: `x402:${details.txHash}`,
  };
}

/**
 * Log an x402 payment to billing_events.
 *
 * This should be called AFTER the x402_payments insert succeeds.
 * Failures here are logged but do not block the payment flow.
 *
 * @param store - Injectable DB layer
 * @param details - Payment details
 * @returns Whether the billing event was successfully recorded
 */
export async function logPaymentToBilling(
  store: PaymentLogStore,
  details: X402PaymentDetails,
): Promise<boolean> {
  const event = buildBillingEvent(details);

  const result = await store.insertBillingEvent(event);

  if (!result.success) {
    // Duplicate idempotency_key means we already logged this payment
    if (result.error?.includes('23505')) {
      return true; // Already logged — not an error
    }
    return false;
  }

  return true;
}
