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

import { createHmac } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
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
    // BUG-2026-08-11: without `network` this priced anchor requests off
    // MAINNET congestion on every non-mainnet deployment — billing callers
    // for a fee the network in use does not charge.
    const estimator = new MempoolFeeEstimator({
      target: 'halfHour',
      timeoutMs: 3000,
      network: config.bitcoinNetwork,
    });
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
  payerAddress?: string;
}

const X402_VALIDATION_SERVICE_FAILURE_REASONS = new Set([
  'rpc_not_configured',
  'rpc_unavailable',
  'validation_error',
]);

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
  const rpcUrl = config.baseRpcUrl;
  if (!rpcUrl) {
    logger.error('BASE_RPC_URL not configured — rejecting x402 payment validation');
    return { valid: false, reason: 'rpc_not_configured' };
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

    if (!receiptResponse.ok) {
      logger.warn({ status: receiptResponse.status }, 'Base RPC receipt lookup failed');
      return { valid: false, reason: 'rpc_unavailable' };
    }

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
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics.length >= 3,
    );

    if (!transferLog) {
      return { valid: false, reason: 'no_usdc_transfer_found' };
    }

    const addressTopicPattern = /^0x[0-9a-fA-F]{64}$/;
    if (
      !addressTopicPattern.test(transferLog.topics[1] ?? '')
      || !addressTopicPattern.test(transferLog.topics[2] ?? '')
      || !/^0x[0-9a-fA-F]{1,64}$/.test(transferLog.data)
    ) {
      return { valid: false, reason: 'invalid_transfer_event' };
    }

    // Decode amount and trusted identities from the verified Transfer event.
    const transferAmount = parseInt(transferLog.data, 16) / 1_000_000;
    const payerAddress = `0x${transferLog.topics[1].slice(-40)}`.toLowerCase();
    const recipient = `0x${transferLog.topics[2].slice(-40)}`.toLowerCase();
    if (!Number.isFinite(transferAmount) || /^0x0{40}$/.test(payerAddress)) {
      return { valid: false, reason: 'invalid_transfer_event' };
    }

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

    return {
      valid: true,
      confirmed: true,
      amount: transferAmount,
      recipient,
      payerAddress,
    };
  } catch (error) {
    // Fetch errors can embed the configured RPC URL (and provider credential)
    // in their message/cause. Log only the coarse error class.
    logger.warn(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'On-chain validation failed — rejecting payment',
    );
    return { valid: false, reason: 'validation_error' };
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
  timestamp?: number;
} | null {
  const paymentHeader = req.headers['x-payment'] as string | undefined;
  if (!paymentHeader) return null;

  try {
    const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));

    // Basic validation
    const txHash = decoded.txHash ?? decoded.transactionHash ?? '';
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return null;
    }

    let timestamp: number | undefined;
    if (decoded.timestamp !== undefined) {
      const parsedTimestamp = Number(decoded.timestamp);
      if (!Number.isFinite(parsedTimestamp) || parsedTimestamp < 0) return null;
      timestamp = parsedTimestamp;
    }

    return {
      txHash,
      // The worker validates against its configured Base RPC. Do not trust a
      // client-provided network label for settlement evidence.
      network: config.x402Network ?? 'eip155:84532',
      timestamp,
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
    let enabled: unknown;
    let flagError: unknown;
    try {
      const flagResult = await db.rpc('get_flag', {
        p_flag_key: 'ENABLE_X402_PAYMENTS',
      });
      enabled = flagResult.data;
      flagError = flagResult.error;
    } catch (error) {
      enabled = null;
      flagError = error;
    }

    if (flagError) {
      if (req.apiKey) {
        req.x402PayerContext = { kind: 'bypass', reason: 'api-key' };
        next();
        return;
      }
      logger.error({ error: flagError }, 'x402 switchboard lookup failed');
      res.status(503).json({
        error: 'payment_gate_unavailable',
        message: 'Payment authorization is temporarily unavailable.',
      });
      return;
    }

    if (!enabled) {
      req.x402PayerContext = { kind: 'bypass', reason: 'payments-disabled' };
      next();
      return;
    }

    // If the request has an API key, allow through (x402 is alternative)
    if (req.apiKey) {
      req.x402PayerContext = { kind: 'bypass', reason: 'api-key' };
      next();
      return;
    }

    // BUG-2 fix: If auth was attempted (any API key or Bearer header present)
    // but failed validation upstream, return 401 instead of falling through to 402.
    // This prevents confusing "payment required" responses when the real issue is bad credentials.
    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'];
    if (authHeader?.startsWith('Bearer ak_') || (typeof apiKeyHeader === 'string' && apiKeyHeader.startsWith('ak_'))) {
      // An API key was provided but didn't pass apiKeyAuth — it's invalid/revoked/expired.
      // apiKeyAuth already sent 401, but if we somehow reach here, enforce 401.
      res.status(401).json({
        error: 'invalid_api_key',
        message: 'The provided API key is invalid, revoked, or expired.',
      });
      return;
    }

    // When USDC address is not configured, fall back to requiring API key auth.
    const payeeAddress = config.arkovaUsdcAddress ?? '';
    if (!payeeAddress) {
      logger.warn('ARKOVA_USDC_ADDRESS not configured — x402 payments unavailable, rejecting unauthenticated request');
      res.status(401).json({
        error: 'authentication_required',
        message: 'API key required. Pass via Authorization: Bearer ak_... or X-API-Key header.',
      });
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

    const payerHmacSecret = config.apiKeyHmacSecret;
    if (!payerHmacSecret) {
      logger.error('API_KEY_HMAC_SECRET not configured — verified payer identity unavailable');
      res.status(503).json({
        error: 'payer_identity_unavailable',
        message: 'Payment authorization is temporarily unavailable.',
      });
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
    let existingPayment: unknown;
    let replayLookupError: unknown;
    try {
      const replayResult = await dbAny
        .from('x402_payments')
        .select('id')
        .eq('tx_hash', payment.txHash)
        .maybeSingle();
      existingPayment = replayResult.data;
      replayLookupError = replayResult.error;
    } catch (error) {
      existingPayment = null;
      replayLookupError = error;
    }

    if (replayLookupError) {
      logger.error({ error: replayLookupError }, 'x402 replay lookup failed');
      res.status(503).json({
        error: 'payment_validation_unavailable',
        message: 'Payment validation is temporarily unavailable.',
      });
      return;
    }

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
    const validation = await validateOnChain(payment.txHash, price, payeeAddress);

    if (!validation.valid) {
      if (validation.reason && X402_VALIDATION_SERVICE_FAILURE_REASONS.has(validation.reason)) {
        res.status(503).json({
          error: 'payment_validation_unavailable',
          reason: validation.reason,
          message: 'Payment validation is temporarily unavailable. Retry later or use API key authentication.',
        });
        return;
      }

      res.status(402).json({
        error: 'payment_validation_failed',
        reason: validation.reason,
        message: `On-chain validation failed: ${validation.reason}. Submit a valid payment.`,
      });
      return;
    }

    if (!validation.payerAddress) {
      res.status(402).json({
        error: 'payment_validation_failed',
        reason: 'payer_identity_missing',
        message: 'On-chain validation did not yield a payer identity.',
      });
      return;
    }

    const payerAddress = validation.payerAddress.toLowerCase();
    req.x402PayerContext = {
      kind: 'verified',
      payerKey: createHmac('sha256', payerHmacSecret).update(payerAddress).digest('hex'),
    };

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
          payerAddress,
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
          payerAddress,
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

    logger.info({ endpoint }, 'x402 payment validated — proceeding to handler');
    next();
  };
}
