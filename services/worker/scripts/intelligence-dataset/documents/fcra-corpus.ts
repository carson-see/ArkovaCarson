/**
 * NVI-09 — Synthetic FCRA document corpus (SCRUM-813).
 *
 * Every entry is either synthetic (no PII ever) or anonymised (PII
 * stripped to [REDACTED] or synthetic placeholders). The `anonymisedAt`
 * field on each entry is the date the maintainer certified the strip.
 *
 * Seed corpus: 8 documents covering the key compliance surfaces. Lift
 * via distillation + anonymised production samples to get to 70+.
 */

import type { DocumentEntry } from '../document-grounded';

const ANON = '2026-04-17';

export const FCRA_DOCUMENT_CORPUS: DocumentEntry[] = [
  // ─── Adverse-action notices ───
  {
    id: 'aa-notice-deficient-001',
    kind: 'adverse-action-notice',
    description: 'Deficient §615(a) notice — missing CRA name/address + dispute rights',
    anonymisedAt: ANON,
    text:
      'Dear [APPLICANT NAME],\n\n' +
      'We regret to inform you that we cannot proceed with your application at this time. Thank you for your interest in [COMPANY].\n\n' +
      'Sincerely,\n[HR MANAGER]',
  },
  {
    id: 'aa-notice-compliant-001',
    kind: 'adverse-action-notice',
    description: 'Fully compliant §615(a) notice including CFPB Summary of Rights',
    anonymisedAt: ANON,
    text:
      'Dear [APPLICANT],\n\n' +
      'This letter is to inform you that we have decided not to move forward with your application for employment. This decision was based in whole or in part on information contained in a consumer report we obtained from:\n\n' +
      '  ACME Consumer Reports, Inc.\n' +
      '  1234 Example St., Suite 100\n' +
      '  City, ST 00000\n' +
      '  Toll-free: 1-800-555-0000\n\n' +
      'ACME Consumer Reports, Inc. did not make the decision to take adverse action and is unable to provide you with specific reasons. You have the right to obtain, within 60 days, a free copy of your consumer report from that consumer reporting agency. You also have the right to dispute the accuracy or completeness of any information contained in the report directly with ACME Consumer Reports, Inc.\n\n' +
      'Enclosed: A Summary of Your Rights Under the Fair Credit Reporting Act.\n\n' +
      'Sincerely,\n[HR DIRECTOR]',
  },
  // ─── Pre-adverse notices ───
  {
    id: 'pre-adverse-deficient-001',
    kind: 'pre-adverse-notice',
    description: 'Pre-adverse notice sent 1 business day before adverse action',
    anonymisedAt: ANON,
    text:
      'Dear [APPLICANT],\n\n' +
      'Based on a consumer report we received, we are considering taking adverse action on your application. A copy of the report and the Summary of Rights is enclosed.\n\n' +
      'We intend to finalize this decision tomorrow. If you have questions, contact [HR].',
  },
  // ─── §604(b)(2) standalone disclosures ───
  {
    id: 'disclosure-syed-violation-001',
    kind: 'standalone-disclosure',
    description: 'Disclosure bundled with authorization form and other application content — Syed violation pattern',
    anonymisedAt: ANON,
    text:
      'APPLICATION FOR EMPLOYMENT\n' +
      'Name: _______ Address: _______\n' +
      '\n' +
      'By signing below, I acknowledge that [COMPANY] may procure a consumer report about me for employment purposes, and I authorize [COMPANY] to do so. I also release [COMPANY] and the consumer reporting agency from any and all claims arising from the procurement or use of the report.\n' +
      '\n' +
      'Signature: _______ Date: _______',
  },
  {
    id: 'disclosure-compliant-001',
    kind: 'standalone-disclosure',
    description: 'Standalone §604(b)(2) disclosure — clear, conspicuous, no liability waiver',
    anonymisedAt: ANON,
    text:
      'DISCLOSURE REGARDING BACKGROUND INVESTIGATION\n' +
      '\n' +
      '[COMPANY] ("Employer") may obtain a "consumer report" about you from a consumer reporting agency for employment purposes. A consumer report may contain information about your character, general reputation, personal characteristics, and mode of living.\n' +
      '\n' +
      '[This disclosure is a standalone document. It contains no other content. Authorization is provided on a separate form.]',
  },
  // ─── Consumer reports ───
  {
    id: 'consumer-report-expired-001',
    kind: 'consumer-report',
    description: 'Tenant-screening report including a 9-year-old civil judgment — §605(a) violation',
    anonymisedAt: ANON,
    text:
      'TENANT SCREENING REPORT\n' +
      'Subject: [APPLICANT]\n' +
      'Date of report: 2026-04-01\n' +
      '\n' +
      'Public Records:\n' +
      '- Civil Judgment — Case # [REDACTED], Judgment date: 2017-02-14, Amount: $3,200, Status: Satisfied 2020-11\n' +
      '- Civil Judgment — Case # [REDACTED], Judgment date: 2023-06-05, Amount: $1,100, Status: Outstanding\n',
  },
  // ─── Credential verifications ───
  {
    id: 'credential-diploma-mill-001',
    kind: 'credential-verification',
    description: 'Degree verification referencing a known diploma-mill institution',
    anonymisedAt: ANON,
    text:
      'DEGREE VERIFICATION\n' +
      'Candidate: [APPLICANT]\n' +
      'Institution: "Oregon Pacific University" (listed on Oregon ODA unaccredited-institutions list)\n' +
      'Degree claimed: Ph.D., Organizational Leadership, conferred 2022\n' +
      'Verification source: Direct confirmation with registrar email listed on institution website (no accredited registrar database)',
  },
  // ─── Tenant screening (RealPage-style) ───
  {
    id: 'tenant-screening-realpage-001',
    kind: 'tenant-screening-report',
    description: 'Tenant screening report with potentially inaccurate criminal-history match',
    anonymisedAt: ANON,
    text:
      'TENANT SCREENING SUMMARY\n' +
      'Applicant: [APPLICANT] — DOB [REDACTED]\n' +
      'Criminal records:\n' +
      '  - 2019: Felony Fraud — matched on name only, no DOB verification\n' +
      'Recommendation: DECLINE\n' +
      '\n' +
      '(Note: name-only match is a common FTC RealPage-pattern source of inaccuracy complaints.)',
  },
];
