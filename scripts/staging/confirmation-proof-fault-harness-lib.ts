/**
 * Pure, side-effect-free helpers for confirmation-proof-fault-harness.ts (#1408).
 *
 * Split out (mirrors batch-drain-harness-lib.ts / load-harness-env.ts) so the
 * fault-plan + evidence-shape helpers are unit-testable without importing the
 * harness entrypoint (which runs main() on load and needs rig credentials).
 * NOTHING here touches the network or a DB.
 */

/**
 * The provider-fault classes the rig harness injects into the isolated rig's
 * inclusion-proof source, and the confirmation-proof STATUS each MUST produce.
 * This is the HTTP-layer mirror of the unit driver's taxonomy
 * (services/worker/src/jobs/confirmation-proof-fault-driver.ts): transient
 * faults ⇒ `pending` (retry), definitive faults ⇒ `stale` (non-retryable).
 */
export type RigFaultKind =
  | 'http_5xx'
  | 'http_429'
  | 'timeout'
  | 'network'
  | 'econnreset'
  | 'http_4xx'
  | 'rpc_application';

export interface RigFaultPlanEntry {
  kind: RigFaultKind;
  /** 'transient' ⇒ expect pending; 'definitive' ⇒ expect stale. */
  faultClass: 'transient' | 'definitive';
  expectedStatus: 'pending' | 'stale';
}

const TRANSIENT_KINDS: RigFaultKind[] = ['http_5xx', 'http_429', 'timeout', 'network', 'econnreset'];
const DEFINITIVE_KINDS: RigFaultKind[] = ['http_4xx', 'rpc_application'];

/**
 * Build the full fault plan the harness drives: every fault kind mapped to the
 * confirmation-proof status the #1408 contract requires. The rig harness seeds a
 * SECURED anchor, points the stub inclusion-proof provider at the given fault,
 * drives POST /jobs/populate-confirmation-proofs, and asserts the row's
 * proof_error_code / status matches `expectedStatus`.
 */
export function buildFaultPlan(): RigFaultPlanEntry[] {
  return [
    ...TRANSIENT_KINDS.map(
      (kind): RigFaultPlanEntry => ({ kind, faultClass: 'transient', expectedStatus: 'pending' }),
    ),
    ...DEFINITIVE_KINDS.map(
      (kind): RigFaultPlanEntry => ({ kind, faultClass: 'definitive', expectedStatus: 'stale' }),
    ),
  ];
}

/** True when a fault kind is one the classifier must treat as retryable. */
export function isTransientKind(kind: RigFaultKind): boolean {
  return TRANSIENT_KINDS.includes(kind);
}

/**
 * Validate that an observed status matches the fault plan. Returns a structured
 * verdict the harness records as evidence (never throws — the harness aggregates
 * and fails loudly at the end so one mismatch does not hide the others).
 */
export function verdictFor(
  entry: RigFaultPlanEntry,
  observedStatus: string,
): { kind: RigFaultKind; expected: string; observed: string; pass: boolean } {
  return {
    kind: entry.kind,
    expected: entry.expectedStatus,
    observed: observedStatus,
    pass: observedStatus === entry.expectedStatus,
  };
}

/**
 * A bounded backoff schedule the harness asserts the retry path honours: delays
 * must be non-negative, no more than `maxRetries` of them, and each within the
 * jittered [0.5, 1.0)·base·2^n envelope (matching retryWithBackoff's jitter).
 * Pure — used to validate captured retry telemetry.
 */
export function isBoundedBackoff(delaysMs: number[], baseMs: number, maxRetries: number): boolean {
  if (delaysMs.length > maxRetries) return false;
  for (let i = 0; i < delaysMs.length; i++) {
    const ceiling = baseMs * Math.pow(2, i);
    const floor = ceiling * 0.5;
    if (delaysMs[i] < floor || delaysMs[i] > ceiling) return false;
  }
  return true;
}
