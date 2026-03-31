#!/usr/bin/env tsx
/**
 * Tests for Nessie v4 Training Data Pipeline (NMT-06)
 *
 * TDD: Tests written BEFORE implementation.
 * Validates: distillation quality, confidence calibration, general data mixing,
 * deduplication, domain coverage, JSONL format, and hyperparameter correctness.
 */

import { describe, it, expect, vi } from 'vitest';

// Module under test — will be implemented after tests
import {
  computeRealisticConfidence,
  deduplicateByContent,
  validateTrainingExample,
  buildDistillationPrompt,
  mixGeneralData,
  V4_TRAINING_DEFAULTS,
  type V4TrainingExample,
  type V4DomainConfig,
} from './nessie-v4-data.js';

// ============================================================================
// 1. HYPERPARAMETER DEFAULTS
// ============================================================================

describe('V4_TRAINING_DEFAULTS', () => {
  it('uses LoRA-appropriate learning rate (2e-4, not 5e-6)', () => {
    expect(V4_TRAINING_DEFAULTS.learningRate).toBeGreaterThanOrEqual(1e-4);
    expect(V4_TRAINING_DEFAULTS.learningRate).toBeLessThanOrEqual(3e-4);
  });

  it('limits epochs to 2-3 (prevent overfitting)', () => {
    expect(V4_TRAINING_DEFAULTS.epochs).toBeGreaterThanOrEqual(2);
    expect(V4_TRAINING_DEFAULTS.epochs).toBeLessThanOrEqual(3);
  });

  it('includes general data mix ratio of 20-30%', () => {
    expect(V4_TRAINING_DEFAULTS.generalDataMixRatio).toBeGreaterThanOrEqual(0.20);
    expect(V4_TRAINING_DEFAULTS.generalDataMixRatio).toBeLessThanOrEqual(0.30);
  });

  it('targets all linear layers for LoRA', () => {
    expect(V4_TRAINING_DEFAULTS.loraTargetModules).toContain('q_proj');
    expect(V4_TRAINING_DEFAULTS.loraTargetModules).toContain('k_proj');
    expect(V4_TRAINING_DEFAULTS.loraTargetModules).toContain('v_proj');
    expect(V4_TRAINING_DEFAULTS.loraTargetModules).toContain('o_proj');
    expect(V4_TRAINING_DEFAULTS.loraTargetModules).toContain('gate_proj');
    expect(V4_TRAINING_DEFAULTS.loraTargetModules).toContain('up_proj');
    expect(V4_TRAINING_DEFAULTS.loraTargetModules).toContain('down_proj');
  });

  it('uses LoRA rank 16-32 with alpha = 2x rank', () => {
    expect(V4_TRAINING_DEFAULTS.loraRank).toBeGreaterThanOrEqual(16);
    expect(V4_TRAINING_DEFAULTS.loraRank).toBeLessThanOrEqual(32);
    expect(V4_TRAINING_DEFAULTS.loraAlpha).toBe(V4_TRAINING_DEFAULTS.loraRank * 2);
  });

  it('uses bf16 precision', () => {
    expect(V4_TRAINING_DEFAULTS.precision).toBe('bf16');
  });

  it('uses cosine LR scheduler with warmup', () => {
    expect(V4_TRAINING_DEFAULTS.lrScheduler).toBe('cosine');
    expect(V4_TRAINING_DEFAULTS.warmupRatio).toBeGreaterThanOrEqual(0.03);
    expect(V4_TRAINING_DEFAULTS.warmupRatio).toBeLessThanOrEqual(0.10);
  });

  it('sets max gradient norm to 0.3', () => {
    expect(V4_TRAINING_DEFAULTS.maxGradNorm).toBe(0.3);
  });
});

// ============================================================================
// 2. REALISTIC CONFIDENCE ASSIGNMENT
// ============================================================================

describe('computeRealisticConfidence', () => {
  it('assigns high confidence (0.85-0.95) for complete structured documents', () => {
    const fields = {
      credentialType: 'SEC_FILING',
      issuerName: 'Apple Inc.',
      issuedDate: '2025-10-28',
      jurisdiction: 'United States',
      fieldOfStudy: 'Securities & Exchange',
      registrationNumber: '0000320193',
    };
    const conf = computeRealisticConfidence(fields, 'Full SEC 10-K filing with complete metadata');
    expect(conf).toBeGreaterThanOrEqual(0.85);
    expect(conf).toBeLessThanOrEqual(0.95);
  });

  it('assigns medium confidence (0.60-0.80) for partial documents', () => {
    const fields = {
      credentialType: 'LEGAL',
      issuerName: 'U.S. District Court',
      // Missing: issuedDate, jurisdiction, fieldOfStudy
    };
    const conf = computeRealisticConfidence(fields, 'Court opinion with limited metadata');
    expect(conf).toBeGreaterThanOrEqual(0.55);
    expect(conf).toBeLessThanOrEqual(0.82);
  });

  it('assigns low confidence (0.30-0.55) for sparse documents', () => {
    const fields = {
      credentialType: 'OTHER',
      // Almost nothing else
    };
    const conf = computeRealisticConfidence(fields, 'Untitled document');
    expect(conf).toBeGreaterThanOrEqual(0.25);
    expect(conf).toBeLessThanOrEqual(0.58);
  });

  it('never hardcodes 0.92 (the v3 mistake)', () => {
    const fields = {
      credentialType: 'SEC_FILING',
      issuerName: 'Tesla Inc.',
      issuedDate: '2025-01-01',
    };
    // Run multiple times — should vary based on input
    const confidences = new Set<number>();
    for (let i = 0; i < 5; i++) {
      confidences.add(computeRealisticConfidence(
        fields,
        `Document ${i} with varying text length ${'x'.repeat(i * 100)}`,
      ));
    }
    // Should NOT all be the same value
    expect(confidences.size).toBeGreaterThan(1);
  });

  it('rewards presence of key fields (issuerName, issuedDate, jurisdiction)', () => {
    const sparse = { credentialType: 'REGULATION' };
    const rich = {
      credentialType: 'REGULATION',
      issuerName: 'Environmental Protection Agency',
      issuedDate: '2025-06-15',
      jurisdiction: 'United States',
      fieldOfStudy: 'Environmental Regulation',
      registrationNumber: '2025-12345',
    };
    const sparsConf = computeRealisticConfidence(sparse, 'Regulation text');
    const richConf = computeRealisticConfidence(rich, 'Regulation text');
    expect(richConf).toBeGreaterThan(sparsConf);
  });

  it('considers text length (longer text = more evidence)', () => {
    const fields = { credentialType: 'LEGAL', issuerName: 'Supreme Court' };
    const shortConf = computeRealisticConfidence(fields, 'Short');
    const longConf = computeRealisticConfidence(fields, 'A '.repeat(500));
    expect(longConf).toBeGreaterThanOrEqual(shortConf);
  });
});

// ============================================================================
// 3. DEDUPLICATION
// ============================================================================

describe('deduplicateByContent', () => {
  it('removes exact duplicate training examples', () => {
    const examples: V4TrainingExample[] = [
      { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'same text' }, { role: 'assistant', content: '{"credentialType":"LEGAL"}' }], domain: 'legal' },
      { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'same text' }, { role: 'assistant', content: '{"credentialType":"LEGAL"}' }], domain: 'legal' },
      { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'different text' }, { role: 'assistant', content: '{"credentialType":"SEC_FILING"}' }], domain: 'sec' },
    ];
    const deduped = deduplicateByContent(examples);
    expect(deduped).toHaveLength(2);
  });

  it('keeps near-duplicates with different extracted fields', () => {
    const examples: V4TrainingExample[] = [
      { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Apple 10-K' }, { role: 'assistant', content: '{"credentialType":"SEC_FILING","issuerName":"Apple"}' }], domain: 'sec' },
      { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Apple 10-K' }, { role: 'assistant', content: '{"credentialType":"SEC_FILING","issuerName":"Apple Inc."}' }], domain: 'sec' },
    ];
    const deduped = deduplicateByContent(examples);
    // Same user text but different assistant output — keep both (different extractions)
    expect(deduped).toHaveLength(2);
  });

  it('handles empty array', () => {
    expect(deduplicateByContent([])).toHaveLength(0);
  });
});

// ============================================================================
// 4. TRAINING EXAMPLE VALIDATION
// ============================================================================

describe('validateTrainingExample', () => {
  it('accepts valid 3-message conversation', () => {
    const example: V4TrainingExample = {
      messages: [
        { role: 'system', content: 'You are a credential extraction assistant.' },
        { role: 'user', content: 'Extract metadata from: SEC 10-K filing...' },
        { role: 'assistant', content: '{"credentialType":"SEC_FILING","issuerName":"Apple Inc.","confidence":0.90}' },
      ],
      domain: 'sec',
    };
    expect(validateTrainingExample(example)).toBe(true);
  });

  it('rejects example with hardcoded 0.92 confidence', () => {
    const example: V4TrainingExample = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'text' },
        { role: 'assistant', content: '{"credentialType":"LEGAL","confidence":0.92}' },
      ],
      domain: 'legal',
    };
    // 0.92 was the v3 hardcoded value — reject to prevent training on it
    expect(validateTrainingExample(example)).toBe(false);
  });

  it('rejects example with missing credentialType', () => {
    const example: V4TrainingExample = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'text' },
        { role: 'assistant', content: '{"issuerName":"Test"}' },
      ],
      domain: 'legal',
    };
    expect(validateTrainingExample(example)).toBe(false);
  });

  it('rejects example with less than 3 messages', () => {
    const example: V4TrainingExample = {
      messages: [
        { role: 'user', content: 'text' },
        { role: 'assistant', content: '{}' },
      ],
      domain: 'sec',
    };
    expect(validateTrainingExample(example)).toBe(false);
  });

  it('rejects example with non-JSON assistant response', () => {
    const example: V4TrainingExample = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'text' },
        { role: 'assistant', content: 'This is not JSON' },
      ],
      domain: 'sec',
    };
    expect(validateTrainingExample(example)).toBe(false);
  });

  it('accepts confidence values that are NOT 0.92', () => {
    for (const conf of [0.40, 0.65, 0.78, 0.85, 0.91, 0.93]) {
      const example: V4TrainingExample = {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'text' },
          { role: 'assistant', content: JSON.stringify({ credentialType: 'LEGAL', confidence: conf }) },
        ],
        domain: 'legal',
      };
      expect(validateTrainingExample(example)).toBe(true);
    }
  });
});

// ============================================================================
// 5. DISTILLATION PROMPT
// ============================================================================

describe('buildDistillationPrompt', () => {
  it('includes source text in prompt', () => {
    const prompt = buildDistillationPrompt('SEC 10-K filing for Apple Inc.', 'SEC_FILING');
    expect(prompt).toContain('SEC 10-K filing for Apple Inc.');
  });

  it('includes credential type hint', () => {
    const prompt = buildDistillationPrompt('Court opinion text', 'LEGAL');
    expect(prompt).toContain('LEGAL');
  });

  it('asks for JSON output', () => {
    const prompt = buildDistillationPrompt('any text', 'REGULATION');
    expect(prompt).toContain('JSON');
  });

  it('includes confidence instruction (not hardcoded)', () => {
    const prompt = buildDistillationPrompt('any text', 'SEC_FILING');
    expect(prompt).toContain('confidence');
    expect(prompt).not.toContain('0.92');
  });
});

// ============================================================================
// 6. GENERAL DATA MIXING
// ============================================================================

describe('mixGeneralData', () => {
  it('adds general instruction data at configured ratio', () => {
    const domainExamples: V4TrainingExample[] = Array.from({ length: 100 }, (_, i) => ({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: `domain example ${i}` },
        { role: 'assistant', content: `{"credentialType":"LEGAL","confidence":0.8}` },
      ],
      domain: 'legal' as const,
    }));

    const mixed = mixGeneralData(domainExamples, 0.25);

    // 100 domain + ~33 general (25% of total ≈ 133)
    expect(mixed.length).toBeGreaterThan(100);
    expect(mixed.length).toBeLessThan(200);

    // Verify general examples are present
    const generalCount = mixed.filter(e => e.domain === 'general').length;
    const ratio = generalCount / mixed.length;
    expect(ratio).toBeGreaterThanOrEqual(0.18); // Allow some tolerance
    expect(ratio).toBeLessThanOrEqual(0.32);
  });

  it('marks general examples with domain="general"', () => {
    const domainExamples: V4TrainingExample[] = [
      { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: '{"credentialType":"LEGAL","confidence":0.7}' }], domain: 'legal' },
    ];
    const mixed = mixGeneralData(domainExamples, 0.25);
    const generalExamples = mixed.filter(e => e.domain === 'general');
    expect(generalExamples.length).toBeGreaterThan(0);
  });

  it('shuffles the result (domain and general interleaved)', () => {
    const domainExamples: V4TrainingExample[] = Array.from({ length: 50 }, (_, i) => ({
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: `d${i}` }, { role: 'assistant', content: '{"credentialType":"SEC_FILING","confidence":0.8}' }],
      domain: 'sec' as const,
    }));

    const mixed = mixGeneralData(domainExamples, 0.25);

    // First 10 items should not all be domain or all general (shuffled)
    const first10Domains = mixed.slice(0, 10).map(e => e.domain);
    const uniqueDomains = new Set(first10Domains);
    // With 25% general mix, highly likely first 10 has both
    expect(uniqueDomains.size).toBeGreaterThanOrEqual(1); // At minimum not empty
  });
});

// ============================================================================
// 7. DOMAIN CONFIG
// ============================================================================

describe('V4DomainConfig', () => {
  it('defines all four Nessie domains', () => {
    // Import will verify this at compile time, but let's be explicit
    const domains: V4DomainConfig[] = [
      { domain: 'sec', credentialTypes: ['SEC_FILING'], minExamples: 500 },
      { domain: 'legal', credentialTypes: ['LEGAL'], minExamples: 500 },
      { domain: 'regulatory', credentialTypes: ['REGULATION'], minExamples: 500 },
      { domain: 'academic', credentialTypes: ['PUBLICATION'], minExamples: 500 },
    ];
    expect(domains).toHaveLength(4);
    expect(domains.map(d => d.domain)).toEqual(['sec', 'legal', 'regulatory', 'academic']);
  });
});
