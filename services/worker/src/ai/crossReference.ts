/**
 * GRE-04: Cross-Reference Verification
 *
 * Before Gemini extracts a credential, check if the claimed issuer
 * exists in our pipeline databases. This context is injected into
 * the extraction prompt so Gemini can make informed decisions.
 *
 * Example: "This document claims to be from University of Michigan.
 * Our DAPIP database confirms this institution is accredited (UNITID: 170976)."
 *
 * Sources checked:
 * - DAPIP (accredited institutions)
 * - IPEDS (education institutions)
 * - NPI (healthcare providers)
 * - FINRA (broker/dealers)
 * - CalBar (California attorneys)
 * - ACNC (Australian charities)
 *
 * Constitution 1.6: Only metadata is used — no document content leaves the device.
 */

import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface CrossReferenceResult {
  issuerFound: boolean;
  matches: CrossReferenceMatch[];
  context: string; // Human-readable summary for prompt injection
}

export interface CrossReferenceMatch {
  source: string;
  sourceId: string;
  title: string;
  confidence: 'exact' | 'partial' | 'fuzzy';
  metadata: Record<string, unknown>;
}

/**
 * Search pipeline databases for an issuer name.
 * Returns matches and a human-readable context string for prompt injection.
 *
 * Designed for <500ms latency — uses a single ilike query with limit.
 */
export async function crossReferenceIssuer(
  supabase: SupabaseClient,
  issuerName: string,
): Promise<CrossReferenceResult> {
  if (!issuerName || issuerName.length < 3) {
    return { issuerFound: false, matches: [], context: '' };
  }

  const cleanName = issuerName.trim().replace(/[[\]]/g, '');
  if (cleanName.length < 3) {
    return { issuerFound: false, matches: [], context: '' };
  }

  try {
    // Single query: search public_records by title (ilike) across all pipeline sources
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: records, error } = await (supabase as any)
      .from('public_records')
      .select('source, source_id, title, metadata')
      .ilike('title', `%${cleanName}%`)
      .in('source', [
        'dapip', 'ipeds', 'npi', 'finra', 'calbar', 'acnc',
        'edgar', 'sec_iapd', 'fcc', 'sam_gov',
      ])
      .limit(5);

    if (error || !records || records.length === 0) {
      return {
        issuerFound: false,
        matches: [],
        context: `Issuer "${cleanName}" was NOT found in Arkova's verified databases (DAPIP, IPEDS, NPI, FINRA, CalBar, ACNC). This does not mean the issuer is illegitimate — it may be a small or regional institution not yet in our pipeline.`,
      };
    }

    const matches: CrossReferenceMatch[] = records.map(
      (r: { source: string; source_id: string; title: string; metadata: Record<string, unknown> }) => ({
        source: r.source,
        sourceId: r.source_id,
        title: r.title,
        confidence: r.title.toLowerCase() === cleanName.toLowerCase() ? 'exact' as const : 'partial' as const,
        metadata: r.metadata ?? {},
      }),
    );

    const sourceNames = [...new Set(matches.map((m) => m.source))].join(', ');
    const bestMatch = matches[0];

    const context = `Issuer "${cleanName}" was FOUND in Arkova's verified databases. ${matches.length} match(es) across: ${sourceNames}. Best match: "${bestMatch.title}" (source: ${bestMatch.source}, ID: ${bestMatch.sourceId}). This increases confidence that the credential is from a legitimate institution.`;

    return { issuerFound: true, matches, context };
  } catch (err) {
    logger.warn({ issuerName: cleanName, error: err }, 'Cross-reference lookup failed — proceeding without verification');
    return { issuerFound: false, matches: [], context: '' };
  }
}
