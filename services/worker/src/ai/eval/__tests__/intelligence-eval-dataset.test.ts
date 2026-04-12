/**
 * NCE-05 Intelligence Eval Dataset Tests
 *
 * Validates the 100-entry evaluation dataset structure, coverage, and quality.
 */

import { describe, it, expect } from 'vitest';
import {
  INTELLIGENCE_EVAL_DATASET_V2,
  getEntriesByDomain,
  getEntriesByTaskType,
  getDatasetStats,
} from '../intelligence-eval-dataset.js';

describe('NCE-05: Intelligence Evaluation Dataset', () => {
  it('has exactly 100 entries', () => {
    expect(INTELLIGENCE_EVAL_DATASET_V2.length).toBe(100);
  });

  it('has 20 entries per domain', () => {
    const stats = getDatasetStats();
    expect(stats.byDomain['sec_financial']).toBe(20);
    expect(stats.byDomain['legal_court']).toBe(20);
    expect(stats.byDomain['regulatory']).toBe(20);
    expect(stats.byDomain['patent_ip']).toBe(20);
    expect(stats.byDomain['employment_screening']).toBe(20);
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
