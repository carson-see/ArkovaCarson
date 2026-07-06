import { CTDL_CONTEXT } from './ctdl-type-map.js';

export interface CtdlValidationResult {
  valid: boolean;
  errors: string[];
}

const SAFE_CTLD_STATUS_TYPES = new Set([
  'ceterms:Active',
  'ceterms:Expired',
  'ceterms:Revoked',
  'ceterms:Superseded',
]);

// SCRUM-2374 (CE-03) — CTDL status types for which a forward-looking
// ceterms:expirationDate is a contradiction (the credential ended for an
// unrelated reason). Mirrors statusAllowsExpiration() in ctdl-type-map.ts at the
// CTDL-status layer the validator operates on.
const STATUS_TYPES_DISALLOWING_EXPIRATION = new Set([
  'ceterms:Revoked',
  'ceterms:Superseded',
]);

/**
 * SCRUM-2375 (CE-04) — plausibility ceiling for a single credential's contact
 * hours. Anything above this is a data error (or a unit confusion), and an
 * implausible public assertion is worse than an honest omission. SINGLE SHARED
 * SOURCE (round-1 review finding 4): the serializer's `normalizeContactHours`
 * imports this same constant, so the emission gate and this independent second
 * check cannot drift. Defined here (not in the serializer) because the
 * serializer already imports from this module — the reverse import would be a
 * cycle.
 */
export const MAX_CONTACT_HOURS = 1000;

const UNSAFE_PUBLIC_KEYS = new Set([
  'anchor_id',
  'anchorId',
  'fingerprint',
  'recipient_email',
  'recipientEmail',
  'filename',
  'file_name',
  'source_filename',
  'sourceFilename',
  'user_id',
  'userId',
  'org_id',
  'orgId',
  'metadata',
]);
const REAL_CTID_PATTERN = /^ce-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCetermsType(value: unknown): boolean {
  return isNonEmptyString(value) && /^ceterms:[A-Za-z][A-Za-z]*$/.test(value);
}

function isAbsoluteHttpUrl(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isRealCtid(value: unknown): boolean {
  return isNonEmptyString(value) && REAL_CTID_PATTERN.test(value);
}

// Real ISO-8601 check (not a lenient Date.parse). Date.parse() accepts locale
// strings like "12/31/2030" and even PII-prefixed values like
// "recipient@example.com 2030-01-01", which must NEVER be treated as valid dates
// on the public CTDL projection. This is the independent second check that a
// non-canonical value never reaches ceterms:expirationDate / dateEffective /
// revocationDate. Accepts calendar dates (YYYY-MM-DD) and full date-times with an
// optional time zone offset.
const ISO_8601_DATE_OR_DATETIME =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function isIsoDateLike(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  const trimmed = value.trim();
  if (!ISO_8601_DATE_OR_DATETIME.test(trimmed)) return false;
  // Also require the value to be a real calendar instant (rejects 2030-13-40 etc.).
  return !Number.isNaN(new Date(trimmed).getTime());
}

function addRequiredStringError(
  errors: string[],
  record: Record<string, unknown>,
  key: string,
  label = key,
): void {
  if (!isNonEmptyString(record[key])) {
    errors.push(`${label} is required`);
  }
}

function collectUnsafeKeys(value: unknown, errors: string[], path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectUnsafeKeys(item, errors, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (UNSAFE_PUBLIC_KEYS.has(key)) {
      errors.push(`unsafe public CTDL key: ${childPath}`);
    }
    collectUnsafeKeys(child, errors, childPath);
  }
}

function unsafeDepth(error: string): number {
  return error.replace(/^unsafe public CTDL key: /, '').split('.').length;
}

function validateOfferedBy(value: Record<string, unknown>, errors: string[]): void {
  const offeredBy = value['ceterms:offeredBy'];
  if (!isRecord(offeredBy)) {
    errors.push('ceterms:offeredBy must be an object');
    return;
  }
  if (offeredBy['@type'] !== 'ceterms:Organization') {
    errors.push('ceterms:offeredBy.@type must be ceterms:Organization');
  }
  addRequiredStringError(errors, offeredBy, 'ceterms:name', 'ceterms:offeredBy.ceterms:name');
  if (offeredBy['ceterms:ctid'] !== undefined && !isRealCtid(offeredBy['ceterms:ctid'])) {
    errors.push('ceterms:offeredBy.ceterms:ctid must be a real Credential Engine CTID when present');
  }
}

function validateVerificationProfile(value: Record<string, unknown>, errors: string[]): void {
  const verification = value['ceterms:verificationServiceProfile'];
  if (!isRecord(verification)) {
    errors.push('ceterms:verificationServiceProfile must be an object');
    return;
  }
  if (verification['@type'] !== 'ceterms:VerificationServiceProfile') {
    errors.push('ceterms:verificationServiceProfile.@type must be ceterms:VerificationServiceProfile');
  }
  addRequiredStringError(
    errors,
    verification,
    'ceterms:name',
    'ceterms:verificationServiceProfile.ceterms:name',
  );
  if (!isAbsoluteHttpUrl(verification['ceterms:verificationService'])) {
    errors.push('ceterms:verificationServiceProfile.ceterms:verificationService must be an absolute http(s) URL');
  }
}

function validateIdentifier(value: Record<string, unknown>, errors: string[]): void {
  const identifier = value['ceterms:identifier'];
  if (!isRecord(identifier)) {
    errors.push('ceterms:identifier must be an object');
    return;
  }
  addRequiredStringError(
    errors,
    identifier,
    'ceterms:identifierType',
    'ceterms:identifier.ceterms:identifierType',
  );
  addRequiredStringError(
    errors,
    identifier,
    'ceterms:identifierValue',
    'ceterms:identifier.ceterms:identifierValue',
  );
}

// SCRUM-2374 (CE-03) — expiration/revocation date shape + the cross-field invariant.
// A forward-looking expiration date contradicts a Revoked or Superseded status (the
// credential ended for an unrelated reason). The serializer suppresses
// ceterms:expirationDate at the source; this is the independent second check that
// catches any body — now or from a future code path — that re-introduces the conflation.
function validateExpirationAndStatus(value: Record<string, unknown>, errors: string[]): void {
  if (value['ceterms:expirationDate'] !== undefined && !isIsoDateLike(value['ceterms:expirationDate'])) {
    errors.push('ceterms:expirationDate must be a date string');
  }
  if (value['ceterms:revocationDate'] !== undefined && !isIsoDateLike(value['ceterms:revocationDate'])) {
    errors.push('ceterms:revocationDate must be a date string');
  }
  if (
    value['ceterms:expirationDate'] !== undefined &&
    typeof value['ceterms:credentialStatusType'] === 'string' &&
    STATUS_TYPES_DISALLOWING_EXPIRATION.has(value['ceterms:credentialStatusType'])
  ) {
    errors.push('ceterms:expirationDate must not be present for a Revoked or Superseded credential');
  }
}

// SCRUM-2375 (CE-04) — independent second check on the ContactHour ValueProfile.
// The serializer only emits `ceterms:creditValue` as a ValueProfile array with a
// positive finite `schema:value` and a `creditUnit:ContactHour` unit; this
// validator rejects any body — now or from a future code path — that carries a
// bare-scalar credit (the exact shape Jeanne Kitchens corrected), a fabricated
// zero/negative value, or a unit we do not emit. ContactHour is deliberately the
// ONLY accepted unit today; widen alongside the serializer when a new unit is
// introduced, never ahead of it.
function validateCreditUnitTypes(units: unknown, index: number, errors: string[]): void {
  if (!Array.isArray(units) || units.length === 0) {
    errors.push(
      `ceterms:creditValue[${index}].ceterms:creditUnitType must be a non-empty array of alignment objects`,
    );
    return;
  }
  units.forEach((unit, unitIndex) => {
    if (!isRecord(unit) || unit['@type'] !== 'ceterms:CredentialAlignmentObject') {
      errors.push(
        `ceterms:creditValue[${index}].ceterms:creditUnitType[${unitIndex}].@type must be ceterms:CredentialAlignmentObject`,
      );
      return;
    }
    if (unit['ceterms:targetNode'] !== 'creditUnit:ContactHour') {
      errors.push(
        `ceterms:creditValue[${index}].ceterms:creditUnitType[${unitIndex}].ceterms:targetNode must be creditUnit:ContactHour`,
      );
    }
  });
}

function validateCreditValue(value: Record<string, unknown>, errors: string[]): void {
  const creditValue = value['ceterms:creditValue'];
  if (creditValue === undefined) return;

  if (!Array.isArray(creditValue) || creditValue.length === 0) {
    errors.push('ceterms:creditValue must be an array of ceterms:ValueProfile objects');
    return;
  }
  // Round-1 review finding 4: the serializer's type is the single-element
  // tuple [CtdlContactHourValueProfile]; a multi-profile credit is a shape the
  // emission side can never produce and must fail the independent second check.
  if (creditValue.length !== 1) {
    errors.push('ceterms:creditValue must contain exactly one ceterms:ValueProfile');
  }

  creditValue.forEach((profile, index) => {
    if (!isRecord(profile)) {
      errors.push('ceterms:creditValue must be an array of ceterms:ValueProfile objects');
      return;
    }
    if (profile['@type'] !== 'ceterms:ValueProfile') {
      errors.push(`ceterms:creditValue[${index}].@type must be ceterms:ValueProfile`);
    }
    const schemaValue = profile['schema:value'];
    if (typeof schemaValue !== 'number' || !Number.isFinite(schemaValue) || schemaValue <= 0) {
      errors.push(`ceterms:creditValue[${index}].schema:value must be a positive finite number`);
    } else if (schemaValue > MAX_CONTACT_HOURS) {
      // Same plausibility ceiling normalizeContactHours enforces at emission
      // (round-1 review finding 4): the validator must reject what the
      // serializer can never emit.
      errors.push(
        `ceterms:creditValue[${index}].schema:value must be at most ${MAX_CONTACT_HOURS} contact hours`,
      );
    }
    validateCreditUnitTypes(profile['ceterms:creditUnitType'], index, errors);
  });
}

export function validateCtdlJsonLd(value: unknown): CtdlValidationResult {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return { valid: false, errors: ['CTDL JSON-LD body must be an object'] };
  }

  if (value['@context'] !== CTDL_CONTEXT) {
    errors.push('@context must be the CTDL JSON-LD context');
  }
  if (!isCetermsType(value['@type'])) {
    errors.push('@type must be a ceterms type');
  }
  addRequiredStringError(errors, value, 'ceterms:name');
  if (value['ceterms:ctid'] !== undefined && !isRealCtid(value['ceterms:ctid'])) {
    errors.push('ceterms:ctid must be a real Credential Engine CTID when present');
  }

  validateOfferedBy(value, errors);

  if (!isNonEmptyString(value['ceterms:credentialStatusType']) || !SAFE_CTLD_STATUS_TYPES.has(value['ceterms:credentialStatusType'])) {
    errors.push('ceterms:credentialStatusType must be a supported CTDL status');
  }
  if (!isIsoDateLike(value['ceterms:dateEffective'])) {
    errors.push('ceterms:dateEffective must be a date string');
  }

  validateVerificationProfile(value, errors);
  validateIdentifier(value, errors);
  validateExpirationAndStatus(value, errors);
  validateCreditValue(value, errors);

  const unsafeErrors: string[] = [];
  collectUnsafeKeys(value, unsafeErrors);
  unsafeErrors.sort((left, right) => unsafeDepth(left) - unsafeDepth(right) || left.localeCompare(right));
  errors.push(...unsafeErrors);

  return { valid: errors.length === 0, errors };
}

export function assertValidCtdlJsonLd(value: unknown): asserts value is Record<string, unknown> {
  const result = validateCtdlJsonLd(value);
  if (!result.valid) {
    throw new Error(`Invalid CTDL JSON-LD: ${result.errors.join('; ')}`);
  }
}
