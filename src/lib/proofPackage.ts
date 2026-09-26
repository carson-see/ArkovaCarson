/**
 * Proof Package Export
 *
 * Generates and validates proof packages for anchor verification.
 * Uses approved terminology per Constitution.
 */

import { z } from 'zod';

import type { ProofPacket } from './generateAuditReport';

// Zod v4 enforces RFC 4122 version+variant bits in z.string().uuid().
// Seed/test UUIDs (e.g. 44444444-0000-0000-0000-000000000001) use zeroed
// version/variant fields. Accept any 8-4-4-4-12 hex UUID here so proof
// packages validate in both production (proper v4 UUIDs) and local dev.
const uuidLenient = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
);

// =============================================================================
// PROOF PACKAGE SCHEMA
// =============================================================================

/**
 * `{ hash, position }` — the sibling entry shape shared by BOTH inclusion
 * branches. Never `string[]`: a bare hash list drops the side each sibling is
 * folded on, which is exactly the information an offline verifier needs to
 * recompute a root. See the same warning in `buildProofPacket`.
 */
const MerkleProofEntrySchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/i),
  position: z.enum(['left', 'right']),
});

/**
 * The CANONICAL machine-readable proof bundle — field-for-field the packet that
 * PROOF-05 (SCRUM-2338) emits on `GET /api/v1/verify/:id/proof`, that the
 * PROOF-07 reference CLI parses, and that the PDF certificate embeds via
 * `buildProofPacket`. Mirrored here so the JSON export carries the SAME
 * artifact rather than a second, weaker shape.
 */
const ProofBundleSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  merkle_root: z.string().nullable(),
  /** Layer-1 APP-tree branch, in stored orientation. */
  merkle_proof: z.array(MerkleProofEntrySchema).nullable(),
  merkle_index: z.number().nullable(),
  /** Arms the CVE-2012-2459 duplicate-leaf guard together with merkle_index. */
  leaf_count: z.number().nullable(),
  tx_id: z.string().nullable(),
  block_height: z.number().nullable(),
  block_hash: z.string().nullable(),
  /** Raw 80-byte header as 160-hex — binds merkle_root to the block. */
  block_header: z.string().nullable(),
  /** "ARKV"+root commitment as plain hex. */
  op_return_payload: z.string().nullable(),
  proof_schema_version: z.number(),
  block_timestamp: z.string().nullable(),
  /**
   * Layer-2 BITCOIN-tree branch (migration 0427). NOT interchangeable with
   * `merkle_proof`: byte-reversed hex folded with Bitcoin's positional rule.
   */
  tx_inclusion_branch: z.array(MerkleProofEntrySchema).nullable(),
  tx_block_index: z.number().nullable(),
  signature: z
    .object({ alg: z.string(), signing_key_id: z.string() })
    .nullable(),
});

/**
 * Schema for exported proof package
 *
 * `1.1` adds `proof_bundle` (additive). Historical `1.0` files still validate:
 * the field is optional and the version is accepted as a union.
 */
export const ProofPackageSchema = z.object({
  version: z.union([z.literal('1.0'), z.literal('1.1')]),
  generated_at: z.string().datetime(),

  // Document info
  document: z.object({
    filename: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
    file_size: z.number().nullable(),
    mime_type: z.string().nullable(),
  }),

  // Verification status
  verification: z.object({
    status: z.enum(['PENDING', 'SUBMITTED', 'SECURED', 'REVOKED', 'EXPIRED']),
    verified: z.boolean(),
    public_id: z.string().nullable(),
  }),

  // Network receipt (chain data) — humanized field names (Design Audit #10)
  network_receipt: z
    .object({
      network_proof_id: z.string(),
      block_height: z.number(),
      observed_time: z.string().datetime(),
    })
    .nullable(),

  // Verification tree proof (if available) — humanized field names (Design Audit #10)
  proof: z
    .object({
      verification_tree_root: z.string().nullable(),
      proof_path: z.array(z.string()).nullable(),
    })
    .nullable(),

  // Canonical, independently-verifiable bundle (added in 1.1). The humanized
  // `proof` above is retained for back-compat but is NOT sufficient on its own:
  // its `proof_path` is a bare hash list with no sibling positions.
  proof_bundle: ProofBundleSchema.nullable().optional(),

  // Whether every field needed to run EVERY offline check was sourced. False
  // means the bundle is present and inspectable but at least one guard cannot
  // be run — today that is `leaf_count`, which arms the CVE-2012-2459
  // duplicate-leaf check for a batch member. The PDF certificate has carried
  // this since PROOF-04 (it swaps in different prose); the JSON carried it only
  // as a transient toast, so once dismissed the file was indistinguishable from
  // a fully-verifiable proof. §1.5: state what is measured.
  proof_bundle_complete: z.boolean().nullable().optional(),

  // Metadata
  metadata: z.object({
    created_at: z.string().datetime(),
    user_id: uuidLenient,
    org_id: uuidLenient.nullable(),
  }),

  // Human-readable glossary (Design Audit #10)
  proof_glossary: z.record(z.string(), z.string()).optional(),
});

export type ProofPackage = z.infer<typeof ProofPackageSchema>;

// =============================================================================
// PROOF PACKAGE GENERATOR
// =============================================================================

interface AnchorData {
  id: string;
  fingerprint: string;
  filename: string;
  file_size: number | null;
  file_mime: string | null;
  status: 'PENDING' | 'SUBMITTED' | 'SECURED' | 'REVOKED' | 'EXPIRED';
  public_id: string | null;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  created_at: string;
  user_id: string;
  org_id: string | null;
}

interface ProofData {
  merkle_root: string | null;
  proof_path: string[] | null;
}

function toIsoDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid proof package timestamp: ${value}`);
  }
  return date.toISOString();
}

/**
 * Generate a proof package from anchor data
 */
export function generateProofPackage(
  anchor: AnchorData,
  proof?: ProofData,
  proofBundle?: ProofPacket | null,
  proofBundleComplete?: boolean
): ProofPackage {
  const hasNetworkReceipt =
    anchor.status === 'SECURED' &&
    Boolean(anchor.chain_tx_id) &&
    typeof anchor.chain_block_height === 'number' &&
    Boolean(anchor.chain_timestamp);

  const proofPackage: ProofPackage = {
    version: '1.1',
    generated_at: new Date().toISOString(),

    document: {
      filename: anchor.filename,
      fingerprint: anchor.fingerprint,
      file_size: anchor.file_size,
      mime_type: anchor.file_mime,
    },

    verification: {
      status: anchor.status,
      verified: anchor.status === 'SECURED',
      public_id: anchor.public_id,
    },

    network_receipt:
      hasNetworkReceipt
        ? {
            network_proof_id: anchor.chain_tx_id!,
            block_height: anchor.chain_block_height!,
            observed_time: toIsoDateTime(anchor.chain_timestamp!),
          }
        : null,

    proof: proof
      ? {
          verification_tree_root: proof.merkle_root,
          proof_path: proof.proof_path,
        }
      : null,

    // The verifiable artifact. `null` when the record has no servable branch
    // (proof_availability `root_only`) — stated as null rather than omitted so a
    // consumer can tell "no proof stored" from "older export format".
    proof_bundle: proofBundle ?? null,

    // Only meaningful when a bundle exists; null otherwise so a consumer cannot
    // read "complete: false" as a statement about a record that has no proof.
    proof_bundle_complete: proofBundle ? (proofBundleComplete ?? false) : null,

    metadata: {
      created_at: toIsoDateTime(anchor.created_at),
      user_id: anchor.user_id,
      org_id: anchor.org_id,
    },

    proof_glossary: {
      fingerprint: 'A SHA-256 fingerprint of the document contents. Two identical documents always produce the same fingerprint.',
      network_proof_id: 'The unique identifier for the network record that contains this document\'s proof.',
      verification_tree_root: 'The root of the Merkle tree that groups multiple documents into a single network record.',
      proof_path: 'The cryptographic path from this document\'s fingerprint to the verification tree root.',
      observed_time: 'The timestamp when the network confirmed this record.',
      block_height: 'The position in the network\'s permanent record chain where this proof was stored.',
      proof_bundle: 'The machine-readable proof, in the same format the verification API and the reference verifier use. This is the field an independent tool checks.',
      merkle_proof: 'Each sibling fingerprint on the path to the verification tree root, with the side it is combined on. Both parts are required to recompute the root.',
      leaf_count: 'How many documents were grouped into this verification tree. Used to reject a malformed proof that reuses a duplicated entry.',
      block_header: 'The raw 80-byte header of the permanent network record holding this proof. Recomputing its fingerprint shows the verification tree root was committed to that record.',
      op_return_payload: 'The exact bytes Arkova committed to the network for this group of documents.',
      tx_inclusion_branch: 'The sibling path showing this anchor receipt is contained in the permanent network record identified by the header above.',
      proof_bundle_complete: 'True when every field needed to run all offline checks was available. If false, the proof is still shown for inspection but at least one check cannot be completed.',
    },
  };

  // Validate the package
  return ProofPackageSchema.parse(proofPackage);
}

/**
 * Validate an imported proof package
 */
export function validateProofPackage(data: unknown): ProofPackage {
  return ProofPackageSchema.parse(data);
}

/**
 * Generate download filename
 */
export function getProofPackageFilename(anchor: { filename: string; public_id: string | null }): string {
  const basename = anchor.filename.replace(/\.[^/.]+$/, '');
  const id = anchor.public_id || 'pending';
  return `arkova-proof-${basename}-${id}.json`;
}

/**
 * Download proof package as JSON file
 */
export function downloadProofPackage(proofPackage: ProofPackage, filename: string): void {
  const json = JSON.stringify(proofPackage, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 100);
}
