import {
  CTDL_CONTEXT,
  resolveCtdlType,
  toCtdlCredentialStatusType,
  type CtdlStatusType,
  type CtdlType,
} from './ctdl-type-map.js';
import { assertValidCtdlJsonLd } from './ctdl-validation.js';

export interface CtdlIssuer {
  name?: string | null;
  publicId?: string | null;
  websiteUrl?: string | null;
  domain?: string | null;
}

export interface CtdlAnchor {
  publicId: string;
  /** Internal audit context only. The serializer never emits this field. */
  orgId?: string | null;
  status: string;
  credentialType: string | null;
  subType?: string | null;
  label?: string | null;
  description?: string | null;
  metadata?: unknown;
  createdAt: string;
  chainTimestamp?: string | null;
  issuedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revocationReason?: string | null;
  issuer?: CtdlIssuer | null;
}

export interface BuildCtdlOptions {
  verifyUrl: string;
}

export interface CtdlJsonLd {
  '@context': typeof CTDL_CONTEXT;
  '@type': CtdlType;
  'ceterms:name': string;
  'ceterms:ctid': string;
  'ceterms:offeredBy': {
    '@type': 'ceterms:Organization';
    'ceterms:name': string;
    'ceterms:ctid'?: string;
    'ceterms:subjectWebpage'?: string;
  };
  'ceterms:credentialStatusType': CtdlStatusType;
  'ceterms:dateEffective': string;
  'ceterms:verificationServiceProfile': {
    '@type': 'ceterms:VerificationServiceProfile';
    'ceterms:name': string;
    'ceterms:verificationService': string;
  };
  'ceterms:identifier': {
    'ceterms:identifierType': 'Arkova public credential ID';
    'ceterms:identifierValue': string;
  };
  'ceterms:description'?: string;
  'ceterms:expirationDate'?: string;
  'ceterms:revocationDate'?: string;
  'ceterms:revocationReason'?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stripControlChars(value: string): string {
  return Array.from(value).filter((ch) => {
    const code = ch.charCodeAt(0);
    return code >= 32 && code !== 127;
  }).join('');
}

function cleanPublicString(value: unknown, maxLength = 240): string | null {
  if (typeof value !== 'string') return null;
  const clean = stripControlChars(value).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length <= maxLength ? clean : clean.slice(0, maxLength).trimEnd();
}

function pickMetadataString(metadata: Record<string, unknown>, keys: readonly string[], maxLength?: number): string | null {
  for (const key of keys) {
    const clean = cleanPublicString(metadata[key], maxLength);
    if (clean) return clean;
  }
  return null;
}

function isPublicHttpUrl(value: unknown): string | null {
  const clean = cleanPublicString(value, 500);
  if (!clean) return null;
  try {
    const url = new URL(clean);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function credentialName(anchor: CtdlAnchor, metadata: Record<string, unknown>): string {
  return (
    cleanPublicString(anchor.label) ??
    pickMetadataString(metadata, [
      'credential_name',
      'credentialName',
      'course_title',
      'courseTitle',
      'program_name',
      'programName',
      'certificate_title',
      'certificateTitle',
      'name',
      'title',
    ]) ??
    cleanPublicString(anchor.description) ??
    `Arkova credential ${anchor.publicId}`
  );
}

function issuerName(anchor: CtdlAnchor, metadata: Record<string, unknown>): string {
  return (
    cleanPublicString(anchor.issuer?.name) ??
    pickMetadataString(metadata, [
      'issuer_name',
      'issuerName',
      'issuer',
      'provider_name',
      'providerName',
      'entity_name',
      'entityName',
    ]) ??
    'Arkova verified issuer'
  );
}

function effectiveDate(anchor: CtdlAnchor): string {
  return anchor.issuedAt ?? anchor.chainTimestamp ?? anchor.createdAt;
}

function ctidFromPublicId(publicId: string): string {
  return `ce-${publicId}`;
}

export function buildCtdlJsonLd(anchor: CtdlAnchor, options: BuildCtdlOptions): CtdlJsonLd {
  const statusType = toCtdlCredentialStatusType(anchor.status);
  if (!statusType) {
    throw new Error(`Cannot serialize CTDL for non-publishable status: ${anchor.status}`);
  }

  const metadata = asRecord(anchor.metadata);
  const offeredBy: CtdlJsonLd['ceterms:offeredBy'] = {
    '@type': 'ceterms:Organization',
    'ceterms:name': issuerName(anchor, metadata),
  };

  if (anchor.issuer?.publicId) {
    offeredBy['ceterms:ctid'] = ctidFromPublicId(anchor.issuer.publicId);
  }

  const subjectWebpage = isPublicHttpUrl(anchor.issuer?.websiteUrl);
  if (subjectWebpage) {
    offeredBy['ceterms:subjectWebpage'] = subjectWebpage;
  }

  const jsonLd: CtdlJsonLd = {
    '@context': CTDL_CONTEXT,
    '@type': resolveCtdlType(anchor.credentialType, anchor.subType),
    'ceterms:name': credentialName(anchor, metadata),
    'ceterms:ctid': ctidFromPublicId(anchor.publicId),
    'ceterms:offeredBy': offeredBy,
    'ceterms:credentialStatusType': statusType,
    'ceterms:dateEffective': effectiveDate(anchor),
    'ceterms:verificationServiceProfile': {
      '@type': 'ceterms:VerificationServiceProfile',
      'ceterms:name': 'Arkova credential verification',
      'ceterms:verificationService': options.verifyUrl,
    },
    'ceterms:identifier': {
      'ceterms:identifierType': 'Arkova public credential ID',
      'ceterms:identifierValue': anchor.publicId,
    },
  };

  const description = cleanPublicString(anchor.description, 500);
  if (description) jsonLd['ceterms:description'] = description;
  if (anchor.expiresAt) jsonLd['ceterms:expirationDate'] = anchor.expiresAt;
  if (anchor.status === 'REVOKED') {
    if (anchor.revokedAt) jsonLd['ceterms:revocationDate'] = anchor.revokedAt;
    const reason = cleanPublicString(anchor.revocationReason, 500);
    if (reason) jsonLd['ceterms:revocationReason'] = reason;
  }

  assertValidCtdlJsonLd(jsonLd);
  return jsonLd;
}
