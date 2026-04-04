/**
 * Tests for Nessie DPO Training Data (NMT-09)
 */

import { describe, it, expect } from 'vitest';
import {
  generateCorruptedResponse,
  generateDPOPairsFromSFT,
  dpoPairsToJSONL,
  validateDPOPair,
  getDPOStats,
} from './nessie-dpo-data.js';

const VALID_RESPONSE = JSON.stringify({
  analysis: 'The company is compliant [DOC-1].',
  citations: [{ record_id: 'DOC-1', source: 'edgar', excerpt: 'Filed all required reports.' }],
  risks: ['credential expiring soon'],
  recommendations: ['renew before deadline'],
  confidence: 0.82,
  gaps: ['missing Q4 filing'],
});

describe('nessie-dpo-data', () => {
  describe('generateCorruptedResponse', () => {
    it('hallucinate strategy adds fake citation', () => {
      const corrupted = generateCorruptedResponse(VALID_RESPONSE, ['DOC-1'], 'hallucinate');
      const parsed = JSON.parse(corrupted);
      expect(parsed.citations.length).toBeGreaterThan(1);
      expect(parsed.citations.some((c: { record_id: string }) => c.record_id.startsWith('FAKE-'))).toBe(true);
    });

    it('swap_ids strategy swaps citation IDs', () => {
      const twoDocResponse = JSON.stringify({
        analysis: 'Analysis [A] and [B].',
        citations: [
          { record_id: 'A', source: 'edgar', excerpt: 'From doc A' },
          { record_id: 'B', source: 'courtlistener', excerpt: 'From doc B' },
        ],
        confidence: 0.8,
      });
      const corrupted = generateCorruptedResponse(twoDocResponse, ['A', 'B'], 'swap_ids');
      const parsed = JSON.parse(corrupted);
      expect(parsed.citations[0].record_id).toBe('B');
      expect(parsed.citations[1].record_id).toBe('A');
    });

    it('fabricate_excerpt replaces real excerpts', () => {
      const corrupted = generateCorruptedResponse(VALID_RESPONSE, ['DOC-1'], 'fabricate_excerpt');
      const parsed = JSON.parse(corrupted);
      expect(parsed.citations[0].excerpt).not.toBe('Filed all required reports.');
      expect(parsed.citations[0].excerpt).toContain('regulatory framework');
    });

    it('overconfident strategy boosts confidence and removes hedging', () => {
      const hedgedResponse = JSON.stringify({
        analysis: 'The company may be compliant.',
        citations: [],
        confidence: 0.5,
        gaps: ['need more data'],
      });
      const corrupted = generateCorruptedResponse(hedgedResponse, [], 'overconfident');
      const parsed = JSON.parse(corrupted);
      expect(parsed.confidence).toBeGreaterThan(0.8);
      expect(parsed.analysis).not.toContain('may ');
      expect(parsed.gaps).toHaveLength(0);
    });

    it('missing_citations removes all citations', () => {
      const corrupted = generateCorruptedResponse(VALID_RESPONSE, ['DOC-1'], 'missing_citations');
      const parsed = JSON.parse(corrupted);
      expect(parsed.citations).toHaveLength(0);
      expect(parsed.analysis).not.toContain('[DOC-1]');
    });

    it('handles invalid JSON gracefully', () => {
      const corrupted = generateCorruptedResponse('not json', [], 'hallucinate');
      const parsed = JSON.parse(corrupted);
      expect(parsed.analysis).toBeDefined();
      expect(parsed.citations).toHaveLength(0);
    });
  });

  describe('generateDPOPairsFromSFT', () => {
    const sftExamples = [
      {
        messages: [
          { role: 'system', content: 'You are a compliance engine.' },
          { role: 'user', content: 'Query\n\nrecord_id: DOC-1\nSome content' },
          { role: 'assistant', content: VALID_RESPONSE },
        ],
        taskType: 'compliance_qa',
      },
      {
        messages: [
          { role: 'system', content: 'You are a compliance engine.' },
          { role: 'user', content: 'Query 2\n\nrecord_id: DOC-2\nMore content' },
          { role: 'assistant', content: VALID_RESPONSE },
        ],
        taskType: 'risk_analysis',
      },
    ];

    it('generates one DPO pair per SFT example', () => {
      const pairs = generateDPOPairsFromSFT(sftExamples);
      expect(pairs).toHaveLength(2);
    });

    it('chosen matches original assistant response', () => {
      const pairs = generateDPOPairsFromSFT(sftExamples);
      expect(pairs[0].chosen).toBe(VALID_RESPONSE);
    });

    it('rejected differs from chosen', () => {
      const pairs = generateDPOPairsFromSFT(sftExamples);
      expect(pairs[0].rejected).not.toBe(pairs[0].chosen);
    });

    it('pairs have unique IDs', () => {
      const pairs = generateDPOPairsFromSFT(sftExamples);
      const ids = pairs.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('rotates through corruption strategies', () => {
      const moreExamples = Array(8).fill(null).map((_, i) => ({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: `q${i}\nrecord_id: D${i}` },
          { role: 'assistant', content: VALID_RESPONSE },
        ],
      }));
      const pairs = generateDPOPairsFromSFT(moreExamples);
      const strategies = pairs.map((p) => p.id.split('-').slice(2).join('-'));
      const uniqueStrategies = new Set(strategies);
      expect(uniqueStrategies.size).toBeGreaterThanOrEqual(4);
    });
  });

  describe('dpoPairsToJSONL', () => {
    it('produces valid JSONL', () => {
      const pairs = generateDPOPairsFromSFT([{
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'q\nrecord_id: D1' },
          { role: 'assistant', content: VALID_RESPONSE },
        ],
      }]);
      const jsonl = dpoPairsToJSONL(pairs);
      const lines = jsonl.trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.prompt).toBeDefined();
      expect(parsed.chosen).toBeDefined();
      expect(parsed.rejected).toBeDefined();
    });
  });

  describe('validateDPOPair', () => {
    it('returns null for valid pair', () => {
      const pairs = generateDPOPairsFromSFT([{
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'q\nrecord_id: D1' },
          { role: 'assistant', content: VALID_RESPONSE },
        ],
      }]);
      expect(validateDPOPair(pairs[0])).toBeNull();
    });

    it('rejects missing prompt', () => {
      expect(validateDPOPair({ id: 'x', prompt: '', chosen: VALID_RESPONSE, rejected: '{}' })).toContain('Missing prompt');
    });

    it('rejects identical chosen/rejected', () => {
      expect(validateDPOPair({ id: 'x', prompt: 'q', chosen: VALID_RESPONSE, rejected: VALID_RESPONSE })).toContain('identical');
    });
  });

  describe('getDPOStats', () => {
    it('counts pairs by strategy', () => {
      const pairs = generateDPOPairsFromSFT(Array(4).fill(null).map((_, i) => ({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: `q${i}\nrecord_id: D${i}` },
          { role: 'assistant', content: VALID_RESPONSE },
        ],
      })));
      const stats = getDPOStats(pairs);
      expect(Object.keys(stats).length).toBeGreaterThanOrEqual(4);
    });
  });
});
