import {
  CTDL_CONTEXT,
  resolveCtdlType,
  toCtdlCredentialStatusType,
  type CtdlType,
} from './ctdl-type-map.js';
import { assertValidCtdlJsonLd } from './ctdl-validation.js';
// SCRUM-1922 R-CTDL-FR9 — keep the issuer DID format in lockstep with the
// did:web resolver so the CTDL `sameAs` link resolves to the org's DID doc.
import { ARKOVA_DID } from '../api/did-web.js';

export interface CtdlIssuer {
  name?: string | null;
  publicId?: string | null;
  ctid?: string | null;
  websiteUrl?: string | null;
  domain?: string | null;
}

export interface CtdlAnchor {
  publicId: string;
  ctid?: string | null;
  /** Internal audit context only. The serializer never emits this field. */
  orgId?: string | null;
  status: string;
  credentialType: string | null;
  subType?: string | null;
  label?: string | null;
  description?: string | null;
  metadata?: unknown;
  cpeMetadata?: Record<string, unknown> | null;
  cleMetadata?: Record<string, unknown> | null;
  createdAt: string;
  chainTimestamp?: string | null;
  issuedAt?: string | null;
  /** Issued-person expiry. Do not serialize as CTDL resource availability. */
  expiresAt?: string | null;
  revokedAt?: string | null;
  revocationReason?: string | null;
  issuer?: CtdlIssuer | null;
}

export interface BuildCtdlOptions {
  verifyUrl: string;
}

export interface CtdlCreditValueProfile {
  '@type': 'ceterms:ValueProfile';
  'schema:value': number;
  'ceterms:creditUnitType': 'creditUnit:ContactHour';
  'schema:description': string;
}

export interface CtdlConditionProfile {
  '@type': 'ceterms:ConditionProfile';
  'ceterms:name': string;
  'ceterms:creditValue': CtdlCreditValueProfile[];
}

export interface CtdlJsonLd {
  '@context': typeof CTDL_CONTEXT;
  '@type': CtdlType;
  'ceterms:name': string;
  'ceterms:ctid'?: string;
  'ceterms:offeredBy': {
    '@type': 'ceterms:Organization';
    'ceterms:name': string;
    'ceterms:ctid'?: string;
    'ceterms:subjectWebpage'?: string;
    /**
     * SCRUM-1922 R-CTDL-FR9 — equivalent identifier(s) for the issuing org.
     * Carries the org's did:web DID so a CTDL consumer can resolve the org's
     * W3C DID document (key + homepage). Additive + frozen-schema-safe (§1.8).
     */
    'ceterms:sameAs'?: string[];
  };
  'ceterms:verificationServiceProfile': {
    '@type': 'ceterms:VerificationServiceProfile';
    'ceterms:name': string;
    'ceterms:verificationService': string;
  };
  'ceterms:identifier': {
    'ceterms:identifierType': string;
    'ceterms:identifierValue': string;
  };
  'ceterms:requires'?: CtdlConditionProfile[];
  'ceterms:description'?: string;
}

export class CtdlPiiSafetyError extends Error {
  constructor(message = 'CTDL PII safety gate blocked public serialization') {
    super(message);
    this.name = 'CtdlPiiSafetyError';
  }
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

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const SSN_PATTERN = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/;
const PHONE_PATTERN = /(?:\+1\d{10}|\(\d{3}\)\s?\d{3}[-.]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\+(?:[2-9]\d)\d{7,11})/;
const REAL_CTID_PATTERN = /^ce-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSCRIPT_SIGNAL_PATTERN = /\b(?:transcript|student record|academic record|learner record)\b/i;
const NAME_TOKEN = String.raw`[A-Z][a-z]{1,}`;
const OPTIONAL_MIDDLE = String.raw`(?:\s+(?:[A-Z]\.?|${NAME_TOKEN}))?`;
const FULL_NAME = String.raw`${NAME_TOKEN}${OPTIONAL_MIDDLE}\s+${NAME_TOKEN}`;
const CONTEXTUAL_LEARNER_NAME_PATTERN = new RegExp(
  String.raw`\b(?:for|learner|student|recipient|issued to|awarded to|completed by|earned by|held by)\s+${FULL_NAME}\b`,
);
const NAME_FIRST_LEARNER_PATTERN = new RegExp(
  String.raw`\b${FULL_NAME}(?:'s)?\s+(?:transcript|student record|learner record|certificate|credential|degree|completion)\b`,
);
const MAX_CREDIT_HOURS = 1000;

function containsHighConfidencePii(value: string): boolean {
  return EMAIL_PATTERN.test(value) || SSN_PATTERN.test(value) || PHONE_PATTERN.test(value);
}

function normalizePublicText(value: string): string {
  return stripControlChars(value).replace(/\s+/g, ' ').trim();
}

function containsLearnerNamePii(value: string): boolean {
  const clean = normalizePublicText(value);
  return CONTEXTUAL_LEARNER_NAME_PATTERN.test(clean) || NAME_FIRST_LEARNER_PATTERN.test(clean);
}

function cleanPublicFreeText(value: unknown, maxLength = 240): string | null {
  const clean = cleanPublicString(value, maxLength);
  if (!clean || containsHighConfidencePii(clean) || containsLearnerNamePii(clean)) return null;
  return clean;
}

function pickMetadataString(metadata: Record<string, unknown>, keys: readonly string[], maxLength?: number): string | null {
  for (const key of keys) {
    const clean = cleanPublicFreeText(metadata[key], maxLength);
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
    cleanPublicFreeText(anchor.label) ??
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
    cleanPublicFreeText(anchor.description) ??
    `Arkova credential ${anchor.publicId}`
  );
}

function issuerName(anchor: CtdlAnchor, metadata: Record<string, unknown>): string {
  return (
    cleanPublicFreeText(anchor.issuer?.name) ??
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

function realCtid(value: unknown): string | null {
  const clean = cleanPublicString(value, 80);
  if (!clean || !REAL_CTID_PATTERN.test(clean)) return null;
  return clean;
}

function positiveNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 && value <= MAX_CREDIT_HOURS ? value : null;
  }

  const clean = cleanPublicString(value, 40);
  if (!clean || !/^\d+(?:\.\d+)?$/.test(clean)) return null;
  const parsed = Number(clean);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_CREDIT_HOURS ? parsed : null;
}

function hasCreditMetadata(metadata: Record<string, unknown>): boolean {
  return (
    metadata.credit_hours !== undefined ||
    metadata.creditHours !== undefined ||
    metadata.ethics_hours !== undefined ||
    metadata.ethicsHours !== undefined
  );
}

function nestedMetadata(metadata: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  for (const key of keys) {
    const nested = asRecord(metadata[key]);
    if (hasCreditMetadata(nested)) return nested;
  }
  return hasCreditMetadata(metadata) ? metadata : {};
}

function professionalEducationCreditMetadata(
  anchor: CtdlAnchor,
  metadata: Record<string, unknown>,
): { kind: 'CLE' | 'CPE'; metadata: Record<string, unknown> } | null {
  const credentialType = anchor.credentialType?.toUpperCase();
  if (credentialType === 'CLE') {
    return {
      kind: 'CLE',
      metadata: hasCreditMetadata(asRecord(anchor.cleMetadata))
        ? asRecord(anchor.cleMetadata)
        : nestedMetadata(metadata, ['cle_metadata', 'cleMetadata']),
    };
  }
  if (credentialType === 'CPE') {
    return {
      kind: 'CPE',
      metadata: hasCreditMetadata(asRecord(anchor.cpeMetadata))
        ? asRecord(anchor.cpeMetadata)
        : nestedMetadata(metadata, ['cpe_metadata', 'cpeMetadata']),
    };
  }
  return null;
}

function readCreditValue(metadata: Record<string, unknown>, snakeKey: string, camelKey: string, label: string): number | null {
  const value = metadata[snakeKey] ?? metadata[camelKey];
  if (value === undefined || value === null || value === '') return null;
  const parsed = positiveNumber(value);
  if (!parsed) throw new Error(`Invalid CTDL credit value: ${label}`);
  return parsed;
}

function creditDescription(kind: 'CLE' | 'CPE', suffix: string): string {
  return `${kind} ${suffix}`;
}

function creditValueProfile(value: number, description: string): CtdlCreditValueProfile {
  return {
    '@type': 'ceterms:ValueProfile',
    'schema:value': value,
    'ceterms:creditUnitType': 'creditUnit:ContactHour',
    'schema:description': description,
  };
}

function creditRequirements(anchor: CtdlAnchor, metadata: Record<string, unknown>): CtdlConditionProfile[] | null {
  const source = professionalEducationCreditMetadata(anchor, metadata);
  if (!source) return null;

  const creditHours = readCreditValue(source.metadata, 'credit_hours', 'creditHours', `${source.kind} credit hours`);
  const ethicsHours = readCreditValue(source.metadata, 'ethics_hours', 'ethicsHours', `${source.kind} ethics credit hours`);
  const creditValue: CtdlCreditValueProfile[] = [];

  if (creditHours) {
    creditValue.push(creditValueProfile(
      creditHours,
      creditDescription(source.kind, 'credit hours'),
    ));
  }
  if (ethicsHours) {
    creditValue.push(creditValueProfile(
      ethicsHours,
      creditDescription(source.kind, 'ethics credit hours'),
    ));
  }

  if (creditValue.length === 0) return null;
  return [{
    '@type': 'ceterms:ConditionProfile',
    'ceterms:name': 'Continuing education credit value',
    'ceterms:creditValue': creditValue,
  }];
}

function metadataTextValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(metadataTextValues);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(metadataTextValues);
}

function isTranscriptLikeEducation(anchor: CtdlAnchor, metadata: Record<string, unknown>): boolean {
  const credentialType = anchor.credentialType?.toUpperCase() ?? '';
  if (credentialType !== 'DEGREE' && credentialType !== 'CERTIFICATE') return false;

  const haystack = [
    anchor.subType,
    anchor.label,
    anchor.description,
    ...metadataTextValues(metadata),
  ].filter((value): value is string => typeof value === 'string').join(' ');
  return TRANSCRIPT_SIGNAL_PATTERN.test(haystack);
}

function assertCtdlPiiSafe(anchor: CtdlAnchor, metadata: Record<string, unknown>): void {
  if (!isTranscriptLikeEducation(anchor, metadata)) return;

  const freeTextValues = [
    anchor.label,
    anchor.description,
    ...metadataTextValues(metadata),
  ].filter((value): value is string => typeof value === 'string');

  if (freeTextValues.some((value) => containsLearnerNamePii(value))) {
    throw new CtdlPiiSafetyError();
  }
}

export function buildCtdlJsonLd(anchor: CtdlAnchor, options: BuildCtdlOptions): CtdlJsonLd {
  if (!toCtdlCredentialStatusType(anchor.status)) {
    throw new Error(`Cannot serialize CTDL for non-publishable status: ${anchor.status}`);
  }

  const metadata = asRecord(anchor.metadata);
  assertCtdlPiiSafe(anchor, metadata);
  const offeredBy: CtdlJsonLd['ceterms:offeredBy'] = {
    '@type': 'ceterms:Organization',
    'ceterms:name': issuerName(anchor, metadata),
  };

  const issuerCtid = realCtid(anchor.issuer?.ctid);
  if (issuerCtid) {
    offeredBy['ceterms:ctid'] = issuerCtid;
  }

  if (anchor.issuer?.publicId) {
    // SCRUM-1922 R-CTDL-FR9 — link the org's did:web identity. The public_id
    // is the same value the did:web resolver keys on, so this resolves to
    // https://app.arkova.ai/orgs/{public_id}/did.json.
    offeredBy['ceterms:sameAs'] = [`${ARKOVA_DID}:orgs:${anchor.issuer.publicId}`];
  }

  const subjectWebpage = isPublicHttpUrl(anchor.issuer?.websiteUrl);
  if (subjectWebpage) {
    offeredBy['ceterms:subjectWebpage'] = subjectWebpage;
  }

  const jsonLd: CtdlJsonLd = {
    '@context': CTDL_CONTEXT,
    '@type': resolveCtdlType(anchor.credentialType, anchor.subType),
    'ceterms:name': credentialName(anchor, metadata),
    'ceterms:offeredBy': offeredBy,
    'ceterms:verificationServiceProfile': {
      '@type': 'ceterms:VerificationServiceProfile',
      'ceterms:name': 'Arkova credential verification',
      'ceterms:verificationService': options.verifyUrl,
    },
    'ceterms:identifier': {
      'ceterms:identifierType': 'Arkova public ID',
      'ceterms:identifierValue': anchor.publicId,
    },
  };

  const credentialCtid = realCtid(anchor.ctid);
  if (credentialCtid) jsonLd['ceterms:ctid'] = credentialCtid;

  const requires = creditRequirements(anchor, metadata);
  if (requires) jsonLd['ceterms:requires'] = requires;

  const description = cleanPublicFreeText(anchor.description, 500);
  if (description) jsonLd['ceterms:description'] = description;

  assertValidCtdlJsonLd(jsonLd);
  return jsonLd;
}
