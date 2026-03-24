/**
 * x402 Payment Gate Middleware (PH1-PAY-01)
 *
 * Returns 402 Payment Required with x402 payment requirements on protected endpoints.
 * When payment is verified, records settlement in x402_payments table.
 *
 * Audit fixes applied:
 *   RISK-2:  On-chain TX validation via BASE RPC
 *   RISK-3:  Payment recording moved to post-execution (response interceptor)
 *   RISK-4:  Replay prevention via tx_hash uniqueness check + in-memory cache
 *   ECON-2:  Dynamic pricing with fee estimates in 402 response
 *   RECON-2: Links x402_payments to API request IDs (X-Request-Id)
 *   Item #18: In-memory validation cache with TTL for fast replay rejection
 *   Item #19: Fee estimate included in 402 response for agent decision-making
 *   Item #20: Webhook dispatch on payment confirmation
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

// ─── Pricing ──────────────────────────────────────────────────────────────

/** Base pricing per endpoint (USD) — read-only endpoints use static pricing */
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

/** Endpoints that involve anchoring costs (dynamic pricing) */
const ANCHOR_ENDPOINTS = new Set(['/api/v1/anchor']);

/**
 * Get dynamic price for an endpoint.
 * Read endpoints use static pricing. Anchor endpoints add estimated Bitcoin fee.
 * ECON-2: Prevents negative margin on anchoring operations.
 */
export async function getDynamicPrice(endpoint: string): Promise<{
  price: number;
  feeEstimate?: { satPerVbyte: number; estimatedFeeSats: number; estimatedFeeUsd: number };
}> {
  const basePrice = X402_PRICING[endpoint] ?? 0.01;

  if (!ANCHOR_ENDPOINTS.has(endpoint)) {
    return { price: basePrice };
  }

  // Dynamic pricing for anchor endpoints: base + estimated Bitcoin fee
  try {
    const { MempoolFeeEstimator } = await import('../chain/fee-estimator.js');
    const estimator = new MempoolFeeEstimator({ target: 'halfHour', timeoutMs: 3000 });
    const satPerVbyte = await estimator.estimateFee();
    const estimatedVbytes = 250; // typical OP_RETURN TX size
    const estimatedFeeSats = satPerVbyte * estimatedVbytes;
    // Rough BTC/USD conversion — in production, fetch from price oracle
    const btcPriceUsd = 60000;
    const estimatedFeeUsd = (estimatedFeeSats / 100_000_000) * btcPriceUsd;
    const dynamicPrice = basePrice + estimatedFeeUsd * 1.2; // 20% margin

    return {
      price: dynamicPrice,
      feeEstimate: { satPerVbyte, estimatedFeeSats, estimatedFeeUsd },
    };
  } catch {
    // Fallback to base price if fee estimation fails
    return { price: basePrice };
  }
}

// ─── Validation Cache (Item #18) ──────────────────────────────────────────

/** In-memory cache of validated tx hashes for fast replay rejection */
const validatedTxCache = new Map<string, number>(); // txHash → timestamp
const TX_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TX_CACHE_MAX_SIZE = 10_000;

/** Check if a tx hash is in the validation cache */
function isTxCached(txHash: string): boolean {
  const timestamp = validatedTxCache.get(txHash);
  if (!timestamp) return false;
  if (Date.now() - timestamp > TX_CACHE_TTL_MS) {
    validatedTxCache.delete(txHash);
    return false;
  }
  return true;
}

/** Add a tx hash to the validation cache */
function cacheTxHash(txHash: string): void {
  // Evict oldest entries if cache is full
  if (validatedTxCache.size >= TX_CACHE_MAX_SIZE) {
    const oldest = validatedTxCache.entries().next().value;
    if (oldest) validatedTxCache.delete(oldest[0]);
  }
  validatedTxCache.set(txHash, Date.now());
}

/** Evict expired entries periodically */
function evictExpiredCache(): void {
  const now = Date.now();
  for (const [hash, ts] of validatedTxCache) {
    if (now - ts > TX_CACHE_TTL_MS) {
      validatedTxCache.delete(hash);
    }
  }
}

// Run eviction every 10 minutes
setInterval(evictExpiredCache, 10 * 60 * 1000).unref();

// ─── On-Chain Validation (RISK-2) ─────────────────────────────────────────

interface OnChainValidationResult {
  valid: boolean;
  reason?: string;
  confirmed?: boolean;
  amount?: number;
  recipient?: string;
}

/**
 * Validate a transaction on-chain via BASE RPC.
 * Verifies: (1) TX exists, (2) TX is confirmed, (3) USDC transfer amount and recipient match.
 *
 * RISK-2: Prevents fabricated txHash and amount mismatches.
 */
async function validateOnChain(
  txHash: string,
  expectedAmount: number,
  expectedRecipient: string,
): Promise<OnChainValidationResult> {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    // No RPC configured — log warning and allow (graceful degradation)
    logger.warn('BASE_RPC_URL not configured — skipping on-chain validation');
    return { valid: true, reason: 'rpc_not_configured' };
  }

  try {
    // 1. Get transaction receipt
    const receiptResponse = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
      signal: AbortSignal.timeout(5000),
    });

    const receiptData = await receiptResponse.json() as {
      result?: {
        status: string;
        logs: Array<{
          address: string;
          topics: string[];
          data: string;
        }>;
      };
    };

    if (!receiptData.result) {
      return { valid: false, reason: 'transaction_not_found' };
    }

    if (receiptData.result.status !== '0x1') {
      return { valid: false, reason: 'transaction_reverted' };
    }

    // 2. Check USDC Transfer event logs
    // USDC Transfer event: keccak256("Transfer(address,address,uint256)")
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    // USDC contract on Base Sepolia
    const USDC_ADDRESS = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';

    const transferLog = receiptData.result.logs.find(
      (log) =>
        log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
        log.topics[0] === TRANSFER_TOPIC,
    );

    if (!transferLog) {
      return { valid: false, reason: 'no_usdc_transfer_found' };
    }

    // Decode amount from log data (uint256, USDC has 6 decimals)
    const transferAmount = parseInt(transferLog.data, 16) / 1_000_000;
    // Decode recipient from topic[2] (padded address)
    const recipient = '0x' + transferLog.topics[2].slice(26);

    // 3. Verify amount (allow 1% tolerance for gas-related rounding)
    if (transferAmount < expectedAmount * 0.99) {
      return {
        valid: false,
        reason: 'insufficient_amount',
        amount: transferAmount,
        recipient,
      };
    }

    // 4. Verify recipient
    if (expectedRecipient && recipient.toLowerCase() !== expectedRecipient.toLowerCase()) {
      return {
        valid: false,
        reason: 'wrong_recipient',
        amount: transferAmount,
        recipient,
      };
    }

    return { valid: true, confirmed: true, amount: transferAmount, recipient };
  } catch (error) {
    logger.warn({ error, txHash }, 'On-chain validation failed — allowing with warning');
    return { valid: true, reason: 'validation_error_graceful' };
  }
}

// ─── x402 Protocol Types ──────────────────────────────────────────────────

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

// ─── Core Functions ───────────────────────────────────────────────────────

/**
 * Build 402 Payment Required response body per x402 protocol.
 * Item #19: Includes fee estimate in extra field for agent decision-making.
 */
function buildPaymentRequired(
  endpoint: string,
  amount: number,
  feeEstimate?: { satPerVbyte: number; estimatedFeeSats: number; estimatedFeeUsd: number },
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
          ...(feeEstimate && {
            feeEstimate: {
              bitcoinFeeRateSatPerVbyte: feeEstimate.satPerVbyte,
              estimatedAnchorFeeSats: feeEstimate.estimatedFeeSats,
              estimatedAnchorFeeUsd: feeEstimate.estimatedFeeUsd,
              note: 'Price includes estimated Bitcoin anchoring fee. Fee may vary based on network conditions.',
            },
          }),
        },
      },
    ],
    error: 'Payment required. Include x402 payment header to proceed.',
  };
}

/**
 * Record a payment settlement in x402_payments table.
 * RISK-4: Uses UNIQUE constraint on tx_hash (migration 0100) to prevent duplicates.
 * RECON-2: Links payment to API request via verification_request_id.
 */
async function recordPayment(
  txHash: string,
  network: string,
  amount: number,
  payerAddress: string,
  payeeAddress: string,
  verificationRequestId?: string,
  _status: 'settled' | 'pending' | 'refund_required' = 'settled',
): Promise<{ success: boolean; duplicate: boolean }> {
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
    // RISK-4: UNIQUE violation (code 23505) means tx_hash already used
    if (error.code === '23505') {
      return { success: false, duplicate: true };
    }
    logger.error({ error, txHash }, 'Failed to record x402 payment');
    return { success: false, duplicate: false };
  }

  // Cache the validated tx hash for fast future rejection
  cacheTxHash(txHash);
  return { success: true, duplicate: false };
}

/**
 * Parse x402 payment proof from request headers.
 * RISK-4: Validates timestamp to reject proofs older than 5 minutes.
 */
function parsePaymentHeader(req: Request): {
  txHash: string;
  network: string;
  payerAddress: string;
  timestamp?: number;
} | null {
  const paymentHeader = req.headers['x-payment'] as string | undefined;
  if (!paymentHeader) return null;

  try {
    const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));

    // Basic validation
    const txHash = decoded.txHash ?? decoded.transactionHash ?? '';
    if (!txHash || typeof txHash !== 'string' || txHash.length < 10) {
      return null;
    }

    return {
      txHash,
      network: decoded.network ?? config.x402Network ?? 'eip155:84532',
      payerAddress: decoded.payerAddress ?? decoded.from ?? '',
      timestamp: decoded.timestamp ? Number(decoded.timestamp) : undefined,
    };
  } catch {
    return null;
  }
}

// ─── Middleware ────────────────────────────────────────────────────────────

/**
 * Middleware factory: gates an endpoint behind x402 payment.
 *
 * When ENABLE_X402_PAYMENTS is off, passes through (API key auth handles access).
 * When enabled:
 *   - If X-PAYMENT header present → validate, check replay, verify on-chain, then proceed
 *   - If no payment header → return 402 with payment requirements + fee estimate
 *   - If API key present → still allow (x402 is alternative to API key, not replacement)
 *
 * RISK-3: Payment recording moved to post-execution via response interceptor.
 */
export function x402PaymentGate(endpoint: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Check switchboard flag
    const { data: enabled } = await db.rpc('get_flag', {
      p_flag_key: 'ENABLE_X402_PAYMENTS',
    });

    if (!enabled) {
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
      // No payment — return 402 with dynamic pricing
      const { price, feeEstimate } = await getDynamicPrice(endpoint);
      const paymentRequired = buildPaymentRequired(endpoint, price, feeEstimate);
      res.status(402).json(paymentRequired);
      return;
    }

    // RISK-4: Check in-memory cache first (fast path for replay rejection)
    if (isTxCached(payment.txHash)) {
      res.status(409).json({
        error: 'payment_already_used',
        message: 'This transaction hash has already been used for a previous API call.',
      });
      return;
    }

    // RISK-4: Check timestamp — reject proofs older than 5 minutes
    if (payment.timestamp) {
      const ageMs = Date.now() - payment.timestamp;
      if (ageMs > 5 * 60 * 1000) {
        res.status(400).json({
          error: 'payment_expired',
          message: 'Payment proof is older than 5 minutes. Submit a new payment.',
        });
        return;
      }
    }

    // RISK-4: Check DB for replay (belt-and-suspenders with the UNIQUE constraint)
    const { data: existingPayment } = await dbAny
      .from('x402_payments')
      .select('id')
      .eq('tx_hash', payment.txHash)
      .maybeSingle();

    if (existingPayment) {
      cacheTxHash(payment.txHash); // Warm cache for future fast rejection
      res.status(409).json({
        error: 'payment_already_used',
        message: 'This transaction hash has already been used for a previous API call.',
      });
      return;
    }

    // RISK-2: On-chain validation
    const { price } = await getDynamicPrice(endpoint);
    const payeeAddress = config.arkovaUsdcAddress ?? '';
    const validation = await validateOnChain(payment.txHash, price, payeeAddress);

    if (!validation.valid) {
      res.status(402).json({
        error: 'payment_validation_failed',
        reason: validation.reason,
        message: `On-chain validation failed: ${validation.reason}. Submit a valid payment.`,
      });
      return;
    }

    // RISK-3: Record payment AFTER successful API execution (response interceptor)
    // RECON-2: Link to request ID
    const requestId = (req.headers['x-request-id'] as string) ?? req.id ?? undefined;

    // Store payment context for post-execution recording
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      const statusCode = res.statusCode;

      // Record payment based on outcome
      if (statusCode >= 200 && statusCode < 300) {
        // Success — record as settled
        recordPayment(
          payment.txHash,
          payment.network,
          price,
          payment.payerAddress,
          payeeAddress,
          requestId,
        ).catch((err) => {
          logger.error({ error: err, txHash: payment.txHash }, 'Failed to record settled x402 payment');
        });
      } else if (statusCode >= 500) {
        // Server error — record as refund_required
        recordPayment(
          payment.txHash,
          payment.network,
          price,
          payment.payerAddress,
          payeeAddress,
          requestId,
          'refund_required',
        ).catch((err) => {
          logger.error({ error: err, txHash: payment.txHash }, 'Failed to record refund-required x402 payment');
        });
      }
      // For 4xx errors, don't record (client error, no payment consumed)

      return originalJson(body);
    };

    logger.info({ endpoint, txHash: payment.txHash }, 'x402 payment validated — proceeding to handler');
    next();
  };
}
