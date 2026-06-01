/**
 * Credly badge → Arkova evidence package adapter — SCRUM-1612 CSI-04B.
 *
 * Transforms a single `CredlyIssuedBadge` (as returned by `client.ts`) into
 * a `CredentialEvidenceHashInput` that the existing CSI-01 module
 * (`services/worker/src/lib/credential-evidence.ts`) can hash and anchor.
 *
 * Verification level in v1.0:
 *   - We have authoritative-source confirmation (the issuer-partnered Credly
 *     org returned this badge via its own API), so verification_level is
 *     `'account_linked'`. This is the strongest level v1.0 supports for a
 *     credential-source-import flow.
 *   - We do NOT set `'source_signed'` even when Credly returns a `proof`
 *     block. Per PRD §13 cryptographic VC proof verification is deferred
 *     to v1.1; promoting to `source_signed` without verifying the proof
 *     would be the trust gap I flagged on SCRUM-1596 and SCRUM-1600.
 *   - We do detect the `proof` field so a future v1.1 pipeline can scan
 *     historical rows and upgrade them once verification ships.
 *
 * PII handling:
 *   - The adapter never copies the raw recipient email into the evidence
 *     package. It only stores a SHA-256 hash of the lowercased email in
 *     `credential.recipientIdentifierHash`.
 *   - Same for credential id — we hash it into `credentialIdHash` rather
 *     than copying the raw value, so the on-chain leaf reveals nothing
 *     that would not already be visible on the Credly public page.
 *
 * No raw payload is hashed here. Callers compute `payloadHash` over the
 * exact bytes they received from Credly and pass it in via `deps`. This
 * lets the import job persist the raw payload alongside the evidence
 * package for v1.1 verification re-runs without breaking the hash chain.
 */
import { createHash } from 'node:crypto';

import {
  CREDENTIAL_EVIDENCE_SCHEMA_VERSION,
  type CredentialEvidenceHashInput,
  type CredentialEvidencePackage,
  buildCredentialEvidencePackage,
} from '../../../lib/credential-evidence.js';

import type { CredlyIssuedBadge } from './client.js';

/** Source slug recorded into evidence packages — matches PRD §6.1. */
export const CREDLY_SOURCE_PROVIDER_SLUG = 'credly' as const;

/** SHA-256 hex digest of a UTF-8 string (lowercased emails, raw ids). */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface CredlyAdapterDeps {
  /** ISO 8601 timestamp the worker fetched this badge from Credly. */
  fetchedAt: string;
  /** SHA-256 hex digest of the raw Credly response bytes. */
  payloadHash: string;
  /** Optional byte length of the raw payload, captured for audit. */
  payloadByteLength?: number;
  /** Optional recipient email; if provided it is hashed into the package. */
  recipientEmail?: string;
}

export interface CredlyAdapterResult {
  /** The hash-input shape, ready to feed back into the anchor pipeline. */
  evidence: CredentialEvidenceHashInput;
  /** The fully-built package including `evidencePackageHash`. */
  package: CredentialEvidencePackage;
  /**
   * True when the raw Credly payload contained a `proof` block (i.e. the
   * badge is OB3-compliant and cryptographically signed by Credly).
   * Recorded for v1.1 upgrade scans; does NOT promote `verification_level`.
   */
  proofDetected: boolean;
}

/**
 * Map a Credly issued-badge object to an Arkova evidence package.
 *
 * Throws if essential fields are missing — Credly responses without a
 * stable badge id or template name cannot be safely anchored.
 */
export function credlyBadgeToEvidence(
  badge: CredlyIssuedBadge,
  deps: CredlyAdapterDeps,
): CredlyAdapterResult {
  if (!badge.id) {
    throw new Error('Credly badge missing required `id`');
  }
  const title = badge.badge_template?.name;
  if (!title) {
    throw new Error('Credly badge missing required `badge_template.name`');
  }

  // public_url is the most stable canonical source URL Credly emits;
  // we fall back to a deterministic API path when absent.
  const source_url =
    badge.public_url ??
    `https://api.credly.com/v1/issued_badges/${encodeURIComponent(badge.id)}`;

  // Recipient email (when present) is lowercased before hashing so two
  // syntactic variants of the same email hash identically.
  const recipientIdentifierHash = deps.recipientEmail
    ? sha256Hex(deps.recipientEmail.trim().toLowerCase())
    : undefined;

  const proofDetected = badge.proof !== undefined && badge.proof !== null;

  const evidence: CredentialEvidenceHashInput = {
    schemaVersion: CREDENTIAL_EVIDENCE_SCHEMA_VERSION,
    source: {
      provider: CREDLY_SOURCE_PROVIDER_SLUG,
      url: source_url,
      id: badge.id,
      fetchedAt: deps.fetchedAt,
      payloadHash: deps.payloadHash,
      payloadContentType: 'application/json',
      payloadByteLength: deps.payloadByteLength,
    },
    credential: {
      type: 'BADGE',
      title,
      issuerName: badge.badge_template?.owner?.name,
      issuedAt: badge.issued_at,
      expiresAt: badge.expires_at ?? undefined,
      credentialIdHash: sha256Hex(badge.id),
      recipientIdentifierHash,
    },
    evidence: {
      // v1.0: account_linked — issuer-partnership API confirmed.
      // NOT source_signed even if `proof` is present (deferred to v1.1).
      verificationLevel: 'account_linked',
      extractionMethod: 'issuer_api',
      confidence: 1.0,
    },
  };

  return {
    evidence,
    package: buildCredentialEvidencePackage(evidence),
    proofDetected,
  };
}
