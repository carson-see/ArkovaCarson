/**
 * NCE-05 Intelligence Eval Dataset Tests
 *
 * Validates the evaluation dataset structure, coverage, and quality.
 * Baseline = 100 core entries (5 domains × 20) + KAU-06 jurisdiction
 * procedures (Kenya + Australia NDB, SCRUM-754).
 */

import { describe, it, expect } from 'vitest';
import {
  INTELLIGENCE_EVAL_DATASET_V2,
  getEntriesByDomain,
  getEntriesByTaskType,
  getDatasetStats,
} from '../intelligence-eval-dataset.js';

const CORE_DOMAINS = ['sec_financial', 'legal_court', 'regulatory', 'patent_ip', 'employment_screening'] as const;
const CORE_ENTRIES_PER_DOMAIN = 20;
const CORE_ENTRY_COUNT = CORE_DOMAINS.length * CORE_ENTRIES_PER_DOMAIN;

describe('NCE-05: Intelligence Evaluation Dataset', () => {
  it(`has at least ${CORE_ENTRY_COUNT} core entries`, () => {
    expect(INTELLIGENCE_EVAL_DATASET_V2.length).toBeGreaterThanOrEqual(CORE_ENTRY_COUNT);
  });

  it(`has ${CORE_ENTRIES_PER_DOMAIN} entries per core domain`, () => {
    const stats = getDatasetStats();
    for (const domain of CORE_DOMAINS) {
      expect(stats.byDomain[domain]).toBe(CORE_ENTRIES_PER_DOMAIN);
    }
  });

  it('covers KAU-06 jurisdictions (Kenya + Australia NDB procedures)', () => {
    const stats = getDatasetStats();
    expect(stats.byDomain['kenya_ndb_procedures']).toBeGreaterThan(0);
    expect(stats.byDomain['australia_ndb_procedures']).toBeGreaterThan(0);
  });

  it('covers all 5 task types', () => {
    const stats = getDatasetStats();
    expect(Object.keys(stats.byTaskType)).toContain('compliance_qa');
    expect(Object.keys(stats.byTaskType)).toContain('risk_analysis');
    expect(Object.keys(stats.byTaskType)).toContain('document_summary');
    expect(Object.keys(stats.byTaskType)).toContain('recommendation');
    expect(Object.keys(stats.byTaskType)).toContain('cross_reference');
  });

  it('has all required fields on every entry', () => {
    for (const entry of INTELLIGENCE_EVAL_DATASET_V2) {
      expect(entry.id).toBeTruthy();
      expect(entry.taskType).toBeTruthy();
      expect(entry.domain).toBeTruthy();
      expect(entry.query).toBeTruthy();
      expect(entry.contextDocIds.length).toBeGreaterThan(0);
      expect(entry.expectedKeyPoints.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.expectedRisks)).toBe(true);
      expect(entry.expectedCitations.length).toBeGreaterThan(0);
      expect(entry.minConfidence).toBeGreaterThanOrEqual(0);
      expect(entry.minConfidence).toBeLessThanOrEqual(1);
    }
  });

  it('has unique IDs across all entries', () => {
    const ids = INTELLIGENCE_EVAL_DATASET_V2.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('risk_analysis entries have expected risks', () => {
    const riskEntries = getEntriesByTaskType('risk_analysis');
    expect(riskEntries.length).toBeGreaterThan(0);
    for (const entry of riskEntries) {
      expect(entry.expectedRisks.length).toBeGreaterThan(0);
    }
  });

  it('cross_reference entries have multiple context docs', () => {
    const crossRefEntries = getEntriesByTaskType('cross_reference');
    expect(crossRefEntries.length).toBeGreaterThan(0);
    // At least some cross-ref entries should reference multiple docs
    const multiDocEntries = crossRefEntries.filter((e) => e.contextDocIds.length > 1);
    expect(multiDocEntries.length).toBeGreaterThan(0);
  });

  it('getEntriesByDomain filters correctly', () => {
    const sec = getEntriesByDomain('sec_financial');
    expect(sec.length).toBe(20);
    expect(sec.every((e) => e.domain === 'sec_financial')).toBe(true);
  });

  it('getEntriesByTaskType filters correctly', () => {
    const qa = getEntriesByTaskType('compliance_qa');
    expect(qa.length).toBeGreaterThan(0);
    expect(qa.every((e) => e.taskType === 'compliance_qa')).toBe(true);
  });

  it('confidence thresholds are reasonable', () => {
    for (const entry of INTELLIGENCE_EVAL_DATASET_V2) {
      expect(entry.minConfidence).toBeGreaterThanOrEqual(0.60);
      expect(entry.minConfidence).toBeLessThanOrEqual(0.90);
    }
  });
});
