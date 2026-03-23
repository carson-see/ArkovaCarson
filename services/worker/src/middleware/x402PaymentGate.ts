/**
 * x402 Payment Gate Middleware (PH1-PAY-01)
 *
 * Returns 402 Payment Required with x402 payment requirements on protected endpoints.
 * When payment is verified, records settlement in x402_payments table.
 *
 * Gated by ENABLE_X402_PAYMENTS switchboard flag.
 * Falls back to API key auth when x402 is disabled.
 *
 * Constitution refs:
 *   - 1.9: ENABLE_X402_PAYMENTS controls whether 402 responses are sent
 *   - 1.4: Payment addresses never logged
 */

import { Request, Response, NextFunction } from 'express';
import { db } from '../utils/db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// x402_payments table from migration 0080 — not yet in generated types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

/** Pricing per endpoint (USD) */
export const X402_PRICING: Record<string, number> = {
  '/api/v1/verify': 0.002,
  '/api/v1/verify/batch': 0.002, // per item — multiplied by count
  '/api/v1/verify/entity': 0.005,
  '/api/v1/compliance/check': 0.01,
  '/api/v1/regulatory/lookup': 0.002,
  '/api/v1/cle': 0.005,
  '/api/v1/ai/search': 0.01,
  '/api/v1/nessie/query': 0.01,
};

/** x402 payment requirement response per the protocol spec */
interface X402PaymentRequired {
  x402Version: 1;
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    resource: string;
    description: string;
    mimeType: string;
    payTo: string;
    maxTimeoutSeconds: number;
    asset: string;
    extra?: Record<string, unknown>;
  }>;
  error: string;
}

/**
 * Build 402 Payment Required response body per x402 protocol.
 */
function buildPaymentRequired(
  endpoint: string,
  amount: number,
): X402PaymentRequired {
  const facilitatorUrl = config.x402FacilitatorUrl ?? 'https://x402.org/facilitator';
  const payeeAddress = config.arkovaUsdcAddress ?? '';
  const network = config.x402Network ?? 'eip155:84532'; // Base Sepolia default

  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network,
        maxAmountRequired: String(Math.round(amount * 1_000_000)), // USDC has 6 decimals
        resource: endpoint,
        description: `Arkova verification: ${endpoint}`,
        mimeType: 'application/json',
        payTo: payeeAddress,
        maxTimeoutSeconds: 60,
        asset: 'USDC',
        extra: {
          facilitatorUrl,
        },
      },
    ],
    error: 'Payment required. Include x402 payment header to proceed.',
  };
}

/**
 * Record a payment settlement in x402_payments table.
 */
async function recordPayment(
  txHash: string,
  network: string,
  amount: number,
  payerAddress: string,
  payeeAddress: string,
  verificationRequestId?: string,
): Promise<void> {
  const { error } = await dbAny.from('x402_payments').insert({
    tx_hash: txHash,
    network,
    amount_usd: amount,
    payer_address: payerAddress,
    payee_address: payeeAddress,
    token: 'USDC',
    facilitator_url: config.x402FacilitatorUrl ?? 'https://x402.org/facilitator',
    verification_request_id: verificationRequestId ?? null,
    raw_response: null,
  });

  if (error) {
    logger.error({ error, txHash }, 'Failed to record x402 payment');
  }
}

/**
 * Parse x402 payment proof from request headers.
 * The x402 protocol uses the X-PAYMENT header with a base64-encoded JSON payload.
 */
function parsePaymentHeader(req: Request): {
  txHash: string;
  network: string;
  payerAddress: string;
} | null {
  const paymentHeader = req.headers['x-payment'] as string | undefined;
  if (!paymentHeader) return null;

  try {
    const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
    return {
      txHash: decoded.txHash ?? decoded.transactionHash ?? '',
      network: decoded.network ?? config.x402Network ?? 'eip155:84532',
      payerAddress: decoded.payerAddress ?? decoded.from ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * Middleware factory: gates an endpoint behind x402 payment.
 *
 * When ENABLE_X402_PAYMENTS is off, passes through (API key auth handles access).
 * When enabled:
 *   - If X-PAYMENT header present → validate and record payment, then proceed
 *   - If no payment header → return 402 with payment requirements
 *   - If API key present → still allow (x402 is alternative to API key, not replacement)
 */
export function x402PaymentGate(endpoint: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Check switchboard flag
    const { data: enabled } = await db.rpc('get_flag', {
      p_flag_key: 'ENABLE_X402_PAYMENTS',
    });

    if (!enabled) {
      // x402 disabled — fall through to normal auth
      next();
      return;
    }

    // If the request has an API key, allow through (x402 is alternative)
    if (req.apiKey) {
      next();
      return;
    }

    // Check for x402 payment header
    const payment = parsePaymentHeader(req);
    if (!payment) {
      // No payment — return 402
      const amount = X402_PRICING[endpoint] ?? 0.01;
      const paymentRequired = buildPaymentRequired(endpoint, amount);
      res.status(402).json(paymentRequired);
      return;
    }

    // Payment header present — record and proceed
    const amount = X402_PRICING[endpoint] ?? 0.01;
    const payeeAddress = config.arkovaUsdcAddress ?? '';

    await recordPayment(
      payment.txHash,
      payment.network,
      amount,
      payment.payerAddress,
      payeeAddress,
    );

    logger.info({ endpoint, txHash: payment.txHash }, 'x402 payment recorded');
    next();
  };
}
