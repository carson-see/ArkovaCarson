/**
 * NDD — retrieval-accuracy scorer.
 *
 * Takes the model's citations + emitted tier and returns a deterministic
 * pass/fail breakdown against the registered retrieval expectations.
 * Pure function — safe for CI and unit tests.
 */

import type { EnforcementTier, NddJurisdictionPack, NddStoryId, NddRetrievalExpectation } from './types.js';
import { NDD_SOURCES_BY_STORY } from './sources.js';
import { NDD_ENFORCEMENT_LADDERS } from './enforcement.js';
import { NDD_RETRIEVAL_TESTS } from './retrieval-tests.js';

export interface NddCandidateAnswer {
  /** Retrieval query the candidate answered. */
  query: string;
  /** Source ids the model cited in its answer. */
  citedSourceIds: string[];
  /** Optional — tier the model emitted for risk analysis. */
  emittedTier?: EnforcementTier;
}

export interface NddPerQueryResult {
  query: string;
  citationHit: boolean;
  tierOk: boolean;
  reasons: string[];
}

export interface NddStoryReport {
  storyId: NddStoryId;
  totalQueries: number;
  citationHitRate: number;
  tierAccuracy: number;
  perQuery: NddPerQueryResult[];
}

/**
 * NDD-wide target: each story should hit ≥85% citation retrieval and
 * ≥80% tier accuracy before being considered deploy-ready. Matches the
 * NTF-03 compliance-Q&A target band so reports stay comparable.
 */
export const NDD_CITATION_TARGET = 0.85;
export const NDD_TIER_TARGET = 0.8;

/**
 * Assemble a full `NddJurisdictionPack` from the three per-story maps.
 * Use this to build eval dashboards or train-set manifests.
 */
export function getNddPack(storyId: NddStoryId, name: string, scope: string): NddJurisdictionPack {
  return {
    storyId,
    name,
    scope,
    sources: NDD_SOURCES_BY_STORY[storyId],
    enforcementRules: NDD_ENFORCEMENT_LADDERS[storyId],
    retrievalTests: NDD_RETRIEVAL_TESTS[storyId],
  };
}

export function scoreNddStory(storyId: NddStoryId, candidates: NddCandidateAnswer[]): NddStoryReport {
  const expectations = NDD_RETRIEVAL_TESTS[storyId];
  const byQuery = new Map<string, NddCandidateAnswer>();
  for (const c of candidates) byQuery.set(c.query, c);

  const perQuery: NddPerQueryResult[] = expectations.map((e) => scoreExpectation(e, byQuery.get(e.query)));
  const citationHits = perQuery.filter((p) => p.citationHit).length;
  const tierChecks = perQuery.filter((p) => expectations.find((e) => e.query === p.query)?.expectedTier !== undefined);
  const tierHits = tierChecks.filter((p) => p.tierOk).length;

  return {
    storyId,
    totalQueries: perQuery.length,
    citationHitRate: perQuery.length === 0 ? 0 : citationHits / perQuery.length,
    tierAccuracy: tierChecks.length === 0 ? 1 : tierHits / tierChecks.length,
    perQuery,
  };
}

function scoreExpectation(e: NddRetrievalExpectation, candidate: NddCandidateAnswer | undefined): NddPerQueryResult {
  const reasons: string[] = [];
  if (!candidate) {
    reasons.push('no candidate answer provided');
    return { query: e.query, citationHit: false, tierOk: false, reasons };
  }
  const citationHit = e.mustCiteAnyOf.some((id) => candidate.citedSourceIds.includes(id));
  if (!citationHit) reasons.push(`missing citation; expected any of ${e.mustCiteAnyOf.join(', ')}`);
  const tierOk = e.expectedTier === undefined || candidate.emittedTier === e.expectedTier;
  if (!tierOk) reasons.push(`tier mismatch; expected ${e.expectedTier}, got ${candidate.emittedTier ?? '(none)'}`);
  return { query: e.query, citationHit, tierOk, reasons };
}

/**
 * Validate the NDD dataset as a whole: every retrieval test must
 * reference sources registered in the matching story's pack, every
 * enforcement rule must anchor to registered sources, source ids are
 * unique within a story, and every story has ≥1 retrieval test.
 */
export function validateNddRegistry(): string[] {
  const errs: string[] = [];
  for (const [storyId, sources] of Object.entries(NDD_SOURCES_BY_STORY) as Array<[NddStoryId, typeof NDD_SOURCES_BY_STORY[NddStoryId]]>) {
    const ids = new Set<string>();
    for (const s of sources) {
      if (ids.has(s.id)) errs.push(`${storyId}: duplicate source id ${s.id}`);
      ids.add(s.id);
    }
    for (const rule of NDD_ENFORCEMENT_LADDERS[storyId]) {
      for (const anchor of rule.anchorSources) {
        if (!ids.has(anchor)) errs.push(`${storyId} rule "${rule.name}" anchors to missing source ${anchor}`);
      }
    }
    const tests = NDD_RETRIEVAL_TESTS[storyId];
    if (tests.length === 0) errs.push(`${storyId}: no retrieval tests defined`);
    for (const t of tests) {
      for (const anchor of t.mustCiteAnyOf) {
        if (!ids.has(anchor)) errs.push(`${storyId} test "${t.query}" cites missing source ${anchor}`);
      }
    }
  }
  return errs;
}
