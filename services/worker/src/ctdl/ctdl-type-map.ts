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
  BADGE: 'ceterms:OpenBadge',
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

// SCRUM-2374 (CE-03) — ceterms:expirationDate is the RESOURCE-AVAILABILITY
// (offering) expiry: the date beyond which the credential resource is no longer
// offered/available (Jeanne Kitchens, Credential Engine — SCRUM-2294). It is NOT
// the expiration of a credential issued to a person; that person-level validity
// lives in the OB3/W3C VC layer (SCRUM-2296) and is never emitted here.
//
// This gate governs the STATUS dimension of that offering-availability date:
// ACTIVE/SECURED resources are still offered; an EXPIRED resource's offering term
// has lapsed (the availability date IS why it is expired). REVOKED and SUPERSEDED
// resources ended for an unrelated reason, so a forward-looking availability date
// would contradict the status. Single source of truth, shared by the serializer
// (gates emission) and the validator (rejects any body that re-introduces the
// conflict).
const STATUSES_ALLOWING_EXPIRATION = new Set(['ACTIVE', 'SECURED', 'EXPIRED']);

export function statusAllowsExpiration(status: string): boolean {
  return STATUSES_ALLOWING_EXPIRATION.has(status);
}

// SCRUM-2375 (CE-04) — credential types whose CE credit value is expressed as
// contact hours (CTDL ceterms:creditValue → ceterms:ValueProfile with
// creditUnit:ContactHour, per Jeanne Kitchens' correction). Deliberately narrow:
// only the continuing-education types (CPE, CLE) carry a contact-hour credit we
// can honestly assert; a `contact_hours` metadata value on any other type is
// ambiguous (semester hours? seat time?) and is omitted rather than guessed.
// Widen only with a documented CTDL-vocabulary reason.
const CONTINUING_EDUCATION_CREDIT_TYPES = new Set<string>(['CPE', 'CLE']);

export function isContinuingEducationCreditType(
  credentialType: string | null | undefined,
): boolean {
  return (
    typeof credentialType === 'string' && CONTINUING_EDUCATION_CREDIT_TYPES.has(credentialType)
  );
}
