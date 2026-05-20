/**
 * Source Provenance Utilities Tests (CSI-03 / SCRUM-1599)
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
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

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it('strips sensitive query parameters including OAuth redirect values', () => {
    const url = 'https://example.com/badge?id=123&token=secret123&state=public-route&code=course-101';
    const result = sanitizeSourceUrl(url);
    expect(result).toContain('id=123');
    expect(result).not.toContain('state=public-route');
    expect(result).not.toContain('code=course-101');
    expect(result).not.toContain('token=secret123');
  });

  it('strips access_token parameter', () => {
    const result = sanitizeSourceUrl('https://api.example.com/v1/cert?access_token=xyz&format=json');
    expect(result).toContain('format=json');
    expect(result).not.toContain('access_token');
  });

  it('strips API key parameters case-insensitively', () => {
    const result = sanitizeSourceUrl('https://example.com/doc?api_key=abc123&id=42');
    expect(result).toContain('id=42');
    expect(result).not.toContain('api_key');
  });

  it('strips signature-style parameters', () => {
    expect(sanitizeSourceUrl('https://example.com/doc?sig=abc&id=1')).toBe('https://example.com/doc?id=1');
    expect(sanitizeSourceUrl('https://example.com/doc?signature=xyz&name=test')).toBe('https://example.com/doc?name=test');
    expect(sanitizeSourceUrl('https://example.com/doc?x-api-key=secret&id=2')).toBe('https://example.com/doc?id=2');
    expect(sanitizeSourceUrl('https://example.com/doc?hmac=deadbeef&type=cert')).toBe('https://example.com/doc?type=cert');
  });

  it('returns null for URLs with userinfo', () => {
    expect(sanitizeSourceUrl('https://user:pass@example.com/badge')).toBeNull();
    expect(sanitizeSourceUrl('https://admin@example.com/cert')).toBeNull();
  });

  it('strips URL fragments', () => {
    expect(sanitizeSourceUrl('https://example.com/badge/123#access_token=secret')).toBe(
      'https://example.com/badge/123'
    );
  });

  it('rejects invalid and non-http(s) URLs', () => {
    expect(sanitizeSourceUrl('not-a-url')).toBeNull();
    expect(sanitizeSourceUrl('file:///etc/passwd')).toBeNull();
    expect(sanitizeSourceUrl('blob:https://example.com/uuid')).toBeNull();
    expect(sanitizeSourceUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeSourceUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(sanitizeSourceUrl('ftp://files.example.com/cert.pdf')).toBeNull();
  });

  it('allows http and https protocols', () => {
    expect(sanitizeSourceUrl('https://example.com/badge')).toBe('https://example.com/badge');
    expect(sanitizeSourceUrl('http://example.com/badge')).toBe('http://example.com/badge');
  });
});

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

describe('evidence level helpers', () => {
  it('returns labels and descriptions for valid levels', () => {
    expect(getEvidenceLevelLabel('issuer_anchored')).toBe('Issuer Anchored');
    expect(getEvidenceLevelLabel('source_signed')).toBe('Source Signed');
    expect(getEvidenceLevelLabel('account_linked')).toBe('Account Linked');
    expect(getEvidenceLevelLabel('captured_url')).toBe('Captured URL Evidence');
    expect(getEvidenceLevelLabel('ai_captured')).toBe('AI-Captured Evidence');
    expect(getEvidenceLevelDescription('issuer_anchored')).toContain('Verified directly');
    expect(getEvidenceLevelDescription('captured_url')).toContain('public URL');
  });

  it('returns null/0 for unknown levels', () => {
    expect(getEvidenceLevelLabel('unknown_level')).toBeNull();
    expect(getEvidenceLevelLabel(null)).toBeNull();
    expect(getEvidenceLevelDescription('nonsense')).toBeNull();
    expect(getEvidenceLevelStrength('invalid')).toBe(0);
  });

  it('orders evidence strength', () => {
    expect(getEvidenceLevelStrength('issuer_anchored')).toBe(5);
    expect(getEvidenceLevelStrength('source_signed')).toBe(4);
    expect(getEvidenceLevelStrength('account_linked')).toBe(3);
    expect(getEvidenceLevelStrength('captured_url')).toBe(2);
    expect(getEvidenceLevelStrength('ai_captured')).toBe(1);
    expect(isStrongEvidence('issuer_anchored')).toBe(true);
    expect(isStrongEvidence('source_signed')).toBe(true);
    expect(isStrongEvidence('captured_url')).toBe(false);
    expect(isStrongEvidence(null)).toBe(false);
  });
});

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

describe('buildEvidenceProofFields', () => {
  it('includes all present fields', () => {
    const result = buildEvidenceProofFields({
      evidence_package_hash: 'abc123',
      source_payload_hash: 'def456',
      source_provider: 'credly',
      source_url: 'https://credly.com/badges/123',
      fetched_at: '2026-05-10T12:00:00Z',
      verification_level: 'captured_url',
    });

    expect(result).toEqual({
      evidence_package_hash: 'abc123',
      source_payload_hash: 'def456',
      source_provider: 'credly',
      source_url: 'https://credly.com/badges/123',
      fetched_at: '2026-05-10T12:00:00Z',
      verification_level: 'captured_url',
    });
  });

  it('omits null/undefined/invalid fields and unsafe URLs', () => {
    expect(buildEvidenceProofFields({})).toEqual({});
    expect(buildEvidenceProofFields({ source_url: 'https://user:pass@evil.com/cert' }).source_url).toBeUndefined();
    expect(buildEvidenceProofFields({ verification_level: 'not_real' as never }).verification_level).toBeUndefined();
  });

  it('sanitizes source_url before including', () => {
    const result = buildEvidenceProofFields({
      source_url: 'https://example.com/badge?token=secret&id=123',
    });
    expect(result.source_url).toContain('id=123');
    expect(result.source_url).not.toContain('token=secret');
  });
});

describe('badgeUrl', () => {
  it('builds a badge URL with public ID and no spoofable status parameter', () => {
    const result = badgeUrl('ARK-2026-001');
    expect(result).toContain('/api/badge/ARK-2026-001');
    expect(result).not.toContain('status=');
  });

  it('encodes public IDs in the badge path', () => {
    const result = badgeUrl('ARK/2026?`#001`');
    expect(result).toContain('/api/badge/ARK%2F2026%3F%60%23001%60');
  });
});

describe('linkedInCredentialUrl', () => {
  it('builds Arkova verification URL', () => {
    expect(linkedInCredentialUrl('ARK-2026-001')).toBe('https://app.arkova.ai/verify/ARK-2026-001');
  });

  it('uses configured app base URL and encodes the public ID', () => {
    vi.stubEnv('VITE_APP_URL', 'https://preview.arkova.ai/');
    expect(linkedInCredentialUrl('ARK 2026/001?x=1')).toBe(
      'https://preview.arkova.ai/verify/ARK%202026%2F001%3Fx%3D1'
    );
  });

  it('does not include linkedin.com domain', () => {
    expect(linkedInCredentialUrl('ARK-2026-001')).not.toContain('linkedin.com');
  });
});
