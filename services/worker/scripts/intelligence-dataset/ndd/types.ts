/**
 * NDD (Nessie Domain Depth) — shared types.
 *
 * 10 NDD stories (SCRUM-780..789) each target a specific regulatory
 * regime at enforcement-decision level. Every story follows the same
 * pattern:
 *   1. An anchored source registry (`NddJurisdictionSources`) — statutes,
 *      enforcement bulletins, case citations.
 *   2. An enforcement-level index (`EnforcementTier`) — penalty magnitudes
 *      and severity markers used to populate confidence bands.
 *   3. Retrieval expectations (`NddRetrievalExpectation`) — query-level
 *      "must cite any of these sources" tests for the RAG harness.
 *
 * No LLM calls. No tuning submissions. Scaffolding only while the NVI
 * gate is active (see CLAUDE.md §0).
 */

import type { IntelligenceSource } from '../types.js';

/**
 * Canonical identifier for each NDD story. These map 1:1 to the Jira
 * ticket keys so the eval report can group by story.
 */
export type NddStoryId =
  | 'ndd-01-ny'
  | 'ndd-02-ca'
  | 'ndd-03-hipaa-ocr'
  | 'ndd-04-sox-pcaob'
  | 'ndd-05-ferpa'
  | 'ndd-06-fcra-employment'
  | 'ndd-07-kenya-odpc'
  | 'ndd-08-australia-app'
  | 'ndd-09-gdpr-dpa'
  | 'ndd-10-nigeria-sa';

/**
 * Penalty/severity tier. Ordered from CIVIL at the bottom to CRIMINAL at
 * the top. The model should emit `tier` alongside its risk analysis.
 */
export type EnforcementTier =
  | 'ADVISORY'
  | 'CIVIL_MINOR'
  | 'CIVIL_MAJOR'
  | 'CIVIL_MAX'
  | 'CRIMINAL';

export interface NddEnforcementRule {
  /** Short label — "HIPAA Tier 4 willful neglect, uncorrected". */
  name: string;
  tier: EnforcementTier;
  /** Ordered list of anchored source ids backing the rule. */
  anchorSources: string[];
  /** Penalty text (ranges, per-violation caps, annual caps). */
  penalty: string;
  /** Confidence band the model should emit when this tier applies. */
  confidenceBand: 'clear-statute' | 'common-interpretation' | 'grey-area';
}

export interface NddJurisdictionPack {
  /** Jira story id — drives grouping in reports. */
  storyId: NddStoryId;
  /** Display name. */
  name: string;
  /** ISO-3166 or 'federal-us' / 'federal-eu' label. */
  scope: string;
  /** Sources anchored to this regime. */
  sources: IntelligenceSource[];
  /** Enforcement ladder from ADVISORY → CRIMINAL. */
  enforcementRules: NddEnforcementRule[];
  /** RAG retrieval expectations. */
  retrievalTests: NddRetrievalExpectation[];
}

export interface NddRetrievalExpectation {
  query: string;
  /** At least one of these source ids must appear in the model's citations. */
  mustCiteAnyOf: string[];
  /** Optional — the `EnforcementTier` the model should surface. */
  expectedTier?: EnforcementTier;
}
