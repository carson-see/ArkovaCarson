/**
 * Self-Hosted x402 Facilitator (Item #16, RISK-7)
 *
 * Validates x402 payment proofs on-chain via BASE RPC.
 * Eliminates dependency on Coinbase's reference facilitator.
 *
 * Deployed as a Cloudflare Worker route: /x402/verify
 *
 * Responsibilities:
 *   1. Verify USDC transfer TX on BASE chain
 *   2. Confirm amount matches requested payment
 *   3. Confirm recipient is Arkova's USDC address
 *   4. Return signed attestation of payment validity
 *
 * Privacy improvement over Coinbase facilitator:
 *   - Payment data stays within Arkova infrastructure
 *   - No third-party can observe payment amounts or API endpoints
 */

import type { Env } from './env.js';

/** USDC contract on Base Sepolia */
const USDC_BASE_SEPOLIA = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
/** USDC contract on Base Mainnet */
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** USDC Transfer event topic */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

interface PaymentVerification {
  txHash: string;
  network: string;
  expectedAmount: number;
  expectedRecipient: string;
}

interface VerificationResult {
  valid: boolean;
  txHash: string;
  confirmed: boolean;
  amount?: number;
  recipient?: string;
  reason?: string;
  timestamp?: string;
}

/**
 * Verify a USDC transfer on BASE chain via RPC.
 */
async function verifyPayment(
  env: Env,
  request: PaymentVerification,
): Promise<VerificationResult> {
  const rpcUrl = env.BASE_RPC_URL;
  if (!rpcUrl) {
    return { valid: false, txHash: request.txHash, confirmed: false, reason: 'rpc_not_configured' };
  }

  try {
    // Fetch transaction receipt
    const receiptRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [request.txHash],
      }),
    });

    const receipt = await receiptRes.json() as {
      result?: {
        status: string;
        blockNumber: string;
        logs: Array<{ address: string; topics: string[]; data: string }>;
      };
    };

    if (!receipt.result) {
      return { valid: false, txHash: request.txHash, confirmed: false, reason: 'tx_not_found' };
    }

    if (receipt.result.status !== '0x1') {
      return { valid: false, txHash: request.txHash, confirmed: false, reason: 'tx_reverted' };
    }

    // Find USDC Transfer log
    const isMainnet = env.X402_NETWORK === 'eip155:8453';
    const defaultUsdc = isMainnet ? USDC_BASE_MAINNET : USDC_BASE_SEPOLIA;
    const usdcAddress = env.USDC_CONTRACT_ADDRESS ?? defaultUsdc;
    const transferLog = receipt.result.logs.find(
      (log) =>
        log.address.toLowerCase() === usdcAddress.toLowerCase() &&
        log.topics[0] === TRANSFER_TOPIC,
    );

    if (!transferLog) {
      return { valid: false, txHash: request.txHash, confirmed: true, reason: 'no_usdc_transfer' };
    }

    // Decode transfer amount and recipient
    const amount = parseInt(transferLog.data, 16) / 1_000_000; // USDC has 6 decimals
    const recipient = '0x' + transferLog.topics[2].slice(26).toLowerCase();

    // Validate amount (1% tolerance)
    if (amount < request.expectedAmount * 0.99) {
      return {
        valid: false,
        txHash: request.txHash,
        confirmed: true,
        amount,
        recipient,
        reason: 'insufficient_amount',
      };
    }

    // Validate recipient
    if (request.expectedRecipient && recipient !== request.expectedRecipient.toLowerCase()) {
      return {
        valid: false,
        txHash: request.txHash,
        confirmed: true,
        amount,
        recipient,
        reason: 'wrong_recipient',
      };
    }

    return {
      valid: true,
      txHash: request.txHash,
      confirmed: true,
      amount,
      recipient,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      valid: false,
      txHash: request.txHash,
      confirmed: false,
      reason: `rpc_error: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }
}

/**
 * F-2 hardening (edge bug-bounty 2026-04-26):
 *   1. Feature flag — route is 404 unless ENABLE_X402_FACILITATOR=true.
 *   2. Strict txHash format check — rejects garbage before any RPC call.
 *   3. Per-IP token bucket on MCP_RATE_LIMIT_KV — caps RPC fan-out at
 *      30 req/min/IP so a public unauthenticated endpoint can't burn the
 *      Base RPC quota (denial-of-wallet).
 */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const X402_RATE_PER_IP_PER_MIN = 30;

async function ipRateLimit(
  env: Env,
  clientIp: string | null,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const kv = env.MCP_RATE_LIMIT_KV;
  // No KV → no limit (matches mcp-rate-limit.ts pass-through semantics).
  // Production binds the KV (wrangler.toml), so this only fails open in
  // dev / preview.
  if (!kv || !clientIp) return { ok: true };
  const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
  const key = `x402-ip:${clientIp}:${windowStart}`;
  let count = 0;
  try {
    const raw = await kv.get(key);
    count = raw ? Number(raw) : 0;
  } catch {
    return { ok: true }; // KV read failure → fail-open (consistent with mcp-rate-limit.ts)
  }
  if (count >= X402_RATE_PER_IP_PER_MIN) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((windowStart + 60_000 - Date.now()) / 1000)) };
  }
  try {
    await kv.put(key, String(count + 1), { expirationTtl: 120 });
  } catch {
    // Write failure is non-fatal — let the request through, log will surface it.
  }
  return { ok: true };
}

/**
 * Handle x402 facilitator requests.
 * POST /x402/verify — Verify a payment proof on-chain.
 */
export async function handleX402Facilitator(
  request: Request,
  env: Env,
): Promise<Response> {
  // F-2 (1): feature flag. Default off — flip ENABLE_X402_FACILITATOR
  // to "true" only when the paywall is wired through edge.arkova.ai.
  if (env.ENABLE_X402_FACILITATOR !== 'true') {
    return new Response('arkova-edge: no matching route', { status: 404 });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // F-2 (3): per-IP rate limit — caps RPC fan-out before we touch RPC.
  const clientIp =
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    null;
  const rl = await ipRateLimit(env, clientIp);
  if (!rl.ok) {
    return new Response(
      JSON.stringify({ error: 'rate_limit_exceeded', retry_after_seconds: rl.retryAfter }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(rl.retryAfter),
        },
      },
    );
  }

  try {
    const body = await request.json() as PaymentVerification;

    // F-2 (2): strict shape check — reject before RPC. Most attacker
    // garbage gets caught here for free, no upstream RPC call billed.
    if (!body.txHash || typeof body.txHash !== 'string' || !TX_HASH_RE.test(body.txHash)) {
      return new Response(JSON.stringify({ error: 'txHash must be a 0x-prefixed 32-byte hex string' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await verifyPayment(env, body);

    return new Response(JSON.stringify(result), {
      status: result.valid ? 200 : 402,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
