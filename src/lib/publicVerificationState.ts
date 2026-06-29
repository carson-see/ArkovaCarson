export type PublicVerificationStatus = 'PENDING' | 'SUBMITTED' | 'SECURED' | 'REVOKED' | 'EXPIRED' | 'SUPERSEDED';

export function normalizePublicVerificationStatus(status: string): PublicVerificationStatus {
  if (status === 'ACTIVE') return 'SECURED';

  if (
    status === 'PENDING' ||
    status === 'SUBMITTED' ||
    status === 'SECURED' ||
    status === 'REVOKED' ||
    status === 'EXPIRED' ||
    status === 'SUPERSEDED'
  ) {
    return status;
  }

  return 'PENDING';
}

export function isPreSecuredStatus(status: PublicVerificationStatus): boolean {
  return status === 'PENDING' || status === 'SUBMITTED';
}

export function hasPublicVerificationProof(status: PublicVerificationStatus): boolean {
  return status === 'SECURED' || status === 'REVOKED' || status === 'EXPIRED' || status === 'SUPERSEDED';
}

/**
 * SECURED-only gate for DOWNLOADING a proof artifact (FE-PROOF-GATE / SCRUM-2501).
 *
 * Distinct from `hasPublicVerificationProof`: a REVOKED / EXPIRED / SUPERSEDED anchor
 * still HAS a public verification record (its status section renders), but its proof
 * must NOT be downloadable as a "Verified" artifact — we never hand out a downloadable
 * proof for an anchor that is no longer genuinely secured. Only SECURED qualifies.
 */
export function isProofDownloadable(status: PublicVerificationStatus): boolean {
  return status === 'SECURED';
}
