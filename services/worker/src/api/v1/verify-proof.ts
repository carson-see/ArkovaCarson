/**
 * GET /api/v1/verify/:publicId/proof (BTC-003)
 *
 * Returns the Merkle inclusion proof for a batch-anchored document.
 * Enables independent client-side verification that a document's
 * fingerprint is included in the on-chain Merkle root.
 *
 * Response includes:
 *   - merkle_proof: array of sibling hashes + positions
 *   - merkle_root: the root committed on-chain
 *   - tx_id: Bitcoin transaction containing the root
 *   - block_height / block_timestamp: confirmation details
 *   - batch_id: internal batch identifier
 */

import { Router, Request, Response } from 'express';
import { verifyMerkleInclusion } from '../../utils/merkle-verify.js';
import { isValidProofArray } from '../../utils/proofBranch.js';
import {
  proofAvailabilityFields,
  type ProofAvailability,
} from '../../constants/proofAvailability.js';
import {
  connectorFingerprintRederivabilityFields,
  resolveConnectorFetchSource,
  type FingerprintRederivability,
} from '../../constants/connectorFingerprint.js';
import { fromByteaHex } from '../../utils/anchorProofs.js';
import { createSignedBundle, staticEd25519Signer, type SignerFn } from '../../proof/signed-bundle.js';
import { buildBoundProofPayload } from '../../proof/did-binding.js';
import {
  gcpKmsEd25519Signer,
  createRealGcpKmsEd25519Client,
  type KmsEd25519ClientLike,
} from '../../proof/kms-signer.js';

const router = Router();

/**
 * Resolve the signer once per process. Returns null when no production
 * or dev signing material is configured, so `?format=signed` can respond
 * 503 (caller degrades to the legacy unsigned shape) instead of silently
 * shipping an unsigned bundle.
 *
 * Resolution order:
 *   1. PROOF_SIGNING_KMS_KEY + PROOF_SIGNING_KEY_ID → GCP KMS Ed25519
 *      signer (production: private key never leaves KMS, per
 *      `feedback_no_aws.md` and SCRUM-900 AC)
 *   2. PROOF_SIGNING_KEY_PEM + PROOF_SIGNING_KEY_ID → static-PEM signer
 *      (dev / preview / unit fixtures only — never set in prod)
 *   3. None of the above → null → 503
 *
 * Memoized: env vars are immutable post-boot in Cloud Run, so the
 * resolved signer (and the KMS client it lazy-initialises on first call)
 * lives for the lifetime of the worker process. Without this memo,
 * every signed-proof request would build a fresh signer and re-import
 * the GCP KMS SDK client.
 *
 * `__resetSignerCacheForTests()` clears both the signer and the KMS
 * client memos so per-test env-var swaps take effect.
 */
let cachedSigner: { sign: SignerFn; keyId: string } | null | undefined;
let cachedKmsClient: Promise<KmsEd25519ClientLike> | null = null;

export function resolveSigner(): { sign: SignerFn; keyId: string } | null {
  if (cachedSigner !== undefined) return cachedSigner;
  const keyId = process.env.PROOF_SIGNING_KEY_ID;
  if (!keyId) {
    cachedSigner = null;
    return null;
  }
  const kmsKeyName = process.env.PROOF_SIGNING_KMS_KEY;
  if (kmsKeyName) {
    // Lazy-init the SDK client on first invocation, then memoize the
    // Promise so concurrent first-callers don't double-instantiate.
    const sign: SignerFn = async (canonical) => {
      if (!cachedKmsClient) cachedKmsClient = createRealGcpKmsEd25519Client();
      const client = await cachedKmsClient;
      return gcpKmsEd25519Signer({ keyResourceName: kmsKeyName, shortKeyId: keyId }, client)(canonical);
    };
    cachedSigner = { sign, keyId };
    return cachedSigner;
  }
  const pem = process.env.PROOF_SIGNING_KEY_PEM;
  if (pem) {
    cachedSigner = { sign: staticEd25519Signer(pem, keyId), keyId };
    return cachedSigner;
  }
  cachedSigner = null;
  return null;
}

/** Test-only: reset both signer + KMS-client memos. */
export function __resetSignerCacheForTests(): void {
  cachedSigner = undefined;
  cachedKmsClient = null;
}

/** Merkle proof entry matching the stored format */
export interface MerkleProofEntry {
  hash: string;
  position: 'left' | 'right';
}

/**
 * PROOF-05 (SCRUM-2338) — self-contained, INDEPENDENTLY-CHECKABLE proof bundle.
 *
 * Additive + nullable per Constitution §1.8: `proof_bundle` is a NEW key on the
 * frozen MerkleProofResponse; it is `null` whenever the two-layer proof is
 * incomplete and is NEVER fabricated (Constitution §1.5 — measured, not
 * asserted). It carries only the already-stored cryptographic evidence:
 *
 *   - app-tree (layer 1): fingerprint, merkle_root, merkle_proof, merkle_index,
 *     leaf_count
 *   - bitcoin-tree (layer 2): tx_id, block_height, block_hash, block_header,
 *     op_return_payload, block_timestamp
 *   - proof_schema_version: the format version (1 = plain double-SHA256)
 *   - signature: RESERVED inline-signature placeholder, always `null` today —
 *     the signed envelope lives at the outer `?format=signed` response level,
 *     not inside the bundle.
 *
 * CANONICAL SHAPE (frozen — PDF/CLI/fixtures conform to this):
 *   { fingerprint, merkle_root, merkle_proof:{hash,position}[], merkle_index,
 *     leaf_count, tx_id, block_height, block_hash(64hex), block_header(160hex),
 *     op_return_payload(ARKV‖root hex, no version byte), block_timestamp,
 *     proof_schema_version:1 (non-null), signature|null }.
 *
 * This is the contract consumed by FE-PROOF-GATE, the PROOF-04 PDF, and the
 * PROOF-07 CLI — keep the field set + names stable.
 *
 * SECURITY (§1.6 boundary): the bundle is built from an explicit allowlist of
 * cryptographic fields only. No raw document content, no PII, no extraction
 * metadata, and no `anchors.metadata` blob ever flows in — block_header /
 * op_return_payload are decoded bytea (header bytes / "ARKV"+root commitment),
 * not document bytes.
 */
export interface ProofBundleSignature {
  alg: string;
  signing_key_id: string;
}

export interface ProofBundle {
  fingerprint: string;
  merkle_root: string;
  merkle_proof: MerkleProofEntry[];
  merkle_index: number | null;
  /**
   * PROOF-05: total number of leaves in the batch tree this proof belongs to.
   * Together with `merkle_index` this arms the CVE-2012-2459 duplicate-leaf
   * structural guard downstream (see utils/merkle-verify.ts). BOTH must be
   * present in a complete bundle — a bundle with either unknown is `null`.
   * Sourced exactly from the count of `anchor_proofs` rows sharing this
   * proof's `batch_id` (one row per leaf), never estimated from branch length.
   */
  leaf_count: number;
  tx_id: string | null;
  block_height: number | null;
  block_hash: string | null;
  /** Raw 80-byte block header as plain 160-hex (bytea `\x` prefix stripped). */
  block_header: string | null;
  /**
   * Raw OP_RETURN payload as plain hex. Canonical Arkova shape:
   * "ARKV" (0x41524b56) + the 32-byte app-tree root (64 hex), NO version byte
   * — optionally followed by a truncated metadata hash (8/16 bytes). Matches
   * the on-chain format built by chain/signet.ts (`Buffer.concat([ARKV, root])`).
   */
  op_return_payload: string | null;
  block_timestamp: string | null;
  /**
   * Proof format version (1 = plain double-SHA256 app-tree). Non-null —
   * defaults to 1 when the stored row predates the column.
   */
  proof_schema_version: number;
  /**
   * RESERVED — inline detached-signature envelope metadata. Always `null` on
   * this (unsigned) JSON path today; the signed envelope lives at the outer
   * `?format=signed` response level (bundle_version + signature + signing_key_id
   * via createSignedBundle), NOT inside proof_bundle. Kept as a typed, nullable
   * placeholder so a future inline-signature format is additive (§1.8) and so
   * downstream consumers can treat `signature === null` as "verify the outer
   * envelope instead." Never fabricated.
   */
  signature: ProofBundleSignature | null;
}

/** Response shape for the proof endpoint */
export interface MerkleProofResponse {
  public_id: string;
  fingerprint: string;
  merkle_root: string;
  merkle_proof: MerkleProofEntry[];
  tx_id: string | null;
  block_height: number | null;
  block_timestamp: string | null;
  batch_id: string | null;
  /**
   * SCRUM-2490 (PROOF-VERIFY): the result of CRYPTOGRAPHICALLY recomputing
   * the Merkle root from `merkle_proof` and comparing it to `merkle_root`.
   * Derived purely from cryptography — NEVER from `anchors.status`.
   */
  verified: boolean;
  /**
   * PROOF-05 (SCRUM-2338): additive nullable self-contained proof bundle.
   * `null` when the two-layer proof is incomplete (Constitution §1.8 / §1.5).
   */
  proof_bundle: ProofBundle | null;
  /**
   * BUG-2026-08-13-010 (§1.5 / §1.6A): present only for connector-sourced
   * records — the fingerprint commits the exact bytes fetched from the
   * connected source at fetch time; re-fetching is NOT expected to reproduce
   * it. Response-level on purpose: NEVER inside `proof_bundle` (that object is
   * the signed / independently-verifiable artifact and its shape must not
   * grow a prose field). Omitted, never null, when not measured. Additive —
   * Constitution §1.8.
   */
  fingerprint_rederivability?: FingerprintRederivability;
  /**
   * The §1.5 measured / asserted / NOT-asserted statement for
   * `fingerprint_rederivability`. Present exactly when it is.
   */
  fingerprint_rederivability_note?: string;
}

/**
 * Stable, machine-readable discriminator for the two `/proof` 404 states.
 *
 * Additive per Constitution §1.8 — a NEW optional field, NOT a breaking change
 * and NOT a v2. The human-readable `error` prose is unchanged (older clients
 * that exact-match it keep working); this code lets a consumer (the FE
 * proof-availability classifier — src/lib/proofAvailability.ts) route on a
 * stable token instead of the prose, which would silently misroute if the copy
 * is ever localized or a typo is corrected.
 *
 * Only the two 404 bodies carry a code today:
 *   - NO_BATCH_PROOF    record exists (not deleted) but has NO Merkle proof —
 *                       the honest "state 2" back-catalogue signal (empty state)
 *   - RECORD_NOT_FOUND  unknown or soft-deleted publicId — a real error state
 *
 * 400 / 500 / 503 bodies intentionally omit it (undefined) — consumers MUST
 * treat its absence as "fall back to the `error` string / HTTP status".
 */
export const PROOF_ERROR_CODE = {
  NO_BATCH_PROOF: 'NO_BATCH_PROOF',
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
} as const;
export type ProofErrorCode = (typeof PROOF_ERROR_CODE)[keyof typeof PROOF_ERROR_CODE];

/** Error response */
export interface ProofErrorResponse {
  error: string;
  /**
   * Additive (§1.8) machine-readable 404 discriminator. Present only on the two
   * `/proof` 404 bodies; absent (undefined) on 400/500/503 and every response
   * that predates this field — consumers MUST fall back to `error` when absent.
   */
  proof_error_code?: ProofErrorCode;
  /**
   * SCRUM-2575: additive proof-availability class, present ONLY on the
   * NO_BATCH_PROOF 404 — the honest back-catalogue signal, where it is always
   * `root_only`. Absent on RECORD_NOT_FOUND (an unknown record has no proof
   * class) and on 400/500/503.
   */
  proof_availability?: ProofAvailability;
  /**
   * SCRUM-2575: the measured / asserted / NOT-asserted statement for
   * `proof_availability` (§1.5). Present exactly when it is.
   *
   * The prose `error` above says only that no Merkle proof is available, which a
   * caller can read as "this record could not be verified." That is the wrong
   * reading: the record IS anchored, its fingerprint IS committed on-chain, and
   * only the per-document branch is missing. This states that distinction
   * instead of leaving it to be inferred from a 404.
   */
  proof_availability_note?: string;
}

/**
 * SCRUM-2575: the NO_BATCH_PROOF 404 body, assembled in one place so the two
 * routes that emit it (test-lookup path and DB path) cannot drift.
 *
 * NOTE ON THE STATUS CODE. SCRUM-2575's acceptance criteria ask for root-only
 * anchors to be returned "neither a 404 nor a false verified verdict." This
 * change delivers the second half and the honest statement, but keeps the 404:
 * the code is load-bearing in the PUBLISHED FE contract
 * (`docs/reference/FE_PROOF_GATE_CONTRACT.md` §2.2) and in
 * `src/lib/proofAvailability.ts`, which routes on it to render the honest empty
 * state. Flipping it to 200 is a breaking contract change requiring the FE
 * classifier, the contract doc, and both SDKs to move together — see the PR body.
 * The affirmative honest answer now lives on `GET /api/v1/verify/:publicId`,
 * which returns 200 and states availability directly.
 */
export function noBatchProofBody(): ProofErrorResponse {
  return {
    error: 'No Merkle proof available for this record. It may not have been batch-anchored.',
    proof_error_code: PROOF_ERROR_CODE.NO_BATCH_PROOF,
    // Reaching this body means the route already failed to resolve a branch
    // from BOTH the stored row and the legacy metadata, so root_only is a
    // measurement here, not an assumption.
    ...proofAvailabilityFields(false),
  };
}

/** Injectable lookup for testing */
export interface ProofLookup {
  lookupByPublicId(publicId: string): Promise<ProofAnchorData | null>;
}

export interface ProofAnchorData {
  public_id: string;
  fingerprint: string;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ProofRecordData {
  merkle_root: string | null;
  proof_path: unknown;
  batch_id?: string | null;
  /** Integer leaf index (PROOF-02 column / PROOF-01 `merkle_index`). */
  merkle_index?: number | null;
  // PROOF-05 (SCRUM-2338): layer-2 bitcoin-tree columns (migration 0340).
  // `block_header` / `op_return_payload` are bytea — PostgREST returns them as
  // `\x`-prefixed hex; we normalise to plain hex via fromByteaHex.
  block_header?: string | null;
  block_hash?: string | null;
  op_return_payload?: string | null;
  proof_schema_version?: number | null;
}

/** Normalised proof source threaded into the cryptographic verdict. */
interface ResolvedProofSource {
  merkleRoot: string;
  merkleProof: MerkleProofEntry[];
  batchId: string | null;
  merkleIndex: number | null;
  /** PROOF-05: layer-2 bitcoin-tree fields, present only from a stored proof row. */
  blockHeader: string | null;
  blockHash: string | null;
  opReturnPayload: string | null;
  proofSchemaVersion: number;
}

/** Exactly 160 hex chars (case-insensitive) == an 80-byte block header. */
const BLOCK_HEADER_HEX_RE = /^[0-9a-fA-F]{160}$/;
/** Exactly 64 hex chars (case-insensitive) == a 32-byte block hash. */
const BLOCK_HASH_HEX_RE = /^[0-9a-fA-F]{64}$/;
/**
 * "ARKV" (0x41524b56) + the 32-byte app-tree root (64 hex) at minimum, then an
 * OPTIONAL trailing metadata hash. Even total length, all hex. NO version byte
 * — matches chain/signet.ts (`Buffer.concat([ARKV, root[, metadataHash]])`).
 */
const OP_RETURN_CANONICAL_RE = /^41524b56[0-9a-fA-F]{64}([0-9a-fA-F]{2})*$/i;

/**
 * PROOF-05: validate the OP_RETURN payload is the canonical Arkova commitment
 * AND that the 32-byte root it commits is EXACTLY this proof's `merkleRoot`.
 *
 * Carson P1 (second pass): shape validation alone is insufficient. A stored row
 * with merkle_root=A and op_return_payload=ARKV‖B is internally contradictory —
 * the on-chain commitment names a DIFFERENT app-tree than the branch the bundle
 * ships, yet the old (shape-only) gate still emitted a non-null, "complete"
 * bundle. An independently-checkable bundle must never advertise such a row.
 * We extract the committed 32-byte root (hex chars [8,72) — the 64 hex chars
 * following the 8-hex "ARKV"/41524b56 tag) and require it to equal `merkleRoot`
 * (case-insensitive). Any mismatch ⇒ `null` (no partial, no fabricated
 * commitment — Constitution §1.5: measured, not asserted).
 *
 * Returns the lowercased canonical hex when valid AND committing the expected
 * root, else `null`.
 */
function canonicalOpReturn(value: string | null, merkleRoot: string): string | null {
  if (value == null) return null;
  if (!OP_RETURN_CANONICAL_RE.test(value)) return null;
  // The regex guarantees ≥ 72 hex chars: 8-hex "ARKV" tag + 64-hex root. The
  // committed app-tree root is exactly those 64 hex chars at [8, 72).
  const committedRoot = value.slice(8, 72).toLowerCase();
  if (committedRoot !== merkleRoot.toLowerCase()) return null;
  return value.toLowerCase();
}

/** Read an integer leaf index from an untyped value (NULL/garbage → null). */
function readMerkleIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Validate that a merkle_proof array has the correct shape.
 *
 * SCRUM-2575: the implementation moved to `utils/proofBranch.ts` so
 * `/api/v1/verify` can apply the IDENTICAL test when it
 * decides whether to advertise `proof_availability: per_document`. Two surfaces
 * answering "is a proof available?" with two predicates is how the API ends up
 * contradicting itself about one record. Re-exported here to keep this module's
 * public surface unchanged.
 */
export { isValidProofArray } from '../../utils/proofBranch.js';

function extractStoredProof(
  proof: ProofRecordData | null,
): ResolvedProofSource | ProofErrorResponse | null {
  if (!proof?.merkle_root || !proof.proof_path) return null;
  if (!isValidProofArray(proof.proof_path)) {
    return { error: 'Merkle proof data is malformed' };
  }
  return {
    merkleRoot: proof.merkle_root,
    merkleProof: proof.proof_path,
    batchId: proof.batch_id ? String(proof.batch_id) : null,
    merkleIndex: readMerkleIndex(proof.merkle_index),
    // PROOF-05: bytea columns → plain hex; null/malformed → null (never faked).
    blockHeader: fromByteaHex(proof.block_header),
    blockHash: typeof proof.block_hash === 'string' && proof.block_hash.length > 0 ? proof.block_hash : null,
    opReturnPayload: fromByteaHex(proof.op_return_payload),
    proofSchemaVersion:
      typeof proof.proof_schema_version === 'number' && Number.isInteger(proof.proof_schema_version)
        ? proof.proof_schema_version
        : 1,
  };
}

function extractMetadataProof(
  metadata: Record<string, unknown> | null,
): ResolvedProofSource | ProofErrorResponse | null {
  if (!metadata?.merkle_root || !metadata.merkle_proof) return null;
  if (typeof metadata.merkle_root !== 'string') {
    return { error: 'Merkle proof data is malformed' };
  }
  if (metadata.batch_id != null && typeof metadata.batch_id !== 'string') {
    return { error: 'Merkle proof data is malformed' };
  }
  if (!isValidProofArray(metadata.merkle_proof)) {
    return { error: 'Merkle proof data is malformed' };
  }
  return {
    merkleRoot: metadata.merkle_root,
    merkleProof: metadata.merkle_proof,
    batchId: metadata.batch_id ?? null,
    merkleIndex: readMerkleIndex(metadata.merkle_index),
    // PROOF-05: the legacy metadata fallback never carries layer-2 bitcoin-tree
    // evidence, so the proof_bundle stays null for these (incomplete) records.
    blockHeader: null,
    blockHash: null,
    opReturnPayload: null,
    proofSchemaVersion: 1,
  };
}

/**
 * PROOF-05 (SCRUM-2338): assemble the self-contained `proof_bundle`, or `null`
 * when the two-layer proof is INCOMPLETE.
 *
 * Completeness rule (honest, never partial — Constitution §1.5). A bundle is
 * emitted ONLY when an independently-checkable verifier could (a) fetch the
 * Network/Anchor Receipt and (b) validate an 80-byte header / 32-byte block
 * hash / canonical commitment / structural inclusion. That requires ALL of:
 *   - app-tree: merkle_root + merkle_proof (guaranteed by the caller) AND
 *     merkle_index present AND leaf_count present (both arm the CVE-2012-2459
 *     duplicate-leaf guard).
 *   - receipt: tx_id, block_height, block_timestamp all present (else there is
 *     no receipt to fetch / no confirmation context).
 *   - bitcoin-tree: block_header EXACTLY 160 hex (80 bytes), block_hash EXACTLY
 *     64 hex (32 bytes), op_return_payload matching the canonical Arkova shape
 *     ("ARKV" + 64-hex root, no version byte, optional trailing metadata).
 *
 * Any missing field, short-but-well-formed hex, or non-ARKV payload ⇒ `null`
 * (no fabricated header, no half-bundle). This keeps the metadata-only /
 * app-tree-only records (the back catalogue) returning `proof_bundle: null`
 * rather than a misleading partial structure that a downstream verifier would
 * treat as complete and then fail to check.
 *
 * The field set is an explicit allowlist of cryptographic evidence — no raw
 * document bytes, PII, or `anchors.metadata` blob can leak in (§1.6).
 *
 * @param leafCount total leaves in the batch tree (count of anchor_proofs rows
 *                  sharing batch_id). `null` ⇒ unknown ⇒ incomplete ⇒ bundle null.
 */
function buildProofBundle(
  anchor: ProofAnchorData,
  source: ResolvedProofSource,
  leafCount: number | null,
): ProofBundle | null {
  // --- Receipt layer: a verifier must be able to fetch + frame the receipt.
  if (anchor.chain_tx_id == null) return null;
  if (anchor.chain_block_height == null) return null;
  if (anchor.chain_timestamp == null) return null;

  // --- App-tree structural completeness: index + count arm the CVE guard.
  if (source.merkleIndex == null) return null;
  if (!Number.isInteger(leafCount) || (leafCount as number) < 1) return null;
  // Index must be inside the tree (mirrors verifyMerkleInclusion's range check).
  if (source.merkleIndex < 0 || source.merkleIndex >= (leafCount as number)) return null;

  // --- Bitcoin-tree layer: exact sizes + canonical commitment, else null.
  if (source.blockHeader == null || !BLOCK_HEADER_HEX_RE.test(source.blockHeader)) return null;
  if (source.blockHash == null || !BLOCK_HASH_HEX_RE.test(source.blockHash)) return null;
  // Carson P1 (2nd pass): the OP_RETURN must COMMIT THIS EXACT merkle_root, not
  // merely have the canonical ARKV shape. A row whose committed root != the
  // app-tree root it ships is internally contradictory ⇒ bundle null.
  const opReturn = canonicalOpReturn(source.opReturnPayload, source.merkleRoot);
  if (opReturn == null) return null;

  return {
    fingerprint: anchor.fingerprint,
    merkle_root: source.merkleRoot,
    merkle_proof: source.merkleProof,
    merkle_index: source.merkleIndex,
    leaf_count: leafCount as number,
    tx_id: anchor.chain_tx_id,
    block_height: anchor.chain_block_height,
    block_hash: source.blockHash.toLowerCase(),
    block_header: source.blockHeader.toLowerCase(),
    op_return_payload: opReturn,
    block_timestamp: anchor.chain_timestamp,
    proof_schema_version: source.proofSchemaVersion,
    // RESERVED — inline signature is always null on this unsigned path today;
    // the signed envelope is the outer ?format=signed wrapper. Never fabricated.
    signature: null,
  };
}

/**
 * Build the proof response from anchor data.
 * Extracted for testability.
 *
 * @param leafCount total leaves in the batch tree this proof belongs to —
 *                  sourced by the production reader from the count of
 *                  `anchor_proofs` rows sharing the proof's `batch_id`. `null`
 *                  when unknown (no batch linkage); the bundle then stays null.
 * @param leafCountIndeterminate set by the production reader ONLY when the proof
 *                  IS batch-linked (has a `batch_id`) but the exact leaf_count
 *                  could NOT be determined — e.g. the count query returned an
 *                  error or a non-positive/null count on a transient DB fault.
 *                  This is the FAIL-CLOSED signal (CodeRabbit / SCRUM-2338).
 *                  When true we must NOT silently degrade to the weaker
 *                  `{leafIndex}`-only verdict (which RE-DISABLES the
 *                  CVE-2012-2459 structural self-pair guard and could read
 *                  `verified=true` for a structurally-forged batch proof) and we
 *                  must NOT suppress an otherwise-complete bundle as if the proof
 *                  were merely legacy/unbatched. Instead the request fails closed
 *                  / indeterminate (a `ProofErrorResponse`). A genuinely
 *                  single-leaf / non-batch proof carries `leafCount` resolved
 *                  (≥1) with this flag false and is unaffected.
 */
export function buildProofResponse(
  anchor: ProofAnchorData,
  proof: ProofRecordData | null = null,
  leafCount: number | null = null,
  leafCountIndeterminate = false,
): MerkleProofResponse | ProofErrorResponse | null {
  const proofSource = extractStoredProof(proof) ?? extractMetadataProof(anchor.metadata);
  if (!proofSource) return null;
  if ('error' in proofSource) return proofSource;

  // CodeRabbit (SCRUM-2338) — FAIL CLOSED on an indeterminate leaf_count for a
  // BATCH-linked proof. If the production reader could not resolve the exact
  // leaf_count for a proof that genuinely belongs to a batch tree, the verdict
  // CANNOT honestly run the CVE-2012-2459 structural guard, and the proof is not
  // "merely legacy/unbatched" — so we must neither emit `verified=true` via the
  // weaker {leafIndex}-only path nor suppress an otherwise-complete bundle as a
  // silent null. Surface it as indeterminate; the route maps this to a 500 so a
  // transient DB fault never downgrades the cryptographic guarantee.
  if (leafCountIndeterminate) {
    return { error: 'Proof leaf count could not be determined; verification is indeterminate.' };
  }

  // SCRUM-2490 (PROOF-VERIFY) — the pre-mortem K1 kill-shot was that
  // `verified` was derived from `anchors.status` and nothing recomputed the
  // root. `verified` is now the result of CRYPTOGRAPHICALLY recomputing the
  // app-tree root from the stored branch (with the CVE-2012-2459 guard when
  // the leaf index is known) and checking it equals the committed
  // `merkle_root`. Status is irrelevant to this field.
  //
  // Carson P1 (2nd pass): thread the EXACT `leafCount` into the TOP-LEVEL
  // verdict too. `leafCount` already flows to buildProofBundle, but the public
  // `verified` field previously passed only `{ leafIndex }`, leaving the
  // CVE-2012-2459 structural self-pair guard INACTIVE on the frozen verdict even
  // when the leaf count was known (a structurally-forged branch could read
  // verified=true). Pass BOTH when present; fall back to `{ leafIndex }` (then
  // `{}`) so legacy rows without a known count keep their prior recompute-only
  // behaviour.
  const inclusionOpts: { leafIndex?: number; leafCount?: number } = {};
  if (proofSource.merkleIndex != null) {
    inclusionOpts.leafIndex = proofSource.merkleIndex;
    if (leafCount != null) {
      inclusionOpts.leafCount = leafCount;
    }
  }
  const inclusion = verifyMerkleInclusion(
    anchor.fingerprint,
    proofSource.merkleProof,
    proofSource.merkleRoot,
    inclusionOpts,
  );

  return {
    public_id: anchor.public_id,
    fingerprint: anchor.fingerprint,
    merkle_root: proofSource.merkleRoot,
    merkle_proof: proofSource.merkleProof,
    tx_id: anchor.chain_tx_id,
    block_height: anchor.chain_block_height,
    block_timestamp: anchor.chain_timestamp,
    batch_id: proofSource.batchId,
    verified: inclusion.valid,
    // PROOF-05 (SCRUM-2338): additive, nullable self-contained bundle.
    proof_bundle: buildProofBundle(anchor, proofSource, leafCount),
    // BUG-2026-08-13-010 (§1.5/§1.6A): connector-sourced fingerprints attest
    // fetch-time bytes, not source re-derivability. Response-level only —
    // never inside the (signable) proof_bundle. Spread emits the indivisible
    // pair for a measured connector marker and NOTHING otherwise.
    ...(resolveConnectorFetchSource(anchor.metadata)
      ? connectorFingerprintRederivabilityFields()
      : {}),
  };
}

/**
 * GET /api/v1/verify/:publicId/proof
 */
router.get('/:publicId/proof', async (req: Request<{ publicId: string }>, res: Response) => {
  const { publicId } = req.params;

  if (!publicId || publicId.length < 3) {
    res.status(400).json({ error: 'Invalid publicId parameter' } as ProofErrorResponse);
    return;
  }

  try {
    // Use injected lookup for tests, lazy-import db for production
    const lookup = (req as unknown as { _testLookup?: ProofLookup })._testLookup;
    let anchor: ProofAnchorData | null;

    if (lookup) {
      anchor = await lookup.lookupByPublicId(publicId);
    } else {
      const { db } = await import('../../utils/db.js');
      const { data, error } = await db
        .from('anchors')
        .select('id, public_id, fingerprint, status, chain_tx_id, chain_block_height, chain_timestamp, metadata')
        .eq('public_id', publicId)
        .is('deleted_at', null)
        .single();

      if (error || !data) {
        anchor = null;
      } else {
        // PROOF-05 (SCRUM-2338): add the layer-2 bitcoin-tree columns (mig 0340).
        // Single-line literal so PostgREST/Supabase type inference resolves the
        // row shape (a concatenated/commented select degrades to GenericStringError).
        const { data: proofData } = await db
          .from('anchor_proofs')
          .select('merkle_root, proof_path, batch_id, merkle_index, block_header, block_hash, op_return_payload, proof_schema_version')
          .eq('anchor_id', data.id)
          .maybeSingle();

        anchor = {
          public_id: data.public_id ?? '',
          fingerprint: data.fingerprint,
          status: data.status,
          chain_tx_id: data.chain_tx_id,
          chain_block_height: data.chain_block_height,
          chain_timestamp: data.chain_timestamp,
          metadata: typeof data.metadata === 'object' && data.metadata !== null
            ? data.metadata as Record<string, unknown>
            : null,
        };

        // PROOF-05 (SCRUM-2338): the EXACT leaf_count for the tree this proof
        // belongs to is the number of anchor_proofs rows sharing the batch_id
        // (one row per leaf — upsert onConflict 'anchor_id'). This is the only
        // exact read-side source; we never estimate it from branch length.
        // `null` ⇒ unknown (no batch linkage) ⇒ buildProofBundle returns null.
        //
        // CodeRabbit (SCRUM-2338): when the proof IS batch-linked but the count
        // query fails (countError or a null/non-positive count on a transient DB
        // fault), we must FAIL CLOSED rather than fall back to the weaker
        // {leafIndex}-only verdict (which re-disables the CVE-2012-2459 guard)
        // and suppress an otherwise-complete bundle. `leafCountIndeterminate`
        // carries that signal into buildProofResponse, which returns an error.
        let leafCount: number | null = null;
        let leafCountIndeterminate = false;
        const batchId = proofData?.batch_id ?? null;
        if (batchId) {
          const { count, error: countError } = await db
            .from('anchor_proofs')
            .select('anchor_id', { count: 'exact', head: true })
            .eq('batch_id', batchId);
          if (!countError && typeof count === 'number' && count >= 1) {
            leafCount = count;
          } else {
            // Batch-linked but the exact count is unresolvable ⇒ indeterminate.
            leafCountIndeterminate = true;
          }
        }

        const result = buildProofResponse(
          anchor,
          proofData
            ? {
                merkle_root: proofData.merkle_root ?? null,
                proof_path: proofData.proof_path ?? null,
                batch_id: proofData.batch_id ?? null,
                merkle_index: proofData.merkle_index ?? null,
                // PROOF-05 (SCRUM-2338): layer-2 bitcoin-tree columns.
                block_header: proofData.block_header ?? null,
                block_hash: proofData.block_hash ?? null,
                op_return_payload: proofData.op_return_payload ?? null,
                proof_schema_version: proofData.proof_schema_version ?? null,
              }
            : null,
          leafCount,
          leafCountIndeterminate,
        );

        if (result === null) {
          res.status(404).json(noBatchProofBody());
          return;
        }

        if ('error' in result) {
          res.status(500).json(result);
          return;
        }

        if ((req.query.format as string | undefined) === 'signed') {
          const signer = resolveSigner();
          if (!signer) {
            res.status(503).json({
              error:
                'Signed proof bundle is not configured in this environment. Set PROOF_SIGNING_KEY_PEM + PROOF_SIGNING_KEY_ID or call without ?format=signed.',
            } as ProofErrorResponse);
            return;
          }
          // PROOF-06 (SCRUM-2339): bind the bundle to the issuer DID before
          // signing, so a verifier follows one chain — issuer DID →
          // assertionMethod key (signer.keyId) → anchored proof.
          const bundle = await createSignedBundle({
            payload: buildBoundProofPayload(
              result as unknown as Record<string, unknown>,
              signer.keyId,
            ),
            sign: signer.sign,
          });
          res.json(bundle);
          return;
        }

        res.json(result);
        return;
      }
    }

    if (!anchor) {
      res.status(404).json({
        error: 'Record not found',
        proof_error_code: PROOF_ERROR_CODE.RECORD_NOT_FOUND,
      } as ProofErrorResponse);
      return;
    }

    const result = buildProofResponse(anchor);

    if (result === null) {
      res.status(404).json(noBatchProofBody());
      return;
    }

    if ('error' in result) {
      res.status(500).json(result);
      return;
    }

    // Default shape is unchanged for backwards compatibility. `?format=signed`
    // wraps the payload in an Ed25519 envelope verifiable against our
    // published public key (docs.arkova.ai/keys.json).
    if ((req.query.format as string | undefined) === 'signed') {
      const signer = resolveSigner();
      if (!signer) {
        res.status(503).json({
          error:
            'Signed proof bundle is not configured in this environment. Set PROOF_SIGNING_KEY_PEM + PROOF_SIGNING_KEY_ID or call without ?format=signed.',
        } as ProofErrorResponse);
        return;
      }
      // PROOF-06 (SCRUM-2339): bind the bundle to the issuer DID before
      // signing, so a verifier follows one chain — issuer DID →
      // assertionMethod key (signer.keyId) → anchored proof.
      const bundle = await createSignedBundle({
        payload: buildBoundProofPayload(
          result as unknown as Record<string, unknown>,
          signer.keyId,
        ),
        sign: signer.sign,
      });
      res.json(bundle);
      return;
    }

    res.json(result);
  } catch (err) {
    // Lazy-import logger to avoid config chain in tests
    try {
      const { logger } = await import('../../utils/logger.js');
      logger.error({ error: err, publicId }, 'Merkle proof lookup failed');
    } catch {
      console.error('Merkle proof lookup failed:', err);
    }
    res.status(500).json({ error: 'Internal server error' } as ProofErrorResponse);
  }
});

export { router as verifyProofRouter };
