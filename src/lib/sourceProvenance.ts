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

export function parseVerificationLevel(value: unknown): VerificationLevel | null {
  const parsed = verificationLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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

export function getEvidenceLevelLabel(level: VerificationLevel | string | null | undefined): string | null {
  const parsed = parseVerificationLevel(level);
  if (!parsed) return null;
  return EVIDENCE_LEVEL_LABELS[parsed] ?? null;
}

export function getEvidenceLevelDescription(level: VerificationLevel | string | null | undefined): string | null {
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

export function getEvidenceLevelStrength(level: VerificationLevel | string | null | undefined): number {
  const parsed = parseVerificationLevel(level);
  if (!parsed) return 0;
  return LEVEL_STRENGTH[parsed] ?? 0;
}

export function isStrongEvidence(level: VerificationLevel | string | null | undefined): boolean {
  return getEvidenceLevelStrength(level) >= 4;
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
