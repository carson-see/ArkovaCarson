/**
 * Golden Dataset Phase 15 — Reasoning-Enriched Entries (GRE-05/06, NCX-05)
 *
 * Entries with sub_type, reasoning, and concerns fields.
 * Covers the 4 gap domains: CE, transcripts, business entities, compliance.
 * Includes Kenya and Australia jurisdiction examples.
 *
 * Each entry demonstrates what Gemini's reasoning output should look like.
 */

import type { GoldenDatasetEntry } from './types.js';

export const GOLDEN_DATASET_PHASE15: GoldenDatasetEntry[] = [
  // ============================================================
  // CONTINUING EDUCATION (CLE/CME/CPE)
  // ============================================================

  {
    id: 'GD-1901',
    description: 'California CLE ethics course completion with reasoning',
    strippedText: 'Continuing Legal Education Certificate of Completion. [NAME_REDACTED], Bar No. [REDACTED]. Course: Professional Responsibility and Ethics in the Digital Age. Credits: 4.0 Hours (Ethics). Provider: California Lawyers Association. Approved by: State Bar of California. Date Completed: January 15, 2026. Activity Number: CLE-2026-CA-4521. This course satisfies the MCLE ethics requirement under California Rules of Court, Rule 9.40.',
    credentialTypeHint: 'CLE',
    groundTruth: {
      credentialType: 'CLE',
      subType: 'ethics_cle',
      issuerName: 'California Lawyers Association',
      issuedDate: '2026-01-15',
      fieldOfStudy: 'Professional Responsibility and Ethics in the Digital Age',
      jurisdiction: 'California, USA',
      creditHours: 4.0,
      creditType: 'Ethics',
      providerName: 'California Lawyers Association',
      approvedBy: 'State Bar of California',
      activityNumber: 'CLE-2026-CA-4521',
      fraudSignals: [],
      reasoning: 'Document is a CLE certificate from California Lawyers Association, explicitly labeled as Ethics credits (4.0 hours) approved by State Bar of California. Activity number and MCLE rule reference confirm legitimacy.',
      concerns: [],
    },
    source: 'synthetic/cle_ca_ethics_2026',
    category: 'cle',
    tags: ['clean', 'reasoning', 'ethics', 'california'],
  },

  {
    id: 'GD-1902',
    description: 'NASBA CPE accounting continuing education certificate',
    strippedText: 'Certificate of Continuing Professional Education. [NAME_REDACTED], CPA. Course: Advanced Tax Planning Strategies for High Net Worth Individuals. CPE Credits: 8.0 Hours. Field of Study: Taxes. Delivery Method: Group Live. Provider: AICPA. NASBA Sponsor ID: 112891. Date: March 20, 2026. This program was prepared in accordance with the Statement on Standards for Continuing Professional Education (CPE) Programs.',
    credentialTypeHint: 'CLE',
    groundTruth: {
      credentialType: 'CLE',
      subType: 'general_cle',
      issuerName: 'AICPA',
      issuedDate: '2026-03-20',
      fieldOfStudy: 'Advanced Tax Planning Strategies',
      creditHours: 8.0,
      creditType: 'Taxes',
      providerName: 'AICPA',
      fraudSignals: [],
      reasoning: 'CPE certificate from AICPA with NASBA Sponsor ID, indicating a NASBA-registered continuing education provider. 8.0 CPE credits in Taxes field. Delivery method and standards statement confirm compliance with NASBA requirements.',
      concerns: [],
    },
    source: 'synthetic/cpe_aicpa_tax_2026',
    category: 'cle',
    tags: ['clean', 'reasoning', 'cpe', 'accounting'],
  },

  {
    id: 'GD-1903',
    description: 'CME medical continuing education — ACCME accredited',
    strippedText: 'Certificate of Completion. Continuing Medical Education. [NAME_REDACTED], MD. Activity: Current Concepts in Emergency Cardiology. AMA PRA Category 1 Credits: 12.5. Provider: Mayo Clinic School of Continuous Professional Development. ACCME Accredited Provider. Date: February 8, 2026. This activity was planned and implemented in accordance with the accreditation requirements and policies of the ACCME.',
    credentialTypeHint: 'CERTIFICATE',
    groundTruth: {
      credentialType: 'CLE',
      subType: 'general_cle',
      issuerName: 'Mayo Clinic School of Continuous Professional Development',
      issuedDate: '2026-02-08',
      fieldOfStudy: 'Emergency Cardiology',
      creditHours: 12.5,
      creditType: 'AMA PRA Category 1',
      accreditingBody: 'ACCME',
      fraudSignals: [],
      reasoning: 'CME certificate from Mayo Clinic, an ACCME-accredited provider. 12.5 AMA PRA Category 1 credits for emergency cardiology. ACCME accreditation statement confirms legitimacy. Classified as CLE (continuing education) rather than CERTIFICATE because it awards credit hours.',
      concerns: [],
    },
    source: 'synthetic/cme_mayo_cardiology_2026',
    category: 'cle',
    tags: ['clean', 'reasoning', 'cme', 'medical'],
  },

  // ============================================================
  // TRANSCRIPTS
  // ============================================================

  {
    id: 'GD-1910',
    description: 'Official undergraduate transcript from state university',
    strippedText: 'OFFICIAL TRANSCRIPT. University of Texas at Austin. Office of the Registrar. Student: [NAME_REDACTED]. Student ID: [REDACTED]. Degree: Bachelor of Arts. Major: Political Science. Minor: Economics. Date of Admission: August 2021. Date Conferred: May 2025. Cumulative GPA: 3.62 / 4.00. Total Credit Hours: 128. Dean\'s List: Fall 2022, Spring 2023, Fall 2023. This transcript is issued on security paper with the University seal. Issued: June 1, 2025.',
    credentialTypeHint: 'TRANSCRIPT',
    groundTruth: {
      credentialType: 'TRANSCRIPT',
      subType: 'official_undergraduate',
      issuerName: 'University of Texas at Austin',
      issuedDate: '2025-06-01',
      fieldOfStudy: 'Political Science',
      degreeLevel: 'Bachelor',
      jurisdiction: 'Texas, USA',
      fraudSignals: [],
      reasoning: 'Explicitly labeled "OFFICIAL TRANSCRIPT" from UT Austin Office of the Registrar. Contains GPA, credit hours, degree conferral date, and security paper mention — all indicators of an official undergraduate transcript. BA in Political Science with 128 credit hours is consistent with a 4-year undergraduate program.',
      concerns: [],
    },
    source: 'synthetic/transcript_utaustin_poli_2025',
    category: 'transcript',
    tags: ['clean', 'reasoning', 'official', 'undergraduate'],
  },

  {
    id: 'GD-1911',
    description: 'WES international credential evaluation report',
    strippedText: 'World Education Services. Credential Evaluation Report. Reference No: WES-2026-1847392. Applicant: [NAME_REDACTED]. Country of Education: India. Institution: Indian Institute of Technology Bombay. Credential Evaluated: Bachelor of Technology (B.Tech) in Computer Science and Engineering. Date of Credential: June 2024. WES Evaluation: The credential described above is found comparable to a Bachelor\'s degree in the United States. Report Issued: January 10, 2026.',
    credentialTypeHint: 'TRANSCRIPT',
    groundTruth: {
      credentialType: 'TRANSCRIPT',
      subType: 'international_wes',
      issuerName: 'World Education Services',
      issuedDate: '2026-01-10',
      fieldOfStudy: 'Computer Science and Engineering',
      degreeLevel: 'Bachelor',
      accreditingBody: 'World Education Services',
      jurisdiction: 'India',
      fraudSignals: [],
      reasoning: 'WES credential evaluation report for an Indian B.Tech degree from IIT Bombay. WES is a recognized international credential evaluation service. The report confirms US equivalency (comparable to a Bachelor\'s degree). Classified as TRANSCRIPT/international_wes because it\'s an evaluation of a foreign credential, not the original degree.',
      concerns: [],
    },
    source: 'synthetic/transcript_wes_iit_2026',
    category: 'transcript',
    tags: ['clean', 'reasoning', 'international', 'wes', 'india'],
  },

  // ============================================================
  // BUSINESS ENTITIES
  // ============================================================

  {
    id: 'GD-1920',
    description: 'Delaware certificate of good standing',
    strippedText: 'State of Delaware. Department of State. Division of Corporations. Certificate of Good Standing. I, [NAME_REDACTED], Secretary of State of the State of Delaware, do hereby certify that ARKOVA INC., a corporation organized under the laws of the State of Delaware, File No. 7654321, is in good standing and has a legal corporate existence so far as the records of this office show. In Testimony Whereof, I have hereunto set my hand and official seal this 15th day of March 2026.',
    credentialTypeHint: 'BUSINESS_ENTITY',
    groundTruth: {
      credentialType: 'BUSINESS_ENTITY',
      subType: 'certificate_of_good_standing',
      issuerName: 'Delaware Division of Corporations',
      issuedDate: '2026-03-15',
      entityType: 'Corporation',
      stateOfFormation: 'Delaware',
      goodStandingStatus: 'Good Standing',
      jurisdiction: 'Delaware, USA',
      fraudSignals: [],
      reasoning: 'Official Certificate of Good Standing from Delaware Division of Corporations with Secretary of State certification, file number, and official seal. Confirms ARKOVA INC. is an active Delaware corporation in good standing. Standard format for Delaware good standing certificates.',
      concerns: [],
    },
    source: 'synthetic/biz_de_good_standing_2026',
    category: 'business_entity',
    tags: ['clean', 'reasoning', 'delaware', 'good-standing'],
  },

  {
    id: 'GD-1921',
    description: 'California LLC articles of organization',
    strippedText: 'Secretary of State. State of California. Articles of Organization — Limited Liability Company (LLC-1). Entity Name: BAYSHORE TECHNOLOGIES LLC. Entity Number: 202638471923. Date Filed: February 1, 2026. Agent for Service of Process: [NAME_REDACTED], [ADDRESS_REDACTED], San Francisco, CA 94105. Purpose: The purpose of this LLC is to engage in any lawful act or activity. Organizer: [NAME_REDACTED]. California Secretary of State.',
    credentialTypeHint: 'BUSINESS_ENTITY',
    groundTruth: {
      credentialType: 'BUSINESS_ENTITY',
      subType: 'certificate_of_formation',
      issuerName: 'California Secretary of State',
      issuedDate: '2026-02-01',
      entityType: 'LLC',
      stateOfFormation: 'California',
      registeredAgent: '[NAME_REDACTED]',
      jurisdiction: 'California, USA',
      fraudSignals: [],
      reasoning: 'Articles of Organization for a California LLC filed with the Secretary of State. Entity number format (12-digit starting with year) is consistent with CA SOS numbering. Contains standard LLC formation elements: entity name, agent for service of process, purpose statement.',
      concerns: [],
    },
    source: 'synthetic/biz_ca_llc_formation_2026',
    category: 'business_entity',
    tags: ['clean', 'reasoning', 'california', 'llc', 'formation'],
  },

  // ============================================================
  // KENYA JURISDICTION
  // ============================================================

  {
    id: 'GD-1930',
    description: 'Kenya KNEC KCSE certificate',
    strippedText: 'Republic of Kenya. Kenya National Examinations Council. Kenya Certificate of Secondary Education (KCSE). This is to certify that [NAME_REDACTED], Index No: 28/538/0012/2024, sat for the Kenya Certificate of Secondary Education Examination in the year 2024 and obtained the following results: English B+, Kiswahili A-, Mathematics A, Biology B+, Chemistry A-, Physics A, History B, Geography B+. Mean Grade: A- (minus). KNEC/KCSE/2024/28538.',
    credentialTypeHint: 'TRANSCRIPT',
    groundTruth: {
      credentialType: 'TRANSCRIPT',
      subType: 'high_school',
      issuerName: 'Kenya National Examinations Council',
      issuedDate: '2024-01-01',
      fieldOfStudy: 'Secondary Education',
      jurisdiction: 'Kenya',
      fraudSignals: [],
      reasoning: 'KNEC KCSE certificate — Kenya\'s national secondary school examination. Contains index number in standard KNEC format (region/school/student/year), subject grades using Kenya grading system (A to E), and mean grade calculation. KNEC is the sole authority for national examinations in Kenya.',
      concerns: [],
    },
    source: 'synthetic/ke_knec_kcse_2024',
    category: 'transcript',
    tags: ['clean', 'reasoning', 'kenya', 'knec', 'secondary'],
  },

  {
    id: 'GD-1931',
    description: 'Kenya Law Society advocate practicing certificate',
    strippedText: 'The Law Society of Kenya. Practising Certificate. Year: 2026. This is to certify that [NAME_REDACTED], having been admitted as an Advocate of the High Court of Kenya on [DATE_REDACTED], and having complied with the provisions of the Advocates Act (Cap 16), Laws of Kenya, is hereby authorized to practice as an Advocate for the year 2026. LSK Membership No: [REDACTED]. Certificate No: LSK/PC/2026/14832.',
    credentialTypeHint: 'LICENSE',
    groundTruth: {
      credentialType: 'LICENSE',
      subType: 'law_bar_admission',
      issuerName: 'Law Society of Kenya',
      issuedDate: '2026-01-01',
      expiryDate: '2026-12-31',
      fieldOfStudy: 'Law',
      jurisdiction: 'Kenya',
      accreditingBody: 'Law Society of Kenya',
      fraudSignals: [],
      reasoning: 'LSK Practising Certificate — annual license required for Kenyan advocates. Issued under the Advocates Act (Cap 16). Certificate number format (LSK/PC/YEAR/SERIAL) is consistent with LSK numbering. Valid for calendar year 2026 only.',
      concerns: [],
    },
    source: 'synthetic/ke_lsk_advocate_2026',
    category: 'license',
    tags: ['clean', 'reasoning', 'kenya', 'law', 'advocate'],
  },

  // ============================================================
  // AUSTRALIA JURISDICTION
  // ============================================================

  {
    id: 'GD-1940',
    description: 'AHPRA nursing registration (Australia)',
    strippedText: 'Australian Health Practitioner Regulation Agency (AHPRA). Registration Certificate. Practitioner: [NAME_REDACTED]. Profession: Nursing and Midwifery. Registration Type: General Registration — Registered Nurse (Division 1). Registration Number: NMW[REDACTED]. Registration Status: Registered. Registration Expiry: 31 May 2027. Conditions: Nil. Undertakings: Nil. Reprimands: Nil. National Board: Nursing and Midwifery Board of Australia.',
    credentialTypeHint: 'LICENSE',
    groundTruth: {
      credentialType: 'LICENSE',
      subType: 'nursing_rn',
      issuerName: 'Australian Health Practitioner Regulation Agency',
      expiryDate: '2027-05-31',
      fieldOfStudy: 'Nursing and Midwifery',
      accreditingBody: 'Nursing and Midwifery Board of Australia',
      jurisdiction: 'Australia',
      fraudSignals: [],
      reasoning: 'AHPRA registration certificate for a Registered Nurse (Division 1). AHPRA is Australia\'s national health practitioner regulator. Registration number prefix NMW is standard for nursing. Clean record (nil conditions/undertakings/reprimands). Nursing and Midwifery Board of Australia is the accrediting national board.',
      concerns: [],
    },
    source: 'synthetic/au_ahpra_nursing_2027',
    category: 'license',
    tags: ['clean', 'reasoning', 'australia', 'ahpra', 'nursing'],
  },

  {
    id: 'GD-1941',
    description: 'Australian TEQSA higher education provider registration',
    strippedText: 'Tertiary Education Quality and Standards Agency. Registration Decision. Provider: University of Melbourne. ABN: 84 002 705 224. Provider Category: Australian University. TEQSA Provider ID: PRV12150. Registration Period: 1 January 2024 to 31 December 2030. Conditions of Registration: None. This registration was granted under section 36 of the Tertiary Education Quality and Standards Agency Act 2011 (the TEQSA Act). Signed: Chief Commissioner, TEQSA.',
    credentialTypeHint: 'CERTIFICATE',
    groundTruth: {
      credentialType: 'CERTIFICATE',
      subType: 'accreditation_certificate',
      issuerName: 'Tertiary Education Quality and Standards Agency',
      issuedDate: '2024-01-01',
      expiryDate: '2030-12-31',
      fieldOfStudy: 'Higher Education',
      accreditingBody: 'TEQSA',
      jurisdiction: 'Australia',
      fraudSignals: [],
      reasoning: 'TEQSA registration decision for University of Melbourne. TEQSA is Australia\'s independent national regulator of higher education. Provider ID (PRV12150) and ABN are present. Registration granted under TEQSA Act 2011 with no conditions — indicates a clean, fully accredited university. 7-year registration period is standard for established institutions.',
      concerns: [],
    },
    source: 'synthetic/au_teqsa_unimelb_2024',
    category: 'certificate',
    tags: ['clean', 'reasoning', 'australia', 'teqsa', 'university'],
  },

  // ============================================================
  // COMPLIANCE / FRAUD SCENARIOS WITH REASONING
  // ============================================================

  {
    id: 'GD-1950',
    description: 'Diploma mill degree — suspicious with reasoning',
    strippedText: 'Belford University. Doctor of Business Administration. This is to certify that [NAME_REDACTED] has successfully completed the requirements for the degree of Doctor of Business Administration. Based on extensive life and work experience evaluation. No coursework required. Degree issued: December 25, 2025. Diploma delivered within 7 business days. Order ID: BU-2025-89432.',
    credentialTypeHint: 'DEGREE',
    groundTruth: {
      credentialType: 'DEGREE',
      subType: 'doctorate',
      issuerName: 'Belford University',
      issuedDate: '2025-12-25',
      degreeLevel: 'Doctorate',
      fieldOfStudy: 'Business Administration',
      fraudSignals: ['EXPIRED_ISSUER', 'FORMAT_ANOMALY'],
      reasoning: 'Belford University is a known diploma mill. Multiple red flags: (1) "no coursework required" for a doctoral degree, (2) degree based solely on "life and work experience evaluation", (3) "delivered within 7 business days" — legitimate doctorates take years, (4) Order ID suggests a commercial purchase, (5) Christmas Day issue date is unusual for academic institutions.',
      concerns: ['Belford University is a known diploma mill', '"No coursework required" for a doctoral degree', 'Commercial order ID suggests purchased credential', '7-day delivery for a doctorate is not legitimate'],
    },
    source: 'synthetic/fraud_diploma_mill_belford',
    category: 'degree',
    tags: ['fraud', 'reasoning', 'diploma-mill'],
  },

  {
    id: 'GD-1951',
    description: 'Expired professional license with reasoning',
    strippedText: 'State of Florida. Board of Pharmacy. Pharmacist License. [NAME_REDACTED], PharmD. License No. PH0045678. Original Issue Date: March 1, 2020. Expiration Date: February 28, 2024. License Status: EXPIRED — NOT RENEWED. Last Renewal: February 28, 2022. Disciplinary Action: None on record.',
    credentialTypeHint: 'LICENSE',
    groundTruth: {
      credentialType: 'LICENSE',
      subType: 'nursing_rn',
      issuerName: 'Florida Board of Pharmacy',
      issuedDate: '2020-03-01',
      expiryDate: '2024-02-28',
      fieldOfStudy: 'Pharmacy',
      licenseNumber: 'PH0045678',
      jurisdiction: 'Florida, USA',
      fraudSignals: [],
      reasoning: 'Florida Board of Pharmacy pharmacist license with visible license number. License is explicitly marked EXPIRED — NOT RENEWED since February 2024. No disciplinary action on record. The expiration is a normal lifecycle event, not fraud — the holder simply did not renew.',
      concerns: ['License expired February 2024 — holder may not be currently authorized to practice pharmacy in Florida'],
    },
    source: 'synthetic/license_fl_pharmacy_expired',
    category: 'license',
    tags: ['expired', 'reasoning', 'pharmacy', 'florida'],
  },
];
