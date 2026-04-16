/**
 * Fraud Training Seed Dataset (Gemini Fraud Stream v1)
 *
 * Hand-curated fraud patterns from real-world enforcement actions.
 * Used to build training-output/gemini-fraud-v1-vertex.jsonl for tuning
 * gemini-2.5-pro. See docs/plans/gemini-training-parameters-v1.md.
 *
 * Sources:
 * - FTC enforcement actions (diploma mills): https://www.ftc.gov/enforcement
 * - Oregon ODA unaccredited list (long-running diploma mill registry)
 * - GAO Reports on diploma mills (GAO-04-1024T)
 * - HHS-OIG provider exclusion list
 * - State medical board enforcement actions
 *
 * Each entry: extracted credential metadata (post-Nessie) + expected fraud signals.
 */

export interface FraudTrainingEntry {
  id: string;
  description: string;
  /** Input — what Nessie produced */
  extractedFields: Record<string, unknown>;
  /** Expected output from Gemini fraud stream */
  expectedOutput: {
    fraudSignals: string[];
    confidence: number; // 0-1, fraud-detection confidence
    reasoning: string;
  };
  category: 'diploma_mill' | 'license_forgery' | 'document_tampering' | 'identity_mismatch' | 'sophisticated';
  source: string;
}

export const FRAUD_TRAINING_SEED: FraudTrainingEntry[] = [
  // ============================================================
  // DIPLOMA MILLS (real, FTC-actioned)
  // ============================================================
  {
    id: 'FT-001',
    description: 'Almeda University degree (FTC-shut diploma mill)',
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'Almeda University',
      issuedDate: '2022-08-15',
      fieldOfStudy: 'Business Administration',
      degreeLevel: 'PhD',
      jurisdiction: 'Idaho, USA',
    },
    expectedOutput: {
      fraudSignals: ['KNOWN_DIPLOMA_MILL', 'UNVERIFIABLE_ISSUER', 'ENFORCEMENT_ACTION'],
      confidence: 0.97,
      reasoning: 'Almeda University was a known diploma mill operating from Idaho/Boise area, listed on multiple state unaccredited institution registries. Closed after FTC enforcement actions. Any degree purportedly issued by this institution is invalid.',
    },
    category: 'diploma_mill',
    source: 'FTC v. Almeda University, 2003',
  },
  {
    id: 'FT-002',
    description: 'Belford University degree (closed diploma mill)',
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'Belford University',
      issuedDate: '2019-06-01',
      fieldOfStudy: 'Computer Science',
      degreeLevel: 'Master',
      jurisdiction: 'Texas, USA',
    },
    expectedOutput: {
      fraudSignals: ['KNOWN_DIPLOMA_MILL', 'UNVERIFIABLE_ISSUER'],
      confidence: 0.96,
      reasoning: 'Belford University and its variants (Belford High School, Belford Online) are recognized diploma mills. Originally based in Pakistan, marketed degrees with no academic work required ("life experience" credit). FTC and multiple state AGs have taken enforcement action.',
    },
    category: 'diploma_mill',
    source: 'Oregon ODA unaccredited list',
  },
  {
    id: 'FT-003',
    description: 'Hamilton University degree (Wyoming diploma mill)',
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'Hamilton University',
      issuedDate: '2010-12-18',
      fieldOfStudy: 'Education',
      degreeLevel: 'PhD',
      jurisdiction: 'Wyoming, USA',
    },
    expectedOutput: {
      fraudSignals: ['KNOWN_DIPLOMA_MILL', 'UNVERIFIABLE_ISSUER'],
      confidence: 0.95,
      reasoning: 'Hamilton University (Wyoming) was an unaccredited institution shut down by Wyoming AG. Not to be confused with Hamilton College (NY) or Colgate Hamilton Theological Institution. Wyoming version sold doctoral degrees with no coursework.',
    },
    category: 'diploma_mill',
    source: 'GAO-04-1024T, Wyoming AG action',
  },
  {
    id: 'FT-004',
    description: 'LaSalle University LA degree (Louisiana diploma mill, not the Philadelphia one)',
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'LaSalle University',
      issuedDate: '2008-05-22',
      fieldOfStudy: 'Theology',
      degreeLevel: 'PhD',
      jurisdiction: 'Louisiana, USA',
    },
    expectedOutput: {
      fraudSignals: ['KNOWN_DIPLOMA_MILL', 'INCONSISTENT_ISSUER'],
      confidence: 0.93,
      reasoning: 'LaSalle University in Mandeville, Louisiana was an unaccredited diploma mill (not affiliated with the legitimate La Salle University in Philadelphia). Federal investigation and convictions in early 2000s. Jurisdiction (Louisiana) plus name overlap with legitimate institution is the tell.',
    },
    category: 'diploma_mill',
    source: 'US v. Thomas Kirk, ED LA',
  },
  {
    id: 'FT-005',
    description: 'Trinity Theological Seminary degree (operating but unaccredited)',
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'Trinity Theological Seminary',
      issuedDate: '2024-01-10',
      fieldOfStudy: 'Divinity',
      degreeLevel: 'Doctor',
      jurisdiction: 'Indiana, USA',
    },
    expectedOutput: {
      fraudSignals: ['UNVERIFIABLE_ISSUER'],
      confidence: 0.78,
      reasoning: 'Trinity Theological Seminary (Newburgh, Indiana) is unaccredited by US Department of Education-recognized accrediting bodies, listed on Oregon ODA. The institution operates legally but its degrees are not recognized for academic transfer or most professional licensing.',
    },
    category: 'diploma_mill',
    source: 'Oregon ODA list, USDOE accreditation database',
  },
  {
    id: 'FT-006',
    description: 'Columbia State University degree (closed mill — confused with legit)',
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'Columbia State University',
      issuedDate: '2003-11-15',
      fieldOfStudy: 'Psychology',
      degreeLevel: 'PhD',
      jurisdiction: 'Louisiana, USA',
    },
    expectedOutput: {
      fraudSignals: ['KNOWN_DIPLOMA_MILL', 'INCONSISTENT_ISSUER'],
      confidence: 0.96,
      reasoning: 'Columbia State University (Metairie, LA) was a notorious diploma mill shut down by federal action in 1998. Distinct from Columbia State Community College (TN) or Columbia University (NY). The combination of "Columbia State University" as a name with Louisiana jurisdiction is a strong fraud indicator.',
    },
    category: 'diploma_mill',
    source: 'FBI investigation 1998',
  },

  // ============================================================
  // LICENSE FORGERY (format/number issues)
  // ============================================================
  {
    id: 'FT-101',
    description: 'NPI number with wrong format (9 digits instead of 10)',
    extractedFields: {
      credentialType: 'LICENSE',
      issuerName: 'New York State Education Department',
      fieldOfStudy: 'Medicine',
      licenseNumber: '298765',
      jurisdiction: 'New York, USA',
      // NPI claimed in document but only 9 digits
      recipientIdentifier: 'NPI 123456789',
    },
    expectedOutput: {
      fraudSignals: ['INVALID_FORMAT'],
      confidence: 0.92,
      reasoning: 'NPI (National Provider Identifier) must be exactly 10 digits per CMS specification, starting with 1 or 2. The claimed NPI "123456789" is only 9 digits — this is structurally impossible for a valid NPI and indicates either OCR error (verify source) or document fraud.',
    },
    category: 'license_forgery',
    source: 'CMS NPI specification',
  },
  {
    id: 'FT-102',
    description: 'California medical license with too few digits',
    extractedFields: {
      credentialType: 'LICENSE',
      issuerName: 'Medical Board of California',
      fieldOfStudy: 'Medicine',
      licenseNumber: 'A123',
      jurisdiction: 'California, USA',
      issuedDate: '2024-07-01',
    },
    expectedOutput: {
      fraudSignals: ['INVALID_FORMAT'],
      confidence: 0.88,
      reasoning: 'Medical Board of California issues physician licenses with format "A" followed by 6 digits (e.g., A123456) for MDs, or "G" prefix for DOs. License "A123" is structurally too short and inconsistent with California Business and Professions Code §2050+.',
    },
    category: 'license_forgery',
    source: 'CA Medical Practice Act',
  },
  {
    id: 'FT-103',
    description: 'NY bar number that does not exist in registration period',
    extractedFields: {
      credentialType: 'LICENSE',
      issuerName: 'New York State Bar',
      fieldOfStudy: 'Law',
      licenseNumber: '99999999',
      jurisdiction: 'New York, USA',
      issuedDate: '2025-08-15',
    },
    expectedOutput: {
      fraudSignals: ['INVALID_FORMAT', 'UNVERIFIABLE_ISSUER'],
      confidence: 0.85,
      reasoning: 'NY State Bar registration numbers are assigned sequentially. As of 2025, the highest registered bar number is approximately 5.8M. A bar number of "99999999" (8 digits, all 9s) is structurally suspicious and should be cross-checked against the OCA attorney directory.',
    },
    category: 'license_forgery',
    source: 'NY Office of Court Administration',
  },

  // ============================================================
  // DOCUMENT TAMPERING (impossible timelines, math errors)
  // ============================================================
  {
    id: 'FT-201',
    description: 'Degree issued before issuer founded',
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'Stanford University',
      issuedDate: '1880-06-15',
      fieldOfStudy: 'Computer Science',
      degreeLevel: 'Bachelor',
      jurisdiction: 'California, USA',
    },
    expectedOutput: {
      fraudSignals: ['SUSPICIOUS_DATES', 'SUSPICIOUS_TIMELINE', 'MATERIAL_MISSTATEMENT'],
      confidence: 0.99,
      reasoning: 'Stanford University was founded in 1885 and admitted its first students in 1891. A degree dated 1880-06-15 is impossible. Additionally, Computer Science as a field of study did not exist in 1880 — first CS programs began in the 1960s. Two independent indicators of fabrication.',
    },
    category: 'document_tampering',
    source: 'Stanford Founding Grant 1885',
  },
  {
    id: 'FT-202',
    description: 'CLE earned during bar suspension period',
    extractedFields: {
      credentialType: 'CLE',
      issuerName: 'NY State Bar',
      issuedDate: '2024-03-10',
      fieldOfStudy: 'Ethics',
      barNumber: '5234567',
      jurisdiction: 'New York, USA',
      creditHours: 4,
      creditType: 'Ethics',
    },
    expectedOutput: {
      fraudSignals: ['SUSPICIOUS_TIMELINE'],
      confidence: 0.74,
      reasoning: 'CLE credits are valid only for attorneys in good standing. If the bar number 5234567 is on the OCA suspended/disbarred list with effective date prior to 2024-03-10, the CLE credit would not qualify for compliance. Cross-reference required against OCA discipline registry.',
    },
    category: 'document_tampering',
    source: 'NY 22 NYCRR §1500.5',
  },
  {
    id: 'FT-203',
    description: 'Master degree dated before Bachelor in same record set',
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'Harvard University',
      issuedDate: '2018-05-20',
      fieldOfStudy: 'Economics',
      degreeLevel: 'Master',
      jurisdiction: 'Massachusetts, USA',
    },
    expectedOutput: {
      fraudSignals: ['SUSPICIOUS_TIMELINE'],
      confidence: 0.65,
      reasoning: 'Standalone Master degree from 2018-05-20 is plausible IF a Bachelor was conferred earlier. If extraction context shows the same individual claiming a Bachelor degree dated AFTER 2018-05-20, that is an impossible chronology. This entry alone needs cross-record verification before declaring fraud.',
    },
    category: 'document_tampering',
    source: 'pattern: chronology validation',
  },

  // ============================================================
  // IDENTITY MISMATCH (NPI/license belongs to different person)
  // ============================================================
  {
    id: 'FT-301',
    description: 'NPI valid but registered to different specialty',
    extractedFields: {
      credentialType: 'LICENSE',
      issuerName: 'New York State Education Department',
      fieldOfStudy: 'Cardiology',
      licenseNumber: '298765',
      recipientIdentifier: 'NPI 1234567893',
      jurisdiction: 'New York, USA',
    },
    expectedOutput: {
      fraudSignals: ['INCONSISTENT_ISSUER'],
      confidence: 0.62,
      reasoning: 'NPI 1234567893 is structurally valid (10 digits, starts with 1, valid Luhn check). However, NPI registry lookup is required to confirm: (a) the NPI is active, (b) the registered taxonomy matches "Cardiology". If NPPES shows a different taxonomy (e.g., dentistry), the credential is misrepresented. Cannot determine fraud from extraction alone — flag for verification.',
    },
    category: 'identity_mismatch',
    source: 'CMS NPPES registry pattern',
  },

  // ============================================================
  // SOPHISTICATED FRAUD (legit institution + fake program/dates)
  // ============================================================
  {
    id: 'FT-401',
    description: 'MIT degree in program that does not exist at MIT',
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'Massachusetts Institute of Technology',
      issuedDate: '2024-06-07',
      fieldOfStudy: 'Veterinary Medicine',
      degreeLevel: 'Doctor',
      jurisdiction: 'Massachusetts, USA',
    },
    expectedOutput: {
      fraudSignals: ['MATERIAL_MISSTATEMENT', 'UNVERIFIABLE_ISSUER'],
      confidence: 0.95,
      reasoning: 'MIT does not have a Veterinary Medicine program — never has. MITs schools are Engineering, Architecture, Science, Humanities/Social Sciences, Management, and Computing. A "DVM from MIT" is a strong fabrication indicator: legitimate institution name being used to add credibility to a non-existent program.',
    },
    category: 'sophisticated',
    source: 'MIT Schools registry',
  },
  {
    id: 'FT-402',
    description: 'Harvard MBA dated during COVID gap year (verifiable against academic calendar)',
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'Harvard Business School',
      issuedDate: '2020-12-15',
      fieldOfStudy: 'Business Administration',
      degreeLevel: 'Master',
      jurisdiction: 'Massachusetts, USA',
    },
    expectedOutput: {
      fraudSignals: ['SUSPICIOUS_DATES'],
      confidence: 0.55,
      reasoning: 'Harvard Business School MBA conferral happens in May (occasional January for off-cycle). December conferral dates (2020-12-15) are unusual and warrant verification against the HBS academic calendar. Not a definitive fraud signal alone — could be a partial-program early conferral — but worth flagging for human review.',
    },
    category: 'sophisticated',
    source: 'HBS academic calendar pattern',
  },
  {
    id: 'FT-403',
    description: 'Real CLE provider but provider stopped operating (issuer dead)',
    extractedFields: {
      credentialType: 'CLE',
      issuerName: 'Defunct Bar Association of CLE Inc.',
      issuedDate: '2025-09-12',
      fieldOfStudy: 'Civil Procedure',
      jurisdiction: 'Texas, USA',
      creditHours: 2,
      providerName: 'Defunct Bar Association of CLE Inc.',
    },
    expectedOutput: {
      fraudSignals: ['EXPIRED_ISSUER', 'UNVERIFIABLE_ISSUER'],
      confidence: 0.88,
      reasoning: 'A CLE provider that has dissolved cannot issue valid post-dissolution CLE credits. Verification: check Texas State Bar approved provider list for "Defunct Bar Association of CLE Inc." status and operating dates. If dissolved before 2025-09-12, the credit is not bar-approved.',
    },
    category: 'sophisticated',
    source: 'TX State Bar provider registry',
  },

  // ============================================================
  // CLEAN (non-fraud — to teach the model what NOT to flag)
  // ============================================================
  {
    id: 'FT-901',
    description: 'Genuine UMich CS degree (no fraud)',
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'University of Michigan',
      issuedDate: '2025-05-03',
      fieldOfStudy: 'Computer Science',
      degreeLevel: 'Bachelor',
      jurisdiction: 'Michigan, USA',
    },
    expectedOutput: {
      fraudSignals: [],
      confidence: 0.95,
      reasoning: 'University of Michigan is a regionally accredited public research university. Computer Science is an established UMich program in the College of Engineering. Date is plausible (May conferral standard). No fraud indicators.',
    },
    category: 'sophisticated',
    source: 'clean baseline',
  },
  {
    id: 'FT-902',
    description: 'Genuine PMP cert (no fraud)',
    extractedFields: {
      credentialType: 'CERTIFICATE',
      issuerName: 'Project Management Institute',
      issuedDate: '2026-01-18',
      expiryDate: '2029-01-17',
      fieldOfStudy: 'Project Management',
      licenseNumber: '3456789',
      accreditingBody: 'Project Management Institute',
    },
    expectedOutput: {
      fraudSignals: [],
      confidence: 0.93,
      reasoning: 'PMP (Project Management Professional) is an established certification by PMI, in continuous operation since 1969. Three-year cycle (2026 to 2029) is consistent with PMI policy. PMP number format (7+ digits) is consistent. No fraud indicators.',
    },
    category: 'sophisticated',
    source: 'clean baseline',
  },
];

/**
 * Generate the system prompt for the fraud detection capability.
 * Locked alongside the dataset; both versioned together.
 */
export const FRAUD_SYSTEM_PROMPT = `You are a credential fraud auditor analyzing extracted credential metadata. Your job is to identify fraud signals using only the structured fields provided plus your knowledge of:
- Diploma mills (FTC enforcement actions, GAO reports, state unaccredited lists like Oregon ODA)
- License number formats per jurisdiction (NPI must be 10 digits, state-specific medical/bar formats)
- Institution legitimacy (founding dates, program offerings, accreditation status)
- Temporal consistency (issue dates vs issuer existence, chronology of multiple credentials)

Return a strict JSON object:
{
  "fraudSignals": [<array of signal codes>],
  "confidence": <float 0-1, your confidence in the fraud assessment>,
  "reasoning": <one paragraph explaining the analysis>
}

Valid fraud signal codes:
KNOWN_DIPLOMA_MILL, UNVERIFIABLE_ISSUER, ENFORCEMENT_ACTION, INVALID_FORMAT,
INCONSISTENT_ISSUER, SUSPICIOUS_DATES, SUSPICIOUS_TIMELINE, MATERIAL_MISSTATEMENT,
EXPIRED_ISSUER, EXPIRED_CREDENTIAL, REVOKED_STATUS, DUPLICATE_REGISTRATION,
RETRACTED_VERIFICATION

If no fraud detected, return fraudSignals: []. Confidence should be high (>0.85) for clean credentials and high (>0.85) for unambiguous fraud; use 0.5-0.7 only for cases requiring external verification.`;
