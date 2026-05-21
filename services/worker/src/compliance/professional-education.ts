import { z } from 'zod';
import type { IAIProvider } from '../ai/types.js';
import { buildCleExtractionPrompt } from '../ai/prompts/cle-extraction-prompt.js';
import { buildCpeExtractionPrompt } from '../ai/prompts/cpe-extraction-prompt.js';

export const PROFESSIONAL_EDUCATION_EXTRACTION_JOB_TYPE = 'professional_education.metadata_extraction' as const;

export const NASBA_FIELDS_OF_STUDY = [
  'Accounting',
  'Auditing',
  'Advisory Services',
  'Behavioral Ethics',
  'Business Law',
  'Communications',
  'Computer Software & Applications',
  'Economics',
  'Finance',
  'Information Technology',
  'Management',
  'Marketing',
  'Personal Development',
  'Personnel/Human Resources',
  'Production',
  'Regulatory Ethics',
  'Specialized Knowledge',
  'Statistics',
  'Taxes',
] as const;

export const CPE_DELIVERY_METHODS = [
  'Group Live',
  'Group Internet Based',
  'QAS Self-Study',
  'Nano Learning',
  'Blended Learning',
  'University/College',
  'Other',
] as const;

export const CLE_DELIVERY_FORMATS = [
  'Live',
  'On-Demand',
  'In-Person',
  'Blended',
  'Other',
] as const;

export const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC',
] as const;

export const EXTRACTION_SOURCES = ['ai', 'adapter', 'manual'] as const;

export const CpeMetadataSchema = z.object({
  credit_hours: z.number().nonnegative().nullable().optional(),
  field_of_study: z.enum(NASBA_FIELDS_OF_STUDY).nullable().optional(),
  delivery_method: z.enum(CPE_DELIVERY_METHODS).nullable().optional(),
  sponsor_id: z.string().trim().min(1).max(64).nullable().optional(),
  reporting_period_start: z.string().date().nullable().optional(),
  reporting_period_end: z.string().date().nullable().optional(),
  extraction_confidence: z.number().min(0).max(1).nullable().optional(),
  extraction_source: z.enum(EXTRACTION_SOURCES).nullable().optional(),
  nasba_status: z.enum(['confirmed', 'not_found', 'unknown']).nullable().optional(),
  nasba_lookup_date: z.string().date().nullable().optional(),
  requires_manual_review: z.boolean(),
}).strict();

export const CleMetadataSchema = z.object({
  credit_hours: z.number().nonnegative().nullable().optional(),
  ethics_hours: z.number().nonnegative().nullable().optional(),
  jurisdiction: z.enum(US_STATE_CODES).nullable().optional(),
  approved_provider_name: z.string().trim().min(1).max(200).nullable().optional(),
  provider_approval_status: z.enum(['approved', 'not_approved', 'unknown']).nullable().optional(),
  provider_lookup_date: z.string().date().nullable().optional(),
  delivery_format: z.enum(CLE_DELIVERY_FORMATS).nullable().optional(),
  course_title: z.string().trim().min(1).max(300).nullable().optional(),
  course_id: z.string().trim().min(1).max(128).nullable().optional(),
  reporting_period_start: z.string().date().nullable().optional(),
  reporting_period_end: z.string().date().nullable().optional(),
  extraction_confidence: z.number().min(0).max(1).nullable().optional(),
  extraction_source: z.enum(EXTRACTION_SOURCES).nullable().optional(),
  requires_manual_review: z.boolean(),
}).strict();

export type NasbaFieldOfStudy = (typeof NASBA_FIELDS_OF_STUDY)[number];
export type CpeDeliveryMethod = (typeof CPE_DELIVERY_METHODS)[number];
export type CleDeliveryFormat = (typeof CLE_DELIVERY_FORMATS)[number];
export type CpeMetadata = z.infer<typeof CpeMetadataSchema>;
export type CleMetadata = z.infer<typeof CleMetadataSchema>;

export const ProfessionalEducationKindSchema = z.enum(['CPE', 'CLE']);
export type ProfessionalEducationKind = z.infer<typeof ProfessionalEducationKindSchema>;

export const ProfessionalEducationExtractionJobPayloadSchema = z.object({
  anchorId: z.string().uuid(),
  educationKind: ProfessionalEducationKindSchema,
  evidence: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type ProfessionalEducationExtractionJobPayload = z.infer<typeof ProfessionalEducationExtractionJobPayloadSchema>;

export interface ProfessionalEducationAnchorRow {
  id: string;
  public_id: string | null;
  credential_type: string | null;
  fingerprint: string | null;
  org_id: string | null;
  user_id: string | null;
  metadata: Record<string, unknown> | null;
  cpe_metadata?: Record<string, unknown> | null;
  cle_metadata?: Record<string, unknown> | null;
}

export interface ProfessionalEducationDb {
  from(table: string): {
    select?: (columns: string) => unknown;
    update?: (payload: Record<string, unknown>) => unknown;
    insert?: (payload: Record<string, unknown>) => unknown;
  };
}

export interface ProfessionalEducationExtractionResult {
  anchorId: string;
  educationKind: ProfessionalEducationKind;
  metadata: CpeMetadata | CleMetadata;
  requiresManualReview: boolean;
  auditEventType: 'cpe_metadata.extracted' | 'cle_metadata.extracted';
  parseError?: string;
}

const REVIEW_CONFIDENCE_THRESHOLD = 0.85;

export function normalizeCpeMetadata(input: unknown): CpeMetadata {
  const parsed = CpeMetadataSchema.parse(input);
  return {
    ...parsed,
    requires_manual_review:
      parsed.requires_manual_review ||
      parsed.extraction_confidence === null ||
      parsed.extraction_confidence === undefined ||
      parsed.extraction_confidence < REVIEW_CONFIDENCE_THRESHOLD,
  };
}

export function normalizeCleMetadata(input: unknown): CleMetadata {
  const parsed = CleMetadataSchema.parse(input);
  return {
    ...parsed,
    requires_manual_review:
      parsed.requires_manual_review ||
      parsed.ethics_hours === null ||
      parsed.ethics_hours === undefined ||
      parsed.extraction_confidence === null ||
      parsed.extraction_confidence === undefined ||
      parsed.extraction_confidence < REVIEW_CONFIDENCE_THRESHOLD,
  };
}

const CPE_SIGNAL_PATTERN = /\b(?:cpe|nasba|continuing professional education|cpaacademy|udemy)\b/i;
const CLE_SIGNAL_PATTERN = /\b(?:cle|continuing legal education|bar association|state bar|westlaw|practising law institute|pli)\b/i;

export function classifyProfessionalEducationAnchor(params: {
  credentialType?: string | null;
  metadata?: Record<string, unknown> | null;
}): ProfessionalEducationKind | null {
  const credentialType = params.credentialType?.toUpperCase();
  if (credentialType === 'CLE') return 'CLE';
  if (credentialType === 'CPE') return 'CPE';

  const metadata = params.metadata ?? {};
  const metadataType = stringOrNull(metadata.credential_type)?.toUpperCase();
  if (metadataType === 'CLE') return 'CLE';
  if (metadataType === 'CPE') return 'CPE';

  const searchable = [
    metadata.credential_title,
    metadata.credential_issuer,
    metadata.source_provider,
    metadata.source_url,
  ].filter((value): value is string => typeof value === 'string').join(' ');

  if (CLE_SIGNAL_PATTERN.test(searchable)) return 'CLE';
  if (CPE_SIGNAL_PATTERN.test(searchable)) return 'CPE';
  return null;
}

export function buildProfessionalEducationJobPayload(anchor: ProfessionalEducationAnchorRow): ProfessionalEducationExtractionJobPayload | null {
  const educationKind = classifyProfessionalEducationAnchor({
    credentialType: anchor.credential_type,
    metadata: anchor.metadata,
  });
  if (!educationKind) return null;

  return ProfessionalEducationExtractionJobPayloadSchema.parse({
    anchorId: anchor.id,
    educationKind,
    evidence: anchor.metadata ?? undefined,
  });
}

export async function extractAndPersistProfessionalEducationMetadata(params: {
  db: ProfessionalEducationDb;
  provider: Pick<IAIProvider, 'extractMetadata' | 'name'>;
  anchor: ProfessionalEducationAnchorRow;
  educationKind: ProfessionalEducationKind;
  evidence?: Record<string, unknown>;
}): Promise<ProfessionalEducationExtractionResult> {
  const evidence = params.evidence ?? params.anchor.metadata ?? {};
  const extraction = await runProfessionalEducationExtraction({
    db: params.db,
    provider: params.provider,
    anchor: params.anchor,
    educationKind: params.educationKind,
    evidence,
  });

  const updateColumn = params.educationKind === 'CPE' ? 'cpe_metadata' : 'cle_metadata';
  const updateResult = await callQuery(
    params.db
      .from('anchors')
      .update?.({ [updateColumn]: extraction.metadata }),
    'eq',
    ['id', params.anchor.id],
  );
  assertNoDbError(updateResult, `failed to update ${updateColumn}`);

  await insertProfessionalEducationAuditEvent({
    db: params.db,
    anchor: params.anchor,
    educationKind: params.educationKind,
    metadata: extraction.metadata,
    parseError: extraction.parseError,
  });

  return extraction;
}

async function runProfessionalEducationExtraction(params: {
  db: ProfessionalEducationDb;
  provider: Pick<IAIProvider, 'extractMetadata' | 'name'>;
  anchor: ProfessionalEducationAnchorRow;
  educationKind: ProfessionalEducationKind;
  evidence: Record<string, unknown>;
}): Promise<ProfessionalEducationExtractionResult> {
  const prompt = params.educationKind === 'CPE'
    ? buildCpeExtractionPrompt(params.evidence)
    : buildCleExtractionPrompt(params.evidence);

  try {
    const result = await params.provider.extractMetadata({
      strippedText: prompt,
      credentialType: params.educationKind,
      fingerprint: params.anchor.fingerprint ?? '',
      issuerHint: stringOrNull(params.evidence.credential_issuer) ?? undefined,
    });
    return params.educationKind === 'CPE'
      ? await buildCpeExtractionResult(params.db, params.anchor, params.evidence, result.fields)
      : await buildCleExtractionResult(params.db, params.anchor, params.evidence, result.fields);
  } catch (error) {
    const parseError = error instanceof Error ? error.message : 'unknown extraction error';
    const metadata = params.educationKind === 'CPE'
      ? buildManualReviewCpeMetadata()
      : buildManualReviewCleMetadata();
    return {
      anchorId: params.anchor.id,
      educationKind: params.educationKind,
      metadata,
      requiresManualReview: true,
      auditEventType: params.educationKind === 'CPE' ? 'cpe_metadata.extracted' : 'cle_metadata.extracted',
      parseError,
    };
  }
}

async function buildCpeExtractionResult(
  db: ProfessionalEducationDb,
  anchor: ProfessionalEducationAnchorRow,
  evidence: Record<string, unknown>,
  fields: Record<string, unknown>,
): Promise<ProfessionalEducationExtractionResult> {
  const provider = await lookupCpeProvider(db, evidence, fields);
  const raw = {
    credit_hours: numberOrNull(fields.credit_hours ?? fields.creditHours),
    field_of_study: stringOrNull(fields.field_of_study ?? fields.fieldOfStudy),
    delivery_method: stringOrNull(fields.delivery_method ?? fields.deliveryMethod),
    sponsor_id: stringOrNull(fields.sponsor_id ?? fields.sponsorId ?? fields.nasbaSponsorId) ?? provider?.nasba_sponsor_id ?? null,
    reporting_period_start: dateOnlyOrNull(fields.reporting_period_start ?? fields.reportingPeriodStart),
    reporting_period_end: dateOnlyOrNull(fields.reporting_period_end ?? fields.reportingPeriodEnd),
    extraction_confidence: numberOrNull(fields.extraction_confidence ?? fields.confidence ?? evidence.extraction_confidence),
    extraction_source: 'ai',
    nasba_status: stringOrNull(fields.nasba_status ?? fields.nasbaStatus) ?? provider?.nasba_status ?? 'unknown',
    nasba_lookup_date: dateOnlyOrNull(fields.nasba_lookup_date ?? fields.nasbaLookupDate) ?? provider?.last_verified_date ?? null,
    requires_manual_review: Boolean(fields.requires_manual_review ?? fields.requiresManualReview),
  };
  const normalized = normalizeCpeMetadata(raw);
  const metadata: CpeMetadata = {
    ...normalized,
    requires_manual_review:
      normalized.requires_manual_review ||
      normalized.credit_hours === null ||
      normalized.credit_hours === undefined ||
      normalized.field_of_study === null ||
      normalized.field_of_study === undefined ||
      normalized.nasba_status !== 'confirmed',
  };

  return {
    anchorId: anchor.id,
    educationKind: 'CPE',
    metadata,
    requiresManualReview: metadata.requires_manual_review,
    auditEventType: 'cpe_metadata.extracted',
  };
}

async function buildCleExtractionResult(
  db: ProfessionalEducationDb,
  anchor: ProfessionalEducationAnchorRow,
  evidence: Record<string, unknown>,
  fields: Record<string, unknown>,
): Promise<ProfessionalEducationExtractionResult> {
  const provider = await lookupCleProvider(db, evidence, fields);
  const jurisdiction = stringOrNull(fields.jurisdiction);
  const approvedForJurisdiction = Boolean(
    provider &&
    (provider.approved_jurisdictions.includes('MULTI_STATE') ||
      (jurisdiction ? provider.approved_jurisdictions.includes(jurisdiction) : false)),
  );
  const raw = {
    credit_hours: numberOrNull(fields.credit_hours ?? fields.creditHours),
    ethics_hours: numberOrNull(fields.ethics_hours ?? fields.ethicsHours),
    jurisdiction,
    approved_provider_name:
      stringOrNull(fields.approved_provider_name ?? fields.providerName ?? fields.approvedBy) ??
      provider?.provider_name ??
      null,
    provider_approval_status:
      stringOrNull(fields.provider_approval_status ?? fields.providerApprovalStatus) ??
      (provider ? (approvedForJurisdiction ? provider.approval_status : 'unknown') : 'unknown'),
    provider_lookup_date: dateOnlyOrNull(fields.provider_lookup_date ?? fields.providerLookupDate) ?? provider?.last_verified_date ?? null,
    delivery_format: stringOrNull(fields.delivery_format ?? fields.deliveryFormat),
    course_title: stringOrNull(fields.course_title ?? fields.courseTitle ?? evidence.credential_title),
    course_id: stringOrNull(fields.course_id ?? fields.courseId ?? fields.activityNumber),
    reporting_period_start: dateOnlyOrNull(fields.reporting_period_start ?? fields.reportingPeriodStart),
    reporting_period_end: dateOnlyOrNull(fields.reporting_period_end ?? fields.reportingPeriodEnd),
    extraction_confidence: numberOrNull(fields.extraction_confidence ?? fields.confidence ?? evidence.extraction_confidence),
    extraction_source: 'ai',
    requires_manual_review: Boolean(fields.requires_manual_review ?? fields.requiresManualReview),
  };
  const normalized = normalizeCleMetadata(raw);
  const metadata: CleMetadata = {
    ...normalized,
    requires_manual_review:
      normalized.requires_manual_review ||
      normalized.credit_hours === null ||
      normalized.credit_hours === undefined ||
      normalized.ethics_hours === null ||
      normalized.ethics_hours === undefined ||
      normalized.provider_approval_status !== 'approved',
  };

  return {
    anchorId: anchor.id,
    educationKind: 'CLE',
    metadata,
    requiresManualReview: metadata.requires_manual_review,
    auditEventType: 'cle_metadata.extracted',
  };
}

async function lookupCpeProvider(
  db: ProfessionalEducationDb,
  evidence: Record<string, unknown>,
  fields: Record<string, unknown>,
): Promise<{
  provider_name: string;
  nasba_sponsor_id: string | null;
  nasba_status: 'confirmed' | 'not_found' | 'unknown';
  last_verified_date: string | null;
} | null> {
  const domain = sourceDomain(evidence);
  const byDomain = domain
    ? await maybeSelectProvider(db, 'cpe_provider_registry', 'provider_domain', domain)
    : null;
  if (byDomain) return CpeProviderRowSchema.parse(byDomain);

  const name = stringOrNull(fields.providerName ?? fields.issuerName ?? evidence.credential_issuer ?? evidence.source_provider);
  if (!name) return null;
  const byName = await maybeSelectProvider(db, 'cpe_provider_registry', 'provider_name', name);
  return byName ? CpeProviderRowSchema.parse(byName) : null;
}

async function lookupCleProvider(
  db: ProfessionalEducationDb,
  evidence: Record<string, unknown>,
  fields: Record<string, unknown>,
): Promise<{
  provider_name: string;
  approval_status: 'approved' | 'not_approved' | 'unknown';
  approved_jurisdictions: string[];
  last_verified_date: string | null;
} | null> {
  const domain = sourceDomain(evidence);
  const byDomain = domain
    ? await maybeSelectProvider(db, 'cle_provider_registry', 'provider_domain', domain)
    : null;
  if (byDomain) return CleProviderRowSchema.parse(byDomain);

  const name = stringOrNull(
    fields.approved_provider_name ??
    fields.providerName ??
    fields.approvedBy ??
    evidence.credential_issuer ??
    evidence.source_provider,
  );
  if (!name) return null;
  const byName = await maybeSelectProvider(db, 'cle_provider_registry', 'provider_name', name);
  return byName ? CleProviderRowSchema.parse(byName) : null;
}

const CpeProviderRowSchema = z.object({
  provider_name: z.string(),
  nasba_sponsor_id: z.string().nullable(),
  nasba_status: z.enum(['confirmed', 'not_found', 'unknown']),
  last_verified_date: z.string().nullable(),
});

const CleProviderRowSchema = z.object({
  provider_name: z.string(),
  approval_status: z.enum(['approved', 'not_approved', 'unknown']),
  approved_jurisdictions: z.array(z.string()),
  last_verified_date: z.string().nullable(),
});

async function maybeSelectProvider(
  db: ProfessionalEducationDb,
  table: 'cpe_provider_registry' | 'cle_provider_registry',
  column: 'provider_domain' | 'provider_name',
  value: string,
): Promise<unknown | null> {
  const selected = db.from(table).select?.(
    table === 'cpe_provider_registry'
      ? 'provider_name, nasba_sponsor_id, nasba_status, last_verified_date'
      : 'provider_name, approval_status, approved_jurisdictions, last_verified_date',
  );
  const result = await callQuery(selected, 'eq', [column, column === 'provider_domain' ? value.toLowerCase() : value]);
  if (hasDbError(result)) return null;
  return result?.data ?? null;
}

async function insertProfessionalEducationAuditEvent(params: {
  db: ProfessionalEducationDb;
  anchor: ProfessionalEducationAnchorRow;
  educationKind: ProfessionalEducationKind;
  metadata: CpeMetadata | CleMetadata;
  parseError?: string;
}): Promise<void> {
  const eventType = params.educationKind === 'CPE' ? 'cpe_metadata.extracted' : 'cle_metadata.extracted';
  const details = stripProfessionalEducationPii({
    public_id: params.anchor.public_id,
    education_kind: params.educationKind,
    requires_manual_review: params.metadata.requires_manual_review,
    extraction_source: params.metadata.extraction_source,
    parse_error: params.parseError ?? null,
  });

  const result = await params.db.from('audit_events').insert?.({
    event_type: eventType,
    event_category: 'AI',
    actor_id: params.anchor.user_id,
    org_id: params.anchor.org_id,
    target_type: 'anchor',
    target_id: params.anchor.id,
    details: JSON.stringify(details),
  });
  if (hasDbError(result)) {
    throw new Error(`failed to write ${eventType} audit event: ${result.error.message}`);
  }
}

function buildManualReviewCpeMetadata(): CpeMetadata {
  return {
    extraction_confidence: null,
    extraction_source: 'adapter',
    nasba_status: 'unknown',
    nasba_lookup_date: null,
    requires_manual_review: true,
  };
}

function buildManualReviewCleMetadata(): CleMetadata {
  return {
    ethics_hours: null,
    extraction_confidence: null,
    extraction_source: 'adapter',
    provider_approval_status: 'unknown',
    provider_lookup_date: null,
    requires_manual_review: true,
  };
}

function sourceDomain(evidence: Record<string, unknown>): string | null {
  const rawUrl = stringOrNull(evidence.source_url);
  if (rawUrl) {
    try {
      return new URL(rawUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function dateOnlyOrNull(value: unknown): string | null {
  const maybeDate = stringOrNull(value);
  if (!maybeDate) return null;
  const dateOnly = maybeDate.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) ? dateOnly : null;
}

async function callQuery<T = { data?: unknown; error?: { message: string } }>(
  chain: unknown,
  method: string,
  args: unknown[],
): Promise<T> {
  if (!chain || typeof chain !== 'object' || !(method in chain)) {
    return chain as T;
  }
  const next = (chain as Record<string, (...methodArgs: unknown[]) => unknown>)[method](...args);
  if (next && typeof next === 'object' && 'maybeSingle' in next) {
    return await (next as { maybeSingle: () => Promise<T> }).maybeSingle();
  }
  if (next && typeof next === 'object' && 'then' in next) {
    return await (next as Promise<T>);
  }
  return next as T;
}

function hasDbError(result: unknown): result is { error: { message: string } } {
  return Boolean(
    result &&
    typeof result === 'object' &&
    'error' in result &&
    (result as { error?: unknown }).error,
  );
}

function assertNoDbError(result: unknown, message: string): void {
  if (hasDbError(result)) {
    throw new Error(`${message}: ${result.error.message}`);
  }
}

const SENSITIVE_KEY_PATTERN = /(?:recipient|attorney|email|address|bar.?number|barNumber|subjectName)/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const STREET_TERMS = new Set([
  'street',
  'st',
  'avenue',
  'ave',
  'road',
  'rd',
  'boulevard',
  'blvd',
  'lane',
  'ln',
  'drive',
  'dr',
  'court',
  'ct',
  'way',
  'circle',
  'cir',
]);
const BAR_NUMBER_PREFIXES = ['bar', 'bbo', 'wsba', 'attorney', 'registration', 'p'];

type Jsonish = null | boolean | number | string | Jsonish[] | { [key: string]: Jsonish | undefined };

function stripSensitiveString(value: string): string {
  return redactBarNumbers(redactStreetAddresses(value.replace(EMAIL_PATTERN, '[EMAIL_REDACTED]')));
}

function redactStreetAddresses(value: string): string {
  return value.split('\n').map(redactStreetAddressLine).join('\n');
}

function redactStreetAddressLine(line: string): string {
  const firstDigit = firstDigitIndex(line);
  if (firstDigit < 0 || !containsStreetTerm(line)) return line;

  const zipEnd = findZipEnd(line, firstDigit);
  const end = zipEnd ?? line.length;
  return `${line.slice(0, firstDigit)}[ADDRESS_REDACTED]${line.slice(end)}`;
}

function firstDigitIndex(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    if (isDigit(value[i])) return i;
  }
  return -1;
}

function containsStreetTerm(value: string): boolean {
  for (const token of tokenizeAlphaNumeric(value.toLowerCase())) {
    if (STREET_TERMS.has(token)) return true;
  }
  return false;
}

function tokenizeAlphaNumeric(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  for (const char of value) {
    if (isAlphaNumeric(char)) {
      current += char;
    } else if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function findZipEnd(value: string, start: number): number | null {
  for (let i = start; i <= value.length - 5; i += 1) {
    if (!isFiveDigitRun(value, i)) continue;
    let end = i + 5;
    if (value[end] === '-' && isFourDigitRun(value, end + 1)) {
      end += 5;
    }
    return end;
  }
  return null;
}

function redactBarNumbers(value: string): string {
  let output = value;
  for (const prefix of BAR_NUMBER_PREFIXES) {
    output = redactBarNumbersForPrefix(output, prefix);
  }
  return output;
}

function redactBarNumbersForPrefix(value: string, prefix: string): string {
  let output = value;
  let searchFrom = 0;
  while (searchFrom < output.length) {
    const matchStart = output.toLowerCase().indexOf(prefix, searchFrom);
    if (matchStart < 0) break;
    if (!isWordBoundary(output[matchStart - 1]) || !isWordBoundary(output[matchStart + prefix.length])) {
      searchFrom = matchStart + prefix.length;
      continue;
    }

    const matchEnd = findBarNumberEnd(output, matchStart + prefix.length);
    if (matchEnd === null) {
      searchFrom = matchStart + prefix.length;
      continue;
    }

    output = `${output.slice(0, matchStart)}[BAR_NUMBER_REDACTED]${output.slice(matchEnd)}`;
    searchFrom = matchStart + '[BAR_NUMBER_REDACTED]'.length;
  }
  return output;
}

function findBarNumberEnd(value: string, start: number): number | null {
  const scanEnd = Math.min(value.length, start + 32);
  let consecutiveDigits = 0;
  for (let i = start; i < scanEnd; i += 1) {
    consecutiveDigits = isDigit(value[i]) ? consecutiveDigits + 1 : 0;
    if (consecutiveDigits >= 4) {
      let end = i + 1;
      while (end < scanEnd && (isDigit(value[end]) || value[end] === '-')) end += 1;
      return end;
    }
  }
  return null;
}

function isFiveDigitRun(value: string, start: number): boolean {
  return isFixedDigitRun(value, start, 5);
}

function isFourDigitRun(value: string, start: number): boolean {
  return isFixedDigitRun(value, start, 4);
}

function isFixedDigitRun(value: string, start: number, length: number): boolean {
  if (start < 0 || start + length > value.length) return false;
  for (let i = start; i < start + length; i += 1) {
    if (!isDigit(value[i])) return false;
  }
  return true;
}

function isAlphaNumeric(char: string | undefined): boolean {
  return Boolean(char && ((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')));
}

function isDigit(char: string | undefined): boolean {
  return Boolean(char && char >= '0' && char <= '9');
}

function isWordBoundary(char: string | undefined): boolean {
  return !char || !isAlphaNumeric(char.toLowerCase());
}

export function stripProfessionalEducationPii(value: unknown): Jsonish {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return stripSensitiveString(value);
  if (Array.isArray(value)) return value.map(stripProfessionalEducationPii);
  if (typeof value !== 'object') return null;

  const output: Record<string, Jsonish> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    output[key] = stripProfessionalEducationPii(child);
  }
  return output;
}
