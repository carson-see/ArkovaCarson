/**
 * Proof-packet + fixture types for the standalone Arkova reference verifier.
 *
 * The proof-packet shape mirrors the canonical proof bundle the API exports
 * (`services/worker/src/api/v1/verify-proof.ts` → `MerkleProofResponse`, plus
 * the PROOF-01 structural fields `merkle_index` / `leaf_count` /
 * `op_return_payload`) but the verifier NEVER trusts the API's `verified`
 * field — it recomputes the on-chain root itself (see verify.ts) and confirms
 * inclusion via `@arkova/verifier` against an INDEPENDENT node.
 */

import type { IndependentNodeFetch } from '@arkova/verifier';

/** One sibling along the Merkle inclusion branch. */
export interface MerkleProofEntry {
  hash: string;
  position: 'left' | 'right';
}

/**
 * The proof packet a holder exports from Arkova and hands to an auditor.
 * Shape matches `GET /api/v1/verify/:publicId/proof` (the canonical proof
 * bundle).
 */
export interface ProofPacket {
  /** The document fingerprint (leaf), 64-hex. */
  fingerprint: string;
  /** The Merkle root committed on-chain, 64-hex. */
  merkle_root: string;
  /** Inclusion branch from the fingerprint up to the root. */
  merkle_proof: MerkleProofEntry[];
  /** Network receipt id holding the root in its OP_RETURN, or null if unanchored. */
  tx_id: string | null;
  /** Block height of the receipt, or null. */
  block_height: number | null;
  /** ISO-8601 network-observed time of the block, or null. */
  block_timestamp: string | null;
  /** Internal batch identifier, or null. */
  batch_id: string | null;
  /** Leaf index in the batch tree — enables the structural CVE-2012-2459 guard. */
  merkle_index?: number | null;
  /** Total leaf count of the batch tree — enables the structural CVE-2012-2459 guard. */
  leaf_count?: number | null;
  /**
   * OPTIONAL canonical OP_RETURN payload as published in the bundle:
   * `ARKV(4)‖root(32)` (no version byte), display hex. The verifier does NOT
   * trust this for the verdict — the authoritative payload is the one decoded
   * from the on-chain receipt by `@arkova/verifier`. Surfaced for parity only.
   */
  op_return_payload?: string | null;
  /**
   * The API's own claim. The verifier IGNORES this for its verdict — it is
   * surfaced only so the auditor can see whether the independent recompute
   * agrees with what the server asserted.
   */
  verified?: boolean;
}

/**
 * A signed bundle wrapping a proof packet
 * (`services/worker/src/proof/signed-bundle.ts`). The Ed25519 signature proves
 * *Arkova issued this packet*; it NEVER substitutes for recomputation.
 */
export interface SignedProofBundle {
  payload: ProofPacket & Record<string, unknown>;
  signature: { alg: 'Ed25519'; value: string };
  signing_key_id: string;
  signed_at_utc: string;
  bundle_version: string;
}

/**
 * The independent on-chain source the verifier confirms against. `fetch` is an
 * `@arkova/verifier` `IndependentNodeFetch` (Esplora REST, path → response),
 * built by the CLI from a vetted `--rpc` endpoint via `createEsploraFetch`. It
 * MUST reach a node that is NOT operated by Arkova (the holder's own node,
 * Blockstream, mempool.space Esplora, etc.); the CLI enforces this with
 * `assertIndependentEndpoint`. Tests inject a fixture-backed `fetch` so the
 * suite runs fully offline.
 */
export interface IndependentNode {
  /** A human-readable label for the node (shown in the report). */
  readonly label: string;
  /** Esplora REST transport (path → normalized response). */
  readonly fetch: IndependentNodeFetch;
}

/**
 * The set of canned independent-node responses a fixture serves, keyed by the
 * exact Esplora REST path `@arkova/verifier` requests:
 *   - `/tx/<txid>`                 → JSON EsploraTx
 *   - `/block-height/<height>`     → text block hash
 *   - `/block/<hash>/header`       → text 80-byte (160-hex) header
 *   - `/tx/<txid>/merkle-proof`    → JSON { block_height, merkle[], pos }
 * A value is either a JSON object/array or a raw string (text endpoints).
 */
export type FixtureNodeResponses = Record<string, unknown>;

/**
 * Self-describing fixture (PROOF-08 vector contract). A teammate produces the
 * real golden vectors; until then `fixtures/generate-fixtures.mjs` emits local
 * synthetic vectors that satisfy this interface (canonical OP_RETURN
 * `ARKV‖root`, real headers + inclusion proofs) so the tests run fully offline.
 *
 * Each fixture is fully self-contained: the proof packet PLUS the exact
 * independent-node REST responses needed to confirm it, PLUS the expected
 * verdict.
 */
export interface VerifierFixture {
  /** Stable id, e.g. "single-leaf-pass", "forged-self-pair-fail". */
  name: string;
  /** Human description of what this vector exercises. */
  description: string;
  /** The proof packet under test. */
  packet: ProofPacket;
  /**
   * The independent-node REST responses this vector serves, keyed by Esplora
   * path. Lets a fixture drive a fully offline `IndependentNodeFetch`. Absent
   * for recompute-only / no-chain vectors.
   */
  node?: FixtureNodeResponses;
  /** OPTIONAL published Ed25519 key PEM, for signature-verify vectors. */
  publicKeyPem?: string;
  /** OPTIONAL signed bundle, for signature-verify vectors. */
  signedBundle?: SignedProofBundle;
  /** The expected top-level verdict from the verifier. */
  expect: {
    /** Overall pass/fail of the cryptographic + chain checks. */
    ok: boolean;
    /** Expected machine reason substring on failure (optional). */
    reasonIncludes?: string;
  };
}
