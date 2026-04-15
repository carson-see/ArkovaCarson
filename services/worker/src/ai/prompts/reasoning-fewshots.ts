/**
 * GRE-05: Reasoning Few-Shot Examples
 *
 * 80+ examples demonstrating the OBSERVE-IDENTIFY-CLASSIFY-VERIFY-ASSESS
 * reasoning protocol for credential extraction. Each example includes
 * PII-stripped input text and expected output with reasoning fields.
 *
 * These examples are appended to the extraction prompt to guide Gemini's
 * chain-of-thought reasoning during metadata extraction.
 */

/**
 * A single reasoning few-shot example for the extraction prompt.
 */
export interface ReasoningFewShotExample {
  /** PII-stripped input text (simulating what extraction receives) */
  inputText: string;
  /** Expected structured output from the model */
  expectedOutput: {
    credentialType: string;
    subType: string;
    reasoning: string;
    concerns: string[];
    confidenceReasoning: string;
    fraudSignals?: string[];
    confidence: number;
  };
}

export const REASONING_FEWSHOTS: ReasoningFewShotExample[] = [
  // ============================================================
  // DEGREE (8 examples: 2 international, 1 fraud)
  // ============================================================
  {
    inputText: 'The Board of Trustees of the University of Pennsylvania, on recommendation of the Faculty of the School of Engineering and Applied Science, has conferred upon [NAME_REDACTED] the degree of Bachelor of Science in Engineering in Computer Science, with all the rights and privileges thereunto pertaining. Given at Philadelphia, Pennsylvania, this fifteenth day of May, Two Thousand Twenty-Five. Diploma Number: SEAS-2025-08421.',
    expectedOutput: {
      credentialType: 'DEGREE',
      subType: 'bachelor',
      reasoning: 'OBSERVE: Formal diploma language with Board of Trustees, specific school (Engineering and Applied Science), diploma number. IDENTIFY: University of Pennsylvania, a well-known Ivy League institution. CLASSIFY: Bachelor of Science in Engineering — undergraduate degree. VERIFY: Date format is consistent, diploma number present, no anomalies.',
      concerns: [],
      confidenceReasoning: 'High confidence: all key fields present from a recognized institution with formal diploma formatting.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'The President and Fellows of Harvard University, to all persons to whom these presents may come, Greeting: Be it known that [NAME_REDACTED] having satisfactorily completed the studies and fulfilled the requirements prescribed therefor, is admitted to the degree of Doctor of Philosophy in Economics. In testimony whereof we have caused the seal of Harvard University to be affixed. Cambridge, Massachusetts, June 5, 2025.',
    expectedOutput: {
      credentialType: 'DEGREE',
      subType: 'doctorate',
      reasoning: 'OBSERVE: Formal diploma language with archaic phrasing ("to all persons to whom these presents may come"), university seal reference. IDENTIFY: Harvard University, Cambridge, Massachusetts. CLASSIFY: Doctor of Philosophy (PhD) — doctoral degree in Economics. VERIFY: Consistent formatting for a major research university diploma.',
      concerns: [],
      confidenceReasoning: 'High confidence: classic PhD diploma format from a highly recognizable institution.',
      confidence: 0.94,
    },
  },
  {
    inputText: 'Makerere University, Kampala, Uganda. The Chancellor, on the recommendation of the Senate, hereby confers upon [NAME_REDACTED] the degree of Master of Science in Computer Science, having satisfied all the requirements prescribed by the University. This degree was awarded at the 73rd Graduation Ceremony held on January 18, 2026. Registration Number: [REDACTED].',
    expectedOutput: {
      credentialType: 'DEGREE',
      subType: 'master',
      reasoning: 'OBSERVE: Formal university diploma with Chancellor, Senate references, graduation ceremony number. IDENTIFY: Makerere University, Kampala, Uganda — the oldest and largest public university in Uganda. CLASSIFY: Master of Science — graduate degree. VERIFY: Graduation ceremony reference adds authenticity.',
      concerns: ['International credential — may require WES or equivalent evaluation for US recognition'],
      confidenceReasoning: 'High confidence: well-structured diploma from a recognized African university with institutional details.',
      confidence: 0.88,
    },
  },
  {
    inputText: 'Technische Universitaet Muenchen. Fakultaet fuer Informatik. Urkunde. Der [NAME_REDACTED] wird der akademische Grad Master of Science (M.Sc.) in Informatik verliehen. Muenchen, den 15. Maerz 2026. Der Praesident. Der Dekan.',
    expectedOutput: {
      credentialType: 'DEGREE',
      subType: 'master',
      reasoning: 'OBSERVE: German-language diploma ("Urkunde") with faculty and university references. IDENTIFY: Technical University of Munich (TUM), one of Germany\'s top research universities. CLASSIFY: Master of Science in Informatik (Computer Science). VERIFY: Standard German academic diploma format with President and Dean signatures referenced.',
      concerns: ['Non-English document — German. Translation may be needed for US verification.'],
      confidenceReasoning: 'High confidence: recognizable institution, standard German diploma format, clear degree title.',
      confidence: 0.87,
    },
  },
  {
    inputText: 'Riverside Community College District. The Board of Trustees hereby confers upon [NAME_REDACTED] the degree of Associate in Arts in Liberal Studies, having fulfilled all the requirements as prescribed. Moreno Valley, California. June 12, 2025. College President. Chair, Board of Trustees.',
    expectedOutput: {
      credentialType: 'DEGREE',
      subType: 'associate',
      reasoning: 'OBSERVE: Community college diploma with Board of Trustees, standard conferral language. IDENTIFY: Riverside Community College District, Moreno Valley, California. CLASSIFY: Associate in Arts — two-year degree. VERIFY: Standard community college diploma format.',
      concerns: [],
      confidenceReasoning: 'High confidence: clean, standard associate degree diploma with all expected fields.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'Georgetown University Law Center. The Board of Directors of Georgetown University, upon the nomination of the Faculty of the Law Center, has conferred upon [NAME_REDACTED] the degree of Juris Doctor, cum laude. Washington, District of Columbia. May 18, 2025.',
    expectedOutput: {
      credentialType: 'DEGREE',
      subType: 'professional_jd',
      reasoning: 'OBSERVE: Law school diploma with Board of Directors, Faculty nomination, Latin honors (cum laude). IDENTIFY: Georgetown University Law Center, a prestigious law school in DC. CLASSIFY: Juris Doctor (JD) — a professional doctoral degree in law. VERIFY: Standard JD diploma format with honors notation.',
      concerns: [],
      confidenceReasoning: 'High confidence: well-known law school, standard professional degree format, honors noted.',
      confidence: 0.94,
    },
  },
  {
    inputText: 'Pacific Western University. The Board of Regents has conferred upon [NAME_REDACTED] the degree of Doctor of Philosophy in Business Administration. This 1st day of March, 2026. Los Angeles, California. Accredited by the National Accreditation Board for Higher Learning.',
    expectedOutput: {
      credentialType: 'DEGREE',
      subType: 'doctorate',
      reasoning: 'OBSERVE: Diploma format appears standard but institution name raises concerns. IDENTIFY: Pacific Western University — this institution was known as a diploma mill and closed after legal action. CLASSIFY: PhD in Business Administration. VERIFY: The accrediting body "National Accreditation Board for Higher Learning" is not a recognized CHEA or DOE accreditor.',
      concerns: ['Issuer is associated with known diploma mill operations', 'Accrediting body is not recognized by CHEA or US Department of Education'],
      confidenceReasoning: 'Low confidence: institution has diploma mill association and unrecognized accreditor.',
      fraudSignals: ['KNOWN_DIPLOMA_MILL', 'UNVERIFIABLE_ISSUER'],
      confidence: 0.35,
    },
  },
  {
    inputText: 'Johns Hopkins University. School of Medicine. The Trustees of The Johns Hopkins University have conferred on [NAME_REDACTED] the degree of Doctor of Medicine, with all rights and privileges thereunto appertaining. Baltimore, Maryland, May 22, 2025. Dean of the School of Medicine. President of the University.',
    expectedOutput: {
      credentialType: 'DEGREE',
      subType: 'professional_md',
      reasoning: 'OBSERVE: Medical school diploma with Trustees, Dean, and President references. IDENTIFY: Johns Hopkins University School of Medicine — one of the top medical schools globally. CLASSIFY: Doctor of Medicine (MD) — professional doctoral degree. VERIFY: Standard medical school diploma format from a highly reputable institution.',
      concerns: [],
      confidenceReasoning: 'High confidence: premier medical school, standard MD diploma format, all key details present.',
      confidence: 0.95,
    },
  },

  // ============================================================
  // LICENSE (8 examples: 2 expired, 1 international)
  // ============================================================
  {
    inputText: 'State of California. Board of Registered Nursing. License to Practice as a Registered Nurse. The Board of Registered Nursing hereby certifies that [NAME_REDACTED] has met all requirements and is licensed to practice as a Registered Nurse in the State of California. License Number: RN-789456. Issue Date: March 1, 2024. Expiration Date: March 31, 2026. Status: ACTIVE.',
    expectedOutput: {
      credentialType: 'LICENSE',
      subType: 'nursing_rn',
      reasoning: 'OBSERVE: State board license with license number, dates, and active status. IDENTIFY: California Board of Registered Nursing — the sole licensing authority for RNs in California. CLASSIFY: Registered Nurse license. VERIFY: License number format (RN- prefix) is consistent with California BRN format.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard RN license format with all fields present and active status.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'Texas Real Estate Commission. Real Estate Broker License. The Texas Real Estate Commission certifies that [NAME_REDACTED] has qualified and is licensed as a Real Estate Broker. License No.: 654321. Original Date of Licensure: January 15, 2018. Expiration Date: January 14, 2026. Status: ACTIVE. Office: Premier Realty Group, Austin, TX.',
    expectedOutput: {
      credentialType: 'LICENSE',
      subType: 'real_estate',
      reasoning: 'OBSERVE: State commission license with broker designation, license number, and office affiliation. IDENTIFY: Texas Real Estate Commission (TREC) — the regulatory body for real estate in Texas. CLASSIFY: Real Estate Broker license. VERIFY: Standard TREC format, dates are reasonable.',
      concerns: [],
      confidenceReasoning: 'High confidence: clearly formatted license from recognized state commission.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'Commonwealth of Pennsylvania. Bureau of Professional and Occupational Affairs. State Board of Accountancy. CPA License. This certifies that [NAME_REDACTED] is licensed as a Certified Public Accountant. License No.: PA-CPA-087654. Issue Date: June 15, 2019. Expiration Date: April 30, 2024. Status: EXPIRED — Renewal Required.',
    expectedOutput: {
      credentialType: 'LICENSE',
      subType: 'cpa',
      reasoning: 'OBSERVE: State board license showing CPA credential with explicit EXPIRED status. IDENTIFY: Pennsylvania Bureau of Professional and Occupational Affairs, State Board of Accountancy. CLASSIFY: CPA license. VERIFY: License is explicitly marked as expired.',
      concerns: ['License status is EXPIRED — renewal required', 'Expiration date of April 30, 2024 has passed'],
      confidenceReasoning: 'High confidence in extraction accuracy, though credential validity is compromised by expired status.',
      confidence: 0.91,
    },
  },
  {
    inputText: 'State of Florida. Department of Health. Board of Medicine. License to Practice Medicine. [NAME_REDACTED], M.D. is licensed to practice Medicine and Surgery in the State of Florida. License No.: ME-123456. Original Issue Date: August 1, 2015. Expiration Date: January 31, 2024. Current Status: INACTIVE — EXPIRED. Last Renewal: January 31, 2022.',
    expectedOutput: {
      credentialType: 'LICENSE',
      subType: 'medical_md',
      reasoning: 'OBSERVE: State medical board license with detailed status history and INACTIVE/EXPIRED notation. IDENTIFY: Florida Department of Health, Board of Medicine. CLASSIFY: Medical doctor license (MD). VERIFY: License explicitly marked as INACTIVE and EXPIRED since January 2024.',
      concerns: ['License is INACTIVE and EXPIRED since January 2024', 'Last renewal was January 2022 — two years without renewal'],
      confidenceReasoning: 'High confidence in extraction accuracy; expired status clearly documented.',
      confidence: 0.90,
    },
  },
  {
    inputText: 'Nursing and Midwifery Board of Australia. Registration Certificate. [NAME_REDACTED] is registered under the Health Practitioner Regulation National Law as a Registered Nurse (Division 1). Registration Number: NMW[REDACTED]. Registration Type: General. Conditions: Nil. Expiry Date: 31 May 2027. This registration is managed by the Australian Health Practitioner Regulation Agency (AHPRA).',
    expectedOutput: {
      credentialType: 'LICENSE',
      subType: 'nursing_rn',
      reasoning: 'OBSERVE: Australian nursing registration certificate with AHPRA oversight. IDENTIFY: Nursing and Midwifery Board of Australia, managed by AHPRA — the national regulatory body. CLASSIFY: Registered Nurse (Division 1) registration, equivalent to RN license. VERIFY: Standard AHPRA registration format. Registration number is redacted.',
      concerns: ['International credential — Australian registration, not a US license', 'Registration number is redacted and cannot be verified'],
      confidenceReasoning: 'High confidence: well-structured registration document from recognized Australian regulatory body.',
      confidence: 0.88,
    },
  },
  {
    inputText: 'Oregon State Board of Pharmacy. Pharmacist License. The Oregon State Board of Pharmacy hereby certifies that [NAME_REDACTED] is licensed to practice Pharmacy in the State of Oregon. License Number: PH-2021-34567. Date of Issuance: September 1, 2021. Expiration Date: June 30, 2027. Status: ACTIVE. DEA Number: [REDACTED].',
    expectedOutput: {
      credentialType: 'LICENSE',
      subType: 'pharmacist',
      reasoning: 'OBSERVE: State board pharmacy license with standard fields and DEA number reference. IDENTIFY: Oregon State Board of Pharmacy. CLASSIFY: Pharmacist license. VERIFY: License number format is consistent, DEA number is properly redacted, active status confirmed.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard pharmacist license with all fields present.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'State of Illinois. Department of Financial and Professional Regulation. Division of Professional Regulation. Professional Engineer License. [NAME_REDACTED], PE is licensed to practice Professional Engineering in the State of Illinois. Discipline: Structural Engineering. License Number: 062-078901. Issue Date: May 15, 2020. Expiration Date: November 30, 2026. Status: ACTIVE.',
    expectedOutput: {
      credentialType: 'LICENSE',
      subType: 'engineering_pe',
      reasoning: 'OBSERVE: State-issued PE license with discipline specification (Structural). IDENTIFY: Illinois Department of Financial and Professional Regulation — the licensing authority. CLASSIFY: Professional Engineer license with structural discipline. VERIFY: Standard IL PE license format, active status.',
      concerns: [],
      confidenceReasoning: 'High confidence: clearly formatted PE license from recognized state authority.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'Supreme Court of the State of New York. Appellate Division, First Department. Certificate of Admission. This is to certify that [NAME_REDACTED] having complied with all the requirements, is duly admitted as an Attorney and Counselor-at-Law of the State of New York. Admitted: November 15, 2023. Roll Number: [REDACTED].',
    expectedOutput: {
      credentialType: 'LICENSE',
      subType: 'law_bar_admission',
      reasoning: 'OBSERVE: Bar admission certificate from state supreme court, appellate division. IDENTIFY: Supreme Court of the State of New York, Appellate Division — the admitting authority for attorneys. CLASSIFY: Bar admission — law license to practice. VERIFY: Standard New York bar admission format.',
      concerns: ['Roll number is redacted — cannot verify admission status directly'],
      confidenceReasoning: 'High confidence: standard bar admission certificate format from recognized court.',
      confidence: 0.91,
    },
  },

  // ============================================================
  // CERTIFICATE (6 examples: IT certs, professional certs)
  // ============================================================
  {
    inputText: 'Amazon Web Services. AWS Certified Solutions Architect — Professional. This is to certify that [NAME_REDACTED] has successfully demonstrated proficiency and was awarded this certification on February 10, 2026. Certification ID: AWS-PSA-2026-78901. Validation Number: [REDACTED]. Valid through February 9, 2029.',
    expectedOutput: {
      credentialType: 'CERTIFICATE',
      subType: 'it_certification',
      reasoning: 'OBSERVE: Cloud certification with certification ID, validation number, and 3-year validity period. IDENTIFY: Amazon Web Services (AWS) — major cloud provider and certifying authority. CLASSIFY: IT certification — AWS Solutions Architect Professional is a recognized cloud credential. VERIFY: Standard AWS cert format with ID and validation number.',
      concerns: [],
      confidenceReasoning: 'High confidence: well-known IT certification from AWS with complete metadata.',
      confidence: 0.94,
    },
  },
  {
    inputText: 'Project Management Institute. PMP — Project Management Professional. This is to certify that [NAME_REDACTED] has fulfilled all the requirements and is hereby granted the credential of PMP. PMP Number: 3891045. Date Granted: April 5, 2025. Expiration Date: April 4, 2028. PDU Cycle: 60 PDUs / 3 Years.',
    expectedOutput: {
      credentialType: 'CERTIFICATE',
      subType: 'professional_certification',
      reasoning: 'OBSERVE: Professional certification with unique number, grant date, expiration, and PDU requirements. IDENTIFY: Project Management Institute (PMI) — the global certifying body for project managers. CLASSIFY: Professional certification (PMP). VERIFY: Standard PMI format with PDU maintenance requirements.',
      concerns: [],
      confidenceReasoning: 'High confidence: globally recognized professional certification with complete details.',
      confidence: 0.94,
    },
  },
  {
    inputText: 'Cisco Systems. Cisco Certified Network Professional (CCNP) Enterprise. [NAME_REDACTED] has met all certification requirements. Cisco ID: CSCO[REDACTED]. Certification Date: January 20, 2026. Active through: January 19, 2029. Verify at cisco.com/go/verifycertificate.',
    expectedOutput: {
      credentialType: 'CERTIFICATE',
      subType: 'it_certification',
      reasoning: 'OBSERVE: IT vendor certification with Cisco ID, dates, and verification URL. IDENTIFY: Cisco Systems — networking vendor and certifying body. CLASSIFY: IT certification — CCNP Enterprise. VERIFY: Includes verification URL which adds authenticity.',
      concerns: [],
      confidenceReasoning: 'High confidence: major IT vendor certification with verification link.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'OSHA. Occupational Safety and Health Administration. U.S. Department of Labor. OSHA 30-Hour Construction Safety and Health. This certifies that [NAME_REDACTED] has completed the OSHA Outreach Training Program 30-Hour Construction Industry course. Card Number: [REDACTED]. Completion Date: March 15, 2026. Trainer: [NAME_REDACTED], OSHA Authorized Trainer.',
    expectedOutput: {
      credentialType: 'CERTIFICATE',
      subType: 'training_certificate',
      reasoning: 'OBSERVE: OSHA training completion certificate with 30-hour designation and authorized trainer. IDENTIFY: OSHA (Occupational Safety and Health Administration), U.S. Department of Labor. CLASSIFY: Training certificate — OSHA safety certification is a training completion, not a license. VERIFY: Standard OSHA outreach training format.',
      concerns: [],
      confidenceReasoning: 'High confidence: well-known federal training program with standard format.',
      confidence: 0.92,
    },
  },
  {
    inputText: '(ISC)2. Certified Information Systems Security Professional. CISSP. This is to certify that [NAME_REDACTED] has met the requirements established by (ISC)2 and is awarded the CISSP credential. Member ID: [REDACTED]. Certification Date: October 12, 2024. Annual Maintenance Fee and CPE requirements apply. Endorsed by: [NAME_REDACTED], (ISC)2 Member.',
    expectedOutput: {
      credentialType: 'CERTIFICATE',
      subType: 'it_certification',
      reasoning: 'OBSERVE: Security certification with member endorsement and CPE maintenance requirements. IDENTIFY: (ISC)2 — the certifying body for information security professionals. CLASSIFY: IT certification — CISSP is a widely recognized information security credential. VERIFY: Standard (ISC)2 format with endorsement and maintenance requirements.',
      concerns: ['No explicit expiration date listed — relies on annual CPE and maintenance fee'],
      confidenceReasoning: 'High confidence: premier information security certification from recognized body.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'Google Cloud. Professional Cloud Architect. This credential certifies that [NAME_REDACTED] has demonstrated proficiency in designing, developing, and managing Google Cloud solutions. Credential ID: GCP-PCA-2026-45678. Issue Date: January 8, 2026. Expiration Date: January 7, 2028.',
    expectedOutput: {
      credentialType: 'CERTIFICATE',
      subType: 'it_certification',
      reasoning: 'OBSERVE: Cloud vendor certification with credential ID and 2-year validity. IDENTIFY: Google Cloud — major cloud provider and certifying authority. CLASSIFY: IT certification — Professional Cloud Architect. VERIFY: Standard Google Cloud cert format.',
      concerns: [],
      confidenceReasoning: 'High confidence: well-known cloud certification with complete metadata.',
      confidence: 0.93,
    },
  },

  // ============================================================
  // TRANSCRIPT (6 examples: official, unofficial, international/WES)
  // ============================================================
  {
    inputText: 'University of California, Berkeley. Office of the Registrar. Official Academic Transcript. Issued: December 15, 2025. Student: [NAME_REDACTED]. Student ID: [REDACTED]. Program: Bachelor of Arts, Economics. Admit: Fall 2022. Degree Awarded: May 2025. Cumulative GPA: 3.67. Total Units: 120. THIS IS AN OFFICIAL TRANSCRIPT. Registrar Seal Applied.',
    expectedOutput: {
      credentialType: 'TRANSCRIPT',
      subType: 'official_undergraduate',
      reasoning: 'OBSERVE: Registrar-issued transcript with "OFFICIAL" designation, seal reference, GPA, and units. IDENTIFY: UC Berkeley Office of the Registrar. CLASSIFY: Official undergraduate transcript — BA in Economics. VERIFY: Standard official transcript format with registrar seal.',
      concerns: [],
      confidenceReasoning: 'High confidence: explicitly marked as official, from registrar, with seal reference.',
      confidence: 0.94,
    },
  },
  {
    inputText: 'Massachusetts Institute of Technology. Graduate Transcript. Student: [NAME_REDACTED]. ID: [REDACTED]. Program: Doctor of Philosophy in Computer Science. Admission: September 2020. Thesis Defense: March 2025. Degree Conferred: June 2025. Cumulative GPA: 4.8/5.0. This document is an official record of the Massachusetts Institute of Technology.',
    expectedOutput: {
      credentialType: 'TRANSCRIPT',
      subType: 'official_graduate',
      reasoning: 'OBSERVE: Graduate transcript with thesis defense date, PhD program details, and official record statement. IDENTIFY: MIT — world-renowned research university. CLASSIFY: Official graduate transcript for PhD program. VERIFY: Includes thesis defense date and degree conferral, consistent with doctoral programs.',
      concerns: [],
      confidenceReasoning: 'High confidence: clearly official graduate transcript with comprehensive academic record.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'UNOFFICIAL TRANSCRIPT. Downloaded from Student Portal. [NAME_REDACTED]. University of Texas at Austin. College of Liberal Arts. Major: History. Minor: Political Science. Fall 2024: American History Since 1865 (B+), Constitutional Law (A-), Political Theory (A). Spring 2025: Civil War and Reconstruction (A), International Relations (B). Cum. GPA: 3.45. Note: This is not an official document.',
    expectedOutput: {
      credentialType: 'TRANSCRIPT',
      subType: 'unofficial',
      reasoning: 'OBSERVE: Explicitly labeled "UNOFFICIAL TRANSCRIPT" with "Downloaded from Student Portal" and disclaimer. IDENTIFY: University of Texas at Austin. CLASSIFY: Unofficial transcript — explicitly stated as not official. VERIFY: Contains disclaimer that this is not an official document.',
      concerns: ['Explicitly marked as unofficial — not suitable for official verification purposes'],
      confidenceReasoning: 'High confidence in classification as unofficial transcript; document itself states non-official status.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'World Education Services (WES). Credential Evaluation Report. Evaluation Number: WES-2025-78901. Prepared for: [NAME_REDACTED]. Foreign Credential: Bachelor of Technology in Information Technology. Awarding Institution: Indian Institute of Technology Bombay, Mumbai, India. Year of Award: 2023. US Equivalency: Bachelor\'s degree (four years). Major: Information Technology. GPA Equivalent: 3.7/4.0.',
    expectedOutput: {
      credentialType: 'TRANSCRIPT',
      subType: 'international_wes',
      reasoning: 'OBSERVE: WES credential evaluation report with evaluation number, foreign credential details, and US equivalency. IDENTIFY: World Education Services (WES) — the leading credential evaluation service. CLASSIFY: International transcript evaluation — WES report establishes US equivalency. VERIFY: Standard WES report format with institution, equivalency, and GPA conversion.',
      concerns: ['This is an evaluation report, not the original transcript — original should also be on file'],
      confidenceReasoning: 'High confidence: standard WES evaluation report with complete details.',
      confidence: 0.91,
    },
  },
  {
    inputText: 'Lincoln High School. Official Transcript. Student: [NAME_REDACTED]. Student ID: [REDACTED]. Graduation Date: June 2021. Cumulative GPA: 3.2/4.0. Class Rank: 87 of 412. Courses: AP Calculus AB (4), AP English Literature (3), US History (B+), Chemistry Honors (A-), Physics (B). SAT Score: [REDACTED]. ACT Score: [REDACTED]. Diploma: Standard High School Diploma.',
    expectedOutput: {
      credentialType: 'TRANSCRIPT',
      subType: 'high_school',
      reasoning: 'OBSERVE: High school transcript with class rank, AP courses, standardized test references, and diploma type. IDENTIFY: Lincoln High School — a high school (not a university). CLASSIFY: High school transcript with graduation record. VERIFY: Standard high school transcript format with GPA, rank, and course listing.',
      concerns: [],
      confidenceReasoning: 'High confidence: clearly a high school transcript with standard fields.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'Columbia University. Fu Foundation School of Engineering and Applied Science. Official Academic Record. Student: [NAME_REDACTED]. Program: Master of Science in Data Science. Enrolled: Fall 2024. Expected Completion: May 2026. Fall 2024: Machine Learning (A), Statistical Inference (A-), Algorithms for Data Science (B+). Spring 2025: Deep Learning (A), Natural Language Processing (IP). Semester GPA: 3.78. Note: IP = In Progress.',
    expectedOutput: {
      credentialType: 'TRANSCRIPT',
      subType: 'official_graduate',
      reasoning: 'OBSERVE: Official academic record from engineering school with in-progress courses. IDENTIFY: Columbia University, Fu Foundation School of Engineering. CLASSIFY: Official graduate transcript — MS in Data Science. VERIFY: Has in-progress courses, indicating student is still enrolled.',
      concerns: ['Contains in-progress courses — degree not yet completed'],
      confidenceReasoning: 'High confidence: official record from recognized university, though degree is incomplete.',
      confidence: 0.90,
    },
  },

  // ============================================================
  // PROFESSIONAL (5 examples: board cert, residency, fellowship)
  // ============================================================
  {
    inputText: 'American Board of Internal Medicine. Certificate of Qualification. This is to certify that [NAME_REDACTED], M.D. is certified as a Diplomate of the American Board of Internal Medicine in the subspecialty of Cardiovascular Disease. Certificate Number: [REDACTED]. Date of Certification: November 1, 2024. Valid Through: December 31, 2034. Maintenance of Certification: Current.',
    expectedOutput: {
      credentialType: 'PROFESSIONAL',
      subType: 'board_certification',
      reasoning: 'OBSERVE: Board certification in medical subspecialty with Diplomate status and MOC requirements. IDENTIFY: American Board of Internal Medicine (ABIM) — one of the ABMS member boards. CLASSIFY: Board certification — Cardiovascular Disease subspecialty. VERIFY: Standard ABIM format with 10-year validity and MOC status.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard medical board certification from recognized ABMS member board.',
      confidence: 0.94,
    },
  },
  {
    inputText: 'Accreditation Council for Graduate Medical Education. Certificate of Completion. This certifies that [NAME_REDACTED], M.D. has successfully completed an ACGME-accredited residency program in General Surgery at Massachusetts General Hospital. Program Duration: July 2019 — June 2024 (5 years). Program Director: [NAME_REDACTED], M.D., FACS. Program Number: 4401721042.',
    expectedOutput: {
      credentialType: 'PROFESSIONAL',
      subType: 'residency',
      reasoning: 'OBSERVE: Residency completion certificate with ACGME accreditation, program number, and 5-year duration. IDENTIFY: ACGME and Massachusetts General Hospital — both highly reputable. CLASSIFY: Residency completion — surgical residency is a post-MD training program. VERIFY: 5-year duration is standard for general surgery residency.',
      concerns: [],
      confidenceReasoning: 'High confidence: ACGME-accredited residency at a premier institution with complete details.',
      confidence: 0.94,
    },
  },
  {
    inputText: 'Royal College of Physicians of London. This is to certify that [NAME_REDACTED] has been admitted as a Fellow of the Royal College of Physicians (FRCP). Elected: March 2025. Fellowship Number: [REDACTED]. The Fellow has demonstrated distinction in the practice of medicine and has made a significant contribution to the profession.',
    expectedOutput: {
      credentialType: 'PROFESSIONAL',
      subType: 'fellowship',
      reasoning: 'OBSERVE: Fellowship admission certificate from a Royal College with election date and distinction language. IDENTIFY: Royal College of Physicians of London — one of the oldest medical institutions in England. CLASSIFY: Fellowship — FRCP is an honorary/elected fellowship, not a training fellowship. VERIFY: Standard RCP fellowship format.',
      concerns: ['International credential — UK fellowship, not directly equivalent to US board certification'],
      confidenceReasoning: 'High confidence: prestigious medical fellowship with clear institutional identity.',
      confidence: 0.91,
    },
  },
  {
    inputText: 'American College of Surgeons. Fellowship Certificate. [NAME_REDACTED], M.D. has been admitted as a Fellow of the American College of Surgeons (FACS). This designation indicates that the surgeon has met the rigorous requirements of the College. Date of Admission: October 2025. Convocation: Clinical Congress 2025.',
    expectedOutput: {
      credentialType: 'PROFESSIONAL',
      subType: 'fellowship',
      reasoning: 'OBSERVE: Surgical fellowship admission with FACS designation and convocation reference. IDENTIFY: American College of Surgeons — the premier professional organization for surgeons. CLASSIFY: Fellowship — FACS is an honorary designation based on meeting professional standards. VERIFY: Standard ACS fellowship certificate format.',
      concerns: [],
      confidenceReasoning: 'High confidence: recognized surgical fellowship with clear admission details.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'American Medical Association. Certificate of Membership. This certifies that [NAME_REDACTED], M.D. is a member in good standing of the American Medical Association. Member Since: 2018. Membership Number: [REDACTED]. Category: Active Physician. Specialty: Pediatrics.',
    expectedOutput: {
      credentialType: 'PROFESSIONAL',
      subType: 'membership',
      reasoning: 'OBSERVE: Professional membership certificate with member status and category. IDENTIFY: American Medical Association (AMA) — the largest association of physicians in the US. CLASSIFY: Professional membership — AMA membership is a voluntary professional affiliation, not a license or certification. VERIFY: Standard AMA membership format.',
      concerns: ['Membership is a professional affiliation, not a license or clinical credential'],
      confidenceReasoning: 'High confidence: standard professional membership certificate with clear details.',
      confidence: 0.91,
    },
  },

  // ============================================================
  // CLE (5 examples: ethics, general, CME, CPE)
  // ============================================================
  {
    inputText: 'New York State CLE Board. Certificate of Attendance. [NAME_REDACTED], Esq. has completed: Ethics in the Age of Artificial Intelligence. Ethics Credits: 2.0. Date: February 20, 2026. Provider: New York City Bar Association. Approved by: New York State CLE Board. Format: Live Program. Activity ID: NY-CLE-2026-1234.',
    expectedOutput: {
      credentialType: 'CLE',
      subType: 'ethics_cle',
      reasoning: 'OBSERVE: CLE certificate with explicit Ethics credit designation, activity ID, and approval reference. IDENTIFY: New York State CLE Board as approving authority, NYC Bar Association as provider. CLASSIFY: Ethics CLE — explicitly designated as Ethics credits. VERIFY: Standard NY CLE format with activity ID.',
      concerns: [],
      confidenceReasoning: 'High confidence: complete CLE certificate with ethics designation and approval.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'State Bar of Texas. MCLE Certificate. [NAME_REDACTED] has completed: Advanced Civil Litigation Strategies. CLE Credits: 6.0 (including 1.0 Ethics). Date: March 10, 2026. Provider: Texas Trial Lawyers Association. Approved Provider Number: 0987. Activity Number: TX-CLE-2026-5678.',
    expectedOutput: {
      credentialType: 'CLE',
      subType: 'general_cle',
      reasoning: 'OBSERVE: MCLE certificate with mixed credit types (general + ethics), approved provider number. IDENTIFY: State Bar of Texas as approving authority. CLASSIFY: General CLE — primarily general credits with 1.0 ethics included. VERIFY: Standard Texas MCLE format with provider number.',
      concerns: [],
      confidenceReasoning: 'High confidence: well-formatted MCLE certificate with complete details.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'ACCME Accredited Provider. Mayo Clinic School of Continuous Professional Development. Certificate of Completion. [NAME_REDACTED], M.D. Activity: Advanced Cardiac Imaging Techniques. AMA PRA Category 1 Credits: 15.0. Date Completed: April 5, 2026. This activity was planned in accordance with ACCME accreditation requirements.',
    expectedOutput: {
      credentialType: 'CLE',
      subType: 'general_cle',
      reasoning: 'OBSERVE: CME certificate with AMA PRA Category 1 credits and ACCME accreditation statement. IDENTIFY: Mayo Clinic, ACCME-accredited provider. CLASSIFY: Continuing medical education (CME) — categorized under CLE for continuing professional education. VERIFY: Standard ACCME format with credit designation.',
      concerns: [],
      confidenceReasoning: 'High confidence: ACCME-accredited CME from a premier medical institution.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'AICPA. Certificate of Continuing Professional Education. [NAME_REDACTED], CPA. Program: Forensic Accounting and Fraud Examination. CPE Credits: 16.0. Field of Study: Auditing. Delivery Method: Group Live. NASBA Sponsor ID: 112891. Date: January 22, 2026. Meets NASBA standards for CPE.',
    expectedOutput: {
      credentialType: 'CLE',
      subType: 'general_cle',
      reasoning: 'OBSERVE: CPE certificate with NASBA sponsor ID, field of study, and delivery method. IDENTIFY: AICPA with NASBA sponsorship — recognized CPE providers for accountants. CLASSIFY: CPE (Continuing Professional Education) — categorized under CLE. VERIFY: Standard NASBA-compliant CPE format.',
      concerns: [],
      confidenceReasoning: 'High confidence: NASBA-compliant CPE with complete metadata.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'Illinois MCLE Board. Certificate of Completion. [NAME_REDACTED] has completed: Diversity, Equity, and Inclusion in Legal Practice. Credits: 3.0 Professional Responsibility (Diversity & Inclusion). Date: May 1, 2026. Provider: Illinois State Bar Association. Activity No.: IL-MCLE-2026-7890.',
    expectedOutput: {
      credentialType: 'CLE',
      subType: 'specialized_cle',
      reasoning: 'OBSERVE: MCLE certificate specifically for diversity and inclusion with Professional Responsibility designation. IDENTIFY: Illinois MCLE Board as approving authority. CLASSIFY: Specialized CLE — diversity and inclusion is a specialized professional responsibility area in many jurisdictions. VERIFY: Standard IL MCLE format.',
      concerns: [],
      confidenceReasoning: 'High confidence: clearly formatted specialized CLE from state MCLE board.',
      confidence: 0.92,
    },
  },

  // ============================================================
  // BADGE (3 examples)
  // ============================================================
  {
    inputText: 'Credly Digital Badge. Badge Name: AWS Certified Cloud Practitioner. Issued by: Amazon Web Services Training and Certification. Issued to: [NAME_REDACTED]. Issue Date: March 1, 2026. Expiration Date: March 1, 2029. Badge ID: aws-cp-2026-56789. Skills: Cloud Concepts, AWS Core Services, Security, Billing. Verify at credly.com/badges/[REDACTED].',
    expectedOutput: {
      credentialType: 'BADGE',
      subType: 'digital_badge',
      reasoning: 'OBSERVE: Credly digital badge with badge ID, skills list, and verification URL. IDENTIFY: Credly platform, issued by AWS Training and Certification. CLASSIFY: Digital badge — explicitly from Credly badge platform with digital verification. VERIFY: Includes verification URL and badge ID.',
      concerns: [],
      confidenceReasoning: 'High confidence: Credly digital badge with verification link and complete metadata.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'Acclaim / Credly. Microcredential Badge. Badge: Google Data Analytics Professional Certificate. Issued by: Google Career Certificates. Recipient: [NAME_REDACTED]. Date Issued: February 15, 2026. Skills: Data Cleaning, SQL, R Programming, Tableau, Data Visualization. This badge represents completion of the Google Data Analytics Professional Certificate program on Coursera.',
    expectedOutput: {
      credentialType: 'BADGE',
      subType: 'microcredential',
      reasoning: 'OBSERVE: Acclaim/Credly microcredential badge with skills list and Coursera program reference. IDENTIFY: Google Career Certificates via Coursera, hosted on Credly. CLASSIFY: Microcredential — represents completion of a multi-course online program. VERIFY: Standard Credly badge format with program reference.',
      concerns: ['This is a course completion badge, not a proctored professional certification'],
      confidenceReasoning: 'High confidence: standard digital microcredential from recognized platform.',
      confidence: 0.90,
    },
  },
  {
    inputText: 'Badgr. Open Badge. Badge Name: Introduction to Machine Learning. Issuer: Stanford Online. Recipient: [NAME_REDACTED]. Issued: April 10, 2026. Description: Awarded for completion of the Introduction to Machine Learning self-paced course. Evidence URL: [REDACTED]. Badge Criteria: Complete all modules and pass final assessment with 70% or higher.',
    expectedOutput: {
      credentialType: 'BADGE',
      subType: 'digital_badge',
      reasoning: 'OBSERVE: Badgr Open Badge with evidence URL, criteria, and issuer details. IDENTIFY: Stanford Online via Badgr platform. CLASSIFY: Digital badge — Open Badge standard from Badgr. VERIFY: Includes explicit badge criteria and evidence URL.',
      concerns: ['Self-paced course badge — lower weight than proctored certification'],
      confidenceReasoning: 'High confidence: standard Open Badge format with clear criteria.',
      confidence: 0.89,
    },
  },

  // ============================================================
  // ATTESTATION (4 examples: employment verification, character ref)
  // ============================================================
  {
    inputText: 'TechCorp International. Human Resources Department. 500 Innovation Drive, San Jose, CA 95110. April 1, 2026. To Whom It May Concern: RE: Employment Verification for [NAME_REDACTED]. This letter confirms that [NAME_REDACTED] was employed by TechCorp International from March 15, 2020 to February 28, 2026. Position: Senior Software Engineer. Department: Platform Engineering. Employment Type: Full-Time. Final Title: Staff Engineer. Signed: [NAME_REDACTED], Director of Human Resources.',
    expectedOutput: {
      credentialType: 'ATTESTATION',
      subType: 'employment_verification',
      reasoning: 'OBSERVE: HR department letter on company letterhead with employment dates, position, and department. IDENTIFY: TechCorp International HR Department. CLASSIFY: Employment verification letter — a standard HR attestation of employment history. VERIFY: Contains typical employment verification fields (dates, title, department).',
      concerns: [],
      confidenceReasoning: 'High confidence: standard employment verification letter with complete details.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'To Whom It May Concern: I, [NAME_REDACTED], am writing to provide a character reference for [NAME_REDACTED]. I have known [NAME_REDACTED] for approximately eight years in both professional and personal capacities. During this time, I have found them to be a person of exceptional integrity, strong work ethic, and outstanding moral character. I recommend them without reservation. Signed: [NAME_REDACTED], Senior Partner, [LAW_FIRM_REDACTED]. Date: March 15, 2026.',
    expectedOutput: {
      credentialType: 'ATTESTATION',
      subType: 'character_reference',
      reasoning: 'OBSERVE: Personal letter format with character assessment and recommender credentials. IDENTIFY: Written by a senior partner at a law firm — provides professional weight. CLASSIFY: Character reference — a personal attestation of character, not employment verification. VERIFY: Standard character reference format.',
      concerns: ['Character references are subjective and not independently verifiable'],
      confidenceReasoning: 'Moderate-high confidence: clearly a character reference letter, though limited verifiable metadata.',
      confidence: 0.85,
    },
  },
  {
    inputText: 'Global Consulting Group. 1200 Avenue of the Americas, New York, NY 10036. March 28, 2026. Employment and Salary Verification. Employee: [NAME_REDACTED]. Employee ID: GCG-[REDACTED]. Current Position: Managing Director. Department: Strategy & Operations. Start Date: January 10, 2015. Current Status: Active. Current Base Salary: [SALARY_REDACTED]. Bonus Target: [SALARY_REDACTED]. This verification is provided at the request of [NAME_REDACTED] for mortgage purposes.',
    expectedOutput: {
      credentialType: 'ATTESTATION',
      subType: 'employment_verification',
      reasoning: 'OBSERVE: Employment and salary verification with specific purpose (mortgage), current status, and salary fields redacted. IDENTIFY: Global Consulting Group — employer providing verification. CLASSIFY: Employment verification — includes both employment status and salary confirmation. VERIFY: Standard employment/salary verification for financial purposes.',
      concerns: ['Salary information is redacted — full verification would require original'],
      confidenceReasoning: 'High confidence: standard employment verification format with clear purpose.',
      confidence: 0.91,
    },
  },
  {
    inputText: 'Board of Directors. Nonprofit Foundation for Education. Resolution. Whereas [NAME_REDACTED] has served as Executive Director of the Foundation from 2018 to 2026, and whereas their leadership has resulted in significant growth and impact, the Board hereby resolves to commend [NAME_REDACTED] for their outstanding service. Approved unanimously, March 20, 2026. Board Chair: [NAME_REDACTED].',
    expectedOutput: {
      credentialType: 'ATTESTATION',
      subType: 'service_commendation',
      reasoning: 'OBSERVE: Board resolution format with "Whereas" clauses and unanimous approval. IDENTIFY: Nonprofit Foundation for Education board. CLASSIFY: Service commendation — a board resolution recognizing service, not an employment verification. VERIFY: Standard board resolution format.',
      concerns: ['Board resolutions are internal documents — limited external verification value'],
      confidenceReasoning: 'Moderate-high confidence: clearly a board resolution/commendation.',
      confidence: 0.87,
    },
  },

  // ============================================================
  // FINANCIAL (3 examples)
  // ============================================================
  {
    inputText: 'Independent Auditor\'s Report. To the Board of Directors and Shareholders of [COMPANY_REDACTED]. Opinion: We have audited the accompanying consolidated financial statements of [COMPANY_REDACTED], which comprise the consolidated balance sheet as of December 31, 2025. In our opinion, the consolidated financial statements present fairly, in all material respects, the financial position of [COMPANY_REDACTED]. Basis for Opinion: We conducted our audit in accordance with GAAS and PCAOB standards. Report Date: February 28, 2026. Signed: [NAME_REDACTED], CPA, Partner, Deloitte & Touche LLP.',
    expectedOutput: {
      credentialType: 'FINANCIAL',
      subType: 'audit_report',
      reasoning: 'OBSERVE: Independent auditor\'s report with opinion, GAAS/PCAOB references, and CPA partner signature. IDENTIFY: Deloitte & Touche LLP — Big Four accounting firm. CLASSIFY: Audit report — standard independent auditor\'s report on financial statements. VERIFY: Standard audit report format with proper opinion language.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard audit report format from Big Four firm.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'Internal Revenue Service. Department of the Treasury. Form 1099-MISC. Miscellaneous Information. Tax Year 2025. Payer: [COMPANY_REDACTED]. Payer TIN: [REDACTED]. Recipient: [NAME_REDACTED]. Recipient TIN: [REDACTED]. Box 7 — Nonemployee Compensation: [AMOUNT_REDACTED]. Copy B — For Recipient. This is important tax information and is being furnished to the IRS.',
    expectedOutput: {
      credentialType: 'FINANCIAL',
      subType: 'tax_document',
      reasoning: 'OBSERVE: IRS tax form 1099-MISC with standard box layout and tax year. IDENTIFY: Internal Revenue Service, Department of the Treasury. CLASSIFY: Tax document — 1099-MISC is an official tax form for miscellaneous income. VERIFY: Standard IRS form format with copy designation.',
      concerns: ['Contains sensitive financial information — TINs are redacted'],
      confidenceReasoning: 'High confidence: standard IRS tax form format clearly identifiable.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'SEC EDGAR Filing. Form 10-K. Annual Report. [COMPANY_REDACTED] Inc. CIK: [REDACTED]. Filed: March 15, 2026. Fiscal Year Ended: December 31, 2025. Commission File Number: 001-[REDACTED]. Revenue: [AMOUNT_REDACTED]. Net Income: [AMOUNT_REDACTED]. Total Assets: [AMOUNT_REDACTED]. Certifications under Section 302 and 906 of the Sarbanes-Oxley Act included.',
    expectedOutput: {
      credentialType: 'FINANCIAL',
      subType: 'regulatory_filing',
      reasoning: 'OBSERVE: SEC EDGAR 10-K filing with CIK, commission file number, and Sarbanes-Oxley certifications. IDENTIFY: SEC EDGAR — the official filing system for the Securities and Exchange Commission. CLASSIFY: Financial regulatory filing — annual report (10-K). VERIFY: Standard 10-K format with SOX certifications.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard SEC filing format with required certifications.',
      confidence: 0.93,
    },
  },

  // ============================================================
  // LEGAL (3 examples)
  // ============================================================
  {
    inputText: 'SERVICES AGREEMENT. This Services Agreement ("Agreement") is entered into as of January 15, 2026 ("Effective Date"), by and between [COMPANY_REDACTED] ("Client") and [COMPANY_REDACTED] ("Vendor"). 1. SCOPE OF SERVICES: Vendor shall provide software development consulting services as described in Exhibit A. 2. TERM: This Agreement shall commence on the Effective Date and continue for a period of twelve (12) months. 3. COMPENSATION: Client shall pay Vendor [AMOUNT_REDACTED] per month. Governing Law: State of Delaware.',
    expectedOutput: {
      credentialType: 'LEGAL',
      subType: 'contract',
      reasoning: 'OBSERVE: Formal contract with defined terms, numbered sections, effective date, and governing law. IDENTIFY: Two parties — Client and Vendor (both redacted). CLASSIFY: Legal contract — services agreement between two parties. VERIFY: Standard commercial contract format with governing law clause.',
      concerns: [],
      confidenceReasoning: 'High confidence: clearly formatted legal contract with standard clauses.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'IN THE CIRCUIT COURT OF COOK COUNTY, ILLINOIS. Case No.: 2025-CH-[REDACTED]. ORDER. The Court, having considered the motion filed by Plaintiff [NAME_REDACTED] and the response of Defendant [NAME_REDACTED], hereby ORDERS as follows: 1. Defendant shall produce all documents responsive to Request No. 5 within thirty (30) days. 2. Costs of this motion are awarded to Plaintiff. SO ORDERED this 10th day of March, 2026. Judge [NAME_REDACTED], Circuit Court of Cook County.',
    expectedOutput: {
      credentialType: 'LEGAL',
      subType: 'court_order',
      reasoning: 'OBSERVE: Court order format with case number, "SO ORDERED" language, and judge signature. IDENTIFY: Circuit Court of Cook County, Illinois. CLASSIFY: Court order — judicial order compelling document production. VERIFY: Standard court order format with case number and judicial authority.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard court order format from identified court.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'Securities and Exchange Commission. Washington, D.C. 20549. Administrative Proceeding. File No. 3-[REDACTED]. ORDER INSTITUTING PROCEEDINGS. In the Matter of [COMPANY_REDACTED]. The Commission deems it necessary and appropriate for the protection of investors to institute public administrative proceedings. The respondent is alleged to have violated Section 10(b) of the Securities Exchange Act. Hearing scheduled: April 15, 2026.',
    expectedOutput: {
      credentialType: 'LEGAL',
      subType: 'regulatory_filing',
      reasoning: 'OBSERVE: SEC administrative proceeding with file number, formal legal language, and hearing date. IDENTIFY: Securities and Exchange Commission. CLASSIFY: Regulatory filing — SEC administrative proceeding/enforcement action. VERIFY: Standard SEC administrative proceeding format.',
      concerns: ['This is an enforcement action — indicates regulatory issues with the respondent'],
      confidenceReasoning: 'High confidence: clearly formatted SEC administrative proceeding.',
      confidence: 0.91,
    },
  },

  // ============================================================
  // INSURANCE (3 examples)
  // ============================================================
  {
    inputText: 'CERTIFICATE OF INSURANCE. Hartford Financial Services Group. Policy Holder: [COMPANY_REDACTED] LLC. Policy Number: CGL-2026-789012. Coverage Type: Commercial General Liability. Effective Date: January 1, 2026. Expiration Date: January 1, 2027. Each Occurrence Limit: $2,000,000. General Aggregate: $4,000,000. Products/Completed Operations: $2,000,000. Certificate Holder: [COMPANY_REDACTED] Development Corp.',
    expectedOutput: {
      credentialType: 'INSURANCE',
      subType: 'certificate_of_insurance',
      reasoning: 'OBSERVE: Certificate of insurance with policy number, coverage limits, and certificate holder. IDENTIFY: Hartford Financial Services Group — major insurance carrier. CLASSIFY: Certificate of Insurance (COI) — standard proof of commercial general liability coverage. VERIFY: Standard ACORD-style COI format with proper limit descriptions.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard COI format from recognized carrier with complete coverage details.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'Professional Liability Insurance. Declarations Page. Insurer: Berkshire Hathaway Specialty Insurance. Named Insured: [NAME_REDACTED], M.D. Policy No.: PL-2026-456789. Policy Period: March 1, 2026 to March 1, 2027. Coverage: Medical Professional Liability (Occurrence). Per Claim Limit: $1,000,000. Annual Aggregate: $3,000,000. Specialty: Orthopedic Surgery. Retroactive Date: March 1, 2020.',
    expectedOutput: {
      credentialType: 'INSURANCE',
      subType: 'professional_liability',
      reasoning: 'OBSERVE: Professional liability declarations page with per-claim and aggregate limits, retroactive date. IDENTIFY: Berkshire Hathaway Specialty Insurance — recognized carrier. CLASSIFY: Professional liability insurance — medical malpractice coverage for a physician. VERIFY: Standard medical professional liability format with occurrence coverage.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard professional liability declarations page with complete details.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'Errors & Omissions Insurance Certificate. Insurer: Travelers. Named Insured: [COMPANY_REDACTED] Consulting LLC. Policy Number: EO-2026-321654. Effective: April 1, 2026. Expires: April 1, 2027. Per Occurrence: $5,000,000. Aggregate: $10,000,000. Deductible: $25,000. Coverage Territory: United States and Canada. This certificate is issued as a matter of information only and confers no rights upon the certificate holder.',
    expectedOutput: {
      credentialType: 'INSURANCE',
      subType: 'professional_liability',
      reasoning: 'OBSERVE: E&O insurance certificate with occurrence/aggregate limits, deductible, and coverage territory. IDENTIFY: Travelers — major insurance carrier. CLASSIFY: Professional liability — E&O (Errors and Omissions) insurance for a consulting firm. VERIFY: Standard E&O certificate format with informational disclaimer.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard E&O certificate with complete coverage details.',
      confidence: 0.92,
    },
  },

  // ============================================================
  // RESUME (2 examples)
  // ============================================================
  {
    inputText: '[NAME_REDACTED]. [LOCATION_REDACTED]. [EMAIL_REDACTED] | [PHONE_REDACTED]. PROFESSIONAL SUMMARY: Senior software engineer with 10+ years of experience in distributed systems and cloud architecture. EXPERIENCE: Staff Engineer, [COMPANY_REDACTED], 2021-Present. Led migration of monolithic architecture to microservices. Senior Engineer, [COMPANY_REDACTED], 2017-2021. EDUCATION: M.S. Computer Science, Carnegie Mellon University, 2017. B.S. Computer Science, University of Virginia, 2015. SKILLS: Go, Rust, Python, Kubernetes, AWS, GCP.',
    expectedOutput: {
      credentialType: 'RESUME',
      subType: 'professional_resume',
      reasoning: 'OBSERVE: Standard resume format with professional summary, experience section, education, and skills. IDENTIFY: Multiple employers and educational institutions referenced. CLASSIFY: Resume/CV — a career summary document, not a single credential. VERIFY: Standard US resume format with chronological experience.',
      concerns: ['Resumes are self-reported and not independently verified documents'],
      confidenceReasoning: 'High confidence: clearly a professional resume with standard sections.',
      confidence: 0.91,
    },
  },
  {
    inputText: 'CURRICULUM VITAE. [NAME_REDACTED], Ph.D. Department of [REDACTED], University of [REDACTED]. EDUCATION: Ph.D. Molecular Biology, 2018. M.S. Biochemistry, 2014. B.S. Biology, 2012. PUBLICATIONS: 1. [TITLE_REDACTED]. Nature, 2024. 2. [TITLE_REDACTED]. Cell, 2022. 3. [TITLE_REDACTED]. PNAS, 2020. GRANTS: NIH R01 (PI), 2023-2028: [AMOUNT_REDACTED]. TEACHING: Graduate Molecular Biology, 2019-Present.',
    expectedOutput: {
      credentialType: 'RESUME',
      subType: 'academic_cv',
      reasoning: 'OBSERVE: Academic CV format with publications, grants, and teaching sections. IDENTIFY: University faculty member with PhD. CLASSIFY: Academic CV — longer format with research output, distinct from a professional resume. VERIFY: Includes Nature, Cell, PNAS publications and NIH grant — standard academic CV elements.',
      concerns: ['Academic CVs are self-reported — publication and grant claims should be verified independently'],
      confidenceReasoning: 'High confidence: clearly formatted academic CV with standard sections.',
      confidence: 0.90,
    },
  },

  // ============================================================
  // MEDICAL (3 examples: vaccination, lab result, clearance)
  // ============================================================
  {
    inputText: 'COVID-19 Vaccination Record Card. Patient: [NAME_REDACTED]. Date of Birth: [DOB_REDACTED]. Dose 1: Pfizer-BioNTech. Lot: [REDACTED]. Date: January 15, 2025. Site: [CLINIC_REDACTED]. Dose 2: Pfizer-BioNTech. Lot: [REDACTED]. Date: February 5, 2025. Site: [CLINIC_REDACTED]. Booster: Pfizer-BioNTech (Updated 2024-2025). Lot: [REDACTED]. Date: October 20, 2025.',
    expectedOutput: {
      credentialType: 'MEDICAL',
      subType: 'vaccination_record',
      reasoning: 'OBSERVE: Standard CDC vaccination card format with multiple doses, lot numbers, and dates. IDENTIFY: Multiple vaccination sites referenced, Pfizer-BioNTech manufacturer. CLASSIFY: Vaccination record — COVID-19 immunization card. VERIFY: Three doses with progressive dates, consistent with vaccination schedule.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard vaccination card format with complete dose history.',
      confidence: 0.91,
    },
  },
  {
    inputText: 'LABORATORY REPORT. Quest Diagnostics. Patient: [NAME_REDACTED]. DOB: [DOB_REDACTED]. Specimen Collected: March 10, 2026. Report Date: March 12, 2026. Ordering Physician: [NAME_REDACTED], M.D. Test: Comprehensive Metabolic Panel. Results: Glucose: 95 mg/dL (Ref: 70-100). BUN: 18 mg/dL (Ref: 7-20). Creatinine: 1.0 mg/dL (Ref: 0.7-1.3). All results within normal limits. Reported by: [NAME_REDACTED], MT(ASCP).',
    expectedOutput: {
      credentialType: 'MEDICAL',
      subType: 'lab_result',
      reasoning: 'OBSERVE: Laboratory report with test results, reference ranges, and specimen dates. IDENTIFY: Quest Diagnostics — major clinical laboratory. CLASSIFY: Lab result — comprehensive metabolic panel results. VERIFY: Standard clinical lab report format with proper reference ranges.',
      concerns: ['Contains protected health information — HIPAA considerations apply'],
      confidenceReasoning: 'High confidence: standard clinical lab report from recognized laboratory.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'MEDICAL CLEARANCE CERTIFICATE. This is to certify that [NAME_REDACTED] was examined on March 15, 2026 and is found to be in good physical and mental health. This clearance is provided for: Pre-employment screening. Restrictions: None. Valid for: 90 days from date of examination. Examining Physician: [NAME_REDACTED], M.D. License No.: [REDACTED]. Clinic: [CLINIC_REDACTED].',
    expectedOutput: {
      credentialType: 'MEDICAL',
      subType: 'medical_clearance',
      reasoning: 'OBSERVE: Medical clearance certificate with specific purpose (pre-employment), validity period, and physician credentials. IDENTIFY: Examining physician with license number. CLASSIFY: Medical clearance — physician attestation of fitness for specific purpose. VERIFY: Standard medical clearance format with validity period.',
      concerns: ['90-day validity — clearance may need to be reissued for delayed employment start'],
      confidenceReasoning: 'High confidence: standard medical clearance certificate with proper physician attestation.',
      confidence: 0.90,
    },
  },

  // ============================================================
  // MILITARY (2 examples: DD-214, service record)
  // ============================================================
  {
    inputText: 'DEPARTMENT OF DEFENSE. DD FORM 214. CERTIFICATE OF RELEASE OR DISCHARGE FROM ACTIVE DUTY. 1. Name: [NAME_REDACTED]. 4a. Grade, Rate or Rank: Sergeant (E-5). 4b. Pay Grade: E-5. 12a. Date Entered Active Duty: [DATE_REDACTED]. 12b. Separation Date: March 1, 2026. 13. Decorations, Medals: Army Commendation Medal, Army Achievement Medal (2), Good Conduct Medal (2). 18. REMARKS: Eligible for VA benefits. 24. Character of Service: HONORABLE. 25. Separation Authority: AR 635-200, Chapter 4.',
    expectedOutput: {
      credentialType: 'MILITARY',
      subType: 'dd214',
      reasoning: 'OBSERVE: DD Form 214 with numbered fields matching the standard military discharge form layout. IDENTIFY: Department of Defense — issuing authority for DD-214. CLASSIFY: DD-214 — the official Certificate of Release or Discharge from Active Duty. VERIFY: Standard DD-214 field numbers (12a, 12b, 13, 18, 24, 25) and honorable discharge.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard DD-214 format with proper field numbering and content.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'UNITED STATES NAVY. SERVICE RECORD. Name: [NAME_REDACTED]. Rate/Rank: Lieutenant Commander (O-4). Designator: 1310 (Naval Aviator). Service Entry Date: [DATE_REDACTED]. Duty Stations: NAS Pensacola, FL (Flight Training). USS [SHIP_REDACTED] (CVN-[REDACTED]). NAS Oceana, VA (VFA-[REDACTED]). Total Active Service: 12 years, 6 months. Qualifications: F/A-18E/F Super Hornet, Carrier Landing Qualified. Clearance: [REDACTED].',
    expectedOutput: {
      credentialType: 'MILITARY',
      subType: 'service_record',
      reasoning: 'OBSERVE: Navy service record with rank, designator code, duty stations, and qualifications. IDENTIFY: United States Navy. CLASSIFY: Service record — comprehensive military career summary. VERIFY: Designator 1310 (Naval Aviator) is consistent with the aviation duty stations and F/A-18 qualification.',
      concerns: ['Security clearance level is redacted — may contain classified information'],
      confidenceReasoning: 'High confidence: detailed military service record with consistent career progression.',
      confidence: 0.91,
    },
  },

  // ============================================================
  // IDENTITY (2 examples: birth cert, immigration)
  // ============================================================
  {
    inputText: 'CERTIFICATE OF LIVE BIRTH. State of Texas. Department of State Health Services. Vital Statistics Unit. Certificate Number: [REDACTED]. Child Name: [NAME_REDACTED]. Date of Birth: [DOB_REDACTED]. Place of Birth: [HOSPITAL_REDACTED], Houston, Texas. Mother: [NAME_REDACTED]. Father: [NAME_REDACTED]. Registrar: [NAME_REDACTED]. Date Filed: [DATE_REDACTED].',
    expectedOutput: {
      credentialType: 'IDENTITY',
      subType: 'birth_certificate',
      reasoning: 'OBSERVE: Official birth certificate with state seal reference, vital statistics unit, and registration details. IDENTIFY: Texas Department of State Health Services, Vital Statistics Unit. CLASSIFY: Birth certificate — Certificate of Live Birth is the standard identity document. VERIFY: Standard vital records format with registrar and filing date.',
      concerns: ['Contains sensitive PII — parental names, birth location'],
      confidenceReasoning: 'High confidence: standard state-issued birth certificate format.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'U.S. Citizenship and Immigration Services. Department of Homeland Security. EMPLOYMENT AUTHORIZATION DOCUMENT. Category: C09. Card Expires: [DATE_REDACTED]. [NAME_REDACTED]. Country of Birth: [COUNTRY_REDACTED]. I-94 Number: [REDACTED]. USCIS Number: [REDACTED]. Card Number: [REDACTED]. NOT VALID FOR REENTRY TO THE U.S.',
    expectedOutput: {
      credentialType: 'IDENTITY',
      subType: 'immigration_document',
      reasoning: 'OBSERVE: USCIS Employment Authorization Document (EAD) with category code, I-94 reference, and reentry restriction. IDENTIFY: U.S. Citizenship and Immigration Services, Department of Homeland Security. CLASSIFY: Immigration document — EAD card. VERIFY: Standard EAD format with category C09 and required disclaimers.',
      concerns: ['Contains highly sensitive immigration status information', 'Category C09 indicates pending adjustment of status'],
      confidenceReasoning: 'High confidence: standard USCIS EAD format with proper category and identifiers.',
      confidence: 0.91,
    },
  },

  // ============================================================
  // OTHER (2 examples: junk, unrecognizable)
  // ============================================================
  {
    inputText: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
    expectedOutput: {
      credentialType: 'OTHER',
      subType: 'non_credential',
      reasoning: 'OBSERVE: Text is Latin placeholder text (Lorem ipsum) with no credential indicators. IDENTIFY: No issuer, no institution, no credential type markers. CLASSIFY: Non-credential — this is Lorem ipsum placeholder text, not a document. VERIFY: Entire content is standard Lorem ipsum filler text.',
      concerns: ['Document contains no credential information whatsoever'],
      confidenceReasoning: 'High confidence this is NOT a credential: pure Lorem ipsum placeholder text.',
      confidence: 0.15,
    },
  },
  {
    inputText: 'Meeting Notes — Q4 Planning. Date: November 15, 2025. Attendees: [NAME_REDACTED], [NAME_REDACTED], [NAME_REDACTED]. Agenda: 1. Budget review. 2. Headcount planning. 3. Product roadmap. Action Items: [NAME_REDACTED] to follow up on vendor contracts. [NAME_REDACTED] to schedule design review. Next meeting: November 22, 2025.',
    expectedOutput: {
      credentialType: 'OTHER',
      subType: 'non_credential',
      reasoning: 'OBSERVE: Meeting notes format with agenda, attendees, and action items. IDENTIFY: Internal business meeting — no issuing authority. CLASSIFY: Non-credential — meeting notes are not a credential, certification, or official document. VERIFY: Contains no credential indicators (no license numbers, degrees, certifications).',
      concerns: ['This is a business document, not a credential — likely uploaded in error'],
      confidenceReasoning: 'High confidence this is not a credential: clearly meeting notes with agenda and action items.',
      confidence: 0.12,
    },
  },

  // ============================================================
  // BUSINESS_ENTITY (3 examples: good standing, articles, annual report)
  // ============================================================
  {
    inputText: 'State of Delaware. Department of State. Division of Corporations. CERTIFICATE OF GOOD STANDING. I, [NAME_REDACTED], Secretary of State of the State of Delaware, do hereby certify that [COMPANY_REDACTED] Inc., a corporation organized and existing under the laws of the State of Delaware, File Number: [REDACTED], is in good standing and has a legal corporate existence. Date: March 1, 2026.',
    expectedOutput: {
      credentialType: 'BUSINESS_ENTITY',
      subType: 'good_standing',
      reasoning: 'OBSERVE: Certificate of Good Standing with Secretary of State certification and file number. IDENTIFY: Delaware Division of Corporations — the primary corporate registry in the US. CLASSIFY: Good standing certificate — confirms entity is in legal good standing. VERIFY: Standard Delaware SOS format with certification language.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard Certificate of Good Standing from Delaware.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'State of California. Secretary of State. ARTICLES OF INCORPORATION. A General Stock Corporation. ONE: The name of this corporation is [COMPANY_REDACTED] Inc. TWO: The purpose of this corporation is to engage in any lawful act or activity for which a corporation may be organized under the CGCL. THREE: The name and address of the corporation\'s initial agent for service of process is [NAME_REDACTED]. FOUR: This corporation is authorized to issue 10,000,000 shares of common stock. Filed: February 15, 2026. Filing Number: [REDACTED].',
    expectedOutput: {
      credentialType: 'BUSINESS_ENTITY',
      subType: 'articles_of_incorporation',
      reasoning: 'OBSERVE: Articles of Incorporation with numbered articles, authorized shares, and filing details. IDENTIFY: California Secretary of State — the filing authority. CLASSIFY: Articles of Incorporation — the foundational formation document for a corporation. VERIFY: Standard California articles format with CGCL reference.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard articles of incorporation format filed with state.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'State of New York. Department of State. Division of Corporations. BIENNIAL STATEMENT / ANNUAL REPORT. Entity Name: [COMPANY_REDACTED] LLC. DOS ID: [REDACTED]. Entity Type: Domestic Limited Liability Company. Formation Date: June 10, 2020. County: New York. Principal Office: [ADDRESS_REDACTED]. Registered Agent: [NAME_REDACTED]. Filing Date: January 20, 2026. Status: Active.',
    expectedOutput: {
      credentialType: 'BUSINESS_ENTITY',
      subType: 'annual_report',
      reasoning: 'OBSERVE: State annual report / biennial statement with entity details, registered agent, and filing date. IDENTIFY: New York Department of State, Division of Corporations. CLASSIFY: Annual report — periodic filing required to maintain entity status. VERIFY: Standard NY DOS filing format with active status.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard state annual report/biennial statement format.',
      confidence: 0.92,
    },
  },

  // ============================================================
  // ADDITIONAL COVERAGE (to reach 80+ examples)
  // ============================================================
  {
    inputText: 'Polytechnic University of the Philippines. Office of the Registrar. This is to certify that [NAME_REDACTED] has completed the requirements for the degree of Bachelor of Science in Accountancy. Conferred: April 2025. Manila, Philippines. University President. Registrar.',
    expectedOutput: {
      credentialType: 'DEGREE',
      subType: 'bachelor',
      reasoning: 'OBSERVE: University diploma with registrar certification and conferral date. IDENTIFY: Polytechnic University of the Philippines, Manila — a recognized state university. CLASSIFY: Bachelor of Science in Accountancy. VERIFY: Standard Philippine university diploma format.',
      concerns: ['International credential — Philippines, may require evaluation for US recognition'],
      confidenceReasoning: 'High confidence: standard international degree format from recognized institution.',
      confidence: 0.87,
    },
  },
  {
    inputText: 'State of Georgia. Georgia Secretary of State. Cosmetology License. [NAME_REDACTED] is licensed to practice Cosmetology in the State of Georgia. License Number: COS-2024-67890. Issue Date: May 1, 2024. Expiration Date: April 30, 2026. Status: ACTIVE.',
    expectedOutput: {
      credentialType: 'LICENSE',
      subType: 'cosmetology',
      reasoning: 'OBSERVE: State cosmetology license with license number, dates, and active status. IDENTIFY: Georgia Secretary of State — licensing authority. CLASSIFY: Cosmetology license. VERIFY: Standard state cosmetology license format.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard cosmetology license with complete details.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'National Center for Construction Education and Research. NCCER Certification. This certifies that [NAME_REDACTED] has successfully completed the NCCER Craft Assessment for Pipefitting Level 3. Certification Number: NCCER-PF3-2026-12345. Assessment Date: February 20, 2026. Performance Verified by: [NAME_REDACTED], Certified Assessor.',
    expectedOutput: {
      credentialType: 'CERTIFICATE',
      subType: 'trade_certification',
      reasoning: 'OBSERVE: NCCER trade certification with craft assessment level, certification number, and assessor. IDENTIFY: NCCER — the premier construction trade credentialing body. CLASSIFY: Trade certification — pipefitting craft assessment. VERIFY: Standard NCCER certification format with assessor verification.',
      concerns: [],
      confidenceReasoning: 'High confidence: recognized trade certification body with standard format.',
      confidence: 0.92,
    },
  },
  {
    inputText: 'University of Lagos. Faculty of Law. Official Academic Transcript. Student: [NAME_REDACTED]. Matriculation Number: [REDACTED]. Programme: Bachelor of Laws (LL.B.). Year of Admission: 2020. Year of Graduation: 2025. CGPA: 4.12/5.00. Class of Degree: Second Class Upper Division. This transcript is issued on official university stationery with security features.',
    expectedOutput: {
      credentialType: 'TRANSCRIPT',
      subType: 'official_undergraduate',
      reasoning: 'OBSERVE: Official university transcript with Nigerian CGPA system, class of degree, and security mention. IDENTIFY: University of Lagos — a leading Nigerian federal university. CLASSIFY: Official undergraduate transcript — LL.B. is an undergraduate law degree in Nigeria. VERIFY: CGPA scale and class system are consistent with Nigerian higher education.',
      concerns: ['International credential — Nigerian grading system, may need evaluation for US equivalency'],
      confidenceReasoning: 'High confidence: well-structured official transcript from recognized African university.',
      confidence: 0.88,
    },
  },
  {
    inputText: 'American Board of Psychiatry and Neurology. Certificate of Added Qualification. This certifies that [NAME_REDACTED], M.D. has met all requirements for certification in the subspecialty of Child and Adolescent Psychiatry. Certificate Number: [REDACTED]. Date of Certification: July 1, 2025. This certificate is time-limited and expires December 31, 2035.',
    expectedOutput: {
      credentialType: 'PROFESSIONAL',
      subType: 'board_certification',
      reasoning: 'OBSERVE: ABPN subspecialty certification (Certificate of Added Qualification) with time-limited expiration. IDENTIFY: American Board of Psychiatry and Neurology — ABMS member board. CLASSIFY: Board certification — subspecialty CAQ in Child and Adolescent Psychiatry. VERIFY: Standard ABPN format with 10-year certification period.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard ABMS subspecialty certification with complete details.',
      confidence: 0.93,
    },
  },
  {
    inputText: 'Credly. Digital Badge. Badge: Microsoft Certified: Azure Administrator Associate. Issued by: Microsoft. Recipient: [NAME_REDACTED]. Issue Date: January 5, 2026. Expiration Date: January 5, 2027. Badge ID: ms-aza-2026-34567. Skills: Azure AD, Virtual Machines, Storage, Networking, Monitoring. Verify: credly.com/badges/[REDACTED].',
    expectedOutput: {
      credentialType: 'BADGE',
      subType: 'digital_badge',
      reasoning: 'OBSERVE: Credly digital badge with Microsoft certification, skills list, and verification URL. IDENTIFY: Microsoft via Credly platform. CLASSIFY: Digital badge — Microsoft Azure Administrator certification issued as Credly badge. VERIFY: Includes verification URL and skill tags.',
      concerns: [],
      confidenceReasoning: 'High confidence: recognized vendor certification as digital badge with verification.',
      confidence: 0.91,
    },
  },
  {
    inputText: 'State of Wyoming. Secretary of State. CERTIFICATE OF EXISTENCE. I, [NAME_REDACTED], Secretary of State of the State of Wyoming, do hereby certify that [COMPANY_REDACTED] LLC is a limited liability company organized under the laws of the State of Wyoming. Filing ID: [REDACTED]. Date of Organization: August 10, 2023. Status: Active — Good Standing. Date of Certificate: March 5, 2026.',
    expectedOutput: {
      credentialType: 'BUSINESS_ENTITY',
      subType: 'good_standing',
      reasoning: 'OBSERVE: Certificate of Existence (Wyoming terminology for good standing) from Secretary of State. IDENTIFY: Wyoming Secretary of State — corporate filing authority. CLASSIFY: Good standing certificate — confirms LLC is active. VERIFY: Standard Wyoming SOS format with filing ID and organization date.',
      concerns: [],
      confidenceReasoning: 'High confidence: standard state certificate of existence/good standing.',
      confidence: 0.93,
    },
  },

  // ============================================================
  // FRAUD SCENARIOS (6 examples)
  // ============================================================
  {
    inputText: 'Belford University. Office of the Registrar. This is to certify that [NAME_REDACTED] has been awarded the degree of Master of Business Administration. Conferred: March 2026. Belford University, 4521 Campus Drive, Humble, Texas 77338. Accredited by the Universal Council for Online Education Accreditation. Diploma No.: BU-MBA-2026-001.',
    expectedOutput: {
      credentialType: 'DEGREE',
      subType: 'master',
      reasoning: 'OBSERVE: Diploma format with degree conferral language and accreditation claim. IDENTIFY: Belford University — a known diploma mill flagged by multiple state attorneys general. CLASSIFY: MBA degree. VERIFY: "Universal Council for Online Education Accreditation" is not recognized by CHEA or the US Department of Education. Belford University has been sued for fraud.',
      concerns: ['Belford University is a known diploma mill', 'Accrediting body is not recognized by CHEA or US DOE', 'Institution has faced legal action for fraud'],
      confidenceReasoning: 'Low confidence due to diploma mill indicators: unrecognized accreditor and flagged institution.',
      fraudSignals: ['KNOWN_DIPLOMA_MILL', 'UNVERIFIABLE_ISSUER'],
      confidence: 0.25,
    },
  },
  {
    inputText: 'State of California. Board of Registered Nursing. License to Practice as a Registered Nurse. [NAME_REDACTED]. License Number: RN-654321. Issue Date: January 15, 2028. Expiration Date: January 14, 2030. Status: ACTIVE. Note: This license was issued effective January 2028.',
    expectedOutput: {
      credentialType: 'LICENSE',
      subType: 'nursing_rn',
      reasoning: 'OBSERVE: Nursing license with future issue date (January 2028, which is over a year from now). IDENTIFY: California Board of Registered Nursing. CLASSIFY: RN license. VERIFY: The issue date of January 15, 2028 is in the future — no license should have a future issue date.',
      concerns: ['Issue date is in the future (January 2028) — this is impossible for a currently existing document', 'Possible date manipulation or fabricated credential'],
      confidenceReasoning: 'Low confidence: future-dated issue date is a strong fraud indicator.',
      fraudSignals: ['SUSPICIOUS_DATES'],
      confidence: 0.30,
    },
  },
  {
    inputText: 'National Board of Medical Examiners. USMLE Certificate. This certifies that [NAME_REDACTED] has passed USMLE Step 1, Step 2 CK, Step 2 CS, and Step 3. Step 1: Score 280. Step 2 CK: Score 295. Step 3: Score 270. All examinations completed between 2024 and 2025. Certificate Number: NBME-[REDACTED].',
    expectedOutput: {
      credentialType: 'CERTIFICATE',
      subType: 'professional_certification',
      reasoning: 'OBSERVE: USMLE certificate with unusually high scores on all steps. IDENTIFY: National Board of Medical Examiners. CLASSIFY: Professional certification — USMLE completion certificate. VERIFY: Step 1 score of 280 and Step 2 CK of 295 are statistically implausible — the maximum possible Step 1 score is ~300 and the mean is ~230. A score of 280 would be >99.9th percentile. Having all three scores this high is extremely unusual. Also, Step 2 CS was discontinued in January 2021.',
      concerns: ['Step 1 score of 280 is at the extreme upper end — statistically very rare', 'Step 2 CS was discontinued in 2021, but document claims completion in 2024-2025', 'All scores in the 99th+ percentile raises statistical plausibility concerns'],
      confidenceReasoning: 'Low confidence: discontinued exam reference and statistically implausible scores.',
      fraudSignals: ['SUSPICIOUS_DATES', 'INVALID_FORMAT'],
      confidence: 0.30,
    },
  },
  {
    inputText: 'University of Oxford. Degree Certificate. The Chancellor, Masters, and Scholars of the University of Oxford hereby certify that [NAME_REDACTED] was admitted to the Degree of Doctor of Philosophy. Awarded: June 2025. Department of Computer Science. Supervisor: Prof. [NAME_REDACTED]. Thesis: "Advanced Neural Network Architectures for Natural Language Understanding." Warning: This document was scanned at 72 DPI. Text: University of Oxfrod. Degre Certificate.',
    expectedOutput: {
      credentialType: 'DEGREE',
      subType: 'doctorate',
      reasoning: 'OBSERVE: Oxford PhD certificate with some OCR-quality issues — "Oxfrod" and "Degre" misspellings visible. IDENTIFY: University of Oxford (despite OCR typo). CLASSIFY: PhD — Doctor of Philosophy. VERIFY: Misspellings ("Oxfrod", "Degre") could be OCR artifacts from low-quality scan (72 DPI noted), but could also indicate forgery. The formal language is otherwise consistent with Oxford certificates.',
      concerns: ['Misspellings in institution name and degree title — likely OCR artifacts but could indicate forgery', 'Low-quality scan (72 DPI) reduces confidence in document authenticity', 'Manual verification with Oxford recommended'],
      confidenceReasoning: 'Moderate confidence: recognizable institution but OCR quality issues create uncertainty.',
      fraudSignals: ['INVALID_FORMAT'],
      confidence: 0.55,
    },
  },
  {
    inputText: 'Axact Global University. We are pleased to award [NAME_REDACTED] the degree of Bachelor of Science in Information Technology. This prestigious degree is awarded with highest honors. Our university is recognized by the World Association of Online Education. Founded in 2019 in Islamabad, Pakistan. Accreditation Number: WAOE-2024-999. Contact: [EMAIL_REDACTED].',
    expectedOutput: {
      credentialType: 'DEGREE',
      subType: 'bachelor',
      reasoning: 'OBSERVE: Degree certificate with superlative language ("prestigious", "highest honors"), email contact for degrees, and unfamiliar accrediting body. IDENTIFY: Axact is a well-documented diploma mill operation based in Pakistan, shut down by authorities multiple times. CLASSIFY: BS in IT. VERIFY: "World Association of Online Education" is not a recognized accreditor. The Axact network has been the subject of international investigations for selling fake degrees.',
      concerns: ['Axact is a known diploma mill operation', '"World Association of Online Education" is not a recognized accreditor', 'Providing contact email for "degrees" is unusual for legitimate institutions', 'Superlative marketing language uncommon in genuine academic credentials'],
      confidenceReasoning: 'Very low confidence: well-documented diploma mill with fake accreditation.',
      fraudSignals: ['KNOWN_DIPLOMA_MILL', 'UNVERIFIABLE_ISSUER', 'INVALID_FORMAT'],
      confidence: 0.15,
    },
  },
  {
    inputText: 'State of Florida. Department of Health. Board of Medicine. License to Practice Medicine. [NAME_REDACTED], M.D. License Number: ME-999999. Issue Date: December 1, 2024. Expiration Date: January 31, 2026. Specialty: Cardiac Surgery AND Neurosurgery AND Orthopedic Surgery AND Dermatology. Board Certifications: All ABMS boards. Status: ACTIVE.',
    expectedOutput: {
      credentialType: 'LICENSE',
      subType: 'medical_md',
      reasoning: 'OBSERVE: Medical license listing four unrelated surgical specialties plus dermatology. IDENTIFY: Florida Department of Health, Board of Medicine. CLASSIFY: Medical license. VERIFY: No physician is board-certified in Cardiac Surgery, Neurosurgery, Orthopedic Surgery, AND Dermatology simultaneously. Each surgical specialty requires 5-7 years of residency. "All ABMS boards" is not a real certification. This is highly suspicious.',
      concerns: ['Multiple unrelated surgical specialties listed — physically impossible training timeline', '"All ABMS boards" is not a valid certification statement', 'License number ME-999999 appears fabricated (round number)', 'Content is internally inconsistent and implausible'],
      confidenceReasoning: 'Very low confidence: medically impossible specialty combination and fabricated-looking details.',
      fraudSignals: ['INVALID_FORMAT', 'MATERIAL_MISSTATEMENT'],
      confidence: 0.20,
    },
  },
];
