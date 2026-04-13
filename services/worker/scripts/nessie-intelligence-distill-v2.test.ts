/**
 * Tests for Nessie Intelligence Distillation Pipeline v2 (NMT-11 / SCRUM-674)
 *
 * Verifies distillation pipeline logic: template coverage, context generation,
 * validation, deduplication, and export format.
 */

import { describe, it, expect } from 'vitest';
import {
  type IntelligenceTaskType,
  type IntelligenceTrainingExample,
  type IntelligenceQAPair,
  type IntelligenceContext,
  NESSIE_INTELLIGENCE_SYSTEM_PROMPT,
  TASK_PROMPTS,
  qaPairToTrainingExample,
  deduplicateExamples,
  validateExample,
  getDistributionStats,
  SEED_INTELLIGENCE_PAIRS,
} from '../src/ai/training/nessie-intelligence-data.js';

const ALL_TASK_TYPES: IntelligenceTaskType[] = [
  'compliance_qa', 'risk_analysis', 'document_summary', 'recommendation', 'cross_reference',
];

describe('nessie-intelligence-distill-v2 (NMT-11)', () => {
  describe('task type coverage', () => {
    it('should have prompts for all 5 intelligence task types', () => {
      for (const type of ALL_TASK_TYPES) {
        expect(TASK_PROMPTS[type]).toBeDefined();
        expect(TASK_PROMPTS[type].length).toBeGreaterThan(0);
      }
    });

    it('should have seed pairs covering all task types', () => {
      const coveredTypes = new Set(SEED_INTELLIGENCE_PAIRS.map(p => p.taskType));
      for (const type of ALL_TASK_TYPES) {
        expect(coveredTypes.has(type)).toBe(true);
      }
    });
  });

  describe('system prompt', () => {
    it('should include citation requirement', () => {
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('cite');
    });

    it('should include confidence levels', () => {
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('0.85-1.0');
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('0.65-0.84');
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('0.40-0.64');
    });

    it('should include source authority ranking', () => {
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('SEC EDGAR');
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('Federal Register');
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('CourtListener');
    });

    it('should require JSON response format', () => {
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('JSON');
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('analysis');
      expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toContain('citations');
    });
  });

  describe('qaPairToTrainingExample', () => {
    const mockContext: IntelligenceContext = {
      record_id: 'PR-EDG-0001',
      source: 'edgar',
      title: 'Test Filing',
      record_type: 'sec_filing',
      content: 'Test content',
      content_hash: 'abc123',
    };

    const mockPair: IntelligenceQAPair = {
      id: 'TEST-001',
      taskType: 'compliance_qa',
      domain: 'sec',
      question: 'Is this compliant?',
      context: [mockContext],
      answer: 'Based on [PR-EDG-0001], yes.',
      citations: [{ record_id: 'PR-EDG-0001', excerpt: 'Test content' }],
      confidence: 0.85,
    };

    it('should convert QA pair to training example with 3 messages', () => {
      const example = qaPairToTrainingExample(mockPair);
      expect(example.messages).toHaveLength(3);
      expect(example.messages[0].role).toBe('system');
      expect(example.messages[1].role).toBe('user');
      expect(example.messages[2].role).toBe('assistant');
    });

    it('should preserve task type', () => {
      const example = qaPairToTrainingExample(mockPair);
      expect(example.taskType).toBe('compliance_qa');
    });

    it('should preserve domain', () => {
      const example = qaPairToTrainingExample(mockPair);
      expect(example.domain).toBe('sec');
    });

    it('should include question in user message', () => {
      const example = qaPairToTrainingExample(mockPair);
      expect(example.messages[1].content).toContain('Is this compliant?');
    });

    it('should include context documents in user message', () => {
      const example = qaPairToTrainingExample(mockPair);
      expect(example.messages[1].content).toContain('PR-EDG-0001');
    });
  });

  describe('validateExample', () => {
    function makeValidExample(): IntelligenceTrainingExample {
      return {
        messages: [
          { role: 'system', content: 'System prompt here with enough content to be meaningful.' },
          { role: 'user', content: 'A user question with enough content to be meaningful.' },
          { role: 'assistant', content: JSON.stringify({
            analysis: 'Based on [PR-001], the entity is in compliance.',
            citations: [{ record_id: 'PR-001', excerpt: 'Compliant status confirmed.' }],
            risks: [],
            recommendations: ['Continue monitoring.'],
            confidence: 0.85,
            gaps: [],
          }) },
        ],
        taskType: 'compliance_qa',
        domain: 'sec',
      };
    }

    it('should accept valid example', () => {
      const error = validateExample(makeValidExample());
      expect(error).toBeNull();
    });

    it('should reject example with missing messages', () => {
      const example = makeValidExample();
      example.messages = [];
      const error = validateExample(example);
      expect(error).not.toBeNull();
    });

    it('should reject example with empty assistant response', () => {
      const example = makeValidExample();
      example.messages[2].content = '';
      const error = validateExample(example);
      expect(error).not.toBeNull();
    });
  });

  describe('deduplicateExamples', () => {
    it('should remove duplicate examples', () => {
      const example: IntelligenceTrainingExample = {
        messages: [
          { role: 'system', content: 'prompt' },
          { role: 'user', content: 'same question' },
          { role: 'assistant', content: 'response' },
        ],
        taskType: 'compliance_qa',
        domain: 'sec',
      };
      const deduped = deduplicateExamples([example, { ...example }]);
      expect(deduped.length).toBe(1);
    });

    it('should keep distinct examples', () => {
      const example1: IntelligenceTrainingExample = {
        messages: [
          { role: 'system', content: 'prompt' },
          { role: 'user', content: 'question 1' },
          { role: 'assistant', content: 'response 1' },
        ],
        taskType: 'compliance_qa',
        domain: 'sec',
      };
      const example2: IntelligenceTrainingExample = {
        messages: [
          { role: 'system', content: 'prompt' },
          { role: 'user', content: 'question 2' },
          { role: 'assistant', content: 'response 2' },
        ],
        taskType: 'risk_analysis',
        domain: 'legal',
      };
      const deduped = deduplicateExamples([example1, example2]);
      expect(deduped.length).toBe(2);
    });
  });

  describe('getDistributionStats', () => {
    it('should count examples per task type', () => {
      const examples: IntelligenceTrainingExample[] = [
        {
          messages: [
            { role: 'system', content: 'p' },
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a' },
          ],
          taskType: 'compliance_qa',
          domain: 'sec',
        },
        {
          messages: [
            { role: 'system', content: 'p' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' },
          ],
          taskType: 'compliance_qa',
          domain: 'legal',
        },
        {
          messages: [
            { role: 'system', content: 'p' },
            { role: 'user', content: 'q3' },
            { role: 'assistant', content: 'a3' },
          ],
          taskType: 'risk_analysis',
          domain: 'sec',
        },
      ];

      const stats = getDistributionStats(examples);
      expect(stats.compliance_qa.count).toBe(2);
      expect(stats.risk_analysis.count).toBe(1);
    });
  });

  describe('seed intelligence pairs', () => {
    it('should have at least 5 seed pairs', () => {
      expect(SEED_INTELLIGENCE_PAIRS.length).toBeGreaterThanOrEqual(5);
    });

    it('should have unique IDs', () => {
      const ids = SEED_INTELLIGENCE_PAIRS.map(p => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should all have valid confidence values', () => {
      for (const pair of SEED_INTELLIGENCE_PAIRS) {
        expect(pair.confidence).toBeGreaterThanOrEqual(0);
        expect(pair.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('should all have at least one citation', () => {
      for (const pair of SEED_INTELLIGENCE_PAIRS) {
        expect(pair.citations.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('should all have non-empty contexts', () => {
      for (const pair of SEED_INTELLIGENCE_PAIRS) {
        expect(pair.context.length).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
