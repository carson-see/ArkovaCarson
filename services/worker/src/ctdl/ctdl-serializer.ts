import {
  CTDL_CONTEXT,
  isContinuingEducationCreditType,
  resolveCtdlType,
  statusAllowsExpiration,
  toCtdlCredentialStatusType,
  type CtdlStatusType,
  type CtdlType,
} from './ctdl-type-map.js';
import { MAX_CONTACT_HOURS, assertValidCtdlJsonLd } from './ctdl-validation.js';
import { assertRealCtidOrAbsent, assertNoFabricatedCtidInJsonLd } from './ctdl-ctid-guard.js';
// SCRUM-2377 (CE-06a) — claims-review gate (R-7): no Registry-listing /
// legal-sufficiency overclaim can ship on the public projection.
import { assertNoProhibitedClaimInJsonLd, containsProhibitedClaim } from './ctdl-claims-guard.js';
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
  createdAt: string;
  chainTimestamp?: string | null;
  issuedAt?: string | null;
  /**
   * SCRUM-2374 (CE-03) — the ISSUED-PERSON credential's expiry: the date the
   * individual's credential lapses. Per Jeanne Kitchens (Credential Engine,
   * SCRUM-2294 comment 2026-06-10), this MUST NOT be emitted as CTDL
   * `ceterms:expirationDate`. CTDL `expirationDate` means "the date beyond which
   * the credential RESOURCE is no longer offered/available" — a class/offering
   * property, not a person's credential validity. Issued-person validity belongs
   * in the OB3 / W3C VC issued-credential layer (SCRUM-2296), not class-level CTDL.
   * The serializer therefore NEVER routes this field to `ceterms:expirationDate`.
   */
  expiresAt?: string | null;
  /**
   * SCRUM-2374 (CE-03) — RESOURCE-AVAILABILITY / offering expiry: the date beyond
   * which the credential resource (the program/offering itself) is no longer
   * offered or available. This is the ONLY expiry Jeanne's guidance allows to map
   * to CTDL `ceterms:expirationDate`. Distinct from `expiresAt` (issued-person).
   * Absent for the vast majority of Arkova anchors today (we anchor issued
   * artifacts, not offering catalogs), so `ceterms:expirationDate` is honestly
   * omitted unless a real offering-availability date is supplied.
   */
  resourceAvailableUntil?: string | null;
  /**
   * SCRUM-2375 (CE-04) — CE continuing-education credit value in CONTACT HOURS,
   * emitted as a `ceterms:ValueProfile` with `schema:value` +
   * `ceterms:creditUnitType` ContactHour (per Jeanne Kitchens' CTDL correction).
   * Derived only from allow-listed anchor metadata keys in `normalizeAnchorRow`
   * (`credentials-ctdl.ts`).
   *
   * CONFLATION GUARD: this is the credential's CE ContactHour credit — it has
   * NOTHING to do with the Arkova billing `credit_ledger` (paid anchoring
   * credits). The CTDL path must never import/query billing state, and the
   * billing ledger must never source this value. Enforced by
   * `ctdl-credit-conflation-guard.test.ts`.
   */
  contactHours?: number | null;
  revokedAt?: string | null;
  revocationReason?: string | null;
  issuer?: CtdlIssuer | null;
}

export interface BuildCtdlOptions {
  verifyUrl: string;
}

/**
 * SCRUM-2375 (CE-04) — the CE continuing-education credit value as CTDL wants
 * it: a `ceterms:ValueProfile` carrying `schema:value` and a
 * `ceterms:creditUnitType` alignment to `creditUnit:ContactHour` — NOT a bare
 * scalar. Property spelling follows Credential Engine's published Registry
 * examples for `ceterms:creditValue` (ValueProfile + CredentialAlignmentObject
 * against the credreg.net creditUnit concept scheme), per Jeanne Kitchens'
 * correction that CE credit is "ContactHour via ValueProfile". CE's full
 * Registry envelopes use language-map objects for frameworkName/targetNodeName
 * (`{"en-US": …}`); this module emits plain strings to match every other
 * `ceterms:name`-style field in our projection — a consumer-safe simplification
 * that CE's JSON-LD context accepts.
 */
export interface CtdlContactHourValueProfile {
  '@type': 'ceterms:ValueProfile';
  'schema:value': number;
  'ceterms:creditUnitType': [
    {
      '@type': 'ceterms:CredentialAlignmentObject';
      'ceterms:framework': typeof CREDIT_UNIT_FRAMEWORK;
      'ceterms:frameworkName': 'Credit Unit';
      'ceterms:targetNode': 'creditUnit:ContactHour';
      'ceterms:targetNodeName': 'Contact Hour';
    },
  ];
}

export const CREDIT_UNIT_FRAMEWORK = 'https://credreg.net/ctdl/terms/creditUnit' as const;

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
  /** SCRUM-2375 (CE-04) — ContactHour credit as a ValueProfile array (never a bare scalar). */
  'ceterms:creditValue'?: [CtdlContactHourValueProfile];
}

/**
 * Thrown by the serializer when a transcript-like education record carries
 * low-confidence learner-name signals in its free text. The CTDL route treats
 * this as a fail-closed signal: no public body is emitted (HTTP 404). PII never
 * leaves the worker via the public CTDL projection.
 */
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

// Value-level PII detectors. These run on free-text fields before they are
// emitted in a public CTDL body so that learner contact details never leak even
// when a metadata key is otherwise allow-listed.
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const SSN_PATTERN = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/;
const PHONE_PATTERN = /(?:\+1\d{10}|\(\d{3}\)\s?\d{3}[-.]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\+(?:[2-9]\d)\d{7,11})/;
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

export function containsHighConfidencePii(value: string): boolean {
  return EMAIL_PATTERN.test(value) || SSN_PATTERN.test(value) || PHONE_PATTERN.test(value);
}

function normalizePublicText(value: string): string {
  return stripControlChars(value).replace(/\s+/g, ' ').trim();
}

function containsLearnerNamePii(value: string): boolean {
  const clean = normalizePublicText(value);
  return CONTEXTUAL_LEARNER_NAME_PATTERN.test(clean) || NAME_FIRST_LEARNER_PATTERN.test(clean);
}

// Like cleanPublicString, but additionally drops the value when it carries
// high-confidence PII (email/phone/SSN), a learner-name signal, or — CE-06a
// (SCRUM-2377, R-7) — a prohibited external-status overclaim ("listed in the
// Registry", "legally sufficient", …). Issuer-authored free text asserting a
// Registry listing we do not hold is honestly omitted, same treatment as PII.
function cleanPublicFreeText(value: unknown, maxLength = 240): string | null {
  const clean = cleanPublicString(value, maxLength);
  if (!clean || containsHighConfidencePii(clean) || containsLearnerNamePii(clean)) return null;
  if (containsProhibitedClaim(clean)) return null;
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

function effectiveDate(anchor: CtdlAnchor): string {
  return anchor.issuedAt ?? anchor.chainTimestamp ?? anchor.createdAt;
}

// SCRUM-2375 (CE-04) — the plausibility ceiling (MAX_CONTACT_HOURS) is defined
// in ctdl-validation.ts and imported here, so the emission gate below and the
// validator's independent second check share ONE constant (round-1 review
// finding 4). Anything above it is a data error (or a unit confusion), and an
// implausible public assertion is worse than an honest omission.

/**
 * Single source of truth for "is this a contact-hour value we can honestly
 * assert publicly": a positive, finite number within the plausibility ceiling.
 * Zero/negative/NaN/Infinity/absent → null (the ValueProfile is OMITTED —
 * never a fabricated 0-hour profile). Shared with the metadata derivation in
 * `credentials-ctdl.ts` so the row layer and the serializer cannot drift.
 */
export function normalizeContactHours(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0 || value > MAX_CONTACT_HOURS) return null;
  return value;
}

/**
 * SCRUM-2375 (CE-04) — express the CE continuing-education credit as
 * `ceterms:ValueProfile` + `creditUnit:ContactHour`, per Jeanne Kitchens'
 * correction (never a bare scalar). See {@link CtdlContactHourValueProfile}
 * for the property-spelling rationale.
 */
function buildContactHourValueProfile(contactHours: number): CtdlContactHourValueProfile {
  return {
    '@type': 'ceterms:ValueProfile',
    'schema:value': contactHours,
    'ceterms:creditUnitType': [
      {
        '@type': 'ceterms:CredentialAlignmentObject',
        'ceterms:framework': CREDIT_UNIT_FRAMEWORK,
        'ceterms:frameworkName': 'Credit Unit',
        'ceterms:targetNode': 'creditUnit:ContactHour',
        'ceterms:targetNodeName': 'Contact Hour',
      },
    ],
  };
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

/**
 * Fail-closed gate for transcript-like education records. Per-field suppression
 * (cleanPublicFreeText) already strips obvious learner-name and contact PII, but
 * a transcript whose free text still trips the learner-name heuristic is treated
 * as too risky to publish at all — the serializer throws and the route 404s.
 */
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
  const statusType = toCtdlCredentialStatusType(anchor.status);
  if (!statusType) {
    throw new Error(`Cannot serialize CTDL for non-publishable status: ${anchor.status}`);
  }

  const metadata = asRecord(anchor.metadata);
  assertCtdlPiiSafe(anchor, metadata);
  const offeredBy: CtdlJsonLd['ceterms:offeredBy'] = {
    '@type': 'ceterms:Organization',
    'ceterms:name': issuerName(anchor, metadata),
  };

  // CE-02: a present issuer CTID must be a REAL CE CTID or the build fails
  // closed (FabricatedCtidError). An absent CTID is honestly omitted.
  const issuerCtid = assertRealCtidOrAbsent(anchor.issuer?.ctid, 'issuer');
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

  // CE-02: same fail-closed rule for the credential's own CTID.
  const credentialCtid = assertRealCtidOrAbsent(anchor.ctid, 'credential');
  if (credentialCtid) jsonLd['ceterms:ctid'] = credentialCtid;

  const description = cleanPublicFreeText(anchor.description, 500);
  if (description) jsonLd['ceterms:description'] = description;
  // SCRUM-2374 (CE-03): `ceterms:expirationDate` carries RESOURCE-AVAILABILITY
  // (offering) expiry ONLY — per Jeanne Kitchens (Credential Engine, SCRUM-2294):
  // it is "the date beyond which the credential resource is no longer
  // offered/available", NOT the expiration of a credential issued to a person.
  //
  // Therefore:
  //   - anchor.expiresAt (ISSUED-PERSON expiry) is NEVER emitted here. That
  //     person-level validity belongs to the OB3/W3C VC issued-credential layer
  //     (SCRUM-2296), not class-level CTDL. Emitting it would be the exact
  //     conflation Jeanne flagged.
  //   - anchor.resourceAvailableUntil (offering-availability expiry) IS emitted,
  //     and only for term-bound statuses. A REVOKED/SUPERSEDED resource ended for
  //     an unrelated reason, so a forward-looking availability date would
  //     contradict the status — suppress it there (statusAllowsExpiration()).
  if (anchor.resourceAvailableUntil && statusAllowsExpiration(anchor.status)) {
    jsonLd['ceterms:expirationDate'] = anchor.resourceAvailableUntil;
  }
  // SCRUM-2375 (CE-04): CE continuing-education credit as ContactHour via
  // ceterms:ValueProfile (Jeanne Kitchens' correction — never a bare scalar).
  // Emitted only for continuing-education types (CPE/CLE) with a plausible
  // positive value; absent/zero credit OMITS the property (never fabricated).
  // CONFLATION GUARD: anchor.contactHours is the CE credit value — completely
  // unrelated to the billing credit_ledger (paid anchoring credits).
  const contactHours = normalizeContactHours(anchor.contactHours);
  if (contactHours !== null && isContinuingEducationCreditType(anchor.credentialType)) {
    jsonLd['ceterms:creditValue'] = [buildContactHourValueProfile(contactHours)];
  }
  if (anchor.status === 'REVOKED') {
    if (anchor.revokedAt) jsonLd['ceterms:revocationDate'] = anchor.revokedAt;
    // BUG-2026-07-06-002 / SCRUM-2630 (pre-existing): the reason is issuer
    // free text and used to route through cleanPublicString (hygiene only), so
    // a PII-bearing reason shipped verbatim on the public 410 projection. It
    // now routes through cleanPublicFreeText — PII / learner-name / overclaim
    // reasons are honestly OMITTED (410 + revocationDate stay; the final
    // assertNoProhibitedClaimInJsonLd below remains the backstop).
    const reason = cleanPublicFreeText(anchor.revocationReason, 500);
    if (reason) jsonLd['ceterms:revocationReason'] = reason;
  }

  // CE-02 defense-in-depth: belt-and-suspenders scan of the assembled body so no
  // ceterms:ctid key (now or in a future code path) can carry a fabricated value.
  assertNoFabricatedCtidInJsonLd(jsonLd);
  // CE-06a (SCRUM-2377, R-7): final claims-review pass — any string that still
  // carries a Registry-listing / legal-sufficiency overclaim (e.g. a non-free-
  // text field like publicId, or a future code path that bypasses
  // cleanPublicFreeText) fails the whole build closed. Extends the CE-01/CE-02
  // chain; never a published body.
  assertNoProhibitedClaimInJsonLd(jsonLd);
  assertValidCtdlJsonLd(jsonLd);
  return jsonLd;
}
