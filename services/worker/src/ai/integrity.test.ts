/**
 * Integrity Score Service Tests (P8-S8)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  scoreToLevel,
  calculateMetadataCompleteness,
  calculateTemporalConsistency,
} from './integrity.js';

// Mock db and logger
vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
          neq: vi.fn(() => ({
            // count query
          })),
          order: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          })),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
        ilike: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
      })),
      upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('scoreToLevel', () => {
  it('returns HIGH for scores >= 80', () => {
    expect(scoreToLevel(80)).toBe('HIGH');
    expect(scoreToLevel(100)).toBe('HIGH');
    expect(scoreToLevel(95)).toBe('HIGH');
  });

  it('returns MEDIUM for scores 60-79', () => {
    expect(scoreToLevel(60)).toBe('MEDIUM');
    expect(scoreToLevel(79)).toBe('MEDIUM');
  });

  it('returns LOW for scores 40-59', () => {
    expect(scoreToLevel(40)).toBe('LOW');
    expect(scoreToLevel(59)).toBe('LOW');
  });

  it('returns FLAGGED for scores < 40', () => {
    expect(scoreToLevel(0)).toBe('FLAGGED');
    expect(scoreToLevel(39)).toBe('FLAGGED');
  });
});

describe('calculateMetadataCompleteness', () => {
  it('returns 0 for null metadata', () => {
    expect(calculateMetadataCompleteness(null, 'DEGREE')).toBe(0);
  });

  it('returns 100 for fully complete DEGREE', () => {
    const metadata = {
      issuerName: 'MIT',
      issuedDate: '2024-01-01',
      fieldOfStudy: 'CS',
      degreeLevel: 'PhD',
    };
    expect(calculateMetadataCompleteness(metadata, 'DEGREE')).toBe(100);
  });

  it('returns partial score for incomplete metadata', () => {
    const metadata = {
      issuerName: 'MIT',
      issuedDate: '2024-01-01',
    };
    expect(calculateMetadataCompleteness(metadata, 'DEGREE')).toBe(50);
  });

  it('returns 0 for empty metadata with expected fields', () => {
    expect(calculateMetadataCompleteness({}, 'DEGREE')).toBe(0);
  });

  it('ignores empty string values', () => {
    const metadata = {
      issuerName: '',
      issuedDate: '2024-01-01',
      fieldOfStudy: 'CS',
      degreeLevel: 'PhD',
    };
    expect(calculateMetadataCompleteness(metadata, 'DEGREE')).toBe(75);
  });

  it('handles LICENSE type with more fields', () => {
    const metadata = {
      issuerName: 'Board',
      issuedDate: '2024-01-01',
      expiryDate: '2025-01-01',
      licenseNumber: 'LIC-123',
      jurisdiction: 'CA',
    };
    expect(calculateMetadataCompleteness(metadata, 'LICENSE')).toBe(100);
  });

  it('falls back to OTHER for unknown types', () => {
    const metadata = { issuerName: 'Test' };
    expect(calculateMetadataCompleteness(metadata, 'UNKNOWN')).toBe(100);
  });
});

describe('calculateTemporalConsistency', () => {
  it('returns 50 with flag for missing issued date', () => {
    const result = calculateTemporalConsistency(undefined);
    expect(result.score).toBe(50);
    expect(result.flags).toContain('missing_issued_date');
  });

  it('returns 100 for valid recent date', () => {
    const result = calculateTemporalConsistency('2024-01-01');
    expect(result.score).toBe(100);
    expect(result.flags).toHaveLength(0);
  });

  it('penalizes future issued date', () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    const result = calculateTemporalConsistency(futureDate.toISOString());
    expect(result.score).toBeLessThan(100);
    expect(result.flags).toContain('future_issued_date');
  });

  it('penalizes very old credential', () => {
    const result = calculateTemporalConsistency('1960-01-01');
    expect(result.score).toBeLessThan(100);
    expect(result.flags).toContain('very_old_credential');
  });

  it('penalizes expiry before issued', () => {
    const result = calculateTemporalConsistency('2024-06-01', '2024-01-01');
    expect(result.score).toBeLessThan(100);
    expect(result.flags).toContain('expiry_before_issued');
  });

  it('accepts valid issued + expiry dates', () => {
    const result = calculateTemporalConsistency('2024-01-01', '2025-01-01');
    expect(result.score).toBe(100);
    expect(result.flags).toHaveLength(0);
  });
});

describe('computeIntegrityScore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns FLAGGED score when anchor not found', async () => {
    const { computeIntegrityScore } = await import('./integrity.js');
    const result = await computeIntegrityScore('missing-id', undefined);
    expect(result.level).toBe('FLAGGED');
    expect(result.overallScore).toBe(0);
    expect(result.flags).toContain('anchor_not_found');
  });
});

describe('upsertIntegrityScore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true on successful upsert', async () => {
    const { upsertIntegrityScore } = await import('./integrity.js');
    const result = await upsertIntegrityScore('anchor-1', 'org-1', {
      overallScore: 85,
      level: 'HIGH',
      breakdown: {
        metadataCompleteness: 100,
        extractionConfidence: 80,
        issuerVerification: 90,
        duplicateCheck: 100,
        temporalConsistency: 100,
      },
      flags: [],
      details: {},
    });
    expect(result).toBe(true);
  });
});
