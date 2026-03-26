/**
 * Visual Fraud Detector Tests (Phase 5)
 */

import { describe, it, expect, vi } from 'vitest';

// Mock logger to avoid config validation
vi.mock('../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { scoreToRiskLevel } from './visualFraudDetector.js';

describe('visualFraudDetector', () => {
  describe('scoreToRiskLevel', () => {
    it('maps 0-20 to LOW', () => {
      expect(scoreToRiskLevel(0)).toBe('LOW');
      expect(scoreToRiskLevel(10)).toBe('LOW');
      expect(scoreToRiskLevel(20)).toBe('LOW');
    });

    it('maps 21-50 to MEDIUM', () => {
      expect(scoreToRiskLevel(21)).toBe('MEDIUM');
      expect(scoreToRiskLevel(35)).toBe('MEDIUM');
      expect(scoreToRiskLevel(50)).toBe('MEDIUM');
    });

    it('maps 51-75 to HIGH', () => {
      expect(scoreToRiskLevel(51)).toBe('HIGH');
      expect(scoreToRiskLevel(65)).toBe('HIGH');
      expect(scoreToRiskLevel(75)).toBe('HIGH');
    });

    it('maps 76-100 to CRITICAL', () => {
      expect(scoreToRiskLevel(76)).toBe('CRITICAL');
      expect(scoreToRiskLevel(90)).toBe('CRITICAL');
      expect(scoreToRiskLevel(100)).toBe('CRITICAL');
    });
  });
});
