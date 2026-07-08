/**
 * Targeted soak driver — confirmation-proof fault classification (#1408).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The failed soak fleet ran generic `load-harness --mode mixed`, which proves
 * the worker answers HTTP but NEVER drives `/jobs/populate-confirmation-proofs`
 * against SECURED anchors with an inclusion-proof source that FAILS in the two
 * ways that matter for anchor-lifecycle correctness:
 *
 *   (1) TRANSIENT provider failure — RPC 5xx / timeout / 429 / network drop.
 *       The tx IS confirmed on-chain; the node just couldn't answer THIS tick.
 *       The row MUST stay recoverable: classify `pending`/retry, leave
 *       `block_header = NULL`, retry on the next tick. Poisoning it to `stale`
 *       would strand a legitimately-confirmed anchor's confirmation evidence
 *       forever (the scan `.is('block_header', null)` keeps re-picking it, but a
 *       `stale`-driven skip that fabricates or drops it is the failure mode).
 *
 *   (2) DEFINITIVE provider failure — an RPC application error ("block not
 *       found", malformed proof, reorg: tx now in a different block). The
 *       previously-recorded block no longer commits the tx. This is NOT
 *       retryable by simple backoff — classify `stale`, never persist a branch
 *       under a block that no longer contains the tx (§1.5).
 *
 * `fetchConfirmationProof` (chain/confirmation-proof.ts) is the unit under test.
 * This driver is the REUSABLE fault-injection foundation: a deterministic stub
 * `ConfirmationProofProvider` whose header/proof calls can be scripted to throw
 * transient vs definitive faults, plus a classifier that runs the REAL fetch +
 * populate path and tallies how each fault was classified. The rig layer
 * (confirmation-proof-fault-harness.ts) reuses this same taxonomy over HTTP.
 *
 * NO real Bitcoin API (§1.7): every provider call is a scripted stub. NO rig,
 * NO network, NO spend — this module is pure and unit-testable.
 *
 * Constitution refs:
 *   - §1.5 Evidence: a not-yet-fetchable proof is `pending`, never a fabricated
 *     branch; a reorged-out tx is `stale`, never overwritten.
 *   - §1.7 Testing: provider injected; no real chain.
 *   - §1.12 T3: chain / anchor-lifecycle surface — targeted behavioral evidence.
 */

import {
  fetchConfirmationProof,
  type ConfirmationProof,
} from '../chain/confirmation-proof.js';
import {
  HttpError,
  type ConfirmationProofProvider,
  type RawTransaction,
} from '../chain/utxo-provider.js';

// ─── Fault taxonomy ─────────────────────────────────────────────────────────

/**
 * The classes of provider failure the driver injects. `transient` faults are
 * the ones `isRetryableError` treats as retryable (5xx / timeout / network);
 * `definitive` faults are non-retryable (RPC application error / 4xx).
 */
export type InjectedFaultKind =
  | 'http_5xx' // HttpError status>=500 — transient
  | 'http_429' // HttpError 429 rate-limit — transient (retry-after)
  | 'timeout' // AbortError (AbortSignal.timeout) — transient
  | 'network' // TypeError('fetch failed') — transient
  | 'econnreset' // Error('...ECONNRESET...') — transient
  | 'http_4xx' // HttpError 400/404 — definitive
  | 'rpc_application'; // Error('RPC gettxoutproof error: ...') — definitive

/** True when the fault kind is one a simple backoff SHOULD retry. */
export function isTransientFault(kind: InjectedFaultKind): boolean {
  switch (kind) {
    case 'http_5xx':
    case 'http_429':
    case 'timeout':
    case 'network':
    case 'econnreset':
      return true;
    case 'http_4xx':
    case 'rpc_application':
      return false;
  }
}

/**
 * Build the concrete Error a given fault kind throws, shaped EXACTLY like the
 * error the real provider would raise so `isRetryableError` (utxo-provider.ts)
 * classifies it identically to production. This is the crux of the driver: it
 * exercises the SAME error-shape → retry-class mapping the live path uses.
 */
export function faultError(kind: InjectedFaultKind): Error {
  switch (kind) {
    case 'http_5xx':
      return new HttpError('RPC gettxoutproof failed: HTTP 503', 503);
    case 'http_429':
      return new HttpError('RPC gettxoutproof failed: HTTP 429', 429);
    case 'timeout': {
      // AbortSignal.timeout fires a DOMException named 'AbortError'. In Node a
      // DOMException is available globally; fall back to a shaped Error if not.
      if (typeof DOMException !== 'undefined') {
        return new DOMException('The operation was aborted due to timeout', 'AbortError');
      }
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'AbortError';
      return e;
    }
    case 'network':
      return new TypeError('fetch failed');
    case 'econnreset':
      return new Error('connect ECONNRESET 10.0.0.1:8332');
    case 'http_4xx':
      return new HttpError('RPC gettxoutproof failed: HTTP 404', 404);
    case 'rpc_application':
      return new Error('RPC gettxoutproof error: Block not found (code -5)');
  }
}

// ─── Fault-injecting stub provider ──────────────────────────────────────────

/** Where in the fetch flow a fault should be injected. */
export type FaultTarget = 'getRawTransaction' | 'getBlockHeaderHex' | 'getTxOutProof';

export interface FaultScript {
  /** Which provider method throws. Defaults to `getTxOutProof` (the inclusion-proof call). */
  target?: FaultTarget;
  kind: InjectedFaultKind;
}

export interface StubProviderConfig {
  /** The confirmed tx the provider reports for `getRawTransaction`. */
  rawTx: RawTransaction;
  /** Scripted fault; when absent the method resolves with `ok*` values below. */
  fault?: FaultScript;
  /** Raw 80-byte header hex returned by a non-faulting `getBlockHeaderHex`. */
  okHeaderHex?: string;
  /** gettxoutproof blob returned by a non-faulting `getTxOutProof`. */
  okProofHex?: string;
}

/** Counts how many times each provider method was invoked (drift/retry evidence). */
export interface StubCallCounts {
  getRawTransaction: number;
  getBlockHeaderHex: number;
  getTxOutProof: number;
}

export interface FaultInjectingProvider extends ConfirmationProofProvider {
  readonly calls: StubCallCounts;
}

/**
 * A deterministic {@link ConfirmationProofProvider} whose three methods either
 * resolve with the configured OK values or throw a scripted fault. Pure and
 * synchronous-ish (returns resolved/rejected promises) — no timers, no network.
 */
export function makeFaultInjectingProvider(cfg: StubProviderConfig): FaultInjectingProvider {
  const calls: StubCallCounts = { getRawTransaction: 0, getBlockHeaderHex: 0, getTxOutProof: 0 };
  const target = cfg.fault?.target ?? 'getTxOutProof';

  const throwIfTargeted = (method: FaultTarget): void => {
    if (cfg.fault && target === method) throw faultError(cfg.fault.kind);
  };

  return {
    calls,
    async getRawTransaction(_txid: string): Promise<RawTransaction> {
      calls.getRawTransaction += 1;
      throwIfTargeted('getRawTransaction');
      return cfg.rawTx;
    },
    async getBlockHeaderHex(_blockhash: string): Promise<string> {
      calls.getBlockHeaderHex += 1;
      throwIfTargeted('getBlockHeaderHex');
      if (cfg.okHeaderHex === undefined) {
        throw new Error('stub misconfigured: okHeaderHex required when getBlockHeaderHex is not faulting');
      }
      return cfg.okHeaderHex;
    },
    async getTxOutProof(_txids: string[], _blockhash?: string): Promise<string> {
      calls.getTxOutProof += 1;
      throwIfTargeted('getTxOutProof');
      if (cfg.okProofHex === undefined) {
        throw new Error('stub misconfigured: okProofHex required when getTxOutProof is not faulting');
      }
      return cfg.okProofHex;
    },
  };
}

// ─── Classification driver ──────────────────────────────────────────────────

/**
 * The classification the driver expects for a given fault, so a test (or the
 * rig harness) can assert the REAL fetch matched it.
 *
 *   transient fault → `pending`  (recoverable; retry next tick)
 *   definitive fault → `stale`   (non-retryable; never persist a branch)
 */
export function expectedStatusForFault(kind: InjectedFaultKind): ConfirmationProof['status'] {
  return isTransientFault(kind) ? 'pending' : 'stale';
}

export interface FaultClassificationOutcome {
  fault: InjectedFaultKind;
  target: FaultTarget;
  /** What the REAL fetchConfirmationProof classified this fault as. */
  actual: ConfirmationProof['status'];
  /** What the #1408 contract requires. */
  expected: ConfirmationProof['status'];
  /** True when actual === expected. */
  correct: boolean;
  /** The proof's machine-stable reason string (for evidence). */
  reason?: string;
  /** Provider call counts (retry/backoff evidence). */
  calls: StubCallCounts;
}

/**
 * Drive the REAL {@link fetchConfirmationProof} against a fault-injecting
 * provider for one confirmed tx and one injected fault, and report whether the
 * fault was classified per the #1408 contract.
 *
 * `req` supplies the tx id / expected block hash / minConfirmations exactly as
 * the production populate path would. `okHeaderHex`/`okProofHex` are only used
 * when the fault targets a DIFFERENT method (so the non-faulting calls resolve).
 */
export async function classifyInjectedFault(args: {
  fault: FaultScript;
  rawTx: RawTransaction;
  chainTxId: string;
  expectedBlockHash?: string | null;
  minConfirmations?: number;
  okHeaderHex?: string;
  okProofHex?: string;
}): Promise<FaultClassificationOutcome> {
  const provider = makeFaultInjectingProvider({
    rawTx: args.rawTx,
    fault: args.fault,
    okHeaderHex: args.okHeaderHex,
    okProofHex: args.okProofHex,
  });

  const proof = await fetchConfirmationProof(provider, {
    chainTxId: args.chainTxId,
    expectedBlockHash: args.expectedBlockHash ?? null,
    minConfirmations: args.minConfirmations ?? 1,
  });

  const expected = expectedStatusForFault(args.fault.kind);
  return {
    fault: args.fault.kind,
    target: args.fault.target ?? 'getTxOutProof',
    actual: proof.status,
    expected,
    correct: proof.status === expected,
    reason: proof.reason,
    calls: provider.calls,
  };
}

/**
 * Run the full fault matrix (all {@link InjectedFaultKind}s injected at the
 * inclusion-proof call) against one confirmed tx and return every outcome plus
 * an aggregate. `allCorrect === false` means the classification contract is
 * violated for at least one fault — the exact signal the soak must surface.
 */
export async function runFaultClassificationMatrix(args: {
  rawTx: RawTransaction;
  chainTxId: string;
  okHeaderHex: string;
  okProofHex: string;
  minConfirmations?: number;
  faultTarget?: FaultTarget;
}): Promise<{ outcomes: FaultClassificationOutcome[]; allCorrect: boolean; misclassified: FaultClassificationOutcome[] }> {
  const kinds: InjectedFaultKind[] = [
    'http_5xx',
    'http_429',
    'timeout',
    'network',
    'econnreset',
    'http_4xx',
    'rpc_application',
  ];
  const target = args.faultTarget ?? 'getTxOutProof';

  const outcomes: FaultClassificationOutcome[] = [];
  for (const kind of kinds) {
    outcomes.push(
      await classifyInjectedFault({
        fault: { kind, target },
        rawTx: args.rawTx,
        chainTxId: args.chainTxId,
        minConfirmations: args.minConfirmations,
        okHeaderHex: args.okHeaderHex,
        okProofHex: args.okProofHex,
      }),
    );
  }

  const misclassified = outcomes.filter((o) => !o.correct);
  return { outcomes, allCorrect: misclassified.length === 0, misclassified };
}
