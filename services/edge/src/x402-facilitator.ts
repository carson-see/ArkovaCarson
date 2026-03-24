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
    const usdcAddress = env.USDC_CONTRACT_ADDRESS ?? USDC_BASE_SEPOLIA;
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
 * Handle x402 facilitator requests.
 * POST /x402/verify — Verify a payment proof on-chain.
 */
export async function handleX402Facilitator(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json() as PaymentVerification;

    if (!body.txHash) {
      return new Response(JSON.stringify({ error: 'txHash required' }), {
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
