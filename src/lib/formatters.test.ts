/**
 * Tests for shared display formatters.
 */

import { describe, expect, it } from 'vitest';
import { formatDate, formatFileSize } from './formatters';

describe('formatDate', () => {
  it('formats ISO date as "Mon d, yyyy"', () => {
    expect(formatDate('2026-04-20T12:34:56Z')).toMatch(/Apr (19|20), 2026/);
  });
});

describe('formatFileSize', () => {
  it('formats bytes below 1 KiB with B unit', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('formats bytes below 1 MiB with KB unit at one decimal', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats bytes above 1 MiB with MB unit at one decimal', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(5_242_880)).toBe('5.0 MB');
  });

  it('handles 0 bytes as "0 B"', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });
});
