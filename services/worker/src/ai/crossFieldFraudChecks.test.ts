/**
 * Cross-Field Consistency Fraud Checks Tests
 */

import { describe, it, expect } from 'vitest';
import { runCrossFieldChecks, sanitizeCLEFields } from './crossFieldFraudChecks.js';
import type { ExtractedFields } from './types.js';

describe('crossFieldFraudChecks', () => {
  // =========================================================================
  // DATE LOGIC CHECKS
  // =========================================================================

  describe('date logic checks', () => {
    it('flags issuedDate after expiryDate as SUSPICIOUS_DATES', () => {
      const fields: ExtractedFields = {
        issuedDate: '2025-06-01',
        expiryDate: '2024-01-01',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toContain('SUSPICIOUS_DATES');
      expect(result.confidenceAdjustment).toBeLessThan(0);
    });

    it('flags issuedDate more than 5 years in the future', () => {
      const futureYear = new Date().getFullYear() + 6;
      const fields: ExtractedFields = {
        issuedDate: `${futureYear}-01-15`,
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toContain('SUSPICIOUS_DATES');
      expect(result.confidenceAdjustment).toBeLessThanOrEqual(-0.15);
    });

    it('warns but does NOT flag credential older than 80 years as fraud', () => {
      const fields: ExtractedFields = {
        issuedDate: '1940-01-01',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).not.toContain('SUSPICIOUS_DATES');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('80 years')]),
      );
    });

    it('flags license valid for more than 20 years', () => {
      const fields: ExtractedFields = {
        credentialType: 'LICENSE',
        issuedDate: '2020-01-01',
        expiryDate: '2045-01-01',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toContain('SUSPICIOUS_DATES');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('unusual duration')]),
      );
    });

    it('warns but does NOT flag same-day issue and expiry as fraud (workshops)', () => {
      const fields: ExtractedFields = {
        issuedDate: '2025-03-15',
        expiryDate: '2025-03-15',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).not.toContain('SUSPICIOUS_DATES');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('workshop')]),
      );
    });

    it('does not flag valid date ranges', () => {
      const fields: ExtractedFields = {
        issuedDate: '2024-01-01',
        expiryDate: '2027-01-01',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).not.toContain('SUSPICIOUS_DATES');
      expect(result.confidenceAdjustment).toBe(0);
    });
  });

  // =========================================================================
  // ISSUER VALIDATION CHECKS
  // =========================================================================

  describe('issuer validation checks', () => {
    it('flags known diploma mill (Belford University)', () => {
      const fields: ExtractedFields = {
        issuerName: 'Belford University',
        credentialType: 'DEGREE',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toContain('EXPIRED_ISSUER');
      expect(result.confidenceAdjustment).toBeLessThanOrEqual(-0.20);
    });

    it('flags known diploma mill (Almeda University)', () => {
      const fields: ExtractedFields = {
        issuerName: 'The Almeda University International',
        credentialType: 'DEGREE',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toContain('EXPIRED_ISSUER');
    });

    it('flags suspicious issuer name patterns', () => {
      const fields: ExtractedFields = {
        issuerName: 'Universal Life Church Ministries',
        credentialType: 'DEGREE',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toContain('EXPIRED_ISSUER');
    });

    it('flags online doctorate with no accrediting body', () => {
      const fields: ExtractedFields = {
        issuerName: 'Online Global University',
        credentialType: 'DEGREE',
        degreeLevel: 'Doctorate',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toContain('MISSING_ACCREDITATION');
    });

    it('does not flag legitimate university', () => {
      const fields: ExtractedFields = {
        issuerName: 'Massachusetts Institute of Technology',
        credentialType: 'DEGREE',
        accreditingBody: 'NECHE',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).not.toContain('EXPIRED_ISSUER');
      expect(result.additionalFraudSignals).not.toContain('MISSING_ACCREDITATION');
    });
  });

  // =========================================================================
  // TYPE CONSISTENCY CHECKS
  // =========================================================================

  describe('type consistency checks', () => {
    it('flags DEGREE with no degreeLevel and no fieldOfStudy', () => {
      const fields: ExtractedFields = {
        credentialType: 'DEGREE',
        issuerName: 'Some University',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toContain('FORMAT_ANOMALY');
    });

    it('does not flag DEGREE with degreeLevel present', () => {
      const fields: ExtractedFields = {
        credentialType: 'DEGREE',
        degreeLevel: 'Bachelor',
        issuerName: 'Some University',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).not.toContain('FORMAT_ANOMALY');
    });

    it('warns about LICENSE without jurisdiction but does not flag fraud', () => {
      const fields: ExtractedFields = {
        credentialType: 'LICENSE',
        issuerName: 'State Board of Accountancy',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).not.toContain('FORMAT_ANOMALY');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('LICENSE credential without jurisdiction')]),
      );
    });

    it('flags CLE without creditHours', () => {
      const fields: ExtractedFields = {
        credentialType: 'CLE',
        issuerName: 'State Bar of California',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toContain('FORMAT_ANOMALY');
    });

    it('warns about Doctorate with CERTIFICATE type', () => {
      const fields: ExtractedFields = {
        credentialType: 'CERTIFICATE',
        degreeLevel: 'Doctorate',
        issuerName: 'Some Institution',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('may be misclassified')]),
      );
    });
  });

  // =========================================================================
  // JURISDICTION CHECKS
  // =========================================================================

  describe('jurisdiction checks', () => {
    it('flags US state jurisdiction with foreign issuer', () => {
      const fields: ExtractedFields = {
        jurisdiction: 'New York',
        issuerName: 'United Kingdom Medical Council',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toContain('JURISDICTION_MISMATCH');
    });

    it('flags foreign jurisdiction with US state board issuer', () => {
      const fields: ExtractedFields = {
        jurisdiction: 'United Kingdom',
        issuerName: 'State Board of Registration for Professional Engineers',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toContain('JURISDICTION_MISMATCH');
    });

    it('does not flag matching US jurisdiction and issuer', () => {
      const fields: ExtractedFields = {
        jurisdiction: 'California',
        issuerName: 'State Bar of California',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).not.toContain('JURISDICTION_MISMATCH');
    });
  });

  // =========================================================================
  // COMBINED / EDGE CASES
  // =========================================================================

  describe('combined and edge cases', () => {
    it('caps confidence adjustment at -0.40', () => {
      const futureYear = new Date().getFullYear() + 6;
      const fields: ExtractedFields = {
        issuerName: 'Belford Online University',
        credentialType: 'DEGREE',
        degreeLevel: 'Doctorate',
        issuedDate: `${futureYear}-01-01`,
        expiryDate: '2020-01-01',
        jurisdiction: 'New York',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.confidenceAdjustment).toBeGreaterThanOrEqual(-0.40);
    });

    it('returns clean result for valid credential', () => {
      const fields: ExtractedFields = {
        credentialType: 'DEGREE',
        issuerName: 'Stanford University',
        degreeLevel: 'Master',
        fieldOfStudy: 'Computer Science',
        issuedDate: '2023-06-15',
        accreditingBody: 'WASC',
        jurisdiction: 'California',
      };
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toHaveLength(0);
      expect(result.confidenceAdjustment).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('deduplicates fraud signals', () => {
      // Both "issued after expiry" and "future date" can produce SUSPICIOUS_DATES
      // but they should be deduplicated
      const futureYear = new Date().getFullYear() + 6;
      const fields: ExtractedFields = {
        issuedDate: `${futureYear}-06-01`,
        expiryDate: '2020-01-01',
      };
      const result = runCrossFieldChecks(fields);
      const suspiciousCount = result.additionalFraudSignals.filter(
        (s) => s === 'SUSPICIOUS_DATES',
      ).length;
      expect(suspiciousCount).toBe(1);
    });

    it('handles empty fields gracefully', () => {
      const fields: ExtractedFields = {};
      const result = runCrossFieldChecks(fields);
      expect(result.additionalFraudSignals).toHaveLength(0);
      expect(result.confidenceAdjustment).toBe(0);
    });
  });
});

// =============================================================================
// SANITIZE CLE FIELDS
// =============================================================================

describe('sanitizeCLEFields', () => {
  it('strips barNumber from non-CLE LICENSE extraction', () => {
    const fields: ExtractedFields = {
      credentialType: 'LICENSE',
      issuerName: 'Supreme Court of Illinois',
      barNumber: '6789012',
      jurisdiction: 'Illinois, USA',
    };
    const stripped = sanitizeCLEFields(fields);
    expect(stripped).toContain('barNumber');
    expect(fields.barNumber).toBeUndefined();
    expect(fields.issuerName).toBe('Supreme Court of Illinois');
  });

  it('strips providerName and approvedBy from CERTIFICATE extraction', () => {
    const fields: ExtractedFields = {
      credentialType: 'CERTIFICATE',
      issuerName: 'CompTIA',
      providerName: 'CompTIA',
      approvedBy: 'CompTIA',
    };
    const stripped = sanitizeCLEFields(fields);
    expect(stripped).toContain('providerName');
    expect(stripped).toContain('approvedBy');
    expect((fields as Record<string, unknown>).providerName).toBeUndefined();
    expect((fields as Record<string, unknown>).approvedBy).toBeUndefined();
  });

  it('strips all CLE-only fields from DEGREE extraction', () => {
    const fields: ExtractedFields = {
      credentialType: 'DEGREE',
      issuerName: 'MIT',
      barNumber: '12345',
      creditHours: 3.0,
      creditType: 'Ethics',
      activityNumber: 'CLE-123',
      providerName: 'Law Academy',
      approvedBy: 'State Bar',
    };
    const stripped = sanitizeCLEFields(fields);
    expect(stripped).toHaveLength(6);
    expect(fields.issuerName).toBe('MIT');
    expect(fields.credentialType).toBe('DEGREE');
  });

  it('preserves all CLE-only fields for CLE type', () => {
    const fields: ExtractedFields = {
      credentialType: 'CLE',
      issuerName: 'State Bar CLE',
      barNumber: '12345',
      creditHours: 3.0,
      creditType: 'Ethics',
      providerName: 'Law Academy',
      approvedBy: 'California State Bar',
      activityNumber: 'CLE-2026-001',
    };
    const stripped = sanitizeCLEFields(fields);
    expect(stripped).toHaveLength(0);
    expect(fields.barNumber).toBe('12345');
    expect(fields.creditHours).toBe(3.0);
  });

  it('returns empty array when no CLE-only fields present', () => {
    const fields: ExtractedFields = {
      credentialType: 'LICENSE',
      issuerName: 'State Board',
      jurisdiction: 'Texas, USA',
    };
    const stripped = sanitizeCLEFields(fields);
    expect(stripped).toHaveLength(0);
  });

  it('handles case-insensitive CLE type', () => {
    const fields: ExtractedFields = {
      credentialType: 'cle',
      barNumber: '12345',
      creditHours: 2.0,
    };
    const stripped = sanitizeCLEFields(fields);
    expect(stripped).toHaveLength(0);
  });
});
