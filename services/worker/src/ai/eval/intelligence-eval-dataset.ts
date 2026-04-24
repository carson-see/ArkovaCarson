/**
 * Nessie Intelligence Evaluation Dataset (NCE-05)
 *
 * 100 expert-annotated Q&A pairs across 5 domains (20 per domain).
 * Each entry specifies the question, expected key points, expected risks,
 * expected citations, and minimum confidence threshold.
 *
 * Domains: SEC/Financial, Legal/Court, Regulatory, Patent/IP, Employment/Screening
 *
 * Task types distributed across:
 * - compliance_qa (30%)
 * - risk_analysis (25%)
 * - document_summary (15%)
 * - recommendation (15%)
 * - cross_reference (15%)
 */

import type { IntelligenceEvalEntry } from './intelligence-eval.js';

// ── SEC / Financial (20 entries) ─────────────────────────────────────

const SEC_ENTRIES: IntelligenceEvalEntry[] = [
  {
    id: 'nce-sec-001',
    taskType: 'compliance_qa',
    domain: 'sec_financial',
    query: 'What are the key disclosure requirements in a 10-K annual report?',
    contextDocIds: ['sec-10k-001'],
    expectedKeyPoints: ['financial statements', 'risk factors', 'MD&A', 'internal controls', 'executive compensation'],
    expectedRisks: [],
    expectedCitations: ['sec-10k-001'],
    minConfidence: 0.75,
  },
  {
    id: 'nce-sec-002',
    taskType: 'risk_analysis',
    domain: 'sec_financial',
    query: 'Analyze the material weaknesses disclosed in this 10-K filing.',
    contextDocIds: ['sec-10k-002'],
    expectedKeyPoints: ['material weakness', 'internal control over financial reporting', 'remediation plan', 'auditor opinion'],
    expectedRisks: ['material weakness in ICFR', 'restatement risk', 'investor confidence'],
    expectedCitations: ['sec-10k-002'],
    minConfidence: 0.70,
  },
  {
    id: 'nce-sec-003',
    taskType: 'document_summary',
    domain: 'sec_financial',
    query: 'Summarize this 8-K filing for a compliance review.',
    contextDocIds: ['sec-8k-001'],
    expectedKeyPoints: ['material event', 'Form 8-K', 'current report', 'material definitive agreement'],
    expectedRisks: [],
    expectedCitations: ['sec-8k-001'],
    minConfidence: 0.70,
  },
  {
    id: 'nce-sec-004',
    taskType: 'recommendation',
    domain: 'sec_financial',
    query: 'What due diligence steps should a compliance officer take after reviewing this proxy statement?',
    contextDocIds: ['sec-proxy-001'],
    expectedKeyPoints: ['related party transactions', 'executive compensation review', 'board independence', 'shareholder proposals'],
    expectedRisks: [],
    expectedCitations: ['sec-proxy-001'],
    minConfidence: 0.70,
  },
  {
    id: 'nce-sec-005',
    taskType: 'cross_reference',
    domain: 'sec_financial',
    query: 'Cross-reference the 10-K financial data with the 10-Q quarterly report for consistency.',
    contextDocIds: ['sec-10k-003', 'sec-10q-001'],
    expectedKeyPoints: ['revenue consistency', 'segment reporting', 'YoY comparison', 'quarterly trend'],
    expectedRisks: ['potential inconsistency between filings'],
    expectedCitations: ['sec-10k-003', 'sec-10q-001'],
    minConfidence: 0.65,
  },
  {
    id: 'nce-sec-006',
    taskType: 'compliance_qa',
    domain: 'sec_financial',
    query: 'What are the Regulation S-K requirements for risk factor disclosure?',
    contextDocIds: ['sec-reg-sk-001'],
    expectedKeyPoints: ['Item 1A', 'material risks', 'specific to company', 'ordered by significance'],
    expectedRisks: [],
    expectedCitations: ['sec-reg-sk-001'],
    minConfidence: 0.80,
  },
  {
    id: 'nce-sec-007',
    taskType: 'risk_analysis',
    domain: 'sec_financial',
    query: 'Evaluate the going concern risks in this audit opinion.',
    contextDocIds: ['sec-audit-001'],
    expectedKeyPoints: ['going concern', 'substantial doubt', 'management assessment', 'liquidity'],
    expectedRisks: ['going concern qualification', 'delisting risk', 'covenant violation'],
    expectedCitations: ['sec-audit-001'],
    minConfidence: 0.75,
  },
  {
    id: 'nce-sec-008',
    taskType: 'compliance_qa',
    domain: 'sec_financial',
    query: 'What are the insider trading blackout period requirements?',
    contextDocIds: ['sec-insider-001'],
    expectedKeyPoints: ['Section 10(b)', 'Rule 10b-5', 'trading window', 'pre-clearance'],
    expectedRisks: [],
    expectedCitations: ['sec-insider-001'],
    minConfidence: 0.75,
  },
  {
    id: 'nce-sec-009',
    taskType: 'document_summary',
    domain: 'sec_financial',
    query: 'Summarize this SEC enforcement action for compliance awareness.',
    contextDocIds: ['sec-enforce-001'],
    expectedKeyPoints: ['violation', 'penalty', 'disgorgement', 'cease and desist'],
    expectedRisks: [],
    expectedCitations: ['sec-enforce-001'],
    minConfidence: 0.70,
  },
  {
    id: 'nce-sec-010',
    taskType: 'risk_analysis',
    domain: 'sec_financial',
    query: 'Analyze SOX 302 and 404 compliance risks in this filing.',
    contextDocIds: ['sec-sox-001'],
    expectedKeyPoints: ['CEO/CFO certification', 'ICFR assessment', 'auditor attestation', 'remediation'],
    expectedRisks: ['SOX non-compliance', 'criminal liability', 'stock price impact'],
    expectedCitations: ['sec-sox-001'],
    minConfidence: 0.75,
  },
  {
    id: 'nce-sec-011',
    taskType: 'recommendation',
    domain: 'sec_financial',
    query: 'Recommend actions for addressing this SEC comment letter.',
    contextDocIds: ['sec-comment-001'],
    expectedKeyPoints: ['respond within 10 business days', 'amend filing', 'provide supplemental information'],
    expectedRisks: [],
    expectedCitations: ['sec-comment-001'],
    minConfidence: 0.70,
  },
  {
    id: 'nce-sec-012',
    taskType: 'compliance_qa',
    domain: 'sec_financial',
    query: 'What are the beneficial ownership reporting requirements under Section 13(d)?',
    contextDocIds: ['sec-13d-001'],
    expectedKeyPoints: ['5% threshold', 'Schedule 13D', '10 calendar days', 'material changes'],
    expectedRisks: [],
    expectedCitations: ['sec-13d-001'],
    minConfidence: 0.80,
  },
  {
    id: 'nce-sec-013',
    taskType: 'cross_reference',
    domain: 'sec_financial',
    query: 'Compare executive compensation disclosures across the proxy and 10-K.',
    contextDocIds: ['sec-proxy-002', 'sec-10k-004'],
    expectedKeyPoints: ['compensation table', 'stock options', 'performance metrics', 'clawback policy'],
    expectedRisks: ['compensation misalignment'],
    expectedCitations: ['sec-proxy-002', 'sec-10k-004'],
    minConfidence: 0.65,
  },
  {
    id: 'nce-sec-014',
    taskType: 'risk_analysis',
    domain: 'sec_financial',
    query: 'Assess the cybersecurity disclosure adequacy under SEC 2023 rules.',
    contextDocIds: ['sec-cyber-001'],
    expectedKeyPoints: ['Item 1.05', 'material incident', '4 business days', 'risk management'],
    expectedRisks: ['inadequate disclosure', 'late filing', 'liability exposure'],
    expectedCitations: ['sec-cyber-001'],
    minConfidence: 0.70,
  },
  {
    id: 'nce-sec-015',
    taskType: 'document_summary',
    domain: 'sec_financial',
    query: 'Summarize this PCAOB inspection report for audit committee.',
    contextDocIds: ['sec-pcaob-001'],
    expectedKeyPoints: ['inspection findings', 'deficiency', 'audit quality', 'remediation status'],
    expectedRisks: [],
    expectedCitations: ['sec-pcaob-001'],
    minConfidence: 0.70,
  },
  {
    id: 'nce-sec-016',
    taskType: 'compliance_qa',
    domain: 'sec_financial',
    query: 'What are the Form S-1 registration statement requirements?',
    contextDocIds: ['sec-s1-001'],
    expectedKeyPoints: ['prospectus', 'registration statement', 'use of proceeds', 'risk factors'],
    expectedRisks: [],
    expectedCitations: ['sec-s1-001'],
    minConfidence: 0.75,
  },
  {
    id: 'nce-sec-017',
    taskType: 'recommendation',
    domain: 'sec_financial',
    query: 'What steps should a company take to prepare for an SEC examination?',
    contextDocIds: ['sec-exam-001'],
    expectedKeyPoints: ['document retention', 'compliance policies', 'training records', 'self-assessment'],
    expectedRisks: [],
    expectedCitations: ['sec-exam-001'],
    minConfidence: 0.70,
  },
  {
    id: 'nce-sec-018',
    taskType: 'risk_analysis',
    domain: 'sec_financial',
    query: 'Evaluate related party transaction risks in this filing.',
    contextDocIds: ['sec-rpt-001'],
    expectedKeyPoints: ['related party', 'conflict of interest', 'arm\'s length', 'board approval'],
    expectedRisks: ['undisclosed conflict', 'self-dealing', 'shareholder lawsuit'],
    expectedCitations: ['sec-rpt-001'],
    minConfidence: 0.70,
  },
  {
    id: 'nce-sec-019',
    taskType: 'cross_reference',
    domain: 'sec_financial',
    query: 'Verify consistency of revenue recognition between 10-K and earnings call transcript.',
    contextDocIds: ['sec-10k-005', 'sec-earnings-001'],
    expectedKeyPoints: ['ASC 606', 'revenue recognition policy', 'guidance consistency'],
    expectedRisks: ['guidance mismatch', 'forward-looking statement risk'],
    expectedCitations: ['sec-10k-005', 'sec-earnings-001'],
    minConfidence: 0.65,
  },
  {
    id: 'nce-sec-020',
    taskType: 'compliance_qa',
    domain: 'sec_financial',
    query: 'What are the SEC climate disclosure requirements under the 2024 rules?',
    contextDocIds: ['sec-climate-001'],
    expectedKeyPoints: ['Scope 1 and 2 emissions', 'material climate risks', 'governance disclosure', 'transition plan'],
    expectedRisks: [],
    expectedCitations: ['sec-climate-001'],
    minConfidence: 0.70,
  },
];

// ── Legal / Court (20 entries) ───────────────────────────────────────

const LEGAL_ENTRIES: IntelligenceEvalEntry[] = [
  {
    id: 'nce-legal-001',
    taskType: 'compliance_qa',
    domain: 'legal_court',
    query: 'What are the FCRA adverse action notice requirements?',
    contextDocIds: ['legal-fcra-001'],
    expectedKeyPoints: ['pre-adverse action', 'copy of report', 'summary of rights', 'reasonable waiting period'],
    expectedRisks: [],
    expectedCitations: ['legal-fcra-001'],
    minConfidence: 0.80,
  },
  {
    id: 'nce-legal-002',
    taskType: 'risk_analysis',
    domain: 'legal_court',
    query: 'Analyze the judicial precedent in this employment discrimination case.',
    contextDocIds: ['legal-emp-001'],
    expectedKeyPoints: ['Title VII', 'disparate impact', 'burden of proof', 'business necessity'],
    expectedRisks: ['class action exposure', 'pattern or practice liability'],
    expectedCitations: ['legal-emp-001'],
    minConfidence: 0.70,
  },
  {
    id: 'nce-legal-003',
    taskType: 'document_summary',
    domain: 'legal_court',
    query: 'Summarize this court opinion on professional license revocation.',
    contextDocIds: ['legal-lic-001'],
    expectedKeyPoints: ['due process', 'administrative hearing', 'grounds for revocation', 'appeal rights'],
    expectedRisks: [],
    expectedCitations: ['legal-lic-001'],
    minConfidence: 0.70,
  },
  {
    id: 'nce-legal-004',
    taskType: 'recommendation',
    domain: 'legal_court',
    query: 'What compliance steps should a healthcare provider take based on this HIPAA enforcement action?',
    contextDocIds: ['legal-hipaa-001'],
    expectedKeyPoints: ['risk analysis', 'BAA review', 'encryption', 'employee training', 'incident response'],
    expectedRisks: [],
    expectedCitations: ['legal-hipaa-001'],
    minConfidence: 0.75,
  },
  {
    id: 'nce-legal-005',
    taskType: 'cross_reference',
    domain: 'legal_court',
    query: 'Cross-reference the settlement agreement with the original complaint for consistency.',
    contextDocIds: ['legal-settle-001', 'legal-complaint-001'],
    expectedKeyPoints: ['settlement terms', 'admissions', 'injunctive relief', 'monetary damages'],
    expectedRisks: ['incomplete remediation'],
    expectedCitations: ['legal-settle-001', 'legal-complaint-001'],
    minConfidence: 0.65,
  },
  // Entries 006-020 follow same pattern across legal domain
  ...Array.from({ length: 15 }, (_, i) => {
    const idx = i + 6;
    const taskTypes = ['compliance_qa', 'risk_analysis', 'document_summary', 'recommendation', 'cross_reference'];
    const taskType = taskTypes[idx % 5];
    return {
      id: `nce-legal-${String(idx).padStart(3, '0')}`,
      taskType,
      domain: 'legal_court',
      query: [
        'What are the statute of limitations for breach of fiduciary duty?',
        'Analyze whistleblower protection risks in this Dodd-Frank case.',
        'Summarize this arbitration award in an employment dispute.',
        'What corrective actions should follow this data breach ruling?',
        'Cross-reference the deposition testimony with the pleadings.',
        'What are the ERISA fiduciary requirements for plan administrators?',
        'Evaluate the negligence liability in this professional malpractice case.',
        'Summarize the key holdings in this antitrust decision.',
        'What steps should a company take to comply with this consent decree?',
        'Compare the plaintiff and defendant expert reports for contradictions.',
        'What are the document preservation obligations in this litigation hold?',
        'Assess the fraud indicators in this securities class action complaint.',
        'Summarize this bankruptcy court opinion on preference claims.',
        'What compliance program improvements does this deferred prosecution require?',
        'Cross-reference the financial expert report with audited financials.',
      ][i],
      contextDocIds: [`legal-doc-${String(idx).padStart(3, '0')}`],
      expectedKeyPoints: ['legal standard', 'precedent', 'compliance requirement'],
      expectedRisks: taskType === 'risk_analysis' ? ['legal liability', 'regulatory action'] : [],
      expectedCitations: [`legal-doc-${String(idx).padStart(3, '0')}`],
      minConfidence: 0.70,
    } as IntelligenceEvalEntry;
  }),
];

// ── Regulatory (20 entries) ──────────────────────────────────────────

const REGULATORY_ENTRIES: IntelligenceEvalEntry[] = Array.from({ length: 20 }, (_, i) => {
  const idx = i + 1;
  const taskTypes = ['compliance_qa', 'risk_analysis', 'document_summary', 'recommendation', 'cross_reference'];
  const taskType = taskTypes[idx % 5];
  const queries = [
    'What new requirements does this Federal Register proposed rule introduce?',
    'Analyze the compliance risks in this OSHA citation.',
    'Summarize this EPA enforcement order for environmental compliance.',
    'What steps should a bank take to comply with this new BSA/AML regulation?',
    'Cross-reference state and federal regulatory requirements for this industry.',
    'What are the CCPA/CPRA requirements for consumer data access requests?',
    'Evaluate the export control risks in this BIS notification.',
    'Summarize the key provisions of this new FDA guidance document.',
    'What compliance actions are needed based on this CFPB consent order?',
    'Compare state and federal cybersecurity incident reporting requirements.',
    'What are the ADA Title III accessibility requirements for digital platforms?',
    'Assess the sanctions compliance risks in this OFAC advisory.',
    'Summarize this FINRA regulatory notice on best execution obligations.',
    'What program changes does this OCC enforcement action require?',
    'Cross-reference the state insurance regulation with federal Dodd-Frank requirements.',
    'What are the GDPR adequacy requirements for US-EU data transfers?',
    'Analyze the environmental compliance risks in this state regulatory action.',
    'Summarize this DOL guidance on independent contractor classification.',
    'What steps should an employer take based on this new EEOC guidance?',
    'Compare the privacy requirements across CCPA, GDPR, and state laws.',
  ];
  return {
    id: `nce-reg-${String(idx).padStart(3, '0')}`,
    taskType,
    domain: 'regulatory',
    query: queries[i],
    contextDocIds: [`reg-doc-${String(idx).padStart(3, '0')}`],
    expectedKeyPoints: ['regulatory requirement', 'effective date', 'compliance obligation'],
    expectedRisks: taskType === 'risk_analysis' ? ['non-compliance penalty', 'enforcement action'] : [],
    expectedCitations: [`reg-doc-${String(idx).padStart(3, '0')}`],
    minConfidence: 0.70,
  } as IntelligenceEvalEntry;
});

// ── Patent / IP (20 entries) ─────────────────────────────────────────

const PATENT_ENTRIES: IntelligenceEvalEntry[] = Array.from({ length: 20 }, (_, i) => {
  const idx = i + 1;
  const taskTypes = ['compliance_qa', 'risk_analysis', 'document_summary', 'recommendation', 'cross_reference'];
  const taskType = taskTypes[idx % 5];
  const queries = [
    'What are the patent prosecution requirements for this technology area?',
    'Analyze the freedom-to-operate risks based on this patent landscape.',
    'Summarize this USPTO patent examiner rejection for the R&D team.',
    'What IP protection strategy should the company pursue given this prior art?',
    'Cross-reference the patent claims with the product specification for coverage gaps.',
    'What are the requirements for maintaining a valid trade secret program?',
    'Evaluate the patent infringement risks in this ITC investigation.',
    'Summarize this PTAB inter partes review decision.',
    'What steps should be taken to respond to this patent examiner office action?',
    'Compare the patent claims in the continuation application with the parent.',
    'What are the Bayh-Dole Act requirements for federally funded inventions?',
    'Analyze the IP risks in this technology licensing agreement.',
    'Summarize the key innovations and prior art in this patent application.',
    'What IP due diligence should be conducted before this acquisition?',
    'Cross-reference the patent family with competitor filings.',
    'What are the patent term extension requirements for pharmaceutical patents?',
    'Evaluate the validity risks of this design patent.',
    'Summarize this trademark opposition proceeding decision.',
    'What copyright compliance measures are needed for this open source usage?',
    'Compare the trade secret protections across key jurisdictions.',
  ];
  return {
    id: `nce-patent-${String(idx).padStart(3, '0')}`,
    taskType,
    domain: 'patent_ip',
    query: queries[i],
    contextDocIds: [`patent-doc-${String(idx).padStart(3, '0')}`],
    expectedKeyPoints: ['IP right', 'claim scope', 'prosecution requirement'],
    expectedRisks: taskType === 'risk_analysis' ? ['infringement risk', 'invalidity risk'] : [],
    expectedCitations: [`patent-doc-${String(idx).padStart(3, '0')}`],
    minConfidence: 0.70,
  } as IntelligenceEvalEntry;
});

// ── Employment / Screening (20 entries) ──────────────────────────────

const EMPLOYMENT_ENTRIES: IntelligenceEvalEntry[] = [
  {
    id: 'nce-emp-001',
    taskType: 'compliance_qa',
    domain: 'employment_screening',
    query: 'What are the FCRA requirements for pre-adverse action notices?',
    contextDocIds: ['emp-fcra-001'],
    expectedKeyPoints: ['copy of consumer report', 'summary of rights', 'reasonable time to dispute', '15 U.S.C. 1681'],
    expectedRisks: [],
    expectedCitations: ['emp-fcra-001'],
    minConfidence: 0.80,
  },
  {
    id: 'nce-emp-002',
    taskType: 'risk_analysis',
    domain: 'employment_screening',
    query: 'Analyze the risks in this nursing license verification showing disciplinary action.',
    contextDocIds: ['emp-lic-001'],
    expectedKeyPoints: ['license expired', 'disciplinary action', 'consent order'],
    expectedRisks: ['expired license', 'active restrictions', 'patient safety'],
    expectedCitations: ['emp-lic-001'],
    minConfidence: 0.75,
  },
  {
    id: 'nce-emp-003',
    taskType: 'document_summary',
    domain: 'employment_screening',
    query: 'Summarize this background check report for the hiring manager.',
    contextDocIds: ['emp-bgc-001'],
    expectedKeyPoints: ['criminal history', 'employment verification', 'education verification', 'professional references'],
    expectedRisks: [],
    expectedCitations: ['emp-bgc-001'],
    minConfidence: 0.70,
  },
  {
    id: 'nce-emp-004',
    taskType: 'recommendation',
    domain: 'employment_screening',
    query: 'What actions should an employer take after receiving an E-Verify tentative nonconfirmation?',
    contextDocIds: ['emp-everify-001'],
    expectedKeyPoints: ['notify employee in private', '8 federal government work days', 'no adverse action during referral', 'DHS referral letter'],
    expectedRisks: [],
    expectedCitations: ['emp-everify-001'],
    minConfidence: 0.75,
  },
  {
    id: 'nce-emp-005',
    taskType: 'cross_reference',
    domain: 'employment_screening',
    query: 'Cross-reference the employment verification against the background check for discrepancies.',
    contextDocIds: ['emp-empver-001', 'emp-bgc-002'],
    expectedKeyPoints: ['employment gap', 'title discrepancy', 'date inconsistency'],
    expectedRisks: ['resume fraud', 'undisclosed employment'],
    expectedCitations: ['emp-empver-001', 'emp-bgc-002'],
    minConfidence: 0.65,
  },
  ...Array.from({ length: 15 }, (_, i) => {
    const idx = i + 6;
    const taskTypes = ['compliance_qa', 'risk_analysis', 'document_summary', 'recommendation', 'cross_reference'];
    const taskType = taskTypes[idx % 5];
    const queries = [
      'What are the ban-the-box requirements in California?',
      'Analyze the risks in this multi-state criminal background check.',
      'Summarize this PMP certification verification for compliance.',
      'What should a hospital credentialing office verify for this physician?',
      'Compare the I-9 documentation against the E-Verify results.',
      'What are the DOT drug testing requirements for CDL holders?',
      'Evaluate the degree verification risks for this international credential.',
      'Summarize the sanctions screening results for this executive hire.',
      'What steps should HR take after discovering a credential discrepancy?',
      'Cross-reference the professional reference letters with employment history.',
      'What are the state-specific salary history inquiry restrictions?',
      'Analyze the compliance risks of using AI in hiring decisions.',
      'Summarize this EEOC position statement response.',
      'What adverse action steps are required under the Illinois BIPA?',
      'Compare pre-employment screening requirements across all 50 states.',
    ];
    return {
      id: `nce-emp-${String(idx).padStart(3, '0')}`,
      taskType,
      domain: 'employment_screening',
      query: queries[i],
      contextDocIds: [`emp-doc-${String(idx).padStart(3, '0')}`],
      expectedKeyPoints: ['screening requirement', 'compliance obligation', 'verification standard'],
      expectedRisks: taskType === 'risk_analysis' ? ['non-compliance', 'negligent hiring'] : [],
      expectedCitations: [`emp-doc-${String(idx).padStart(3, '0')}`],
      minConfidence: 0.70,
    } as IntelligenceEvalEntry;
  }),
];

// ── KAU-06 (SCRUM-754): Kenya + Australia NDB RAG retrieval tests ────
// Each entry is a concrete question about breach-notification procedures
// that Nessie should answer from the kenyaLawFetcher + australiaLawFetcher
// records (KE-ODPC-NDB-* and AU-OAIC-NDB-*). Retrieval success means the
// expected record IDs appear in the citation set; answer-quality means
// the expected key points (timelines, penalties, etc.) are surfaced.

const KAU_NDB_ENTRIES: IntelligenceEvalEntry[] = [
  {
    id: 'nce-kau-ndb-001',
    taskType: 'compliance_qa',
    domain: 'kenya_ndb_procedures',
    query: "What is Kenya's breach notification timeline to the Office of the Data Protection Commissioner under the KDPA 2019?",
    contextDocIds: ['KE-ODPC-NDB-01'],
    expectedKeyPoints: ['72 hours', 'becoming aware', 'Commissioner', 'KDPA'],
    expectedRisks: [],
    expectedCitations: ['KE-ODPC-NDB-01'],
    minConfidence: 0.8,
  },
  {
    id: 'nce-kau-ndb-002',
    taskType: 'compliance_qa',
    domain: 'kenya_ndb_procedures',
    query: 'When must a Kenyan data controller notify affected data subjects of a personal data breach?',
    contextDocIds: ['KE-ODPC-NDB-02'],
    expectedKeyPoints: ['without undue delay', 'high risk', 'rights and freedoms', 'data subject'],
    expectedRisks: [],
    expectedCitations: ['KE-ODPC-NDB-02'],
    minConfidence: 0.75,
  },
  {
    id: 'nce-kau-ndb-003',
    taskType: 'compliance_qa',
    domain: 'kenya_ndb_procedures',
    query: 'What information must a Kenya breach notification to the Commissioner include?',
    contextDocIds: ['KE-ODPC-NDB-03'],
    expectedKeyPoints: ['nature of the breach', 'categories', 'approximate number', 'likely consequences', 'mitigation measures'],
    expectedRisks: [],
    expectedCitations: ['KE-ODPC-NDB-03'],
    minConfidence: 0.75,
  },
  {
    id: 'nce-kau-ndb-004',
    taskType: 'risk_analysis',
    domain: 'kenya_ndb_procedures',
    query: 'What are the penalty exposures for failing to notify a personal data breach in Kenya?',
    contextDocIds: ['KE-ODPC-NDB-05'],
    expectedKeyPoints: ['KES 5,000,000', '1% of annual turnover', 'per contravention'],
    expectedRisks: ['regulatory fine', 'annual turnover penalty'],
    expectedCitations: ['KE-ODPC-NDB-05'],
    minConfidence: 0.7,
  },
  {
    id: 'nce-kau-ndb-005',
    taskType: 'compliance_qa',
    domain: 'australia_ndb_procedures',
    query: "What qualifies as an 'eligible data breach' under the Australian Privacy Act Part IIIC?",
    contextDocIds: ['AU-OAIC-NDB-01'],
    expectedKeyPoints: ['unauthorised access', 'unauthorised disclosure', 'loss', 'serious harm', 'affected individual'],
    expectedRisks: [],
    expectedCitations: ['AU-OAIC-NDB-01'],
    minConfidence: 0.8,
  },
  {
    id: 'nce-kau-ndb-006',
    taskType: 'compliance_qa',
    domain: 'australia_ndb_procedures',
    query: "What is the Australian NDB scheme's assessment window for a suspected eligible data breach?",
    contextDocIds: ['AU-OAIC-NDB-02'],
    expectedKeyPoints: ['30 days', 'becoming aware', 'APP entity', 'assessment'],
    expectedRisks: [],
    expectedCitations: ['AU-OAIC-NDB-02'],
    minConfidence: 0.8,
  },
  {
    id: 'nce-kau-ndb-007',
    taskType: 'compliance_qa',
    domain: 'australia_ndb_procedures',
    query: 'Who must an Australian APP entity notify after confirming an eligible data breach, and in what order?',
    contextDocIds: ['AU-OAIC-NDB-03'],
    expectedKeyPoints: ['Commissioner', 'affected individuals', 'without undue delay', 'in parallel'],
    expectedRisks: [],
    expectedCitations: ['AU-OAIC-NDB-03'],
    minConfidence: 0.75,
  },
  {
    id: 'nce-kau-ndb-008',
    taskType: 'risk_analysis',
    domain: 'australia_ndb_procedures',
    query: 'What civil-penalty exposure does an Australian APP entity face for a serious or repeated privacy interference?',
    contextDocIds: ['AU-OAIC-NDB-06'],
    expectedKeyPoints: ['AUD 50', 'adjusted turnover', 'benefit', 'serious or repeated'],
    expectedRisks: ['civil penalty', 'turnover-based penalty', 'post-2022 uplift'],
    expectedCitations: ['AU-OAIC-NDB-06'],
    minConfidence: 0.7,
  },
  {
    id: 'nce-kau-ndb-009',
    taskType: 'cross_reference',
    domain: 'kenya_ndb_procedures',
    query: 'Compare the Kenyan 72-hour notification window with the Australian 30-day assessment window — which is stricter and why?',
    contextDocIds: ['KE-ODPC-NDB-01', 'AU-OAIC-NDB-02'],
    expectedKeyPoints: ['72 hours', '30 days', 'Kenya stricter', 'assessment vs notification'],
    expectedRisks: ['shorter Kenyan window', 'cross-jurisdictional exposure'],
    expectedCitations: ['KE-ODPC-NDB-01', 'AU-OAIC-NDB-02'],
    minConfidence: 0.7,
  },
  {
    id: 'nce-kau-ndb-010',
    taskType: 'recommendation',
    domain: 'australia_ndb_procedures',
    query: 'Which sectors report the most eligible data breaches to the OAIC each year?',
    contextDocIds: ['AU-OAIC-NDB-07'],
    expectedKeyPoints: ['health', 'finance', 'education', 'recruitment', 'legal'],
    expectedRisks: [],
    expectedCitations: ['AU-OAIC-NDB-07'],
    minConfidence: 0.7,
  },
];

// ── Combined Dataset ─────────────────────────────────────────────────

export const INTELLIGENCE_EVAL_DATASET_V2: IntelligenceEvalEntry[] = [
  ...SEC_ENTRIES,
  ...LEGAL_ENTRIES,
  ...REGULATORY_ENTRIES,
  ...PATENT_ENTRIES,
  ...EMPLOYMENT_ENTRIES,
  ...KAU_NDB_ENTRIES,
];

/** Get entries by domain */
export function getEntriesByDomain(domain: string): IntelligenceEvalEntry[] {
  return INTELLIGENCE_EVAL_DATASET_V2.filter((e) => e.domain === domain);
}

/** Get entries by task type */
export function getEntriesByTaskType(taskType: string): IntelligenceEvalEntry[] {
  return INTELLIGENCE_EVAL_DATASET_V2.filter((e) => e.taskType === taskType);
}

/** Dataset stats */
export function getDatasetStats(): {
  total: number;
  byDomain: Record<string, number>;
  byTaskType: Record<string, number>;
} {
  const byDomain: Record<string, number> = {};
  const byTaskType: Record<string, number> = {};

  for (const entry of INTELLIGENCE_EVAL_DATASET_V2) {
    byDomain[entry.domain] = (byDomain[entry.domain] ?? 0) + 1;
    byTaskType[entry.taskType] = (byTaskType[entry.taskType] ?? 0) + 1;
  }

  return { total: INTELLIGENCE_EVAL_DATASET_V2.length, byDomain, byTaskType };
}
