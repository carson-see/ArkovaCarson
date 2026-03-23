/**
 * Integrity Score Service (P8-S8)
 *
 * Computes an integrity score (0-100) for each credential anchor by evaluating:
 *   - Metadata completeness (are all expected fields present?)
 *   - Extraction confidence (how confident was the AI?)
 *   - Issuer verification (is the issuer in ground truth?)
 *   - Duplicate check (any similar fingerprints in the org?)
 *   - Temporal consistency (do dates make logical sense?)
 *
 * Levels: HIGH (>=80), MEDIUM (60-79), LOW (40-59), FLAGGED (<40)
 *
 * Constitution 4A: Only metadata scores, no document content processed.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// TYPES
// =============================================================================

export type IntegrityLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'FLAGGED';

export interface IntegrityBreakdown {
  metadataCompleteness: number;
  extractionConfidence: number;
  issuerVerification: number;
  duplicateCheck: number;
  temporalConsistency: number;
}

export interface IntegrityResult {
  overallScore: number;
  level: IntegrityLevel;
  breakdown: IntegrityBreakdown;
  flags: string[];
  details: Record<string, unknown>;
}

export interface IntegrityScoreRecord {
  id: string;
  anchorId: string;
  orgId: string | null;
  overallScore: number;
  level: IntegrityLevel;
  metadataCompleteness: number;
  extractionConfidence: number;
  issuerVerification: number;
  duplicateCheck: number;
  temporalConsistency: number;
  flags: string[];
  details: Record<string, unknown>;
  computedAt: string;
}

// =============================================================================
// SCORE CALCULATION
// =============================================================================

/** Map score to integrity level */
export function scoreToLevel(score: number): IntegrityLevel {
  if (score >= 80) return 'HIGH';
  if (score >= 60) return 'MEDIUM';
  if (score >= 40) return 'LOW';
  return 'FLAGGED';
}

/** Expected metadata fields per credential type */
const EXPECTED_FIELDS: Record<string, string[]> = {
  DEGREE: ['issuerName', 'issuedDate', 'fieldOfStudy', 'degreeLevel'],
  CERTIFICATE: ['issuerName', 'issuedDate', 'credentialType'],
  LICENSE: ['issuerName', 'issuedDate', 'expiryDate', 'licenseNumber', 'jurisdiction'],
  TRANSCRIPT: ['issuerName', 'issuedDate'],
  PROFESSIONAL: ['issuerName', 'issuedDate', 'accreditingBody'],
  CLE: ['issuerName', 'issuedDate', 'creditHours', 'creditType', 'accreditingBody', 'jurisdiction'],
  OTHER: ['issuerName'],
};

/**
 * Calculate metadata completeness score (0-100).
 * Based on how many expected fields are present for this credential type.
 */
export function calculateMetadataCompleteness(
  metadata: Record<string, unknown> | null,
  credentialType: string,
): number {
  if (!metadata) return 0;
  const expected = EXPECTED_FIELDS[credentialType] ?? EXPECTED_FIELDS.OTHER;
  if (expected.length === 0) return 100;

  const present = expected.filter(
    (key) => metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== '',
  ).length;

  return Math.round((present / expected.length) * 100);
}

/**
 * Calculate temporal consistency score (0-100).
 * Checks: issued date < expiry date, issued date not in future, etc.
 */
export function calculateTemporalConsistency(
  issuedDate?: string | null,
  expiryDate?: string | null,
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 100;

  if (!issuedDate) {
    return { score: 50, flags: ['missing_issued_date'] };
  }

  const issued = new Date(issuedDate);
  const now = new Date();

  // Future issued date
  if (issued > now) {
    score -= 40;
    flags.push('future_issued_date');
  }

  // Very old (>50 years)
  const fiftyYearsAgo = new Date();
  fiftyYearsAgo.setFullYear(fiftyYearsAgo.getFullYear() - 50);
  if (issued < fiftyYearsAgo) {
    score -= 20;
    flags.push('very_old_credential');
  }

  if (expiryDate) {
    const expiry = new Date(expiryDate);
    // Expiry before issued
    if (expiry < issued) {
      score -= 50;
      flags.push('expiry_before_issued');
    }
  }

  return { score: Math.max(0, score), flags };
}

/**
 * Compute full integrity score for an anchor.
 * Requires the anchor row + any AI extraction data.
 */
export async function computeIntegrityScore(
  anchorId: string,
  orgId: string | undefined,
): Promise<IntegrityResult> {
  const flags: string[] = [];
  const details: Record<string, unknown> = {};

  // Fetch anchor data
  const { data: anchor, error: anchorErr } = await db
    .from('anchors')
    .select('id, credential_type, metadata, fingerprint, created_at, issued_at, expires_at, status')
    .eq('id', anchorId)
    .single();

  if (anchorErr || !anchor) {
    logger.warn({ anchorId, error: anchorErr }, 'Anchor not found for integrity scoring');
    return {
      overallScore: 0,
      level: 'FLAGGED',
      breakdown: { metadataCompleteness: 0, extractionConfidence: 0, issuerVerification: 0, duplicateCheck: 0, temporalConsistency: 0 },
      flags: ['anchor_not_found'],
      details: {},
    };
  }

  // 1. Metadata completeness
  const metadata = (anchor.metadata as Record<string, unknown>) ?? {};
  const credType = (anchor.credential_type as string) ?? 'OTHER';
  const metadataCompleteness = calculateMetadataCompleteness(metadata, credType);

  // 2. Extraction confidence — check ai_usage_events for this fingerprint
  let extractionConfidence = 50; // default if no AI was used
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: usageData } = await (db as any)
      .from('ai_usage_events')
      .select('confidence')
      .eq('fingerprint', anchor.fingerprint)
      .eq('event_type', 'extraction')
      .eq('success', true)
      .order('created_at', { ascending: false })
      .limit(1);

    if (usageData && usageData.length > 0 && usageData[0].confidence != null) {
      extractionConfidence = Math.round(usageData[0].confidence * 100);
    }
  } catch {
    // Non-fatal — use default
  }

  // 3. Issuer verification — multi-strategy ground truth matching
  //    Strategy A: exact ilike match (score 100)
  //    Strategy B: fuzzy contains match (score 80)
  //    Strategy C: domain match from metadata (score 70)
  //    No match: score 30
  let issuerVerification = 50; // default
  const issuerName = metadata.issuerName as string | undefined;
  if (issuerName) {
    try {
      // Strategy A: exact match (case-insensitive)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: exactMatch } = await (db as any)
        .from('institution_ground_truth')
        .select('id, name')
        .ilike('name', issuerName)
        .limit(1);

      if (exactMatch && exactMatch.length > 0) {
        issuerVerification = 100;
        details.issuerMatch = true;
        details.issuerMatchStrategy = 'exact';
        details.matchedInstitution = exactMatch[0].name;
      } else {
        // Strategy B: fuzzy contains — strip common prefixes ("The ", "University of ")
        // and check if issuer name contains or is contained in ground truth names
        const normalizedIssuer = issuerName
          .replace(/^(The|A)\s+/i, '')
          .trim()
          // Sanitize for PostgREST filter interpolation — strip characters that could
          // manipulate the .or() filter string (commas, dots, parentheses, LIKE wildcards)
          .replace(/[,.()"'\\%_]/g, '');
        if (!normalizedIssuer || normalizedIssuer.length < 2) {
          issuerVerification = 30;
          flags.push('issuer_not_in_registry');
          details.issuerMatch = false;
        } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: fuzzyMatch } = await (db as any)
          .from('institution_ground_truth')
          .select('id, name')
          .or(`name.ilike.%${normalizedIssuer}%,name.ilike.${normalizedIssuer}%`)
          .limit(1);

        if (fuzzyMatch && fuzzyMatch.length > 0) {
          issuerVerification = 80;
          details.issuerMatch = true;
          details.issuerMatchStrategy = 'fuzzy';
          details.matchedInstitution = fuzzyMatch[0].name;
        } else {
          issuerVerification = 30;
          flags.push('issuer_not_in_registry');
          details.issuerMatch = false;
        }
        }
      }
    } catch {
      // Non-fatal — use default
    }
  } else {
    issuerVerification = 20;
    flags.push('missing_issuer');
  }

  // 4. Duplicate check — look for same fingerprint in this org
  let duplicateCheck = 100;
  if (orgId) {
    try {
      const { count } = await db
        .from('anchors')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('fingerprint', anchor.fingerprint)
        .neq('id', anchorId);

      if (count && count > 0) {
        duplicateCheck = 20;
        flags.push('duplicate_fingerprint');
        details.duplicateCount = count;
      }
    } catch {
      // Non-fatal
    }
  }

  // 5. Temporal consistency
  const temporal = calculateTemporalConsistency(
    anchor.issued_at as string | null,
    anchor.expires_at as string | null,
  );
  flags.push(...temporal.flags);

  // 6. AI fraud signals — if extraction returned fraudSignals array, include them
  const fraudSignals = metadata.fraudSignals as string[] | undefined;
  if (Array.isArray(fraudSignals) && fraudSignals.length > 0) {
    flags.push(...fraudSignals.map((s) => `ai_fraud:${s}`));
    details.aiFraudSignals = fraudSignals;
  }

  // Calculate overall (weighted average)
  const weights = {
    metadataCompleteness: 0.25,
    extractionConfidence: 0.20,
    issuerVerification: 0.25,
    duplicateCheck: 0.15,
    temporalConsistency: 0.15,
  };

  const overallScore = Math.round(
    metadataCompleteness * weights.metadataCompleteness +
    extractionConfidence * weights.extractionConfidence +
    issuerVerification * weights.issuerVerification +
    duplicateCheck * weights.duplicateCheck +
    temporal.score * weights.temporalConsistency,
  );

  const level = scoreToLevel(overallScore);

  return {
    overallScore,
    level,
    breakdown: {
      metadataCompleteness,
      extractionConfidence,
      issuerVerification,
      duplicateCheck,
      temporalConsistency: temporal.score,
    },
    flags,
    details,
  };
}

/**
 * Store or update an integrity score in the database.
 * Uses service_role (no RLS insert policy for regular users).
 */
export async function upsertIntegrityScore(
  anchorId: string,
  orgId: string | undefined,
  result: IntegrityResult,
): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).from('integrity_scores').upsert(
      {
        anchor_id: anchorId,
        org_id: orgId ?? null,
        overall_score: result.overallScore,
        level: result.level,
        metadata_completeness: result.breakdown.metadataCompleteness,
        extraction_confidence: result.breakdown.extractionConfidence,
        issuer_verification: result.breakdown.issuerVerification,
        duplicate_check: result.breakdown.duplicateCheck,
        temporal_consistency: result.breakdown.temporalConsistency,
        flags: result.flags,
        details: result.details,
        computed_at: new Date().toISOString(),
      },
      { onConflict: 'anchor_id' },
    );

    if (error) {
      logger.error({ error, anchorId }, 'Failed to upsert integrity score');
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ error: err, anchorId }, 'Failed to upsert integrity score');
    return false;
  }
}

/**
 * Get integrity score for an anchor.
 */
export async function getIntegrityScore(
  anchorId: string,
): Promise<IntegrityScoreRecord | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('integrity_scores')
      .select('*')
      .eq('anchor_id', anchorId)
      .single();

    if (error || !data) return null;

    return {
      id: data.id,
      anchorId: data.anchor_id,
      orgId: data.org_id,
      overallScore: Number(data.overall_score),
      level: data.level,
      metadataCompleteness: Number(data.metadata_completeness),
      extractionConfidence: Number(data.extraction_confidence),
      issuerVerification: Number(data.issuer_verification),
      duplicateCheck: Number(data.duplicate_check),
      temporalConsistency: Number(data.temporal_consistency),
      flags: data.flags ?? [],
      details: data.details ?? {},
      computedAt: data.computed_at,
    };
  } catch (err) {
    logger.error({ error: err, anchorId }, 'Failed to get integrity score');
    return null;
  }
}
