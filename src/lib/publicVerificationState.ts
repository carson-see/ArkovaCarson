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
