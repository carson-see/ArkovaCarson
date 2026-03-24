/**
 * Proof Package Export
 *
 * Generates and validates proof packages for anchor verification.
 * Uses approved terminology per Constitution.
 */

import { z } from 'zod';

// =============================================================================
// PROOF PACKAGE SCHEMA
// =============================================================================

/**
 * Schema for exported proof package
 */
export const ProofPackageSchema = z.object({
  version: z.literal('1.0'),
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

  // Metadata
  metadata: z.object({
    created_at: z.string().datetime(),
    user_id: z.string().uuid(),
    org_id: z.string().uuid().nullable(),
  }),

  // Human-readable glossary (Design Audit #10)
  proof_glossary: z.record(z.string()).optional(),
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

/**
 * Generate a proof package from anchor data
 */
export function generateProofPackage(
  anchor: AnchorData,
  proof?: ProofData
): ProofPackage {
  const proofPackage: ProofPackage = {
    version: '1.0',
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
      anchor.status === 'SECURED' && anchor.chain_tx_id
        ? {
            network_proof_id: anchor.chain_tx_id,
            block_height: anchor.chain_block_height!,
            observed_time: anchor.chain_timestamp!,
          }
        : null,

    proof: proof
      ? {
          verification_tree_root: proof.merkle_root,
          proof_path: proof.proof_path,
        }
      : null,

    metadata: {
      created_at: anchor.created_at,
      user_id: anchor.user_id,
      org_id: anchor.org_id,
    },

    proof_glossary: {
      fingerprint: 'A SHA-256 hash of the document contents. Two identical documents always produce the same fingerprint.',
      network_proof_id: 'The unique identifier for the network record that contains this document\'s proof.',
      verification_tree_root: 'The root of the Merkle tree that groups multiple documents into a single network record.',
      proof_path: 'The cryptographic path from this document\'s fingerprint to the verification tree root.',
      observed_time: 'The timestamp when the network confirmed this record.',
      block_height: 'The position in the network\'s permanent record chain where this proof was stored.',
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
  link.remove();
  URL.revokeObjectURL(url);
}
