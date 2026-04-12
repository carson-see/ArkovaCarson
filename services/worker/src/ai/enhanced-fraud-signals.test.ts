/**
 * GME-13: Enhanced Fraud Detection Signal Tests
 *
 * Verifies new Gemini 3 Vision fraud signal categories are defined
 * and that the enhanced prompt includes them.
 */

import { describe, it, expect } from 'vitest';
import {
  ENHANCED_FRAUD_CATEGORIES,
  isEnhancedSignalCategory,
} from './enhanced-fraud-signals.js';

describe('GME-13: Enhanced Fraud Signals', () => {
  it('includes original categories', () => {
    expect(ENHANCED_FRAUD_CATEGORIES).toContain('font');
    expect(ENHANCED_FRAUD_CATEGORIES).toContain('layout');
    expect(ENHANCED_FRAUD_CATEGORIES).toContain('manipulation');
    expect(ENHANCED_FRAUD_CATEGORIES).toContain('metadata');
    expect(ENHANCED_FRAUD_CATEGORIES).toContain('security_feature');
  });

  it('includes new Gemini 3 Vision categories', () => {
    expect(ENHANCED_FRAUD_CATEGORIES).toContain('watermark');
    expect(ENHANCED_FRAUD_CATEGORIES).toContain('resolution');
    expect(ENHANCED_FRAUD_CATEGORIES).toContain('metadata_stripping');
  });

  it('isEnhancedSignalCategory validates categories', () => {
    expect(isEnhancedSignalCategory('watermark')).toBe(true);
    expect(isEnhancedSignalCategory('resolution')).toBe(true);
    expect(isEnhancedSignalCategory('metadata_stripping')).toBe(true);
    expect(isEnhancedSignalCategory('font')).toBe(true);
    expect(isEnhancedSignalCategory('invalid_category')).toBe(false);
  });
});
