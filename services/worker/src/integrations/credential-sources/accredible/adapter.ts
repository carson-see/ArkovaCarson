/**
 * Accredible credential → Arkova evidence package adapter — SCRUM-1613 CSI-04C.
 *
 * Mirrors the Credly adapter (SCRUM-1612) in shape but maps Accredible's
 * `name`, `group.organization.name`, `issued_on`, `public_url` fields
 * into the canonical `credential_evidence_v1` schema.
 *
 * Verification level pinned to `account_linked` (issuer-API confirmed) for
 * the v1.0 trust boundary. Any `proof` or `credential_data` block found
 * in the response is surfaced via `proofDetected` for a v1.1 verification
 * upgrade pass — NEVER promoted to `source_signed` here (PRD §13).
 *
 * PII discipline: recipient email and credential id are SHA-256 hashed
 * before insertion; raw values are not stored in the evidence package.
 */
import { createHash } from 'node:crypto';

import {
  CREDENTIAL_EVIDENCE_SCHEMA_VERSION,
  type CredentialEvidenceHashInput,
  type CredentialEvidencePackage,
  buildCredentialEvidencePackage,
} from '../../../lib/credential-evidence.js';

import type { AccredibleCredential } from './client.js';

/** Source slug recorded into evidence packages. */
export const ACCREDIBLE_SOURCE_PROVIDER_SLUG = 'accredible' as const;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface AccredibleAdapterDeps {
  /** ISO 8601 timestamp the worker fetched this credential from Accredible. */
  fetchedAt: string;
  /** SHA-256 hex digest of the raw Accredible response bytes. */
  payloadHash: string;
  /** Byte length of the raw payload, captured for audit. */
  payloadByteLength?: number;
  /** Optional recipient email; hashed into the package if provided. */
  recipientEmail?: string;
}

export interface AccredibleAdapterResult {
  evidence: CredentialEvidenceHashInput;
  package: CredentialEvidencePackage;
  /**
   * True when the raw Accredible payload contained a `proof` block or
   * a `credential_data` envelope (OB3/VC-shaped). Recorded for v1.1
   * upgrade scans; does NOT promote verification_level today.
   */
  proofDetected: boolean;
}

/**
 * Map an Accredible credential object to an Arkova evidence package.
 *
 * Throws if essential fields are missing — Accredible responses without
 * a stable id or credential name cannot be safely anchored.
 */
export function accredibleCredentialToEvidence(
  credential: AccredibleCredential,
  deps: AccredibleAdapterDeps,
): AccredibleAdapterResult {
  // Accredible may return numeric ids; stringify for the canonical record.
  const rawId =
    typeof credential.id === 'number' ? String(credential.id) : credential.id;
  if (!rawId) {
    throw new Error('Accredible credential missing required `id`');
  }
  const title = credential.name;
  if (!title) {
    throw new Error('Accredible credential missing required `name`');
  }

  // public_url is the most stable canonical source URL; fall back to a
  // deterministic API path when absent.
  const source_url =
    credential.public_url ??
    `https://api.accredible.com/v1/credentials/${encodeURIComponent(rawId)}`;

  const recipientIdentifierHash = deps.recipientEmail
    ? sha256Hex(deps.recipientEmail.trim().toLowerCase())
    : undefined;

  const proofDetected =
    (credential.proof !== undefined && credential.proof !== null) ||
    (credential.credential_data !== undefined &&
      credential.credential_data !== null);

  // Accredible credentials cover degrees / certs / awards / accreditations;
  // we record them all as CERTIFICATE which is the closest existing canonical
  // type. Future refinement: detect group.kind to split CERTIFICATE vs
  // DEGREE vs ACCREDITATION — non-blocking for v1.0.
  const evidence: CredentialEvidenceHashInput = {
    schemaVersion: CREDENTIAL_EVIDENCE_SCHEMA_VERSION,
    source: {
      provider: ACCREDIBLE_SOURCE_PROVIDER_SLUG,
      url: source_url,
      id: rawId,
      fetchedAt: deps.fetchedAt,
      payloadHash: deps.payloadHash,
      payloadContentType: 'application/json',
      payloadByteLength: deps.payloadByteLength,
    },
    credential: {
      type: 'CERTIFICATE',
      title,
      issuerName: credential.group?.organization?.name,
      issuedAt: credential.issued_on,
      expiresAt: credential.expired_on ?? undefined,
      credentialIdHash: sha256Hex(rawId),
      recipientIdentifierHash,
    },
    evidence: {
      // v1.0 trust boundary — same discipline as the Credly adapter.
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
