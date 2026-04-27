/**
 * Unit tests for buildInfo (SCRUM-1247 / R0-1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getBuildSha, isValidBuildSha } from './buildInfo.js';

describe('buildInfo', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.BUILD_SHA;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.BUILD_SHA;
    else process.env.BUILD_SHA = original;
  });

  describe('getBuildSha', () => {
    it('returns env value when set', () => {
      process.env.BUILD_SHA = 'a'.repeat(40);
      expect(getBuildSha()).toBe('a'.repeat(40));
    });

    it('returns "unknown" sentinel when env unset', () => {
      delete process.env.BUILD_SHA;
      expect(getBuildSha()).toBe('unknown');
    });
  });

  describe('isValidBuildSha', () => {
    it('accepts a 40-char lowercase hex SHA', () => {
      expect(isValidBuildSha('a'.repeat(40))).toBe(true);
    });

    it('accepts uppercase hex', () => {
      expect(isValidBuildSha('A'.repeat(40))).toBe(true);
    });

    it('rejects undefined', () => {
      expect(isValidBuildSha(undefined)).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidBuildSha('')).toBe(false);
    });

    it('rejects "unknown" sentinel', () => {
      expect(isValidBuildSha('unknown')).toBe(false);
    });

    it('rejects non-hex chars', () => {
      expect(isValidBuildSha('z'.repeat(40))).toBe(false);
    });

    it('rejects wrong length', () => {
      expect(isValidBuildSha('abc')).toBe(false);
      expect(isValidBuildSha('a'.repeat(41))).toBe(false);
    });
  });
});
