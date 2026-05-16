/**
 * Source Provenance Utilities Tests (CSI-03 / SCRUM-1599)
 *
 * TDD: These tests cover the source provenance logic for public verification pages.
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeSourceUrl,
  isSourceUrlSafe,
  getEvidenceLevelLabel,
  getEvidenceLevelDescription,
  getEvidenceLevelStrength,
  isStrongEvidence,
  formatProvider,
  buildEvidenceProofFields,
  badgeUrl,
  linkedInCredentialUrl,
} from './sourceProvenance';

// =============================================================================
// sanitizeSourceUrl
// =============================================================================

describe('sanitizeSourceUrl', () => {
  it('returns null for null/undefined input', () => {
    expect(sanitizeSourceUrl(null)).toBeNull();
    expect(sanitizeSourceUrl(undefined)).toBeNull();
    expect(sanitizeSourceUrl('')).toBeNull();
  });

  it('passes through clean URLs', () => {
    expect(sanitizeSourceUrl('https://www.credly.com/badges/abc-123')).toBe(
      'https://www.credly.com/badges/abc-123'
    );
  });

  it('strips sensitive query parameters', () => {
    const url = 'https://example.com/badge?id=123&token=secret123&name=test';
    const result = sanitizeSourceUrl(url);
    expect(result).toContain('id=123');
    expect(result).toContain('name=test');
    expect(result).not.toContain('token=secret123');
  });

  it('strips access_token parameter', () => {
    const url = 'https://api.example.com/v1/cert?access_token=xyz&format=json';
    const result = sanitizeSourceUrl(url);
    expect(result).toContain('format=json');
    expect(result).not.toContain('access_token');
  });

  it('strips API key parameters (case-insensitive)', () => {
    const url = 'https://example.com/doc?api_key=abc123&id=42';
    const result = sanitizeSourceUrl(url);
    expect(result).toContain('id=42');
    expect(result).not.toContain('api_key');
  });

  it('returns null for URLs with userinfo (user:pass@host)', () => {
    expect(sanitizeSourceUrl('https://user:pass@example.com/badge')).toBeNull();
    expect(sanitizeSourceUrl('https://admin@example.com/cert')).toBeNull();
  });

  it('strips URL fragments', () => {
    const url = 'https://example.com/badge/123#access_token=secret';
    const result = sanitizeSourceUrl(url);
    expect(result).toBe('https://example.com/badge/123');
  });

  it('returns null for invalid URLs', () => {
    expect(sanitizeSourceUrl('not-a-url')).toBeNull();
    expect(sanitizeSourceUrl('ftp://')).toBeNull();
  });

  it('preserves path structure', () => {
    const url = 'https://www.credly.com/badges/12345678-abcd-efgh-ijkl-mnopqrstuvwx';
    expect(sanitizeSourceUrl(url)).toBe(url);
  });
});

// =============================================================================
// isSourceUrlSafe
// =============================================================================

describe('isSourceUrlSafe', () => {
  it('returns false for null/undefined', () => {
    expect(isSourceUrlSafe(null)).toBe(false);
    expect(isSourceUrlSafe(undefined)).toBe(false);
  });

  it('returns true for clean URLs', () => {
    expect(isSourceUrlSafe('https://credly.com/badges/123')).toBe(true);
  });

  it('returns false for URLs with userinfo', () => {
    expect(isSourceUrlSafe('https://admin:pass@evil.com')).toBe(false);
  });
});

// =============================================================================
// getEvidenceLevelLabel
// =============================================================================

describe('getEvidenceLevelLabel', () => {
  it('returns correct labels for all levels', () => {
    expect(getEvidenceLevelLabel('issuer_anchored')).toBe('Issuer Anchored');
    expect(getEvidenceLevelLabel('source_signed')).toBe('Source Signed');
    expect(getEvidenceLevelLabel('account_linked')).toBe('Account Linked');
    expect(getEvidenceLevelLabel('captured_url')).toBe('Captured URL Evidence');
    expect(getEvidenceLevelLabel('ai_captured')).toBe('AI-Captured Evidence');
  });

  it('returns null for unknown levels', () => {
    expect(getEvidenceLevelLabel('unknown_level')).toBeNull();
    expect(getEvidenceLevelLabel(null)).toBeNull();
    expect(getEvidenceLevelLabel(undefined)).toBeNull();
  });
});

// =============================================================================
// getEvidenceLevelDescription
// =============================================================================

describe('getEvidenceLevelDescription', () => {
  it('returns descriptions for valid levels', () => {
    expect(getEvidenceLevelDescription('issuer_anchored')).toContain('Verified directly');
    expect(getEvidenceLevelDescription('captured_url')).toContain('public URL');
  });

  it('returns null for unknown levels', () => {
    expect(getEvidenceLevelDescription(null)).toBeNull();
    expect(getEvidenceLevelDescription('nonsense')).toBeNull();
  });
});

// =============================================================================
// getEvidenceLevelStrength
// =============================================================================

describe('getEvidenceLevelStrength', () => {
  it('returns correct strength ordering', () => {
    expect(getEvidenceLevelStrength('issuer_anchored')).toBe(5);
    expect(getEvidenceLevelStrength('source_signed')).toBe(4);
    expect(getEvidenceLevelStrength('account_linked')).toBe(3);
    expect(getEvidenceLevelStrength('captured_url')).toBe(2);
    expect(getEvidenceLevelStrength('ai_captured')).toBe(1);
  });

  it('returns 0 for null/unknown', () => {
    expect(getEvidenceLevelStrength(null)).toBe(0);
    expect(getEvidenceLevelStrength(undefined)).toBe(0);
    expect(getEvidenceLevelStrength('invalid')).toBe(0);
  });
});

// =============================================================================
// isStrongEvidence
// =============================================================================

describe('isStrongEvidence', () => {
  it('returns true for issuer_anchored and source_signed', () => {
    expect(isStrongEvidence('issuer_anchored')).toBe(true);
    expect(isStrongEvidence('source_signed')).toBe(true);
  });

  it('returns false for weaker levels', () => {
    expect(isStrongEvidence('account_linked')).toBe(false);
    expect(isStrongEvidence('captured_url')).toBe(false);
    expect(isStrongEvidence('ai_captured')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isStrongEvidence(null)).toBe(false);
  });
});

// =============================================================================
// formatProvider
// =============================================================================

describe('formatProvider', () => {
  it('formats known providers with correct casing', () => {
    expect(formatProvider('credly')).toBe('Credly');
    expect(formatProvider('linkedin')).toBe('LinkedIn');
    expect(formatProvider('aws')).toBe('AWS');
    expect(formatProvider('github')).toBe('GitHub');
  });

  it('capitalizes unknown providers', () => {
    expect(formatProvider('customplatform')).toBe('Customplatform');
  });

  it('returns null for null/undefined', () => {
    expect(formatProvider(null)).toBeNull();
    expect(formatProvider(undefined)).toBeNull();
  });
});

// =============================================================================
// buildEvidenceProofFields
// =============================================================================

describe('buildEvidenceProofFields', () => {
  it('includes all present fields', () => {
    const data = {
      evidence_package_hash: 'abc123',
      source_payload_hash: 'def456',
      source_provider: 'credly',
      source_url: 'https://credly.com/badges/123',
      fetched_at: '2026-05-10T12:00:00Z',
      verification_level: 'captured_url' as const,
    };

    const result = buildEvidenceProofFields(data);
    expect(result.evidence_package_hash).toBe('abc123');
    expect(result.source_payload_hash).toBe('def456');
    expect(result.source_provider).toBe('credly');
    expect(result.source_url).toBe('https://credly.com/badges/123');
    expect(result.fetched_at).toBe('2026-05-10T12:00:00Z');
    expect(result.verification_level).toBe('captured_url');
  });

  it('omits null/undefined fields', () => {
    const result = buildEvidenceProofFields({});
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('sanitizes source_url before including', () => {
    const data = {
      source_url: 'https://example.com/badge?token=secret&id=123',
    };
    const result = buildEvidenceProofFields(data);
    expect(result.source_url).toContain('id=123');
    expect(result.source_url).not.toContain('token=secret');
  });

  it('excludes unsafe source URLs', () => {
    const data = {
      source_url: 'https://user:pass@evil.com/cert',
    };
    const result = buildEvidenceProofFields(data);
    expect(result.source_url).toBeUndefined();
  });
});

// =============================================================================
// badgeUrl
// =============================================================================

describe('badgeUrl', () => {
  it('builds a badge URL with public ID and status', () => {
    const result = badgeUrl('ARK-2026-001', 'SECURED');
    expect(result).toContain('/api/badge/ARK-2026-001');
    expect(result).toContain('status=SECURED');
  });
});

// =============================================================================
// linkedInCredentialUrl
// =============================================================================

describe('linkedInCredentialUrl', () => {
  it('builds Arkova verification URL (not LinkedIn native)', () => {
    const result = linkedInCredentialUrl('ARK-2026-001');
    expect(result).toBe('https://app.arkova.ai/verify/ARK-2026-001');
  });

  it('does not include linkedin.com domain', () => {
    const result = linkedInCredentialUrl('ARK-2026-001');
    expect(result).not.toContain('linkedin.com');
  });
});
