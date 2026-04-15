/**
 * GRE-03: Fraud Reasoning Engine Tests
 *
 * TDD — tests written FIRST, implementation follows.
 * Tests cover diploma mill detection, date anomalies, content plausibility,
 * cross-reference integration, and edge cases.
 *
 * Constitution 1.6: Only PII-stripped metadata is tested.
 */

import { describe, it, expect } from 'vitest';
import {
  assessFraud,
  type FraudAssessmentInput,
} from './fraudReasoning.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeInput(overrides: Partial<FraudAssessmentInput> = {}): FraudAssessmentInput {
  return {
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'Harvard University',
      issuedDate: '2024-06-01',
      degreeLevel: 'Bachelor',
      fieldOfStudy: 'Computer Science',
      fraudSignals: [],
    },
    crossReferenceResult: {
      issuerFound: true,
      matches: [
        {
          source: 'dapip',
          sourceId: '166027',
          title: 'Harvard University',
          confidence: 'exact',
          metadata: {},
        },
      ],
      context: 'Issuer "Harvard University" was FOUND in verified databases.',
    },
    rawText: 'Harvard University. Bachelor of Science in Computer Science. Conferred June 2024.',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('fraudReasoning', () => {
  describe('assessFraud', () => {
    // -------------------------------------------------------------------------
    // 1. Clean, legitimate credentials → LOW risk
    // -------------------------------------------------------------------------

    it('returns LOW risk for a clean Harvard credential verified in pipeline', () => {
      const input = makeInput();
      const result = assessFraud(input);

      expect(result.riskLevel).toBe('LOW');
      expect(result.score).toBeLessThanOrEqual(0.2);
      expect(result.signals).toEqual([]);
      expect(result.concerns).toEqual([]);
      expect(result.reasoning).toBeTruthy();
    });

    it('returns LOW risk for a clean license from a verified state board', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'LICENSE',
          issuerName: 'Texas Board of Nursing',
          issuedDate: '2024-01-15',
          expiryDate: '2026-01-15',
          fieldOfStudy: 'Nursing',
          licenseNumber: 'RN-445566',
          jurisdiction: 'Texas, USA',
          fraudSignals: [],
        },
        crossReferenceResult: {
          issuerFound: true,
          matches: [{ source: 'dapip', sourceId: '1', title: 'Texas Board of Nursing', confidence: 'exact', metadata: {} }],
          context: 'Found.',
        },
        rawText: 'Texas Board of Nursing. Licensed Vocational Nurse.',
      });
      const result = assessFraud(input);

      expect(result.riskLevel).toBe('LOW');
      expect(result.score).toBeLessThanOrEqual(0.2);
    });

    it('returns LOW risk for an expired but legitimate credential (expiry is not fraud)', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'LICENSE',
          issuerName: 'California Board of Registered Nursing',
          issuedDate: '2020-01-01',
          expiryDate: '2022-01-01', // expired
          fieldOfStudy: 'Nursing',
          licenseNumber: 'RN-123456',
          jurisdiction: 'California, USA',
          fraudSignals: [],
        },
        crossReferenceResult: {
          issuerFound: true,
          matches: [{ source: 'dapip', sourceId: '2', title: 'California Board of Registered Nursing', confidence: 'exact', metadata: {} }],
          context: 'Found.',
        },
        rawText: 'California Board of Registered Nursing. Expired 2022.',
      });
      const result = assessFraud(input);

      expect(result.riskLevel).toBe('LOW');
      expect(result.signals).not.toContain('EXPIRED_CREDENTIAL_FRAUD');
    });

    // -------------------------------------------------------------------------
    // 2. Diploma mill detection → CRITICAL
    // -------------------------------------------------------------------------

    it('returns CRITICAL risk for Belford University (known diploma mill)', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'DEGREE',
          issuerName: 'Belford University',
          degreeLevel: 'Doctorate',
          fieldOfStudy: 'Business Administration',
          fraudSignals: ['EXPIRED_ISSUER'],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: 'Not found in verified databases.',
        },
        rawText: 'Belford University. Doctor of Business Administration. Life experience. No coursework required.',
      });
      const result = assessFraud(input);

      expect(result.riskLevel).toBe('CRITICAL');
      expect(result.score).toBeGreaterThanOrEqual(0.9);
      expect(result.signals).toContain('DIPLOMA_MILL');
      expect(result.reasoning).toContain('diploma mill');
    });

    it('returns CRITICAL risk for Ashwood University (known diploma mill)', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'DEGREE',
          issuerName: 'Ashwood University',
          degreeLevel: 'Master',
          fieldOfStudy: 'Management',
          fraudSignals: [],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: 'Not found.',
        },
        rawText: 'Ashwood University. Master of Management.',
      });
      const result = assessFraud(input);

      expect(result.riskLevel).toBe('CRITICAL');
      expect(result.signals).toContain('DIPLOMA_MILL');
    });

    // -------------------------------------------------------------------------
    // 3. Date anomalies → HIGH
    // -------------------------------------------------------------------------

    it('returns HIGH risk when issued date is after expiry date', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'LICENSE',
          issuerName: 'Texas Board of Nursing',
          issuedDate: '2028-03-15',
          expiryDate: '2025-12-31',
          fieldOfStudy: 'Nursing',
          licenseNumber: 'LVN-778899',
          jurisdiction: 'Texas, USA',
          fraudSignals: ['SUSPICIOUS_DATES'],
        },
        crossReferenceResult: {
          issuerFound: true,
          matches: [{ source: 'dapip', sourceId: '1', title: 'Texas Board of Nursing', confidence: 'exact', metadata: {} }],
          context: 'Found.',
        },
        rawText: 'Texas Board of Nursing. Issue Date: March 15, 2028. Expiration: December 31, 2025.',
      });
      const result = assessFraud(input);

      expect(result.riskLevel).toBe('HIGH');
      expect(result.score).toBeGreaterThanOrEqual(0.5);
      expect(result.signals).toContain('SUSPICIOUS_DATES');
      expect(result.concerns.length).toBeGreaterThan(0);
    });

    it('returns HIGH risk for a far-future issued date', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'DEGREE',
          issuerName: 'MIT',
          issuedDate: '2031-12-15',
          degreeLevel: 'Doctorate',
          fieldOfStudy: 'Electrical Engineering',
          fraudSignals: ['SUSPICIOUS_DATES'],
        },
        crossReferenceResult: {
          issuerFound: true,
          matches: [{ source: 'ipeds', sourceId: '166683', title: 'Massachusetts Institute of Technology', confidence: 'partial', metadata: {} }],
          context: 'Found.',
        },
        rawText: 'MIT. PhD. Conferred December 15, 2031.',
      });
      const result = assessFraud(input);

      expect(result.riskLevel).toBe('HIGH');
      expect(result.signals).toContain('SUSPICIOUS_DATES');
    });

    // -------------------------------------------------------------------------
    // 4. Content plausibility — "no coursework" doctorate → HIGH
    // -------------------------------------------------------------------------

    it('returns HIGH risk for a doctorate requiring no coursework', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'DEGREE',
          issuerName: 'Unknown Online University',
          degreeLevel: 'Doctorate',
          fieldOfStudy: 'Business Administration',
          fraudSignals: [],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: 'Not found.',
        },
        rawText: 'Unknown Online University. Doctor of Business Administration. Based on life experience. No coursework required. Processing fee: $549.',
      });
      const result = assessFraud(input);

      expect(result.riskLevel).toBe('HIGH');
      expect(result.score).toBeGreaterThanOrEqual(0.6);
      expect(result.signals).toContain('CONTENT_IMPLAUSIBILITY');
    });

    it('returns HIGH risk for "instant degree" language', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'DEGREE',
          issuerName: 'Global Online University',
          degreeLevel: 'Master',
          fieldOfStudy: 'Business',
          fraudSignals: [],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: 'Not found.',
        },
        rawText: 'Global Online University. Masters degree delivered within 7 days. No classes. No exams. Just pay the fee.',
      });
      const result = assessFraud(input);

      expect(result.riskLevel).toMatch(/HIGH|CRITICAL/);
      expect(result.signals).toContain('CONTENT_IMPLAUSIBILITY');
    });

    // -------------------------------------------------------------------------
    // 5. Unknown issuer (not in pipeline, not known mill) → MEDIUM at most
    // -------------------------------------------------------------------------

    it('returns MEDIUM at most for an unknown but plausible issuer', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'CERTIFICATE',
          issuerName: 'Small Regional Training Institute',
          issuedDate: '2024-03-01',
          fieldOfStudy: 'First Aid',
          fraudSignals: [],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: 'Not found in verified databases.',
        },
        rawText: 'Small Regional Training Institute. Certificate of First Aid Training. March 2024.',
      });
      const result = assessFraud(input);

      expect(['LOW', 'MEDIUM']).toContain(result.riskLevel);
      expect(result.score).toBeLessThanOrEqual(0.5);
    });

    // -------------------------------------------------------------------------
    // 6. Cross-reference integration — found issuer lowers risk
    // -------------------------------------------------------------------------

    it('scores lower risk when issuer is verified in pipeline vs not', () => {
      const baseFields = {
        credentialType: 'DEGREE',
        issuerName: 'University of Michigan',
        issuedDate: '2024-06-01',
        degreeLevel: 'Bachelor',
        fieldOfStudy: 'Engineering',
        fraudSignals: [] as string[],
      };

      const verified = assessFraud(makeInput({
        extractedFields: baseFields,
        crossReferenceResult: {
          issuerFound: true,
          matches: [{ source: 'dapip', sourceId: '170976', title: 'University of Michigan', confidence: 'exact', metadata: {} }],
          context: 'Found.',
        },
        rawText: 'University of Michigan. Bachelor of Engineering.',
      }));

      const unverified = assessFraud(makeInput({
        extractedFields: baseFields,
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: 'Not found.',
        },
        rawText: 'University of Michigan. Bachelor of Engineering.',
      }));

      expect(verified.score).toBeLessThan(unverified.score);
    });

    // -------------------------------------------------------------------------
    // 7. Format anomalies
    // -------------------------------------------------------------------------

    it('returns MEDIUM+ risk for a degree with no issuer and no accrediting body', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'DEGREE',
          degreeLevel: 'Doctorate',
          fieldOfStudy: 'Advanced Sciences',
          fraudSignals: ['FORMAT_ANOMALY', 'MISSING_ACCREDITATION'],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: 'No issuer to check.',
        },
        rawText: 'DOCTORAL DEGREE. Ph.D. in Advanced Sciences. This document certifies completion.',
      });
      const result = assessFraud(input);

      expect(result.score).toBeGreaterThanOrEqual(0.4);
      expect(result.signals).toContain('FORMAT_ANOMALY');
    });

    // -------------------------------------------------------------------------
    // 8. Jurisdiction mismatch
    // -------------------------------------------------------------------------

    it('flags jurisdiction mismatch when present in extraction signals', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'LICENSE',
          issuerName: 'California Board of Nursing',
          jurisdiction: 'Ontario, Canada',
          fraudSignals: ['JURISDICTION_MISMATCH'],
        },
        crossReferenceResult: {
          issuerFound: true,
          matches: [{ source: 'dapip', sourceId: '3', title: 'California Board of Nursing', confidence: 'exact', metadata: {} }],
          context: 'Found.',
        },
        rawText: 'California Board of Nursing. Licensed in Ontario, Canada.',
      });
      const result = assessFraud(input);

      expect(result.signals).toContain('JURISDICTION_MISMATCH');
      expect(result.score).toBeGreaterThan(0.2);
    });

    // -------------------------------------------------------------------------
    // 9. Combined signals escalate risk
    // -------------------------------------------------------------------------

    it('escalates to CRITICAL when diploma mill + no coursework + not in pipeline', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'DEGREE',
          issuerName: 'Belford University',
          degreeLevel: 'Doctorate',
          fieldOfStudy: 'Business Administration',
          fraudSignals: ['EXPIRED_ISSUER', 'MISSING_ACCREDITATION', 'FORMAT_ANOMALY'],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: 'Not found.',
        },
        rawText: 'Belford University. Online Division. Doctor of Business Administration. No coursework required. Processing fee: $549. Delivered within 7 days.',
      });
      const result = assessFraud(input);

      expect(result.riskLevel).toBe('CRITICAL');
      expect(result.score).toBeGreaterThanOrEqual(0.9);
      expect(result.signals.length).toBeGreaterThanOrEqual(2);
    });

    // -------------------------------------------------------------------------
    // 10. International credentials — should not be penalized
    // -------------------------------------------------------------------------

    it('returns LOW risk for legitimate Kenyan credential', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'DEGREE',
          issuerName: 'University of Nairobi',
          issuedDate: '2024-07-01',
          degreeLevel: 'Bachelor',
          fieldOfStudy: 'Law',
          jurisdiction: 'Kenya',
          fraudSignals: [],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: 'Not found in verified databases.',
        },
        rawText: 'University of Nairobi. Bachelor of Laws. Conferred July 2024.',
      });
      const result = assessFraud(input);

      // Unknown issuer but no fraud signals → MEDIUM at most
      expect(['LOW', 'MEDIUM']).toContain(result.riskLevel);
      expect(result.score).toBeLessThanOrEqual(0.4);
    });

    it('returns LOW risk for legitimate Australian credential', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'DEGREE',
          issuerName: 'University of Melbourne',
          issuedDate: '2024-03-15',
          degreeLevel: 'Master',
          fieldOfStudy: 'Data Science',
          jurisdiction: 'Australia',
          fraudSignals: [],
        },
        crossReferenceResult: {
          issuerFound: true,
          matches: [{ source: 'acnc', sourceId: 'mel1', title: 'University of Melbourne', confidence: 'exact', metadata: {} }],
          context: 'Found in ACNC.',
        },
        rawText: 'University of Melbourne. Master of Data Science. March 2024.',
      });
      const result = assessFraud(input);

      expect(result.riskLevel).toBe('LOW');
      expect(result.score).toBeLessThanOrEqual(0.15);
    });

    // -------------------------------------------------------------------------
    // 11. Suspicious issuer patterns
    // -------------------------------------------------------------------------

    it('returns HIGH+ risk for suspicious issuer name patterns', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'DEGREE',
          issuerName: 'Life Experience Degree Academy',
          degreeLevel: 'Master',
          fieldOfStudy: 'Business',
          fraudSignals: [],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: 'Not found.',
        },
        rawText: 'Life Experience Degree Academy. Master of Business.',
      });
      const result = assessFraud(input);

      expect(result.score).toBeGreaterThanOrEqual(0.6);
      expect(result.signals).toContain('SUSPICIOUS_ISSUER');
    });

    // -------------------------------------------------------------------------
    // 12. No extraction data → graceful degradation
    // -------------------------------------------------------------------------

    it('handles minimal input gracefully', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'OTHER',
          fraudSignals: [],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: '',
        },
        rawText: '',
      });
      const result = assessFraud(input);

      expect(result.riskLevel).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.reasoning).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // 13. Fake accrediting body
    // -------------------------------------------------------------------------

    it('returns HIGH risk for fake accrediting body', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'DEGREE',
          issuerName: 'Some University',
          degreeLevel: 'Bachelor',
          fieldOfStudy: 'Business',
          accreditingBody: 'World Association of Universities and Colleges',
          fraudSignals: ['MISSING_ACCREDITATION'],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: 'Not found.',
        },
        rawText: 'Some University. Accredited by World Association of Universities and Colleges.',
      });
      const result = assessFraud(input);

      expect(result.score).toBeGreaterThanOrEqual(0.5);
      expect(result.signals).toContain('FAKE_ACCREDITOR');
    });

    // -------------------------------------------------------------------------
    // 14. Output structure validation
    // -------------------------------------------------------------------------

    it('always returns all required fields in FraudAssessment', () => {
      const input = makeInput();
      const result = assessFraud(input);

      expect(result).toHaveProperty('riskLevel');
      expect(result).toHaveProperty('signals');
      expect(result).toHaveProperty('reasoning');
      expect(result).toHaveProperty('concerns');
      expect(result).toHaveProperty('score');
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(result.riskLevel);
      expect(Array.isArray(result.signals)).toBe(true);
      expect(Array.isArray(result.concerns)).toBe(true);
      expect(typeof result.reasoning).toBe('string');
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });

    // -------------------------------------------------------------------------
    // 15. Doctorate from coding bootcamp → HIGH (implausible)
    // -------------------------------------------------------------------------

    it('returns HIGH risk for doctorate from a coding bootcamp', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'DEGREE',
          issuerName: 'App Academy Coding Bootcamp',
          degreeLevel: 'Doctorate',
          fieldOfStudy: 'Computer Science',
          fraudSignals: ['FORMAT_ANOMALY'],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: 'Not found.',
        },
        rawText: 'App Academy Coding Bootcamp. Doctor of Computer Science.',
      });
      const result = assessFraud(input);

      expect(result.score).toBeGreaterThanOrEqual(0.5);
      expect(result.riskLevel).toMatch(/HIGH|CRITICAL/);
    });

    // -------------------------------------------------------------------------
    // 16. Pre-existing extraction fraud signals are carried forward
    // -------------------------------------------------------------------------

    it('carries forward fraud signals from extraction into assessment', () => {
      const input = makeInput({
        extractedFields: {
          credentialType: 'LICENSE',
          issuerName: 'Some Board',
          fraudSignals: ['SUSPICIOUS_DATES', 'FORMAT_ANOMALY'],
        },
        crossReferenceResult: {
          issuerFound: false,
          matches: [],
          context: '',
        },
        rawText: '',
      });
      const result = assessFraud(input);

      expect(result.signals).toContain('SUSPICIOUS_DATES');
      expect(result.signals).toContain('FORMAT_ANOMALY');
    });
  });
});
