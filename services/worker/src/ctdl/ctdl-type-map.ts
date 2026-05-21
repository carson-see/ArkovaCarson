import {
  ANCHOR_CREDENTIAL_TYPES,
  type AnchorCredentialType,
} from '../lib/credential-evidence.js';

export type CtdlType = `ceterms:${string}`;
export type CtdlStatusType = `ceterms:${string}`;

export const CTDL_CONTEXT = 'https://credreg.net/ctdl/schema/context/json' as const;

export const CTDL_TYPE_MAP = {
  DEGREE: 'ceterms:Degree',
  LICENSE: 'ceterms:License',
  CERTIFICATE: 'ceterms:Certificate',
  TRANSCRIPT: 'ceterms:Credential',
  PROFESSIONAL: 'ceterms:ProfessionalCertification',
  CPE: 'ceterms:Certificate',
  CLE: 'ceterms:Certificate',
  BADGE: 'ceterms:DigitalBadge',
  ATTESTATION: 'ceterms:Certification',
  FINANCIAL: 'ceterms:Credential',
  LEGAL: 'ceterms:Credential',
  INSURANCE: 'ceterms:License',
  SEC_FILING: 'ceterms:Credential',
  PATENT: 'ceterms:Credential',
  REGULATION: 'ceterms:Credential',
  PUBLICATION: 'ceterms:Credential',
  CHARITY: 'ceterms:Credential',
  ACCREDITATION: 'ceterms:Credential',
  FINANCIAL_ADVISOR: 'ceterms:ProfessionalCertification',
  BUSINESS_ENTITY: 'ceterms:Credential',
  RESUME: 'ceterms:Credential',
  MEDICAL: 'ceterms:License',
  MILITARY: 'ceterms:Credential',
  IDENTITY: 'ceterms:Credential',
  CONTRACT_PRESIGNING: 'ceterms:Credential',
  CONTRACT_POSTSIGNING: 'ceterms:Credential',
  OTHER: 'ceterms:Credential',
} as const satisfies Record<AnchorCredentialType, CtdlType>;

const ANCHOR_CREDENTIAL_TYPE_SET = new Set<string>(ANCHOR_CREDENTIAL_TYPES);

export function isAnchorCredentialType(value: unknown): value is AnchorCredentialType {
  return typeof value === 'string' && ANCHOR_CREDENTIAL_TYPE_SET.has(value);
}

export function resolveCtdlType(
  credentialType: string | null | undefined,
  subType?: string | null,
): CtdlType {
  if (!isAnchorCredentialType(credentialType)) return CTDL_TYPE_MAP.OTHER;

  if (credentialType === 'DEGREE') {
    const level = (subType ?? '').toLowerCase();
    if (level.includes('associate')) return 'ceterms:AssociateDegree';
    if (level.includes('bachelor')) return 'ceterms:BachelorDegree';
    if (level.includes('master')) return 'ceterms:MasterDegree';
    if (level.includes('doctor') || level.includes('phd')) return 'ceterms:DoctoralDegree';
    if (level.includes('professional')) return 'ceterms:ProfessionalDegree';
  }

  return CTDL_TYPE_MAP[credentialType];
}

export function toCtdlCredentialStatusType(status: string): CtdlStatusType | null {
  switch (status) {
    case 'SECURED':
    case 'ACTIVE':
      return 'ceterms:Active';
    case 'REVOKED':
      return 'ceterms:Revoked';
    case 'EXPIRED':
      return 'ceterms:Expired';
    case 'SUPERSEDED':
      return 'ceterms:Superseded';
    default:
      return null;
  }
}

export function isCtdlPublishableStatus(status: string): boolean {
  return toCtdlCredentialStatusType(status) !== null;
}
