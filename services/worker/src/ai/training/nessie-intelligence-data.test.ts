/**
 * Tests for Nessie Intelligence Training Data (NMT-07)
 */

import { describe, it, expect } from 'vitest';
import {
  SEED_INTELLIGENCE_PAIRS,
  NESSIE_INTELLIGENCE_SYSTEM_PROMPT,
  TASK_PROMPTS,
  qaPairToTrainingExample,
  buildTrainingContext,
  deduplicateExamples,
  validateExample,
  getDistributionStats,
} from './nessie-intelligence-data.js';

describe('nessie-intelligence-data', () => {
  describe('NESSIE_INTELLIGENCE_SYSTEM_PROMPT', () => {
    it('defines Nessie as a compliance intelligence engine, not extraction', () => {
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('compliance intelligence engine');
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('actionable');
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).not.toContain('Extract structured metadata');
    });

    it('requires verified citations', () => {
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('[record_id]');
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('Never fabricate sources');
    });

    it('defines confidence scale', () => {
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('0.85-1.0');
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('0.0-0.39');
    });
  });

  describe('TASK_PROMPTS', () => {
    it('covers all 5 intelligence task types', () => {
      expect(Object.keys(TASK_PROMPTS)).toHaveLength(5);
      expect(TASK_PROMPTS.compliance_qa).toBeDefined();
      expect(TASK_PROMPTS.risk_analysis).toBeDefined();
      expect(TASK_PROMPTS.document_summary).toBeDefined();
      expect(TASK_PROMPTS.recommendation).toBeDefined();
      expect(TASK_PROMPTS.cross_reference).toBeDefined();
    });

    it('risk_analysis prompt mentions severity ranking', () => {
      expect(TASK_PROMPTS.risk_analysis).toContain('HIGH/MEDIUM/LOW');
    });
  });

  describe('SEED_INTELLIGENCE_PAIRS', () => {
    it('has at least 5 seed pairs', () => {
      expect(SEED_INTELLIGENCE_PAIRS.length).toBeGreaterThanOrEqual(5);
    });

    it('covers all task types', () => {
      const types = new Set(SEED_INTELLIGENCE_PAIRS.map((p) => p.taskType));
      expect(types.has('compliance_qa')).toBe(true);
      expect(types.has('risk_analysis')).toBe(true);
      expect(types.has('document_summary')).toBe(true);
      expect(types.has('recommendation')).toBe(true);
      expect(types.has('cross_reference')).toBe(true);
    });

    it('each pair has citations referencing context documents', () => {
      for (const pair of SEED_INTELLIGENCE_PAIRS) {
        expect(pair.citations.length).toBeGreaterThan(0);
        const contextIds = new Set(pair.context.map((c) => c.record_id));
        for (const citation of pair.citations) {
          expect(contextIds.has(citation.record_id)).toBe(true);
        }
      }
    });

    it('each pair has confidence in valid range', () => {
      for (const pair of SEED_INTELLIGENCE_PAIRS) {
        expect(pair.confidence).toBeGreaterThanOrEqual(0);
        expect(pair.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('has unique IDs', () => {
      const ids = SEED_INTELLIGENCE_PAIRS.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('buildTrainingContext', () => {
    it('formats documents matching nessie-query.ts RAG format', () => {
      const docs = [{
        record_id: 'TEST-001',
        source: 'edgar',
        title: 'Test Filing',
        record_type: 'sec_filing',
        content: 'Test content here',
        content_hash: 'abc123',
      }];
      const result = buildTrainingContext(docs);
      expect(result).toContain('DOCUMENT 1');
      expect(result).toContain('record_id: TEST-001');
      expect(result).toContain('source: edgar');
      expect(result).toContain('content_hash: abc123');
    });

    it('handles multiple documents', () => {
      const docs = [
        { record_id: 'A', source: 'edgar', title: 'Doc A', record_type: 'sec_filing', content: 'AAA', content_hash: '111' },
        { record_id: 'B', source: 'uspto', title: 'Doc B', record_type: 'patent', content: 'BBB', content_hash: '222' },
      ];
      const result = buildTrainingContext(docs);
      expect(result).toContain('DOCUMENT 1');
      expect(result).toContain('DOCUMENT 2');
      expect(result).toContain('record_id: A');
      expect(result).toContain('record_id: B');
    });
  });

  describe('qaPairToTrainingExample', () => {
    it('produces valid 3-message training example', () => {
      const example = qaPairToTrainingExample(SEED_INTELLIGENCE_PAIRS[0]);
      expect(example.messages).toHaveLength(3);
      expect(example.messages[0].role).toBe('system');
      expect(example.messages[1].role).toBe('user');
      expect(example.messages[2].role).toBe('assistant');
    });

    it('system prompt includes task-specific addition', () => {
      const example = qaPairToTrainingExample(SEED_INTELLIGENCE_PAIRS[0]);
      expect(example.messages[0].content).toContain('compliance intelligence engine');
      // compliance_qa task prompt
      expect(example.messages[0].content).toContain('compliance question');
    });

    it('user message includes RAG context', () => {
      const example = qaPairToTrainingExample(SEED_INTELLIGENCE_PAIRS[0]);
      expect(example.messages[1].content).toContain('VERIFIED DOCUMENTS');
      expect(example.messages[1].content).toContain('record_id:');
    });

    it('assistant response is valid JSON with required fields', () => {
      const example = qaPairToTrainingExample(SEED_INTELLIGENCE_PAIRS[0]);
      const parsed = JSON.parse(example.messages[2].content);
      expect(parsed.analysis).toBeDefined();
      expect(Array.isArray(parsed.citations)).toBe(true);
      expect(typeof parsed.confidence).toBe('number');
    });

    it('preserves task type and domain', () => {
      const pair = SEED_INTELLIGENCE_PAIRS[1]; // risk_analysis
      const example = qaPairToTrainingExample(pair);
      expect(example.taskType).toBe('risk_analysis');
      expect(example.domain).toBe('education');
    });
  });

  describe('validateExample', () => {
    it('returns null for valid examples', () => {
      for (const pair of SEED_INTELLIGENCE_PAIRS) {
        const example = qaPairToTrainingExample(pair);
        expect(validateExample(example)).toBeNull();
      }
    });

    it('rejects wrong message count', () => {
      const bad = {
        messages: [{ role: 'user' as const, content: 'hi' }],
        taskType: 'compliance_qa' as const,
        domain: 'sec',
      };
      expect(validateExample(bad)).toContain('3 messages');
    });

    it('rejects invalid JSON in assistant response', () => {
      const bad = {
        messages: [
          { role: 'system' as const, content: 'sys' },
          { role: 'user' as const, content: 'q' },
          { role: 'assistant' as const, content: 'not json' },
        ],
        taskType: 'compliance_qa' as const,
        domain: 'sec',
      };
      expect(validateExample(bad)).toContain('not valid JSON');
    });

    it('rejects assistant response missing analysis field', () => {
      const bad = {
        messages: [
          { role: 'system' as const, content: 'sys' },
          { role: 'user' as const, content: 'q' },
          { role: 'assistant' as const, content: JSON.stringify({ citations: [], confidence: 0.5 }) },
        ],
        taskType: 'compliance_qa' as const,
        domain: 'sec',
      };
      expect(validateExample(bad)).toContain('analysis');
    });
  });

  describe('deduplicateExamples', () => {
    it('removes duplicates by user message content', () => {
      const example = qaPairToTrainingExample(SEED_INTELLIGENCE_PAIRS[0]);
      const duped = [example, { ...example }, example];
      const result = deduplicateExamples(duped);
      expect(result).toHaveLength(1);
    });

    it('preserves unique examples', () => {
      const examples = SEED_INTELLIGENCE_PAIRS.map(qaPairToTrainingExample);
      const result = deduplicateExamples(examples);
      expect(result).toHaveLength(examples.length);
    });
  });

  describe('getDistributionStats', () => {
    it('returns stats by task type and domain', () => {
      const examples = SEED_INTELLIGENCE_PAIRS.map(qaPairToTrainingExample);
      const stats = getDistributionStats(examples);
      expect(stats.compliance_qa).toBeDefined();
      expect(stats.compliance_qa.count).toBe(1);
      expect(stats.risk_analysis.count).toBe(1);
      expect(stats.risk_analysis.domains.education).toBe(1);
    });
  });
});
