/**
 * Fixture-corpus plumbing shared by the TEST helpers (test/helpers.ts) and the
 * PARITY comparator (scripts/parity-compare.mjs, which imports the built
 * dist/ copy of this module).
 *
 * Single source of truth for:
 *  - how a PROOF-08 corpus vector becomes a recompute-only ProofPacket, and
 *  - how a fixture's canned Esplora responses become an offline transport,
 * so the two runners can never drift when the packet or response shape
 * changes (the exact drift the three-way parity gate exists to catch).
 */

import type { IndependentNodeFetch } from '@arkova/verifier';
import type { FixtureNodeResponses, MerkleProofEntry, ProofPacket } from '../types.js';

/** One PROOF-08 corpus app-tree vector (proof-fixtures.json `valid`/`invalid[]`). */
export interface Proof08Vector {
  /** Stable vector id — absent on the single `valid` vector. */
  id?: string;
  description?: string;
  fingerprint: string;
  merkle_root: string;
  merkle_proof: MerkleProofEntry[];
  merkle_index: number;
  leaf_count: number;
}

/** The raw PROOF-08 corpus (services/worker/src/proof/fixtures/proof-fixtures.json). */
export interface Proof08Corpus {
  valid: Proof08Vector;
  invalid: Proof08Vector[];
  signed_bundle: Record<string, unknown>;
}

/** Resolve a manifest `ref` to its PROOF-08 corpus vector, or undefined. */
export function resolveProof08Vector(corpus: Proof08Corpus, ref: string): Proof08Vector | undefined {
  return ref === 'valid-inclusion' ? corpus.valid : corpus.invalid.find((v) => v.id === ref);
}

/** Build a recompute-only ProofPacket from a PROOF-08 app-tree vector. */
export function packetFromProof08Vector(v: Proof08Vector): ProofPacket {
  return {
    fingerprint: v.fingerprint,
    merkle_root: v.merkle_root,
    merkle_proof: v.merkle_proof,
    merkle_index: v.merkle_index,
    leaf_count: v.leaf_count,
    tx_id: null,
    block_height: null,
    block_timestamp: null,
    batch_id: null,
  };
}

/**
 * Offline Esplora transport backed by a fixture's canned REST responses. Text
 * endpoints (`/block-height/:h`, `/block/:hash/header`) are stored as raw
 * strings; everything else is JSON. Mirrors `createEsploraFetch`'s normalized
 * response shape ({ ok, status, json/text }); an unknown path returns 404 —
 * it never falls through to a real fetch.
 */
export function fixtureNodeFetch(responses: FixtureNodeResponses): IndependentNodeFetch {
  return async (path: string) => {
    if (!(path in responses)) return { ok: false, status: 404 };
    const value = responses[path];
    if (typeof value === 'string') return { ok: true, status: 200, text: value };
    return { ok: true, status: 200, json: value };
  };
}
