/**
 * proofAvailability tests — FE-PROOF-GATE (SCRUM-2501)
 *
 * Pins the classification rules from docs/reference/FE_PROOF_GATE_CONTRACT.md §3
 * against the real /proof response shapes (verify-proof.ts). Covers state 1,
 * state 1b, state 2 (the honest core), Record not found, 429, and 5xx.
 *
 * Note: state 3 ("not SECURED") and the REVOKED/EXPIRED/SUPERSEDED terminal
 * statuses are NOT this module's concern — `classifyProofAvailability` is only
 * ever invoked by a caller that has already confirmed `status === SECURED`
 * (see VerifierProofDownload's `isProofDownloadable` gate). Those cases are
 * covered in VerifierProofDownload.test.tsx instead.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyProofAvailability,
  NO_MERKLE_PROOF_ERROR,
  RECORD_NOT_FOUND_ERROR,
  PROOF_ERROR_CODE_NO_BATCH_PROOF,
  PROOF_ERROR_CODE_RECORD_NOT_FOUND,
  type ProofBundleLike,
  type ProofEndpointResult,
} from './proofAvailability';

const PROOF_BUNDLE: ProofBundleLike = {
  fingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  merkle_root: 'a'.repeat(64),
  merkle_proof: [{ hash: 'b'.repeat(64), position: 'left' }],
  merkle_index: 2,
  leaf_count: 8,
  tx_id: 'c'.repeat(64),
  block_height: 900123,
  block_hash: 'd'.repeat(64),
  block_header: 'e'.repeat(160),
  op_return_payload: `41524b56${'a'.repeat(64)}`,
  block_timestamp: '2026-07-01T00:00:00Z',
  proof_schema_version: 1,
  signature: null,
};

function ok200(overrides: Partial<{ verified: boolean; proof_bundle: ProofBundleLike | null }>): ProofEndpointResult {
  return {
    ok: true,
    status: 200,
    body: {
      verified: true,
      proof_bundle: PROOF_BUNDLE,
      ...overrides,
    },
  };
}

function notFound(error: string): ProofEndpointResult {
  return { ok: false, status: 404, body: { error } };
}

/** A 404 carrying the additive machine-readable discriminator (contract §2.2). */
function notFoundCoded(proof_error_code: string, error: string): ProofEndpointResult {
  return { ok: false, status: 404, body: { error, proof_error_code } };
}

describe('classifyProofAvailability', () => {
  it('state 1 — 200 + verified true + proof_bundle present -> available, verbatim bundle', () => {
    const result = classifyProofAvailability(ok200({}));
    expect(result.state).toBe('available');
    expect(result.proofBundle).toBe(PROOF_BUNDLE); // verbatim reference, never a rebuilt object
  });

  it('state 1b — 200 + proof_bundle null -> empty (same as state 2), no bundle', () => {
    const result = classifyProofAvailability(ok200({ proof_bundle: null }));
    expect(result.state).toBe('empty');
    expect(result.proofBundle).toBeNull();
  });

  it('state 1b — 200 + verified true but bundle null stays empty even though verified', () => {
    const result = classifyProofAvailability(ok200({ verified: true, proof_bundle: null }));
    expect(result.state).toBe('empty');
  });

  it('state 2 (the honest core) — 404 "No Merkle proof available…" -> empty, no bundle', () => {
    const result = classifyProofAvailability(notFound(NO_MERKLE_PROOF_ERROR));
    expect(result.state).toBe('empty');
    expect(result.proofBundle).toBeNull();
  });

  it('null result (loading / not yet fetched) -> empty, no bundle', () => {
    const result = classifyProofAvailability(null);
    expect(result.state).toBe('empty');
    expect(result.proofBundle).toBeNull();
  });

  it('Record not found 404 -> record-missing, a real error state distinct from state 2', () => {
    const result = classifyProofAvailability(notFound(RECORD_NOT_FOUND_ERROR));
    expect(result.state).toBe('record-missing');
  });

  // --- proof_error_code discriminator (contract §2.2, additive §1.8) ---------
  // Prefer the stable machine-readable code over the human-readable prose so a
  // future prose change (localization, typo fix) cannot silently misroute.

  it('404 code NO_BATCH_PROOF -> empty (code preferred; prose irrelevant)', () => {
    const result = classifyProofAvailability(
      notFoundCoded(PROOF_ERROR_CODE_NO_BATCH_PROOF, 'some future localized no-proof string'),
    );
    expect(result.state).toBe('empty');
    expect(result.proofBundle).toBeNull();
  });

  it('404 code RECORD_NOT_FOUND -> record-missing (code preferred; prose irrelevant)', () => {
    const result = classifyProofAvailability(
      notFoundCoded(PROOF_ERROR_CODE_RECORD_NOT_FOUND, 'un enregistrement introuvable'),
    );
    expect(result.state).toBe('record-missing');
  });

  it('code beats CONTRADICTORY prose — NO_BATCH_PROOF with "Record not found" prose -> empty', () => {
    const result = classifyProofAvailability(
      notFoundCoded(PROOF_ERROR_CODE_NO_BATCH_PROOF, RECORD_NOT_FOUND_ERROR),
    );
    expect(result.state).toBe('empty');
  });

  it('code beats CONTRADICTORY prose — RECORD_NOT_FOUND with "No Merkle proof…" prose -> record-missing', () => {
    const result = classifyProofAvailability(
      notFoundCoded(PROOF_ERROR_CODE_RECORD_NOT_FOUND, NO_MERKLE_PROOF_ERROR),
    );
    expect(result.state).toBe('record-missing');
  });

  it('unrecognized code falls back to the prose match (RECORD_NOT_FOUND_ERROR -> record-missing)', () => {
    const result = classifyProofAvailability(
      notFoundCoded('SOME_UNKNOWN_FUTURE_CODE', RECORD_NOT_FOUND_ERROR),
    );
    expect(result.state).toBe('record-missing');
  });

  it('no code (older worker) still routes by prose — "Record not found" -> record-missing', () => {
    // Fallback path preserved for §1.8-additive responses that predate the code.
    expect(classifyProofAvailability(notFound(RECORD_NOT_FOUND_ERROR)).state).toBe('record-missing');
  });

  it('no code + unknown/localized prose -> retry, never the honest empty-state', () => {
    expect(classifyProofAvailability(notFound('Kein Merkle-Nachweis verfügbar')).state).toBe('retry');
  });

  it('unrecognized code + unknown prose -> retry, never the honest empty-state', () => {
    const result = classifyProofAvailability(
      notFoundCoded('SOME_UNKNOWN_FUTURE_CODE', 'some future unknown string'),
    );
    expect(result.state).toBe('retry');
  });

  it('429 -> transient; renders neither empty-state nor error', () => {
    const result = classifyProofAvailability({ ok: false, status: 429 });
    expect(result.state).toBe('transient');
  });

  it('5xx -> retry, never state-2 copy', () => {
    expect(classifyProofAvailability({ ok: false, status: 500 }).state).toBe('retry');
    expect(classifyProofAvailability({ ok: false, status: 503 }).state).toBe('retry');
  });

  it('verified:false on 200 -> retry (ops/error), never offers the download even with a bundle', () => {
    const result = classifyProofAvailability(ok200({ verified: false, proof_bundle: PROOF_BUNDLE }));
    expect(result.state).toBe('retry');
    expect(result.proofBundle).toBeNull();
  });

  it('unexpected 400 -> retry, not the honest empty-state', () => {
    expect(classifyProofAvailability({ ok: false, status: 400 }).state).toBe('retry');
  });
});
