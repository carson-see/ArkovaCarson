/**
 * Canonical proof-fixture loader (PROOF-08 / SCRUM-2341).
 *
 * Single typed entry point over `proof-fixtures.json` — the cross-consumer
 * fixture set that every proof verifier (API verify-proof, PDF, SDK, CLI,
 * server-side verify) tests against. The JSON is the source of truth and is
 * self-describing (see README.md); this module just gives it a stable shape.
 *
 * The vectors are the SAME ones SCRUM-2490's adversarial Merkle tests use —
 * one valid inclusion proof plus invalid proofs covering: bad document hash,
 * tampered Merkle branch (hash + position), the CVE-2012-2459 duplicated-leaf
 * attack, wrong leaf index, bad block header, and bad signature.
 *
 * Synthetic anchors only — NO real customer data or PII (§1.6 / §1.5).
 */

import { createRequire } from 'node:module';
import type { MerkleProofEntry } from '../../utils/merkle.js';
import type { SignedBundle } from '../signed-bundle.js';

// Load the JSON via require so the module works identically under tsx, the
// compiled dist build, and Vitest without needing `resolveJsonModule`/import
// assertions to be uniform across every consumer's tsconfig.
const require = createRequire(import.meta.url);
const raw = require('./proof-fixtures.json') as ProofFixtureFile;

/** A layer-1 app-tree inclusion vector (valid or invalid). */
export interface InclusionVector {
  id: string;
  /** Present on invalid vectors: the attack class being exercised. */
  attack?: string;
  description: string;
  fingerprint: string;
  merkle_root: string;
  merkle_index: number;
  leaf_count: number;
  merkle_proof: MerkleProofEntry[];
  /** Regex (string) the verifier's failure `reason` must match. Invalid only. */
  expect_invalid_reason?: string;
}

/** A layer-2 bitcoin-tree / header vector. */
export interface BlockHeaderVector {
  id: string;
  attack?: string;
  description: string;
  block_hash: string;
  block_header_hex: string;
  tx_id: string;
  expect_invalid_reason?: string;
}

export interface ProofFixtureFile {
  fixture_set_version: string;
  proof_schema_version: number;
  hash_rule: string;
  tree: {
    description: string;
    leaf_count: number;
    leaves: string[];
    merkle_root: string;
  };
  valid: InclusionVector & {
    public_id: string;
    on_chain: {
      tx_id: string;
      block_height: number;
      block_hash: string;
      block_timestamp: string;
      op_return_payload: string;
    };
    batch_id: string;
  };
  invalid: Array<InclusionVector | BlockHeaderVector>;
  signed_bundle: {
    description: string;
    signing_key_id: string;
    test_public_key_pem: string;
    test_private_key_pem: string;
    bad_signature_value: string;
    valid_bundle: SignedBundle;
  };
}

/** The full parsed fixture file. */
export const proofFixtures: ProofFixtureFile = raw;

/** Convenience: the one canonical valid inclusion vector. */
export const validInclusion = raw.valid;

/** Convenience: every invalid vector, keyed by `id`. */
export function invalidById<T extends InclusionVector | BlockHeaderVector>(id: string): T {
  const found = raw.invalid.find((v) => v.id === id);
  if (!found) throw new Error(`proof fixture: no invalid vector with id "${id}"`);
  return found as T;
}

/** Type guard: is this invalid vector a layer-1 app-tree inclusion vector? */
export function isInclusionVector(v: InclusionVector | BlockHeaderVector): v is InclusionVector {
  return 'merkle_proof' in v;
}

/** Type guard: is this invalid vector a layer-2 block-header vector? */
export function isBlockHeaderVector(v: InclusionVector | BlockHeaderVector): v is BlockHeaderVector {
  return 'block_header_hex' in v;
}

/** The fixture proof_schema_version every vector is stamped to. */
export const FIXTURE_PROOF_SCHEMA_VERSION = raw.proof_schema_version;

/**
 * The on-chain OP_RETURN commitment prefix, hex-encoded — "ARKV".
 * v0 format is `ARKV ‖ 32-byte root [‖ optional 8-byte metadata]`; there is
 * NO version byte (services/worker/src/chain/base.ts).
 */
export const ARKV_PREFIX_HEX = '41524b56';
