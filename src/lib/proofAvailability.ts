/**
 * Proof Availability — FE-PROOF-GATE (SCRUM-2501)
 *
 * Classifies the response of `GET /api/v1/verify/:publicId/proof` (contract:
 * docs/reference/FE_PROOF_GATE_CONTRACT.md) into the states the public
 * verification page must render. This module is pure (no fetch, no React) so
 * the classification rules can be unit-tested in isolation from network
 * mocking — `useProofAvailability` (the fetch hook) delegates here.
 *
 * The full FE gate per the contract §3 is:
 *   status is SECURED (public alias "ACTIVE")
 *   AND GET /proof returns 200
 *   AND verified === true
 *   AND proof_bundle !== null
 *
 * Because the route is proof-existence-gated, not status-gated (contract §1.3),
 * status must be checked on the FE side in addition to the response shape.
 */

/** A minimal shape of the merkle-proof-entry contract (kept structural, not imported from the worker). */
export interface ProofBundleLike {
  fingerprint: string;
  merkle_root: string;
  merkle_proof: Array<{ hash: string; position: 'left' | 'right' }>;
  merkle_index: number | null;
  leaf_count: number;
  tx_id: string | null;
  block_height: number | null;
  block_hash: string | null;
  block_header: string | null;
  op_return_payload: string | null;
  block_timestamp: string | null;
  proof_schema_version: number;
  signature: { alg: string; signing_key_id: string } | null;
}

export interface ProofEndpointSuccess {
  ok: true;
  status: 200;
  body: {
    verified: boolean;
    proof_bundle: ProofBundleLike | null;
    [key: string]: unknown;
  };
}

export interface ProofEndpointNotFound {
  ok: false;
  status: 404;
  body: { error: string; proof_error_code?: string };
}

export interface ProofEndpointOther {
  ok: false;
  status: number;
  body?: unknown;
}

export type ProofEndpointResult = ProofEndpointSuccess | ProofEndpointNotFound | ProofEndpointOther;

/** Verbatim 404 body strings from the contract (§2.2) — the FALLBACK match when no code is present. */
export const NO_MERKLE_PROOF_ERROR =
  'No Merkle proof available for this record. It may not have been batch-anchored.';
export const RECORD_NOT_FOUND_ERROR = 'Record not found';

/**
 * Stable machine-readable 404 discriminators (contract §2.2) — the PREFERRED
 * signal, matched before the prose so a future prose change (localization, typo
 * fix) cannot silently misroute. Mirror of the worker's `ProofErrorCode`
 * (services/worker/src/api/v1/verify-proof.ts) — kept structural, not imported
 * across the FE/worker boundary (same convention as the verbatim strings above).
 * Additive per §1.8: `proof_error_code` may be absent on older responses, so the
 * prose fallback above is retained.
 */
export const PROOF_ERROR_CODE_NO_BATCH_PROOF = 'NO_BATCH_PROOF';
export const PROOF_ERROR_CODE_RECORD_NOT_FOUND = 'RECORD_NOT_FOUND';

/**
 * The rendered presentation states for the proof-download surface.
 *
 * - `available`      state 1 — live download control, artifact = proof_bundle verbatim
 * - `empty`          state 1b / state 2 — honest "no downloadable proof yet" copy, no control
 * - `securing`       state 3 — record not yet SECURED; progress affordance permitted
 * - `record-missing` real error — publicId is stale/unknown/deleted
 * - `transient`      429 — back off; render nothing
 * - `retry`          5xx or malformed 200 (`verified:false`) — retryable "could not load" affordance
 */
export type ProofAvailabilityState =
  | 'available'
  | 'empty'
  | 'record-missing'
  | 'transient'
  | 'retry';

export interface ProofAvailability {
  state: ProofAvailabilityState;
  /** Present only when state === 'available'. The verbatim proof_bundle object — never hand-assembled. */
  proofBundle: ProofBundleLike | null;
}

const NOT_AVAILABLE: ProofAvailability = { state: 'empty', proofBundle: null };
const RECORD_MISSING: ProofAvailability = { state: 'record-missing', proofBundle: null };
const TRANSIENT: ProofAvailability = { state: 'transient', proofBundle: null };
const RETRY: ProofAvailability = { state: 'retry', proofBundle: null };

/**
 * Classify a `/proof` endpoint result into a single presentation state.
 *
 * Callers MUST only invoke this — and only mount the fetch that produces
 * `result` — when the record's normalized status is already known to be
 * SECURED (contract §3's "state 3 — not SECURED" and the REVOKED / EXPIRED /
 * SUPERSEDED terminal-but-not-secured statuses are handled entirely by the
 * caller's own status branch, e.g. `VerifierProofDownload`'s
 * `isProofDownloadable` gate — they never reach this function).
 */
export function classifyProofAvailability(
  result: ProofEndpointResult | null,
): ProofAvailability {
  // No result yet (still loading, or fetch not attempted) — treat as "empty"
  // by default so callers gate on an explicit loading flag rather than this.
  if (result === null) {
    return NOT_AVAILABLE;
  }

  if (result.status === 429) {
    return TRANSIENT;
  }

  if (result.status >= 500) {
    return RETRY;
  }

  if (result.status === 404) {
    const body = result.body as { error?: string; proof_error_code?: string } | undefined;

    // Prefer the stable machine-readable discriminator (contract §2.2) when the
    // worker supplies it — immune to prose changes (localization, typo fixes).
    const code = body?.proof_error_code;
    if (code === PROOF_ERROR_CODE_RECORD_NOT_FOUND) {
      return RECORD_MISSING;
    }
    if (code === PROOF_ERROR_CODE_NO_BATCH_PROOF) {
      return NOT_AVAILABLE;
    }

    // Fallback for older responses that predate proof_error_code (§1.8 additive
    // — the field may be absent) or carry an unrecognized code: exact-match the
    // verbatim prose. Unknown 404 bodies are retryable so we do not silently
    // present API-contract drift as the honest direct-anchored state.
    if (body?.error === RECORD_NOT_FOUND_ERROR) {
      return RECORD_MISSING;
    }
    if (body?.error === NO_MERKLE_PROOF_ERROR) {
      return NOT_AVAILABLE;
    }
    return RETRY;
  }

  if (result.status === 200 && result.ok) {
    const { verified, proof_bundle } = result.body;

    // verified:false is a data fault (contract §3) — never offer the download,
    // and never render it as the honest "not batch-anchored" empty state either.
    if (verified === false) {
      return RETRY;
    }

    if (proof_bundle === null) {
      // State 1b: partial proof. Same honest empty-state as state 2.
      return NOT_AVAILABLE;
    }

    return { state: 'available', proofBundle: proof_bundle };
  }

  // Any other unexpected status (400, etc.) — retryable, never state-2 copy.
  return RETRY;
}
