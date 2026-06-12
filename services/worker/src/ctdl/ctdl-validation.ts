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

function isIsoDateLike(value: unknown): boolean {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
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

  const offeredBy = value['ceterms:offeredBy'];
  if (!isRecord(offeredBy)) {
    errors.push('ceterms:offeredBy must be an object');
  } else {
    if (offeredBy['@type'] !== 'ceterms:Organization') {
      errors.push('ceterms:offeredBy.@type must be ceterms:Organization');
    }
    addRequiredStringError(errors, offeredBy, 'ceterms:name', 'ceterms:offeredBy.ceterms:name');
    if (offeredBy['ceterms:ctid'] !== undefined && !isRealCtid(offeredBy['ceterms:ctid'])) {
      errors.push('ceterms:offeredBy.ceterms:ctid must be a real Credential Engine CTID when present');
    }
  }

  if (
    value['ceterms:credentialStatusType'] !== undefined &&
    (!isNonEmptyString(value['ceterms:credentialStatusType']) || !SAFE_CTLD_STATUS_TYPES.has(value['ceterms:credentialStatusType']))
  ) {
    errors.push('ceterms:credentialStatusType must be a supported CTDL status');
  }
  if (value['ceterms:dateEffective'] !== undefined && !isIsoDateLike(value['ceterms:dateEffective'])) {
    errors.push('ceterms:dateEffective must be a date string');
  }

  const verification = value['ceterms:verificationServiceProfile'];
  if (!isRecord(verification)) {
    errors.push('ceterms:verificationServiceProfile must be an object');
  } else {
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

  const identifier = value['ceterms:identifier'];
  if (identifier !== undefined && !isRecord(identifier)) {
    errors.push('ceterms:identifier must be an object');
  } else if (isRecord(identifier)) {
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

  if (value['ceterms:expirationDate'] !== undefined && !isIsoDateLike(value['ceterms:expirationDate'])) {
    errors.push('ceterms:expirationDate must be a date string');
  }
  if (value['ceterms:revocationDate'] !== undefined && !isIsoDateLike(value['ceterms:revocationDate'])) {
    errors.push('ceterms:revocationDate must be a date string');
  }

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
