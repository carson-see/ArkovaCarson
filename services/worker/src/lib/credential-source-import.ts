import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import {
  ANCHOR_CREDENTIAL_TYPES,
  CREDENTIAL_EVIDENCE_SCHEMA_VERSION,
  buildCredentialEvidencePackage,
  normalizeCredentialSourceUrl,
  toPublicSafeCredentialEvidenceMetadata,
  type AnchorCredentialType,
  type CredentialEvidenceExtractionMethod,
  type CredentialEvidencePackage,
} from './credential-evidence.js';

export const CREDENTIAL_SOURCE_IMPORT_FETCH_TIMEOUT_MS = 5_000;
export const CREDENTIAL_SOURCE_IMPORT_MAX_BYTES = 512 * 1024;
export const CREDENTIAL_SOURCE_IMPORT_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const JSON_CONTENT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/activity+json',
  'application/vnd.ims.obi.v3p0.achievement+json',
]);
const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const TEXT_CONTENT_TYPES = new Set(['text/plain']);
const DATE_ONLY_RE = /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/;
const SOURCE_ID_RE = /^[A-Za-z0-9._:/#@+-]{1,256}$/;
const SHA_256_HEX_RE = /^[a-fA-F0-9]{64}$/;
const FILENAME_UNSAFE_CHARACTERS = String.raw`/\?%*:|"<>`;

export const CredentialSourceImportRequestSchema = z
  .object({
    source_url: z.string().trim().min(1, 'Source URL is required').max(2048, 'Source URL is too long'),
    credential_type: z.enum(ANCHOR_CREDENTIAL_TYPES).optional(),
    issuer_hint: z.string().trim().max(200, 'Issuer hint is too long').optional(),
    expected_source_payload_hash: z.string().regex(SHA_256_HEX_RE, 'Expected source payload hash must be SHA-256 hex').optional(),
  })
  .strict();

export type CredentialSourceImportRequest = z.infer<typeof CredentialSourceImportRequestSchema>;

export type CredentialSourceImportErrorCode =
  | 'invalid_source_url'
  | 'private_source_url'
  | 'source_redirect_invalid'
  | 'source_redirect_limit'
  | 'source_fetch_failed'
  | 'source_fetch_timeout'
  | 'source_content_type_unsupported'
  | 'source_too_large'
  | 'source_empty';

export class CredentialSourceImportError extends Error {
  constructor(
    readonly code: CredentialSourceImportErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'CredentialSourceImportError';
  }
}

export interface CredentialSourceImportPreview {
  normalized_source_url: string;
  source_provider: string;
  source_id: string | null;
  source_fetched_at: string;
  source_payload_hash: string;
  source_payload_content_type: string;
  source_payload_byte_length: number;
  credential_type: AnchorCredentialType;
  credential_title: string;
  credential_issuer: string | null;
  credential_issued_at: string | null;
  credential_expires_at: string | null;
  verification_level: 'captured_url';
  extraction_method: CredentialEvidenceExtractionMethod;
  extraction_confidence: number;
  evidence_package_hash: string;
  anchor_fingerprint: string;
  public_metadata: Record<string, string | number | boolean | null>;
}

export interface CredentialSourceImportBuildResult {
  preview: CredentialSourceImportPreview;
  evidencePackage: CredentialEvidencePackage;
}

export interface CredentialSourceImportDeps {
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  urlGuard: (url: string) => Promise<boolean>;
  now?: () => Date;
}

interface FetchedCredentialSource {
  url: string;
  contentType: string;
  bytes: Buffer;
  text: string;
}

interface ExtractedCredentialMetadata {
  title: string;
  issuerName?: string;
  issuedAt?: string;
  expiresAt?: string;
  credentialType: AnchorCredentialType;
  sourceId?: string;
  confidence: number;
  extractionMethod: CredentialEvidenceExtractionMethod;
}

function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function collapseWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

function normalizeContentType(value: string | null): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function ensureSupportedContentType(contentType: string): void {
  if (
    JSON_CONTENT_TYPES.has(contentType) ||
    HTML_CONTENT_TYPES.has(contentType) ||
    TEXT_CONTENT_TYPES.has(contentType)
  ) {
    return;
  }

  throw new CredentialSourceImportError(
    'source_content_type_unsupported',
    'Credential source must be HTML, JSON, JSON-LD, or plain text',
    415,
  );
}

function isRedirect(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

async function assertPublicFetchTarget(url: string, urlGuard: (url: string) => Promise<boolean>): Promise<void> {
  if (await urlGuard(url)) {
    throw new CredentialSourceImportError(
      'private_source_url',
      'Credential source URL must resolve to a public internet host',
      400,
    );
  }
}

async function readResponseBytes(response: Response): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > CREDENTIAL_SOURCE_IMPORT_MAX_BYTES) {
      throw new CredentialSourceImportError(
        'source_too_large',
        `Credential source exceeds ${CREDENTIAL_SOURCE_IMPORT_MAX_BYTES} bytes`,
        413,
      );
    }
  }

  if (!response.body) {
    throw new CredentialSourceImportError('source_empty', 'Credential source response body was empty', 422);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const chunk = Buffer.from(value);
    received += chunk.byteLength;
    if (received > CREDENTIAL_SOURCE_IMPORT_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new CredentialSourceImportError(
        'source_too_large',
        `Credential source exceeds ${CREDENTIAL_SOURCE_IMPORT_MAX_BYTES} bytes`,
        413,
      );
    }
    chunks.push(chunk);
  }

  if (received === 0) {
    throw new CredentialSourceImportError('source_empty', 'Credential source response body was empty', 422);
  }

  return Buffer.concat(chunks, received);
}

async function fetchCredentialSourceResponse(
  url: string,
  fetchFn: CredentialSourceImportDeps['fetchFn'],
): Promise<Response> {
  try {
    return await fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/ld+json,application/json,text/plain;q=0.9',
        'User-Agent': 'ArkovaCredentialSourceImporter/1.0',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(CREDENTIAL_SOURCE_IMPORT_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new CredentialSourceImportError('source_fetch_timeout', 'Credential source fetch timed out', 504);
    }
    throw new CredentialSourceImportError('source_fetch_failed', 'Credential source could not be fetched', 422);
  }
}

function redirectTargetFromResponse(response: Response, currentUrl: string): string {
  const location = response.headers.get('location');
  if (!location) {
    throw new CredentialSourceImportError(
      'source_redirect_invalid',
      'Credential source redirect did not include a location',
      400,
    );
  }

  try {
    return normalizeCredentialSourceUrl(new URL(location, currentUrl).toString());
  } catch (error) {
    throw new CredentialSourceImportError(
      'source_redirect_invalid',
      error instanceof Error ? error.message : 'Credential source redirect is invalid',
      400,
    );
  }
}

async function fetchedSourceFromResponse(response: Response, currentUrl: string): Promise<FetchedCredentialSource> {
  if (!response.ok) {
    throw new CredentialSourceImportError(
      'source_fetch_failed',
      `Credential source returned HTTP ${response.status}`,
      422,
    );
  }

  const contentType = normalizeContentType(response.headers.get('content-type'));
  ensureSupportedContentType(contentType);
  const bytes = await readResponseBytes(response);

  return {
    url: currentUrl,
    contentType,
    bytes,
    text: bytes.toString('utf8'),
  };
}

async function fetchPublicCredentialSource(
  rawUrl: string,
  deps: CredentialSourceImportDeps,
): Promise<FetchedCredentialSource> {
  let currentUrl: string;
  try {
    currentUrl = normalizeCredentialSourceUrl(rawUrl);
  } catch (error) {
    throw new CredentialSourceImportError(
      'invalid_source_url',
      error instanceof Error ? error.message : 'Source URL is invalid',
      400,
    );
  }

  for (let redirects = 0; redirects <= CREDENTIAL_SOURCE_IMPORT_MAX_REDIRECTS; redirects += 1) {
    await assertPublicFetchTarget(currentUrl, deps.urlGuard);

    const response = await fetchCredentialSourceResponse(currentUrl, deps.fetchFn);

    if (isRedirect(response.status)) {
      if (redirects === CREDENTIAL_SOURCE_IMPORT_MAX_REDIRECTS) {
        throw new CredentialSourceImportError(
          'source_redirect_limit',
          'Credential source redirected too many times',
          400,
        );
      }
      currentUrl = redirectTargetFromResponse(response, currentUrl);
      continue;
    }

    return fetchedSourceFromResponse(response, currentUrl);
  }

  throw new CredentialSourceImportError('source_redirect_limit', 'Credential source redirected too many times', 400);
}

function cleanText(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  }).join('');
  const cleaned = collapseWhitespace(sanitized);
  if (!cleaned) return undefined;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

function safeSourceId(value: unknown): string | undefined {
  const cleaned = cleanText(value, 256);
  return cleaned && SOURCE_ID_RE.test(cleaned) ? cleaned : undefined;
}

function normalizeEvidenceDate(value: unknown): string | undefined {
  const cleaned = cleanText(value, 80);
  if (!cleaned) return undefined;

  const dateOnly = cleaned.match(DATE_ONLY_RE)?.[0];
  if (dateOnly) return isValidDateOnly(dateOnly) ? dateOnly : undefined;

  const parsed = Date.parse(cleaned);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString().slice(0, 10);
}

function objectName(value: unknown): string | undefined {
  if (typeof value === 'string') return cleanText(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    return cleanText(candidate.name ?? candidate.legalName ?? candidate.displayName);
  }
  return undefined;
}

function walkJson(value: unknown, visit: (entry: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => walkJson(item, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;

  const entry = value as Record<string, unknown>;
  visit(entry);
  Object.values(entry).forEach((item) => walkJson(item, visit));
}

function firstJsonString(value: unknown, keys: readonly string[]): string | undefined {
  let found: string | undefined;
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  walkJson(value, (entry) => {
    if (found) return;
    for (const [key, candidate] of Object.entries(entry)) {
      if (!wanted.has(key.toLowerCase())) continue;
      found = cleanText(candidate);
      if (found) return;
    }
  });
  return found;
}

function firstJsonObjectName(value: unknown, keys: readonly string[]): string | undefined {
  let found: string | undefined;
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  walkJson(value, (entry) => {
    if (found) return;
    for (const [key, candidate] of Object.entries(entry)) {
      if (!wanted.has(key.toLowerCase())) continue;
      found = objectName(candidate);
      if (found) return;
    }
  });
  return found;
}

function firstJsonDate(value: unknown, keys: readonly string[]): string | undefined {
  let found: string | undefined;
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  walkJson(value, (entry) => {
    if (found) return;
    for (const [key, candidate] of Object.entries(entry)) {
      if (!wanted.has(key.toLowerCase())) continue;
      found = normalizeEvidenceDate(candidate);
      if (found) return;
    }
  });
  return found;
}

function parseJsonMaybe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractStructuredMetadata(value: unknown): Partial<ExtractedCredentialMetadata> {
  if (!value) return {};

  return {
    title: firstJsonString(value, ['name', 'title', 'credentialName', 'achievementName']),
    issuerName: firstJsonObjectName(value, ['issuer', 'issuedBy', 'provider', 'organization']) ??
      firstJsonString(value, ['issuerName', 'issuer_name', 'authority', 'providerName']),
    issuedAt: firstJsonDate(value, ['issuedOn', 'issuanceDate', 'dateIssued', 'validFrom', 'startDate', 'issuedAt']),
    expiresAt: firstJsonDate(value, ['expires', 'expirationDate', 'validUntil', 'endDate', 'expiresAt']),
    sourceId: safeSourceId(firstJsonString(value, ['id', '@id', 'identifier', 'credentialId'])),
  };
}

function metaContent($: cheerio.CheerioAPI, selectors: readonly string[]): string | undefined {
  for (const selector of selectors) {
    const value = cleanText($(selector).first().attr('content'));
    if (value) return value;
  }
  return undefined;
}

function firstElementText($: cheerio.CheerioAPI, selectors: readonly string[]): string | undefined {
  for (const selector of selectors) {
    const value = cleanText($(selector).first().text());
    if (value) return value;
  }
  return undefined;
}

function extractJsonLd($: cheerio.CheerioAPI): Partial<ExtractedCredentialMetadata> {
  const scripts = $('script[type*="ld+json"]')
    .map((_, element) => $(element).text())
    .get()
    .map(parseJsonMaybe)
    .filter((script): script is NonNullable<unknown> => Boolean(script));

  for (const script of scripts) {
    const extracted = extractStructuredMetadata(script);
    if (extracted.title || extracted.issuerName || extracted.issuedAt || extracted.sourceId) return extracted;
  }

  return {};
}

function inferProvider(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  if (host.includes('credly.')) return 'credly';
  if (host.includes('credential.net') || host.includes('accredible.')) return 'accredible';
  if (host.includes('badgr.') || host.includes('canvascredentials.')) return 'badgr';
  if (host.includes('openbadge')) return 'open_badge';
  return 'generic';
}

function sourceIdFromUrl(url: string): string | undefined {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/');
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment) return safeSourceId(segment);
  }
  return undefined;
}

function inferCredentialType(
  requested: AnchorCredentialType | undefined,
  url: string,
  title: string | undefined,
  issuerName: string | undefined,
): AnchorCredentialType {
  if (requested) return requested;

  const haystack = `${url} ${title ?? ''} ${issuerName ?? ''}`.toLowerCase();
  if (haystack.includes('badge') || haystack.includes('credly') || haystack.includes('openbadge')) return 'BADGE';
  if (haystack.includes('transcript')) return 'TRANSCRIPT';
  if (haystack.includes('degree') || haystack.includes('diploma')) return 'DEGREE';
  if (haystack.includes('license') || haystack.includes('licence')) return 'LICENSE';
  if (haystack.includes('accreditation') || haystack.includes('accredited')) return 'ACCREDITATION';
  if (haystack.includes('certificate') || haystack.includes('certification')) return 'CERTIFICATE';
  return 'OTHER';
}

function scoreExtraction(title: string | undefined, issuerName: string | undefined, issuedAt: string | undefined): number {
  if (title && issuerName && issuedAt) return 0.78;
  if (title && issuerName) return 0.68;
  if (title) return 0.52;
  return 0.35;
}

function extractHtmlMetadata(
  text: string,
  url: string,
  requestedType: AnchorCredentialType | undefined,
  issuerHint: string | undefined,
): ExtractedCredentialMetadata {
  const $ = cheerio.load(text);
  const structured = extractJsonLd($);
  const title = structured.title ??
    metaContent($, ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'meta[name="title"]']) ??
    firstElementText($, ['title', 'h1']);
  const issuerName = cleanText(issuerHint) ??
    structured.issuerName ??
    metaContent($, [
      'meta[name="issuer"]',
      'meta[name="author"]',
      'meta[property="article:author"]',
      'meta[property="og:site_name"]',
      'meta[name="application-name"]',
    ]);
  const issuedAt = structured.issuedAt ??
    normalizeEvidenceDate(metaContent($, [
      'meta[name="date"]',
      'meta[name="dc.date"]',
      'meta[property="article:published_time"]',
      'meta[name="issued"]',
    ])) ??
    normalizeEvidenceDate($('time[datetime]').first().attr('datetime'));
  const finalTitle = title ?? `Imported credential from ${new URL(url).hostname}`;

  return {
    title: finalTitle,
    issuerName,
    issuedAt,
    expiresAt: structured.expiresAt,
    credentialType: inferCredentialType(requestedType, url, finalTitle, issuerName),
    sourceId: structured.sourceId ?? sourceIdFromUrl(url),
    confidence: scoreExtraction(title, issuerName, issuedAt),
    extractionMethod: structured.title || structured.issuerName ? 'json_ld' : 'html_metadata',
  };
}

function extractJsonMetadata(
  text: string,
  url: string,
  requestedType: AnchorCredentialType | undefined,
  issuerHint: string | undefined,
): ExtractedCredentialMetadata {
  const parsed = parseJsonMaybe(text);
  const structured = extractStructuredMetadata(parsed);
  const title = structured.title ?? `Imported credential from ${new URL(url).hostname}`;
  const issuerName = cleanText(issuerHint) ?? structured.issuerName;

  return {
    title,
    issuerName,
    issuedAt: structured.issuedAt,
    expiresAt: structured.expiresAt,
    credentialType: inferCredentialType(requestedType, url, title, issuerName),
    sourceId: structured.sourceId ?? sourceIdFromUrl(url),
    confidence: scoreExtraction(structured.title, issuerName, structured.issuedAt),
    extractionMethod: 'json_ld',
  };
}

function extractPlainTextMetadata(
  text: string,
  url: string,
  requestedType: AnchorCredentialType | undefined,
  issuerHint: string | undefined,
): ExtractedCredentialMetadata {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .find(Boolean);
  const title = firstLine ?? `Imported credential from ${new URL(url).hostname}`;
  const issuerName = cleanText(issuerHint);

  return {
    title,
    issuerName,
    credentialType: inferCredentialType(requestedType, url, title, issuerName),
    sourceId: sourceIdFromUrl(url),
    confidence: scoreExtraction(firstLine, issuerName, undefined),
    extractionMethod: 'manual',
  };
}

function isValidDateOnly(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) return false;

  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

export function buildCredentialSourceAnchorFingerprint(
  preview: Pick<CredentialSourceImportPreview, 'normalized_source_url' | 'source_payload_hash'>,
): string {
  return sha256Hex(`${preview.normalized_source_url}\n${preview.source_payload_hash}`);
}

function extractCredentialMetadata(
  fetched: FetchedCredentialSource,
  input: CredentialSourceImportRequest,
): ExtractedCredentialMetadata {
  if (JSON_CONTENT_TYPES.has(fetched.contentType)) {
    return extractJsonMetadata(fetched.text, fetched.url, input.credential_type, input.issuer_hint);
  }
  if (HTML_CONTENT_TYPES.has(fetched.contentType)) {
    return extractHtmlMetadata(fetched.text, fetched.url, input.credential_type, input.issuer_hint);
  }
  return extractPlainTextMetadata(fetched.text, fetched.url, input.credential_type, input.issuer_hint);
}

export async function buildCredentialSourceImportPreview(
  input: CredentialSourceImportRequest,
  deps: CredentialSourceImportDeps,
): Promise<CredentialSourceImportBuildResult> {
  const fetched = await fetchPublicCredentialSource(input.source_url, deps);
  const extracted = extractCredentialMetadata(fetched, input);
  const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
  const payloadHash = sha256Hex(fetched.bytes);
  const evidencePackage = buildCredentialEvidencePackage({
    schemaVersion: CREDENTIAL_EVIDENCE_SCHEMA_VERSION,
    source: {
      provider: inferProvider(fetched.url),
      url: fetched.url,
      id: extracted.sourceId,
      fetchedAt,
      payloadHash,
      payloadContentType: fetched.contentType,
      payloadByteLength: fetched.bytes.byteLength,
    },
    credential: {
      type: extracted.credentialType,
      title: extracted.title,
      issuerName: extracted.issuerName,
      issuedAt: extracted.issuedAt,
      expiresAt: extracted.expiresAt,
    },
    evidence: {
      verificationLevel: 'captured_url',
      extractionMethod: extracted.extractionMethod,
      confidence: extracted.confidence,
    },
  });
  const publicMetadata = toPublicSafeCredentialEvidenceMetadata(evidencePackage);
  const anchorFingerprint = buildCredentialSourceAnchorFingerprint({
    normalized_source_url: evidencePackage.source.url,
    source_payload_hash: evidencePackage.source.payloadHash,
  });

  return {
    evidencePackage,
    preview: {
      normalized_source_url: evidencePackage.source.url,
      source_provider: evidencePackage.source.provider,
      source_id: evidencePackage.source.id ?? null,
      source_fetched_at: evidencePackage.source.fetchedAt,
      source_payload_hash: evidencePackage.source.payloadHash,
      source_payload_content_type: evidencePackage.source.payloadContentType ?? fetched.contentType,
      source_payload_byte_length: evidencePackage.source.payloadByteLength ?? fetched.bytes.byteLength,
      credential_type: evidencePackage.credential.type,
      credential_title: evidencePackage.credential.title,
      credential_issuer: evidencePackage.credential.issuerName ?? null,
      credential_issued_at: evidencePackage.credential.issuedAt ?? null,
      credential_expires_at: evidencePackage.credential.expiresAt ?? null,
      verification_level: 'captured_url',
      extraction_method: evidencePackage.evidence.extractionMethod,
      extraction_confidence: evidencePackage.evidence.confidence ?? 0,
      evidence_package_hash: evidencePackage.evidencePackageHash,
      anchor_fingerprint: anchorFingerprint,
      public_metadata: publicMetadata,
    },
  };
}

export function buildSelfImportRecipientHash(userId: string): string {
  return sha256Hex(`self-import:${userId}`);
}

export function evidenceDateToTimestamp(value: string | null | undefined, endOfDay = false): string | null {
  if (!value) return null;
  if (value.includes('T')) return value;
  return `${value}T${endOfDay ? '23:59:59' : '00:00:00'}Z`;
}

export function buildSourceImportFilename(preview: CredentialSourceImportPreview): string {
  const host = new URL(preview.normalized_source_url).hostname;
  const title = Array.from(preview.credential_title, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || FILENAME_UNSAFE_CHARACTERS.includes(character) ? ' ' : character;
  }).join('');
  const titleForFilename = collapseWhitespace(title);
  const base = titleForFilename || `Credential source ${host}`;
  return `${base.slice(0, 180)}.url`;
}
