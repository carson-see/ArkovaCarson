/**
 * SCRUM-1597: Credential evidence package schema and canonical hash helpers.
 *
 * This module does not fetch provider pages and does not submit issuer
 * credentials. It only defines the signed/captured evidence envelope Arkova
 * can hash before anchoring.
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { canonicaliseJson } from '../utils/canonical-json.js';

export const CREDENTIAL_EVIDENCE_SCHEMA_VERSION = 'credential_evidence_v1' as const;

export const ANCHOR_CREDENTIAL_TYPES = [
  'DEGREE',
  'LICENSE',
  'CERTIFICATE',
  'TRANSCRIPT',
  'PROFESSIONAL',
  'CLE',
  'BADGE',
  'ATTESTATION',
  'FINANCIAL',
  'LEGAL',
  'INSURANCE',
  'SEC_FILING',
  'PATENT',
  'REGULATION',
  'PUBLICATION',
  'CHARITY',
  'FINANCIAL_ADVISOR',
  'BUSINESS_ENTITY',
  'RESUME',
  'MEDICAL',
  'MILITARY',
  'IDENTITY',
  'OTHER',
] as const;

export const CREDENTIAL_EVIDENCE_VERIFICATION_LEVELS = [
  'issuer_anchored',
  'source_signed',
  'account_linked',
  'captured_url',
  'captured_upload_ai',
] as const;

export const CREDENTIAL_EVIDENCE_EXTRACTION_METHODS = [
  'issuer_api',
  'open_badge',
  'json_ld',
  'html_metadata',
  'ai_extraction',
  'manual',
  'unknown',
] as const;

export type AnchorCredentialType = (typeof ANCHOR_CREDENTIAL_TYPES)[number];
export type CredentialEvidenceVerificationLevel = (typeof CREDENTIAL_EVIDENCE_VERIFICATION_LEVELS)[number];
export type CredentialEvidenceExtractionMethod = (typeof CREDENTIAL_EVIDENCE_EXTRACTION_METHODS)[number];
type PublicMetadataValue = string | number | boolean | null;
type CompactablePublicMetadata = Record<string, PublicMetadataValue | undefined>;

const SHA_256_HEX = /^[a-fA-F0-9]{64}$/;
const PROVIDER_SLUG = /^[a-z][a-z0-9_-]{1,63}$/;
const SOURCE_ID = /^[A-Za-z0-9._:/#@+-]{1,256}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'code',
  'cookie',
  'jwt',
  'key',
  'password',
  'refresh_token',
  'secret',
  'session',
  'sig',
  'signature',
  'signed',
  'signed_url',
  'token',
]);

const TRACKING_QUERY_PREFIXES = ['utm_'];
const TRACKING_QUERY_KEYS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid']);

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function assertPublicHttpHost(hostname: string): void {
  const normalized = stripIpv6Brackets(hostname.toLowerCase());
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    throw new Error('source URL host must be a public internet host');
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4 && isPrivateIpv4(normalized)) {
    throw new Error('source URL must not target a private IPv4 address');
  }
  if (ipVersion === 6 && isPrivateIpv6(normalized)) {
    throw new Error('source URL must not target a private IPv6 address');
  }
}

function shouldDropQueryKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    SENSITIVE_QUERY_KEYS.has(normalized) ||
    TRACKING_QUERY_KEYS.has(normalized) ||
    TRACKING_QUERY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function compareQueryEntries([aKey, aVal]: [string, string], [bKey, bVal]: [string, string]): number {
  const keyComparison = aKey.localeCompare(bKey);
  return keyComparison !== 0 ? keyComparison : aVal.localeCompare(bVal);
}

/**
 * Normalize public credential source URLs before they enter hashed evidence.
 *
 * The URL remains human-clickable but removes userinfo, fragments, tracking
 * params, and known token/signature params so Arkova never anchors or displays
 * bearer material.
 */
export function normalizeCredentialSourceUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error('source URL is required');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('source URL must be absolute');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('source URL must use http or https');
  }
  assertPublicHttpHost(parsed.hostname);

  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();

  const entries = [...parsed.searchParams.entries()]
    .filter(([key]) => !shouldDropQueryKey(key))
    .sort(compareQueryEntries);
  parsed.search = '';
  for (const [key, value] of entries) {
    parsed.searchParams.append(key, value);
  }

  return parsed.toString();
}

const Sha256HexSchema = z
  .string()
  .regex(SHA_256_HEX, 'must be a 64-character SHA-256 hex hash')
  .transform((value) => value.toLowerCase());

const DateOrDateTimeSchema = z
  .string()
  .refine((value) => DATE_ONLY.test(value) || !Number.isNaN(Date.parse(value)), {
    message: 'must be YYYY-MM-DD or an ISO date-time',
  });

const SourceUrlSchema = z.string().transform((value, ctx) => {
  try {
    return normalizeCredentialSourceUrl(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'invalid source URL',
    });
    return z.NEVER;
  }
});

export const CredentialEvidenceSourceSchema = z.object({
  provider: z.string().regex(PROVIDER_SLUG, 'provider must be a lowercase slug'),
  url: SourceUrlSchema,
  id: z.string().regex(SOURCE_ID, 'source id contains unsupported characters').optional(),
  fetchedAt: z.string().datetime({ offset: true }),
  payloadHash: Sha256HexSchema,
  payloadContentType: z.string().max(120).optional(),
  payloadByteLength: z.number().int().nonnegative().optional(),
}).strict();

export const CredentialEvidenceCredentialSchema = z.object({
  type: z.enum(ANCHOR_CREDENTIAL_TYPES),
  title: z.string().min(1).max(500),
  issuerName: z.string().min(1).max(500).optional(),
  issuedAt: DateOrDateTimeSchema.optional(),
  expiresAt: DateOrDateTimeSchema.optional(),
  credentialIdHash: Sha256HexSchema.optional(),
  recipientDisplayName: z.string().min(1).max(300).optional(),
  recipientIdentifierHash: Sha256HexSchema.optional(),
}).strict();

export const CredentialEvidenceAssertionSchema = z.object({
  verificationLevel: z.enum(CREDENTIAL_EVIDENCE_VERIFICATION_LEVELS),
  extractionMethod: z.enum(CREDENTIAL_EVIDENCE_EXTRACTION_METHODS),
  extractionManifestHash: Sha256HexSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

export const CredentialEvidenceHashInputSchema = z.object({
  schemaVersion: z.literal(CREDENTIAL_EVIDENCE_SCHEMA_VERSION),
  source: CredentialEvidenceSourceSchema,
  credential: CredentialEvidenceCredentialSchema,
  evidence: CredentialEvidenceAssertionSchema,
}).strict();

export const CredentialEvidencePackageSchema = CredentialEvidenceHashInputSchema.extend({
  evidencePackageHash: Sha256HexSchema,
}).strict();

export type CredentialEvidenceHashInput = z.input<typeof CredentialEvidenceHashInputSchema>;
export type NormalizedCredentialEvidenceHashInput = z.output<typeof CredentialEvidenceHashInputSchema>;
export type CredentialEvidencePackage = z.output<typeof CredentialEvidencePackageSchema>;

export function canonicalizeCredentialEvidence(input: CredentialEvidenceHashInput): string {
  return canonicaliseJson(CredentialEvidenceHashInputSchema.parse(input));
}

export function computeCredentialEvidenceHash(input: CredentialEvidenceHashInput): string {
  return createHash('sha256').update(canonicalizeCredentialEvidence(input)).digest('hex');
}

export function buildCredentialEvidencePackage(input: CredentialEvidenceHashInput): CredentialEvidencePackage {
  const normalized = CredentialEvidenceHashInputSchema.parse(input);
  return CredentialEvidencePackageSchema.parse({
    ...normalized,
    evidencePackageHash: computeCredentialEvidenceHash(normalized),
  });
}

function compactPublicMetadata(metadata: CompactablePublicMetadata): Record<string, PublicMetadataValue> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  ) as Record<string, PublicMetadataValue>;
}

/**
 * Metadata safe to attach to anchors and surface through public verification.
 *
 * Deliberately excludes recipientDisplayName and any raw credential IDs; those
 * can remain inside the private hashed evidence package or be represented by
 * hashes.
 */
export function toPublicSafeCredentialEvidenceMetadata(
  evidencePackage: CredentialEvidencePackage,
): Record<string, PublicMetadataValue> {
  return compactPublicMetadata({
    evidence_schema_version: evidencePackage.schemaVersion,
    evidence_package_hash: evidencePackage.evidencePackageHash,
    source_url: evidencePackage.source.url,
    source_provider: evidencePackage.source.provider,
    source_id: evidencePackage.source.id,
    source_fetched_at: evidencePackage.source.fetchedAt,
    source_payload_hash: evidencePackage.source.payloadHash,
    source_payload_content_type: evidencePackage.source.payloadContentType,
    source_payload_byte_length: evidencePackage.source.payloadByteLength,
    verification_level: evidencePackage.evidence.verificationLevel,
    extraction_method: evidencePackage.evidence.extractionMethod,
    extraction_manifest_hash: evidencePackage.evidence.extractionManifestHash,
    extraction_confidence: evidencePackage.evidence.confidence,
    credential_title: evidencePackage.credential.title,
    credential_type: evidencePackage.credential.type,
    credential_issuer: evidencePackage.credential.issuerName,
    credential_issued_at: evidencePackage.credential.issuedAt,
    credential_expires_at: evidencePackage.credential.expiresAt,
    credential_id_hash: evidencePackage.credential.credentialIdHash,
    recipient_identifier_hash: evidencePackage.credential.recipientIdentifierHash,
  });
}

export const PublicCredentialEvidenceMetadataSchema = z.object({
  evidence_schema_version: z.literal(CREDENTIAL_EVIDENCE_SCHEMA_VERSION).optional(),
  evidence_package_hash: Sha256HexSchema.optional(),
  source_url: SourceUrlSchema.optional(),
  source_provider: z.string().regex(PROVIDER_SLUG).optional(),
  source_id: z.string().regex(SOURCE_ID).optional(),
  source_fetched_at: z.string().datetime({ offset: true }).optional(),
  source_payload_hash: Sha256HexSchema.optional(),
  source_payload_content_type: z.string().max(120).optional(),
  source_payload_byte_length: z.number().int().nonnegative().optional(),
  verification_level: z.enum(CREDENTIAL_EVIDENCE_VERIFICATION_LEVELS).optional(),
  extraction_method: z.enum(CREDENTIAL_EVIDENCE_EXTRACTION_METHODS).optional(),
  extraction_manifest_hash: Sha256HexSchema.optional(),
  extraction_confidence: z.number().min(0).max(1).optional(),
  credential_title: z.string().min(1).max(500).optional(),
  credential_type: z.enum(ANCHOR_CREDENTIAL_TYPES).optional(),
  credential_issuer: z.string().min(1).max(500).optional(),
  credential_issued_at: DateOrDateTimeSchema.optional(),
  credential_expires_at: DateOrDateTimeSchema.optional(),
  credential_id_hash: Sha256HexSchema.optional(),
  recipient_identifier_hash: Sha256HexSchema.optional(),
}).strict();

const PUBLIC_CREDENTIAL_EVIDENCE_METADATA_KEYS = new Set(Object.keys(PublicCredentialEvidenceMetadataSchema.shape));

export function hasPublicCredentialEvidenceMetadataKeys(metadata: unknown): boolean {
  return (
    !!metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    Object.keys(metadata as Record<string, unknown>).some((key) =>
      PUBLIC_CREDENTIAL_EVIDENCE_METADATA_KEYS.has(key),
    )
  );
}

export function parsePublicCredentialEvidenceMetadata(
  metadata: unknown,
): Record<string, string | number | boolean | null> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const candidate = Object.fromEntries(
    Object.entries(metadata as Record<string, unknown>).filter(([key]) =>
      PUBLIC_CREDENTIAL_EVIDENCE_METADATA_KEYS.has(key),
    ),
  );
  if (Object.keys(candidate).length === 0) return null;
  const parsed = PublicCredentialEvidenceMetadataSchema.partial().safeParse(candidate);
  if (!parsed.success) return null;
  return compactPublicMetadata(parsed.data);
}
