/**
 * Professional-education HELD-OUT eval set (SCRUM-2200).
 *
 * Deliberately HARD, adversarial, and out-of-distribution cases. This set is
 * NEVER wired into the fail-closed merge gates (eval-gates.ts) — the gate
 * fixtures live in golden-dataset-professional-education.ts and must stay
 * stable. This set exists to measure *real* model quality: the production
 * model (golden-v5) scores ~100% on the gate fixtures, which is a saturation
 * signal, not a quality signal. These entries are designed to drop F1 below
 * 100% and surface the model's actual failure modes (OCR noise, decoy IDs,
 * ethics-hour splits, hallucinated fields, non-US formats, unit traps).
 *
 * Discipline: treat this as a held-out TEST split. Do not tune on it, and do
 * not let it leak into the gate fixtures. When real PII-stripped prod traffic
 * becomes available (SCRUM-2200 Track B), labeled prod entries should grow a
 * second held-out split alongside this hand-authored one.
 *
 * PII rule (Constitution §1.6): strippedText models the on-device-stripped
 * payload. It must contain ZERO raw PII — only redaction placeholders such as
 * [NAME_REDACTED]. The accompanying test asserts this.
 */

import type { GoldenDatasetEntry } from './types.js';

export const PROFESSIONAL_EDUCATION_HELDOUT: GoldenDatasetEntry[] = [
  // ---------------------------------------------------------------------------
  // Category: OCR noise / glyph corruption — numbers and IDs mangled by OCR.
  // ---------------------------------------------------------------------------
  {
    id: 'GD-PE-HO-001',
    description: 'OCR-mangled credit hours (letter O for zero, l for 1) on CPE cert',
    strippedText:
      'Certiflcate of Continuing Professional Education. Participant: [NAME_REDACTED], CPA. Course: Advanced Auditing Standards. Course lD: AICPA-AUD-2026-O4l. CPE Credits: 8.O. Field of Study: Auditing. Delivery Method: Group lnternet Based. Provider: AICPA. NASBA Sponsor lD: 1l289l. Completion Date: Apr1l 3, 2026.',
    credentialTypeHint: 'CPE',
    groundTruth: {
      credentialType: 'CPE',
      issuerName: 'AICPA',
      issuedDate: '2026-04-03',
      fieldOfStudy: 'Auditing',
      accreditingBody: 'NASBA',
      creditHours: 8,
      creditType: 'CPE',
      providerName: 'AICPA',
      courseId: 'AICPA-AUD-2026-041',
      deliveryMethod: 'Group Internet Based',
      nasbaStatus: 'active',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/ocr-glyph-corruption',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'ocr-noise', 'cpe', 'course-id'],
  },
  {
    id: 'GD-PE-HO-002',
    description: 'OCR line-break splitting credit value across two tokens',
    strippedText:
      'CLE CERTIFICATE OF ATTENDANCE\nAttendee: [NAME_REDACTED]\nProgram: Trial Advocacy Intensive\nProgram Number: NITA-TA-2026-77\nTotal CLE Credit Hours: 12.\n5 (including 2.0 Ethics)\nFormat: In-Person\nSponsor: National Institute for Trial Advocacy\nState Bar Approval: California',
    credentialTypeHint: 'CLE',
    groundTruth: {
      credentialType: 'CLE',
      issuerName: 'National Institute for Trial Advocacy',
      fieldOfStudy: 'Trial Advocacy',
      jurisdiction: 'California',
      creditHours: 12.5,
      ethicsHours: 2,
      creditType: 'CLE',
      providerName: 'National Institute for Trial Advocacy',
      courseId: 'NITA-TA-2026-77',
      deliveryMethod: 'In-Person',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/ocr-linebreak-split',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'ocr-noise', 'cle', 'ethics', 'course-id'],
  },

  // ---------------------------------------------------------------------------
  // Category: Near-miss / decoy numbers — multiple plausible values present;
  // model must pick the course-specific one, not the cap/aggregate/decoy.
  // ---------------------------------------------------------------------------
  {
    id: 'GD-PE-HO-003',
    description: 'Decoy credit numbers: annual cap and prior balance precede true course credit',
    strippedText:
      'CPE COMPLETION RECORD. Annual CPE requirement: 40 credits. Credits earned year-to-date prior to this course: 31.0. This course: Ethics in Tax Practice. Course ID: SURGENT-ETH-2026-09. Credits awarded for THIS course: 4.0 (Regulatory Ethics: 4.0). Field of Study: Regulatory Ethics. Delivery Method: QAS Self-Study. Sponsor: Surgent. NASBA Registry: Active.',
    credentialTypeHint: 'CPE',
    groundTruth: {
      credentialType: 'CPE',
      issuerName: 'Surgent',
      fieldOfStudy: 'Regulatory Ethics',
      accreditingBody: 'NASBA',
      creditHours: 4,
      ethicsHours: 4,
      creditType: 'CPE Ethics',
      providerName: 'Surgent',
      courseId: 'SURGENT-ETH-2026-09',
      deliveryMethod: 'QAS Self-Study',
      nasbaStatus: 'active',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/decoy-credit-numbers',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'near-miss', 'cpe', 'ethics', 'course-id'],
  },
  {
    id: 'GD-PE-HO-004',
    description: 'Decoy IDs: NASBA sponsor ID and registry ID precede the real course ID',
    strippedText:
      'Continuing Professional Education Certificate. NASBA Sponsor ID: 103024. National Registry ID: 109876. Course ID: BECKER-FAR-2026-212. Course: Financial Accounting & Reporting Update. CPE Credits: 6.0. Field of Study: Accounting. Delivery Method: Group Internet Based. Provider: Becker. Participant: [NAME_REDACTED].',
    credentialTypeHint: 'CPE',
    groundTruth: {
      credentialType: 'CPE',
      issuerName: 'Becker',
      fieldOfStudy: 'Accounting',
      accreditingBody: 'NASBA',
      creditHours: 6,
      creditType: 'CPE',
      providerName: 'Becker',
      courseId: 'BECKER-FAR-2026-212',
      deliveryMethod: 'Group Internet Based',
      nasbaStatus: 'active',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/decoy-sponsor-ids',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'decoy-id', 'cpe', 'course-id'],
  },

  // ---------------------------------------------------------------------------
  // Category: Ethics-hour split subtlety — total credits include a partial
  // ethics component that must be separated, sometimes phrased indirectly.
  // ---------------------------------------------------------------------------
  {
    id: 'GD-PE-HO-005',
    description: 'Ethics hours stated only as a fraction of total ("of which")',
    strippedText:
      'STATE BAR CLE CERTIFICATE. Member: [NAME_REDACTED]. Course: Professional Responsibility & Civility. Activity ID: NYSBA-PR-2026-318. Credits: 3.0 total, of which 1.5 are Ethics & Professionalism. Format: Live Webcast. Provider: New York State Bar Association. Jurisdiction: New York.',
    credentialTypeHint: 'CLE',
    groundTruth: {
      credentialType: 'CLE',
      issuerName: 'New York State Bar Association',
      fieldOfStudy: 'Professional Responsibility',
      jurisdiction: 'New York',
      creditHours: 3,
      ethicsHours: 1.5,
      creditType: 'CLE Ethics',
      providerName: 'New York State Bar Association',
      activityNumber: 'NYSBA-PR-2026-318',
      courseId: 'NYSBA-PR-2026-318',
      deliveryMethod: 'Live Webcast',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/ethics-fraction-of-total',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'ethics', 'cle', 'course-id'],
  },
  {
    id: 'GD-PE-HO-006',
    description: 'No ethics component — model must NOT hallucinate ethicsHours',
    strippedText:
      'CPE Certificate. Course: Data Analytics for Auditors. Course ID: KPMG-DA-2026-55. CPE Credits: 5.0. Field of Study: Information Technology. Delivery Method: Group Live. Provider: KPMG Executive Education. Participant: [NAME_REDACTED]. No ethics credit awarded.',
    credentialTypeHint: 'CPE',
    groundTruth: {
      credentialType: 'CPE',
      issuerName: 'KPMG Executive Education',
      fieldOfStudy: 'Information Technology',
      creditHours: 5,
      creditType: 'CPE',
      providerName: 'KPMG Executive Education',
      courseId: 'KPMG-DA-2026-55',
      deliveryMethod: 'Group Live',
      fraudSignals: [],
      // ethicsHours intentionally omitted — extracting any value is a false positive.
    },
    source: 'synthetic/pe-heldout/no-ethics-hallucination-trap',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'hallucination-trap', 'cpe', 'course-id'],
  },

  // ---------------------------------------------------------------------------
  // Category: Delivery-method ambiguity — nonstandard phrasings that map to a
  // canonical NASBA/bar delivery method.
  // ---------------------------------------------------------------------------
  {
    id: 'GD-PE-HO-007',
    description: 'Delivery method phrased as "on-demand recording" (maps to Self-Study)',
    strippedText:
      'CPE Certificate of Completion. Course: Lease Accounting Under ASC 842. Course ID: PWC-LEASE-2026-14. CPE Credits: 2.0. Field of Study: Accounting. Format: On-demand recorded webcast (no live instructor). Provider: PwC. NASBA Registry: Active. Participant: [NAME_REDACTED].',
    credentialTypeHint: 'CPE',
    groundTruth: {
      credentialType: 'CPE',
      issuerName: 'PwC',
      fieldOfStudy: 'Accounting',
      accreditingBody: 'NASBA',
      creditHours: 2,
      creditType: 'CPE',
      providerName: 'PwC',
      courseId: 'PWC-LEASE-2026-14',
      deliveryMethod: 'Self-Study',
      nasbaStatus: 'active',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/delivery-ondemand-selfstudy',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'delivery-ambiguity', 'cpe', 'course-id'],
  },

  // ---------------------------------------------------------------------------
  // Category: Out-of-distribution / international formats.
  // ---------------------------------------------------------------------------
  {
    id: 'GD-PE-HO-008',
    description: 'UK SRA CPD record (non-US CLE analogue) with "hours" not "credits"',
    strippedText:
      'CONTINUING COMPETENCE RECORD (SRA). Solicitor: [NAME_REDACTED]. Activity: Anti-Money Laundering Update 2026. Reference: LAWSOC-AML-2026-091. Hours of Learning: 4.0. Topic: Regulatory Compliance. Mode: Attended seminar (in person). Provider: The Law Society of England and Wales. Jurisdiction: England & Wales.',
    credentialTypeHint: 'CLE',
    groundTruth: {
      credentialType: 'CLE',
      issuerName: 'The Law Society of England and Wales',
      fieldOfStudy: 'Regulatory Compliance',
      jurisdiction: 'England & Wales',
      creditHours: 4,
      creditType: 'CPD',
      providerName: 'The Law Society of England and Wales',
      courseId: 'LAWSOC-AML-2026-091',
      deliveryMethod: 'In-Person',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/ood-uk-sra-cpd',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'ood', 'international', 'cle', 'course-id'],
  },
  {
    id: 'GD-PE-HO-009',
    description: 'Canadian CPD (Law Society of Ontario) with EDI hours instead of ethics',
    strippedText:
      'LAW SOCIETY OF ONTARIO — CPD HOURS CONFIRMATION. Licensee: [NAME_REDACTED]. Program: Practice Management & Professionalism. Program ID: LSO-PM-2026-402. Total CPD Hours: 6.0, comprising 1.0 Professionalism hours and 5.0 Substantive hours. Delivery: Live webinar. Jurisdiction: Ontario.',
    credentialTypeHint: 'CLE',
    groundTruth: {
      credentialType: 'CLE',
      issuerName: 'Law Society of Ontario',
      fieldOfStudy: 'Practice Management',
      jurisdiction: 'Ontario',
      creditHours: 6,
      ethicsHours: 1,
      creditType: 'CPD',
      providerName: 'Law Society of Ontario',
      courseId: 'LSO-PM-2026-402',
      deliveryMethod: 'Live Webinar',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/ood-canada-lso-cpd',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'ood', 'international', 'cle', 'ethics', 'course-id'],
  },

  // ---------------------------------------------------------------------------
  // Category: Unit traps — "units" or "minutes" that are NOT 1:1 with hours.
  // ---------------------------------------------------------------------------
  {
    id: 'GD-PE-HO-010',
    description: '50-minute CLE hour jurisdiction: 300 minutes = 6.0 credit hours',
    strippedText:
      'MCLE CERTIFICATE. Attendee: [NAME_REDACTED]. Program: Evidence & Trial Practice. Course ID: PLI-EVID-2026-188. Total instructional time: 300 minutes. Note: this jurisdiction defines one CLE hour as 50 minutes. Ethics minutes included: 60. Format: Group Internet Based. Provider: Practising Law Institute. Jurisdiction: California.',
    credentialTypeHint: 'CLE',
    groundTruth: {
      credentialType: 'CLE',
      issuerName: 'Practising Law Institute',
      fieldOfStudy: 'Evidence',
      jurisdiction: 'California',
      creditHours: 6,
      ethicsHours: 1.2,
      creditType: 'CLE',
      providerName: 'Practising Law Institute',
      courseId: 'PLI-EVID-2026-188',
      deliveryMethod: 'Group Internet Based',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/unit-trap-50min-hour',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'unit-trap', 'cle', 'ethics', 'course-id'],
  },

  // ---------------------------------------------------------------------------
  // Category: Missing-field traps — a gate-scored field is genuinely absent;
  // the model must leave it blank rather than fabricate a plausible value.
  // ---------------------------------------------------------------------------
  {
    id: 'GD-PE-HO-011',
    description: 'No course ID present — extracting any ID is a false positive',
    strippedText:
      'CPE Attendance Confirmation. Course: Fraud Risk Management Workshop. CPE Credits: 7.0. Field of Study: Auditing. Delivery Method: Group Live. Provider: ACFE. Participant: [NAME_REDACTED]. (No course or program identifier printed on this certificate.)',
    credentialTypeHint: 'CPE',
    groundTruth: {
      credentialType: 'CPE',
      issuerName: 'ACFE',
      fieldOfStudy: 'Auditing',
      creditHours: 7,
      creditType: 'CPE',
      providerName: 'ACFE',
      deliveryMethod: 'Group Live',
      fraudSignals: [],
      // courseId intentionally omitted — no identifier exists on the document.
    },
    source: 'synthetic/pe-heldout/no-course-id-hallucination-trap',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'hallucination-trap', 'cpe'],
  },
  {
    id: 'GD-PE-HO-012',
    description: 'Field of study absent — generic completion letter, must not infer',
    strippedText:
      'This letter confirms that [NAME_REDACTED] attended and completed our continuing education program on March 9, 2026. Program reference: GENERIC-CE-2026-001. A total of 3.0 continuing education credits were awarded. Delivered live in person. Issued by Metro Professional Development Center.',
    credentialTypeHint: 'CPE',
    groundTruth: {
      credentialType: 'CPE',
      issuerName: 'Metro Professional Development Center',
      issuedDate: '2026-03-09',
      creditHours: 3,
      creditType: 'CPE',
      providerName: 'Metro Professional Development Center',
      courseId: 'GENERIC-CE-2026-001',
      deliveryMethod: 'Group Live',
      fraudSignals: [],
      // fieldOfStudy intentionally omitted — the document names no subject area.
    },
    source: 'synthetic/pe-heldout/no-field-of-study-trap',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'hallucination-trap', 'cpe', 'course-id'],
  },

  // ---------------------------------------------------------------------------
  // Category: Adversarial / fraud-ish — values that look valid but carry a
  // signal (inactive sponsor, expired window, mismatched totals).
  // ---------------------------------------------------------------------------
  {
    id: 'GD-PE-HO-013',
    description: 'Inactive NASBA sponsor — status must be captured, not assumed active',
    strippedText:
      'CPE Certificate. Course: Cryptocurrency Tax Reporting. Course ID: INDIE-CRYPTO-2026-07. CPE Credits: 4.0. Field of Study: Taxes. Delivery Method: Self-Study. Provider: Independent CPE LLC. NASBA Registry Status: INACTIVE (sponsorship lapsed 2025-12-31). Participant: [NAME_REDACTED].',
    credentialTypeHint: 'CPE',
    groundTruth: {
      credentialType: 'CPE',
      issuerName: 'Independent CPE LLC',
      fieldOfStudy: 'Taxes',
      accreditingBody: 'NASBA',
      creditHours: 4,
      creditType: 'CPE',
      providerName: 'Independent CPE LLC',
      courseId: 'INDIE-CRYPTO-2026-07',
      deliveryMethod: 'Self-Study',
      nasbaStatus: 'inactive',
      fraudSignals: ['nasba_sponsor_inactive'],
    },
    source: 'synthetic/pe-heldout/inactive-sponsor',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'adversarial', 'cpe', 'course-id'],
  },
  {
    id: 'GD-PE-HO-014',
    description: 'Internally inconsistent totals — ethics exceeds stated total credits',
    strippedText:
      'CLE CERTIFICATE. Attendee: [NAME_REDACTED]. Course: Legal Ethics Marathon. Program Number: BARBRI-ETH-2026-501. Total CLE Credits: 2.0. Ethics Credits: 3.0. Format: Live Webcast. Provider: BARBRI. Jurisdiction: Texas. (Note: figures as printed.)',
    credentialTypeHint: 'CLE',
    groundTruth: {
      credentialType: 'CLE',
      issuerName: 'BARBRI',
      fieldOfStudy: 'Legal Ethics',
      jurisdiction: 'Texas',
      creditHours: 2,
      ethicsHours: 3,
      creditType: 'CLE Ethics',
      providerName: 'BARBRI',
      courseId: 'BARBRI-ETH-2026-501',
      deliveryMethod: 'Live Webcast',
      manualReviewExpected: true,
      fraudSignals: ['ethics_exceeds_total'],
    },
    source: 'synthetic/pe-heldout/inconsistent-totals',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'adversarial', 'cle', 'ethics', 'course-id'],
  },

  // ---------------------------------------------------------------------------
  // Category: Dense / multi-course documents — the relevant course must be
  // isolated from a transcript-style list.
  // ---------------------------------------------------------------------------
  {
    id: 'GD-PE-HO-015',
    description: 'CPE transcript listing three courses; certificate is for the highlighted one',
    strippedText:
      'CPE TRANSCRIPT — [NAME_REDACTED]. Prior courses: (1) Excel for Accountants — 2.0 — Computer Software; (2) State Tax Nexus — 3.0 — Taxes. THIS CERTIFICATE CERTIFIES COMPLETION OF: Course: Governmental Accounting Standards. Course ID: GFOA-GAS-2026-29. CPE Credits: 8.0. Field of Study: Accounting (Governmental). Delivery Method: Group Internet Based. Provider: GFOA.',
    credentialTypeHint: 'CPE',
    groundTruth: {
      credentialType: 'CPE',
      issuerName: 'GFOA',
      fieldOfStudy: 'Accounting (Governmental)',
      creditHours: 8,
      creditType: 'CPE',
      providerName: 'GFOA',
      courseId: 'GFOA-GAS-2026-29',
      deliveryMethod: 'Group Internet Based',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/multi-course-transcript',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'multi-course', 'cpe', 'course-id'],
  },
  {
    id: 'GD-PE-HO-016',
    description: 'Course ID embedded mid-sentence with unusual delimiter',
    strippedText:
      'This is to certify completion of the program referenced as course#WEBCE-INS-2026/0834 entitled "Insurance Ethics and Suitability." Continuing education credit awarded: 4.0 hours, including 2.0 ethics hours. Delivered via online self-study. Field of study: Insurance. Provider: WebCE. Recipient: [NAME_REDACTED]. State: Florida.',
    credentialTypeHint: 'CLE',
    groundTruth: {
      credentialType: 'CLE',
      issuerName: 'WebCE',
      fieldOfStudy: 'Insurance',
      jurisdiction: 'Florida',
      creditHours: 4,
      ethicsHours: 2,
      creditType: 'CE Ethics',
      providerName: 'WebCE',
      courseId: 'WEBCE-INS-2026/0834',
      deliveryMethod: 'Self-Study',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/embedded-course-id-delimiter',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'embedded-id', 'cle', 'ethics', 'course-id'],
  },

  // ---------------------------------------------------------------------------
  // Category: Half-credit and fractional values that are easy to round wrong.
  // ---------------------------------------------------------------------------
  {
    id: 'GD-PE-HO-017',
    description: 'Fractional credits expressed as words then digits',
    strippedText:
      'CPE Certificate. Course: Quarterly Accounting & Auditing Update. Course ID: SURGENT-AA-2026-Q1. Credits: one and one-half (1.5) CPE hours. Field of Study: Accounting. Delivery Method: Nano-Learning. Provider: Surgent. NASBA Registry: Active. Participant: [NAME_REDACTED].',
    credentialTypeHint: 'CPE',
    groundTruth: {
      credentialType: 'CPE',
      issuerName: 'Surgent',
      fieldOfStudy: 'Accounting',
      accreditingBody: 'NASBA',
      creditHours: 1.5,
      creditType: 'CPE',
      providerName: 'Surgent',
      courseId: 'SURGENT-AA-2026-Q1',
      deliveryMethod: 'Nano-Learning',
      nasbaStatus: 'active',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/fractional-words-and-digits',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'fractional', 'cpe', 'course-id'],
  },
  {
    id: 'GD-PE-HO-018',
    description: 'Combined CPE+CLE certificate — dual credit, must not double-count',
    strippedText:
      'JOINT CPE/CLE CERTIFICATE. Course: Tax Controversy & IRS Practice. Program ID: ABA-TAX-2026-66. This program is approved for 5.0 CLE credit hours (1.0 ethics) and separately for 5.0 CPE credits (Field of Study: Taxes). Delivery: Group Live. Provider: American Bar Association. Attendee: [NAME_REDACTED]. Jurisdiction: Illinois.',
    credentialTypeHint: 'CLE',
    issuerHint: 'American Bar Association',
    groundTruth: {
      credentialType: 'CLE',
      issuerName: 'American Bar Association',
      fieldOfStudy: 'Taxes',
      jurisdiction: 'Illinois',
      creditHours: 5,
      ethicsHours: 1,
      creditType: 'CLE Ethics',
      providerName: 'American Bar Association',
      courseId: 'ABA-TAX-2026-66',
      deliveryMethod: 'Group Live',
      fraudSignals: [],
    },
    source: 'synthetic/pe-heldout/joint-cpe-cle-dual-credit',
    category: 'professional-education-heldout',
    tags: ['synthetic', 'professional-education', 'held-out', 'hard', 'dual-credit', 'cle', 'cpe', 'ethics', 'course-id'],
  },
];
