#!/usr/bin/env tsx
/**
 * PR #1408 chain-resilience admission driver.
 *
 * Self-test mode is local validation only; rows are marked evidenceForSoak=false
 * and must not be used as T3 soak evidence. Live mode requires an admitted
 * real-chain rig and writes countable JSONL rows for the PR-specific behavior.
 */

import { appendFileSync, readFileSync } from 'node:fs';

export interface DriverArgs {
  mode: 'self-test' | 'live';
  targetUrl?: string;
  admissionJson?: string;
  evidenceJsonl?: string;
  cronSecret?: string;
  bearerToken?: string;
}

export interface DriverRow {
  utc: string;
  pr: 1408;
  tier: 'T3';
  mode: 'self-test' | 'live';
  evidenceForSoak: boolean;
  changedBehavior: string;
  status: 'pass' | 'fail';
  counts: Record<string, number | boolean>;
  admission?: Record<string, unknown>;
  targetUrl?: string;
  response?: unknown;
  blockers?: string[];
}

const CHANGED_BEHAVIOR =
  'PR #1408 chain resilience: bounded retry/backoff, 429 transient classification, RPC/GetBlock/Mempool duplicate semantics, and confirmation-proof transient-to-pending vs definitive-to-stale behavior';

class DriverHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'DriverHttpError';
  }
}

class DriverRpcApplicationError extends Error {
  constructor(message: string, public readonly code?: number, public readonly httpStatus?: number) {
    super(message);
    this.name = 'DriverRpcApplicationError';
  }
}

interface DriverProofProvider {
  getRawTransaction(chainTxId: string): Promise<{ txid: string; confirmations?: number; blockhash?: string; vout: unknown[] }>;
  getBlockHeaderHex?(blockhash: string): Promise<string>;
  getTxOutProof?(txids: string[], blockhash?: string): Promise<string>;
}

function isDriverRetryableError(error: unknown): boolean {
  if (error instanceof DriverRpcApplicationError) return false;
  if (error instanceof DriverHttpError) return error.status >= 500 || error.status === 429;
  if (error instanceof TypeError) return /fetch failed|failed to fetch|network/i.test(error.message);
  if (error instanceof Error) return /ECONNRESET|ECONNREFUSED|ETIMEDOUT/.test(error.message);
  return false;
}

function isDriverDuplicateTxError(message: string): boolean {
  return /transaction already in block chain|transaction already in mempool|txn-already-known|txn-already-in-mempool|already known/i.test(message);
}

async function driverRetryWithBackoff(fn: () => Promise<unknown>, maxRetries: number): Promise<void> {
  const retries = Math.min(Math.max(Math.floor(Number.isNaN(maxRetries) ? 3 : maxRetries), 0), 8);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await fn();
      return;
    } catch (err) {
      lastError = err;
      if (!isDriverRetryableError(err)) throw err;
    }
  }
  throw lastError;
}

async function fetchProofLike(provider: DriverProofProvider, chainTxId: string): Promise<{ status: 'pending' | 'stale' }> {
  const rawTx = await provider.getRawTransaction(chainTxId);
  if (!rawTx.blockhash || (rawTx.confirmations ?? 0) <= 0) return { status: 'pending' };
  if (typeof provider.getBlockHeaderHex !== 'function' || typeof provider.getTxOutProof !== 'function') {
    return { status: 'pending' };
  }
  try {
    await provider.getBlockHeaderHex(rawTx.blockhash);
    await provider.getTxOutProof([chainTxId], rawTx.blockhash);
  } catch (err) {
    return { status: isDriverRetryableError(err) ? 'pending' : 'stale' };
  }
  return { status: 'pending' };
}

export function parseArgs(argv: string[]): DriverArgs {
  const args: DriverArgs = { mode: 'self-test' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--self-test':
        args.mode = 'self-test';
        break;
      case '--live':
        args.mode = 'live';
        break;
      case '--target-url':
        args.targetUrl = argv[++i];
        break;
      case '--admission-json':
        args.admissionJson = argv[++i];
        break;
      case '--evidence-jsonl':
        args.evidenceJsonl = argv[++i];
        break;
      case '--cron-secret':
        args.cronSecret = argv[++i];
        break;
      case '--bearer-token':
        args.bearerToken = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function runSelfTest(): Promise<DriverRow> {
  let attempts = 0;
  await driverRetryWithBackoff(
    async () => {
      attempts += 1;
      throw new DriverHttpError('persistent 503', 503);
    },
    Infinity,
  ).catch(() => undefined);

  const txid = '9'.repeat(64);
  const minedTx = { txid, confirmations: 10, blockhash: 'b'.repeat(64), vout: [] };
  const transientProvider: DriverProofProvider = {
    getRawTransaction: async () => minedTx,
    getBlockHeaderHex: async () => {
      throw new DriverHttpError('GetBlock down: HTTP 503', 503);
    },
    getTxOutProof: async () => '00',
  };
  const transientProof = await fetchProofLike(transientProvider, txid);

  const definitiveProvider: DriverProofProvider = {
    getRawTransaction: async () => minedTx,
    getBlockHeaderHex: async () => '11'.repeat(80),
    getTxOutProof: async () => {
      throw new DriverRpcApplicationError('Not all transactions found in specified or retrieved block', -5, 500);
    },
  };
  const definitiveProof = await fetchProofLike(definitiveProvider, txid);

  const mempoolShapeProvider: DriverProofProvider = {
    getRawTransaction: async () => minedTx,
    getBlockHeaderHex: async () => '11'.repeat(80),
  };
  const mempoolShapeProof = await fetchProofLike(mempoolShapeProvider, txid);

  const counts = {
    boundedAttempts: attempts,
    boundedTerminatesAtHardCap: attempts === 9,
    rateLimitRetryable: isDriverRetryableError(new DriverHttpError('rate limited', 429)),
    rpcApplicationErrorNonRetryable: !isDriverRetryableError(new DriverRpcApplicationError('bad tx', -25, 500)),
    duplicateKnown: isDriverDuplicateTxError('txn-already-known'),
    duplicateAlreadyInChain: isDriverDuplicateTxError('Transaction already in block chain'),
    transientProofPending: transientProof.status === 'pending',
    definitiveProofStale: definitiveProof.status === 'stale',
    mempoolShapePendingNoFabricatedProof: mempoolShapeProof.status === 'pending',
  };
  const pass = Object.values(counts).every((value) => value === true || value === 9);

  return {
    utc: new Date().toISOString(),
    pr: 1408,
    tier: 'T3',
    mode: 'self-test',
    evidenceForSoak: false,
    changedBehavior: CHANGED_BEHAVIOR,
    status: pass ? 'pass' : 'fail',
    counts,
  };
}

function loadAdmission(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function validateLiveArgs(args: DriverArgs): string[] {
  const blockers: string[] = [];
  if (!args.targetUrl) blockers.push('missing --target-url');
  if (!args.admissionJson) blockers.push('missing --admission-json');
  if (!args.evidenceJsonl) blockers.push('missing --evidence-jsonl');
  if (!args.cronSecret && !args.bearerToken) blockers.push('missing --cron-secret or --bearer-token');
  return blockers;
}

export async function runLive(args: DriverArgs): Promise<DriverRow> {
  const blockers = validateLiveArgs(args);
  if (blockers.length > 0) {
    return {
      utc: new Date().toISOString(),
      pr: 1408,
      tier: 'T3',
      mode: 'live',
      evidenceForSoak: false,
      changedBehavior: CHANGED_BEHAVIOR,
      status: 'fail',
      counts: {},
      blockers,
    };
  }

  const admission = loadAdmission(args.admissionJson!);
  const targetUrl = args.targetUrl!.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (args.cronSecret) headers['x-cron-secret'] = args.cronSecret;
  if (args.bearerToken) headers.authorization = `Bearer ${args.bearerToken}`;

  const res = await fetch(`${targetUrl}/jobs/populate-confirmation-proofs`, {
    method: 'POST',
    headers,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Preserve text body for diagnostics.
  }

  const objectBody = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const skipped = objectBody.skipped === true;
  const scanned = Number(objectBody.scanned ?? 0);
  const txAttempted = Number(objectBody.txAttempted ?? 0);
  const status = res.ok && !skipped && scanned > 0 && txAttempted > 0 ? 'pass' : 'fail';
  return {
    utc: new Date().toISOString(),
    pr: 1408,
    tier: 'T3',
    mode: 'live',
    evidenceForSoak: status === 'pass',
    changedBehavior: CHANGED_BEHAVIOR,
    status,
    targetUrl,
    admission,
    response: body,
    counts: {
      httpOk: res.ok,
      skipped,
      scanned,
      txAttempted,
      txPending: Number(objectBody.txPending ?? 0),
      txStale: Number(objectBody.txStale ?? 0),
      txConfirmed: Number(objectBody.txConfirmed ?? 0),
      anchorsUpdated: Number(objectBody.anchorsUpdated ?? 0),
    },
  };
}

export async function runDriver(args: DriverArgs): Promise<DriverRow> {
  return args.mode === 'live' ? runLive(args) : runSelfTest();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const row = await runDriver(args);
  const line = `${JSON.stringify(row)}\n`;
  if (args.evidenceJsonl) appendFileSync(args.evidenceJsonl, line);
  process.stdout.write(line);
  if (row.status !== 'pass') process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
