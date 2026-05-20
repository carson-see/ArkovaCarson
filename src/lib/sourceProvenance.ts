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

// =============================================================================
// Types
// =============================================================================

/**
 * Verification level enum values from CSI-01 evidence package.
 * Ordered from strongest to weakest evidence.
 */
export type VerificationLevel = EvidenceLevel;

/**
 * Source provenance data that may be available on a public verification page.
 * All fields nullable since older anchors won't have CSI metadata.
 */
export interface SourceProvenanceData {
  source_url?: string | null;
  source_provider?: string | null;
  verification_level?: VerificationLevel | null;
  evidence_package_hash?: string | null;
  source_payload_hash?: string | null;
  fetched_at?: string | null;
}

/**
 * Evidence metadata included in proof downloads (CSI-03 enrichment).
 */
export interface EvidenceProofFields {
  evidence_package_hash?: string;
  source_payload_hash?: string;
  source_provider?: string;
  source_url?: string;
  fetched_at?: string;
  verification_level?: string;
}

// =============================================================================
// URL Safety
// =============================================================================

/**
 * Sensitive URL parameter names that must be stripped before public display.
 * Case-insensitive matching.
 */
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
  'code',
  'state',
  'nonce',
  'sig',
  'signature',
  'x-api-key',
  'hmac',
]);

/**
 * Strip sensitive query parameters and fragments from a URL for public display.
 * Returns null if the URL is not safe to display (e.g., contains credentials in path).
 */
export function sanitizeSourceUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);

    if (!['https:', 'http:'].includes(url.protocol)) return null;

    // Never display URLs with userinfo (user:pass@host)
    if (url.username || url.password) return null;

    // Strip sensitive query params
    const paramsToDelete: string[] = [];
    url.searchParams.forEach((_value, key) => {
      if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
        paramsToDelete.push(key);
      }
    });
    for (const key of paramsToDelete) {
      url.searchParams.delete(key);
    }

    // Strip fragment (hash) as it may contain tokens
    url.hash = '';

    return url.toString();
  } catch {
    // If URL parsing fails, don't display it
    return null;
  }
}

/**
 * Check whether a source URL is safe to display publicly.
 * More conservative than sanitize — returns false for anything suspicious.
 */
export function isSourceUrlSafe(url: string | null | undefined): boolean {
  return sanitizeSourceUrl(url) !== null;
}

// =============================================================================
// Evidence Level Helpers
// =============================================================================

/**
 * Ordered strength of verification levels (highest first).
 */
const LEVEL_STRENGTH: Record<VerificationLevel, number> = {
  issuer_anchored: 5,
  source_signed: 4,
  account_linked: 3,
  captured_url: 2,
  ai_captured: 1,
};

function isVerificationLevel(level: string): level is VerificationLevel {
  return Object.prototype.hasOwnProperty.call(LEVEL_STRENGTH, level);
}

/**
 * Get the human-readable label for a verification level.
 */
export function getEvidenceLevelLabel(level: VerificationLevel | string | null | undefined): string | null {
  if (!level) return null;
  if (!isVerificationLevel(level)) return null;
  return EVIDENCE_LEVEL_LABELS[level] ?? null;
}

/**
 * Get the description for a verification level.
 */
export function getEvidenceLevelDescription(level: VerificationLevel | string | null | undefined): string | null {
  if (!level) return null;
  if (!isVerificationLevel(level)) return null;
  return EVIDENCE_LEVEL_DESCRIPTIONS[level] ?? null;
}

/**
 * Get the relative strength of a verification level (1-5, 5 being strongest).
 */
export function getEvidenceLevelStrength(level: VerificationLevel | string | null | undefined): number {
  if (!level) return 0;
  if (!isVerificationLevel(level)) return 0;
  return LEVEL_STRENGTH[level];
}

/**
 * Check if a verification level represents strong evidence (issuer_anchored or source_signed).
 */
export function isStrongEvidence(level: VerificationLevel | string | null | undefined): boolean {
  return getEvidenceLevelStrength(level) >= 4;
}

// =============================================================================
// Provider Display
// =============================================================================

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

/**
 * Format a source provider slug into a display name.
 */
export function formatProvider(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return PROVIDER_DISPLAY_NAMES[provider.toLowerCase()] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

// =============================================================================
// Proof Download Enrichment
// =============================================================================

/**
 * Build evidence proof fields for inclusion in the JSON proof download.
 * Only includes fields that are present and non-null.
 */
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
  if (data.verification_level) fields.verification_level = data.verification_level;

  return fields;
}

// =============================================================================
// Badge URL
// =============================================================================

/**
 * Build the URL for the Arkova verification badge SVG.
 */
export function badgeUrl(publicId: string, status: string): string {
  const safePublicId = encodeURIComponent(publicId);
  const baseUrl = typeof window !== 'undefined'
    ? (window.location.origin)
    : 'https://app.arkova.ai';
  return `${baseUrl}/api/badge/${safePublicId}?status=${encodeURIComponent(status)}`;
}

// =============================================================================
// LinkedIn Credential URL
// =============================================================================

/**
 * Build the Arkova verification URL for use as LinkedIn Credential URL.
 * Per CSI-03: use Arkova verification URL, no native LinkedIn checkmark claim.
 */
export function linkedInCredentialUrl(publicId: string): string {
  return verifyUrl(encodeURIComponent(publicId));
}
