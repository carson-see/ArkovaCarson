/**
 * Tests for Nessie Intelligence Prompts (NMT-07)
 */

import { describe, it, expect } from 'vitest';
import {
  INTELLIGENCE_SYSTEM_PROMPT,
  INTELLIGENCE_MODES,
  buildIntelligenceSystemPrompt,
  buildIntelligenceUserPrompt,
  isValidIntelligenceMode,
} from './intelligence.js';

describe('intelligence prompts', () => {
  describe('INTELLIGENCE_SYSTEM_PROMPT', () => {
    it('describes Nessie as compliance intelligence, not extraction', () => {
      expect(INTELLIGENCE_SYSTEM_PROMPT).toContain('compliance intelligence engine');
      expect(INTELLIGENCE_SYSTEM_PROMPT).not.toContain('Extract structured metadata');
    });

    it('requires JSON response format', () => {
      expect(INTELLIGENCE_SYSTEM_PROMPT).toContain('"analysis"');
      expect(INTELLIGENCE_SYSTEM_PROMPT).toContain('"citations"');
      expect(INTELLIGENCE_SYSTEM_PROMPT).toContain('"risks"');
      expect(INTELLIGENCE_SYSTEM_PROMPT).toContain('"recommendations"');
    });
  });

  describe('buildIntelligenceSystemPrompt', () => {
    it('appends mode-specific prompt for each mode', () => {
      for (const mode of INTELLIGENCE_MODES) {
        const prompt = buildIntelligenceSystemPrompt(mode);
        expect(prompt).toContain(INTELLIGENCE_SYSTEM_PROMPT);
        expect(prompt.length).toBeGreaterThan(INTELLIGENCE_SYSTEM_PROMPT.length);
      }
    });

    it('risk_analysis includes severity ranking', () => {
      const prompt = buildIntelligenceSystemPrompt('risk_analysis');
      expect(prompt).toContain('HIGH/MEDIUM/LOW');
    });

    it('cross_reference includes consistency checking', () => {
      const prompt = buildIntelligenceSystemPrompt('cross_reference');
      expect(prompt).toContain('consistency');
    });
  });

  describe('buildIntelligenceUserPrompt', () => {
    const docs = [
      {
        record_id: 'PR-001',
        source: 'edgar',
        title: 'Test 10-K',
        record_type: 'sec_filing',
        content: 'Some filing content',
        content_hash: 'abc123',
        chain_tx_id: 'tx-456',
      },
    ];

    it('includes query and document context', () => {
      const prompt = buildIntelligenceUserPrompt('Is this compliant?', docs);
      expect(prompt).toContain('Is this compliant?');
      expect(prompt).toContain('VERIFIED DOCUMENTS (1 results)');
      expect(prompt).toContain('record_id: PR-001');
    });

    it('includes content hash and chain tx', () => {
      const prompt = buildIntelligenceUserPrompt('query', docs);
      expect(prompt).toContain('content_hash: abc123');
      expect(prompt).toContain('chain_tx_id: tx-456');
    });

    it('handles null title and missing chain_tx_id', () => {
      const prompt = buildIntelligenceUserPrompt('query', [{
        record_id: 'PR-002',
        source: 'uspto',
        title: null,
        record_type: 'patent',
        content: 'Patent text',
      }]);
      expect(prompt).toContain('title: Untitled');
      expect(prompt).toContain('chain_tx_id: not yet anchored');
    });
  });

  describe('isValidIntelligenceMode', () => {
    it('validates known modes', () => {
      expect(isValidIntelligenceMode('compliance_qa')).toBe(true);
      expect(isValidIntelligenceMode('risk_analysis')).toBe(true);
      expect(isValidIntelligenceMode('cross_reference')).toBe(true);
    });

    it('rejects unknown modes', () => {
      expect(isValidIntelligenceMode('extraction')).toBe(false);
      expect(isValidIntelligenceMode('')).toBe(false);
      expect(isValidIntelligenceMode('random')).toBe(false);
    });
  });
});
