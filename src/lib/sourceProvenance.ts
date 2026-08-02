/**
 * Source Provenance Utilities (CSI-03 / SCRUM-1599)
 *
 * Types and helpers for displaying source provenance on public verification pages.
 * Handles:
 * - Verification level enum mapping to UI labels
 * - URL safety (strip tokens/secrets before display)
 * - Evidence metadata for proof downloads
 */

import { EVIDENCE_LEVEL_LABELS, EVIDENCE_LEVEL_DESCRIPTIONS, type EvidenceLevel } from '@/lib/copy';
import { verifyUrl } from '@/lib/routes';
import { z } from 'zod';

export type VerificationLevel = EvidenceLevel;

export const VERIFICATION_LEVEL_VALUES = [
  'issuer_anchored',
  'source_signed',
  'account_linked',
  'captured_url',
  'ai_captured',
] as const satisfies readonly VerificationLevel[];

export const verificationLevelSchema = z.enum(VERIFICATION_LEVEL_VALUES);

/**
 * SCRUM-2480 — server spellings that mean the same tier as a client value.
 *
 * The worker's own enum (`CREDENTIAL_EVIDENCE_VERIFICATION_LEVELS` in
 * `services/worker/src/lib/credential-evidence.ts`) writes
 * `captured_upload_ai`; this module was only ever taught `ai_captured`. Since
 * the stored value is what `get_public_anchor` hands back, every AI-captured
 * anchor parsed as null and rendered NO badge at all — and a missing badge
 * reads as "no caveat", the exact inverse of "weakest evidence we hold".
 *
 * Normalising on READ (rather than renaming either enum) is deliberate: the
 * server spelling is already persisted in `anchors.metadata` on real rows, so
 * a rename would need a backfill, and the verification API response shape is
 * frozen (§1.8). Accepting both spellings fixes existing data with no
 * migration and no contract change.
 *
 * A Map, not an object literal, for two reasons: object index access walks the
 * prototype chain (so `'constructor'` or `'toString'` would resolve to a
 * function rather than miss), and the `Object.hasOwn` guard that would fix that
 * is ES2022 — unavailable under `tsconfig.build.json`, the Vercel-safe config
 * CI type-checks with. A Map has neither problem.
 */
const VERIFICATION_LEVEL_ALIASES: ReadonlyMap<string, VerificationLevel> = new Map([
  ['captured_upload_ai', 'ai_captured' as VerificationLevel],
]);

export function parseVerificationLevel(value: unknown): VerificationLevel | null {
  const parsed = verificationLevelSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (typeof value === 'string') {
    return VERIFICATION_LEVEL_ALIASES.get(value) ?? null;
  }
  return null;
}

export interface SourceProvenanceData {
  source_url?: string | null;
  source_provider?: string | null;
  verification_level?: VerificationLevel | null;
  evidence_package_hash?: string | null;
  source_payload_hash?: string | null;
  fetched_at?: string | null;
}

export interface EvidenceProofFields {
  evidence_package_hash?: string;
  source_payload_hash?: string;
  source_provider?: string;
  source_url?: string;
  fetched_at?: string;
  verification_level?: string;
}

const SENSITIVE_PARAMS = new Set([
  'token',
  'access_token',
  'code',
  'state',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'auth',
  'session',
  'sid',
  'jwt',
  'refresh_token',
  'client_secret',
  'nonce',
  'sig',
  'signature',
  'x-api-key',
  'hmac',
]);

export function sanitizeSourceUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;

    const paramsToDelete: string[] = [];
    url.searchParams.forEach((_value, key) => {
      if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
        paramsToDelete.push(key);
      }
    });
    for (const key of paramsToDelete) {
      url.searchParams.delete(key);
    }

    url.hash = '';

    return url.toString();
  } catch {
    return null;
  }
}

export function isSourceUrlSafe(url: string | null | undefined): boolean {
  return sanitizeSourceUrl(url) !== null;
}

/**
 * Accepted shape for every `parseVerificationLevel`-backed helper below.
 *
 * Deliberately just `string | null | undefined`, not
 * `VerificationLevel | string | null | undefined`: `VerificationLevel` is
 * already a subset of `string`, so including it widens nothing and only
 * erases the literal members from the union (SonarCloud S4025 / caught as a
 * maintainability finding on PR #1840). `parseVerificationLevel` is exactly
 * the function that narrows an arbitrary string back down to the enum.
 */
export type EvidenceLevelInput = string | null | undefined;

export function getEvidenceLevelLabel(level: EvidenceLevelInput): string | null {
  const parsed = parseVerificationLevel(level);
  if (!parsed) return null;
  return EVIDENCE_LEVEL_LABELS[parsed] ?? null;
}

export function getEvidenceLevelDescription(level: EvidenceLevelInput): string | null {
  const parsed = parseVerificationLevel(level);
  if (!parsed) return null;
  return EVIDENCE_LEVEL_DESCRIPTIONS[parsed] ?? null;
}

const LEVEL_STRENGTH: Record<VerificationLevel, number> = {
  issuer_anchored: 5,
  source_signed: 4,
  account_linked: 3,
  captured_url: 2,
  ai_captured: 1,
};

export function getEvidenceLevelStrength(level: EvidenceLevelInput): number {
  const parsed = parseVerificationLevel(level);
  if (!parsed) return 0;
  return LEVEL_STRENGTH[parsed] ?? 0;
}

export function isStrongEvidence(level: EvidenceLevelInput): boolean {
  return getEvidenceLevelStrength(level) >= 4;
}

/**
 * ISSUER-AUTHENTICATION HONESTY GATE (SCRUM-2481).
 *
 * Returns true ONLY for tiers where the issuing organization itself
 * authenticated the credential — `issuer_anchored` (direct issuer anchoring)
 * and `source_signed` (cryptographic signature proving origin). These are the
 * only tiers permitted to render the green "issuer-verified" treatment.
 *
 * `account_linked`, `captured_url`, and `ai_captured` are explicitly EXCLUDED:
 * an account link, a scraped public URL, or an AI extraction proves possession
 * or capture — NOT that the issuer stands behind the credential. They must
 * NEVER compose issuer-verified artwork or wording on any off-platform surface
 * (LinkedIn Credential URL, shared public verification page).
 *
 * This is a strict subset of {@link isStrongEvidence} (strength >= 4): the two
 * issuer tiers are exactly strength 5 (issuer_anchored) and 4 (source_signed).
 * It is the single composition point the badge/provenance UI gates on.
 */
const ISSUER_AUTHENTICATED_LEVELS: ReadonlySet<VerificationLevel> = new Set<VerificationLevel>([
  'issuer_anchored',
  'source_signed',
]);

export function isIssuerAuthenticated(level: EvidenceLevelInput): boolean {
  const parsed = parseVerificationLevel(level);
  if (!parsed) return false;
  return ISSUER_AUTHENTICATED_LEVELS.has(parsed);
}

const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  credly: 'Credly',
  linkedin: 'LinkedIn',
  accredible: 'Accredible',
  badgr: 'Badgr',
  certifier: 'Certifier',
  coursera: 'Coursera',
  udemy: 'Udemy',
  google: 'Google',
  microsoft: 'Microsoft',
  aws: 'AWS',
  github: 'GitHub',
};

export function formatProvider(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return PROVIDER_DISPLAY_NAMES[provider.toLowerCase()] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function buildEvidenceProofFields(data: SourceProvenanceData): EvidenceProofFields {
  const fields: EvidenceProofFields = {};

  if (data.evidence_package_hash) fields.evidence_package_hash = data.evidence_package_hash;
  if (data.source_payload_hash) fields.source_payload_hash = data.source_payload_hash;
  if (data.source_provider) fields.source_provider = data.source_provider;
  if (data.source_url) {
    const safe = sanitizeSourceUrl(data.source_url);
    if (safe) fields.source_url = safe;
  }
  if (data.fetched_at) fields.fetched_at = data.fetched_at;
  const verificationLevel = parseVerificationLevel(data.verification_level);
  if (verificationLevel) fields.verification_level = verificationLevel;

  return fields;
}

export function badgeUrl(publicId: string): string {
  const safePublicId = encodeURIComponent(publicId);
  const baseUrl = typeof window !== 'undefined'
    ? window.location.origin
    : 'https://app.arkova.ai';
  return `${baseUrl}/api/badge/${safePublicId}`;
}

export function linkedInCredentialUrl(publicId: string): string {
  return verifyUrl(encodeURIComponent(publicId));
}
