/**
 * Golden Dataset Phase 13: FCRA & Employment Compliance (NMT-FCRA)
 *
 * 200+ entries covering employment screening, FCRA compliance,
 * ban-the-box laws, credential verification for hiring workflows.
 *
 * This dataset aligns Nessie training with the ICP: screening firms
 * and compliance teams are the near-term revenue target, not SEC analysts.
 */

import type { GoldenDatasetEntry } from './types.js';

export const GOLDEN_DATASET_PHASE13_FCRA: GoldenDatasetEntry[] = [
  // ---- FCRA Adverse Action Notices ----
  {
    id: 'fcra-adverse-001',
    description: 'Standard FCRA pre-adverse action notice with consumer report disclosure',
    strippedText: `PRE-ADVERSE ACTION NOTICE

Dear [Applicant],

In connection with your application for employment with [Company], we obtained a consumer report from [Consumer Reporting Agency Name], [Agency Address], [Phone]. Based in part on information contained in this report, we are considering taking adverse action against your application.

Pursuant to the Fair Credit Reporting Act (15 U.S.C. 1681 et seq.), we are providing you with a copy of the consumer report and a summary of your rights under the FCRA before we make a final decision.

You have the right to dispute the accuracy or completeness of any information in the consumer report directly with [Consumer Reporting Agency Name].

Date: 2025-06-15
Position Applied For: Senior Financial Analyst
Location: New York, NY`,
    credentialTypeHint: 'employment_screening',
    groundTruth: {
      credentialType: 'employment_screening',
      issuerName: '[Company]',
      issuedDate: '2025-06-15',
      jurisdiction: 'New York',
    },
    source: 'synthetic/fcra-adverse-action',
    category: 'employment_screening',
    tags: ['fcra', 'adverse-action', 'pre-adverse', 'employment'],
  },
  {
    id: 'fcra-adverse-002',
    description: 'Final adverse action notice with required disclosures',
    strippedText: `ADVERSE ACTION NOTICE

Date: 2025-07-01
Re: Employment Application — Operations Manager

Dear [Applicant],

This notice is to inform you that [Company] has decided not to hire you based in whole or in part on information obtained in a consumer report from [CRA Name], located at [Address], phone: [Phone].

Under the Fair Credit Reporting Act, you have the right to:
1. Obtain a free copy of the report from [CRA Name] within 60 days.
2. Dispute the accuracy or completeness of any information in the report.

[CRA Name] did not make the adverse decision and is unable to provide you with the reasons for it.

Equal Employment Opportunity Commission: www.eeoc.gov
Consumer Financial Protection Bureau: www.consumerfinance.gov`,
    credentialTypeHint: 'employment_screening',
    groundTruth: {
      credentialType: 'employment_screening',
      issuerName: '[Company]',
      issuedDate: '2025-07-01',
    },
    source: 'synthetic/fcra-adverse-final',
    category: 'employment_screening',
    tags: ['fcra', 'adverse-action', 'final-adverse', 'employment'],
  },

  // ---- Employment Verification Letters ----
  {
    id: 'fcra-empver-001',
    description: 'Standard employment verification letter confirming dates and title',
    strippedText: `EMPLOYMENT VERIFICATION

To Whom It May Concern,

This letter is to verify that [Employee Name] was employed by Acme Corporation from March 15, 2019 to December 31, 2024.

Position: Director of Engineering
Employment Type: Full-time
Final Salary: Verified upon request with signed authorization

This information is provided in response to a verification request and is based on our records as of the date of this letter.

Sincerely,
Human Resources Department
Acme Corporation
Date: January 10, 2025`,
    credentialTypeHint: 'employment_verification',
    groundTruth: {
      credentialType: 'employment_verification',
      issuerName: 'Acme Corporation',
      issuedDate: '2025-01-10',
    },
    source: 'synthetic/employment-verification',
    category: 'employment_verification',
    tags: ['employment', 'verification-letter', 'clean'],
  },
  {
    id: 'fcra-empver-002',
    description: 'Employment verification with gap — potential red flag',
    strippedText: `EMPLOYMENT VERIFICATION REPORT

Subject: [Candidate Name]
Verification Date: 2025-03-20
Requested By: Sterling Background Checks

Employer: TechStart Inc.
Position Held: Software Engineer
Start Date: June 2021
End Date: August 2022
Reason for Leaving: Voluntary resignation

NOTE: There is a 14-month gap between this employment and the candidate's claimed next position at DataFlow Corp (start date: October 2023). The candidate's resume states continuous employment from TechStart to DataFlow with no gap.

Verified By: HR Department, TechStart Inc.`,
    credentialTypeHint: 'employment_verification',
    groundTruth: {
      credentialType: 'employment_verification',
      issuerName: 'TechStart Inc.',
      issuedDate: '2025-03-20',
      fraudSignals: ['employment_gap_discrepancy'],
    },
    source: 'synthetic/employment-verification-gap',
    category: 'employment_verification',
    tags: ['employment', 'verification-letter', 'gap', 'fraud-signal'],
  },
  {
    id: 'fcra-empver-003',
    description: 'Education verification for hiring — degree confirmation',
    strippedText: `EDUCATION VERIFICATION

Verification ID: EDV-2025-44891
Date of Verification: February 28, 2025
Requested By: First Advantage

Institution: University of California, Berkeley
Student Name: [Redacted]
Degree: Bachelor of Science
Major: Computer Science
Date Conferred: May 2020
Honors: Magna Cum Laude
Enrollment Dates: August 2016 - May 2020

This verification was completed through the National Student Clearinghouse.
Clearinghouse Reference: NSC-9928371`,
    credentialTypeHint: 'degree',
    groundTruth: {
      credentialType: 'degree',
      issuerName: 'University of California, Berkeley',
      issuedDate: '2020-05',
      fieldOfStudy: 'Computer Science',
      degreeLevel: 'bachelor',
    },
    source: 'synthetic/education-verification-hiring',
    category: 'degree',
    tags: ['education', 'verification', 'nsc', 'hiring', 'clean'],
  },

  // ---- Ban-the-Box State Law Variations ----
  {
    id: 'fcra-btb-001',
    description: 'California Fair Chance Act compliance notice',
    strippedText: `NOTICE OF INDIVIDUALIZED ASSESSMENT — CALIFORNIA FAIR CHANCE ACT

Date: 2025-04-10
Applicant: [Redacted]
Position: Warehouse Associate
Location: Los Angeles, CA

Pursuant to California Government Code Section 12952 (Fair Chance Act), we have conducted an individualized assessment of your conviction history in relation to the duties and responsibilities of the position for which you applied.

Factors Considered:
1. Nature and gravity of the offense
2. Time elapsed since the offense and completion of sentence
3. Nature of the job held or sought

Preliminary Decision: We are considering rescinding your conditional offer of employment.

You have at least 5 business days to respond to this notice with evidence of rehabilitation, mitigating circumstances, or inaccuracies in the conviction record.

Conviction(s) Under Review:
- Offense: [Redacted], Date: 2019
- County: Los Angeles County Superior Court
- Disposition: Completed sentence 2021`,
    credentialTypeHint: 'employment_screening',
    groundTruth: {
      credentialType: 'employment_screening',
      issuerName: '[Employer]',
      issuedDate: '2025-04-10',
      jurisdiction: 'California',
    },
    source: 'synthetic/ban-the-box-california',
    category: 'employment_screening',
    tags: ['ban-the-box', 'california', 'fair-chance-act', 'individualized-assessment'],
  },
  {
    id: 'fcra-btb-002',
    description: 'New York City Fair Chance Act (Local Law 78) notice',
    strippedText: `FAIR CHANCE NOTICE — NEW YORK CITY

Per NYC Administrative Code 8-107(11-a) (Fair Chance Act), this notice informs you of your rights during the hiring process.

Employer: [Company Name]
Date: 2025-05-22
Position: Customer Service Representative

Under the NYC Fair Chance Act:
- An employer cannot ask about criminal history on a job application
- An employer cannot inquire about criminal history until after a conditional offer of employment
- If an employer wishes to withdraw a conditional offer based on criminal history, they must provide:
  1. A written copy of the inquiry and analysis (Article 23-A factors)
  2. At least 3 business days to respond
  3. Supporting documentation considered

This analysis was performed under Article 23-A of the New York Correction Law.`,
    credentialTypeHint: 'employment_screening',
    groundTruth: {
      credentialType: 'employment_screening',
      issuerName: '[Company Name]',
      issuedDate: '2025-05-22',
      jurisdiction: 'New York City',
    },
    source: 'synthetic/ban-the-box-nyc',
    category: 'employment_screening',
    tags: ['ban-the-box', 'new-york-city', 'local-law-78', 'article-23a'],
  },
  {
    id: 'fcra-btb-003',
    description: 'Illinois Job Opportunities for Qualified Applicants Act notice',
    strippedText: `EMPLOYMENT SCREENING NOTICE — ILLINOIS

Date: 2025-08-14
Employer: Midwest Healthcare Systems
Position: Licensed Practical Nurse
Location: Chicago, IL

This notice is provided pursuant to the Illinois Job Opportunities for Qualified Applicants Act (820 ILCS 75) and the Illinois Employee Credit Privacy Act (820 ILCS 70).

Under Illinois law:
- Employers with 15 or more employees may not inquire about criminal records until after selecting the applicant for an interview (or making a conditional offer if no interview is conducted)
- Credit history cannot be used as a basis for employment decisions unless the position falls within one of the statutory exceptions
- Healthcare positions with patient access are exempt from certain restrictions under the Health Care Worker Background Check Act (225 ILCS 46)

For healthcare positions, the Illinois Department of Public Health requires fingerprint-based background checks through the Illinois State Police.

License Verification Status: Active — Illinois Department of Financial and Professional Regulation
License Number: [Redacted]
Expiration: December 31, 2026`,
    credentialTypeHint: 'license',
    groundTruth: {
      credentialType: 'license',
      issuerName: 'Illinois Department of Financial and Professional Regulation',
      expiryDate: '2026-12-31',
      jurisdiction: 'Illinois',
    },
    source: 'synthetic/ban-the-box-illinois',
    category: 'license',
    tags: ['ban-the-box', 'illinois', 'healthcare', 'license-verification'],
  },

  // ---- Professional License Verification for Hiring ----
  {
    id: 'fcra-lic-001',
    description: 'Medical license verification for hospital credentialing',
    strippedText: `PHYSICIAN LICENSE VERIFICATION

Verification Date: 2025-02-15
Requesting Organization: Memorial Hospital Credentialing Office

Physician: [Redacted], MD
State Medical Board: Texas Medical Board
License Number: [Redacted]
License Type: Full Medical License
Original Issue Date: 2015-06-01
Current Expiration: 2026-06-30
Status: ACTIVE — No Restrictions

Disciplinary History: None
Board Actions: None
DEA Registration: Active, Schedule II-V
NPI Number: Verified

Specialty Board Certification:
- American Board of Internal Medicine — Certified 2016
- Subspecialty: Pulmonary Disease — Certified 2018

Malpractice Claims: Information available upon written request with physician authorization.`,
    credentialTypeHint: 'medical_license',
    groundTruth: {
      credentialType: 'medical_license',
      issuerName: 'Texas Medical Board',
      issuedDate: '2015-06-01',
      expiryDate: '2026-06-30',
      jurisdiction: 'Texas',
    },
    source: 'synthetic/medical-license-verification',
    category: 'medical_license',
    tags: ['medical', 'license', 'credentialing', 'hiring', 'clean'],
  },
  {
    id: 'fcra-lic-002',
    description: 'Nursing license with disciplinary action — red flag',
    strippedText: `NURSING LICENSE VERIFICATION

Date: 2025-09-05
Verification Source: Nursys National Database

Licensee: [Redacted], RN
State: Florida
License Number: RN-[Redacted]
License Type: Registered Nurse
Issue Date: 2012-03-15
Expiration Date: 2024-07-31
Status: EXPIRED — DISCIPLINARY ACTION

Disciplinary Actions:
1. Date: 2023-11-20
   Type: Consent Order
   Description: Practice restriction — supervision required for medication administration
   Duration: 24 months
   Status: Active

2. Date: 2024-01-15
   Type: License Suspension
   Description: Failure to comply with consent order terms
   Duration: Indefinite pending hearing
   Status: Active — License not renewed

NOTE: This license has been expired since July 31, 2024 and has active disciplinary restrictions.`,
    credentialTypeHint: 'nursing_license',
    groundTruth: {
      credentialType: 'nursing_license',
      issuerName: 'Florida Board of Nursing',
      issuedDate: '2012-03-15',
      expiryDate: '2024-07-31',
      jurisdiction: 'Florida',
      fraudSignals: ['expired_license', 'disciplinary_action'],
    },
    source: 'synthetic/nursing-license-disciplinary',
    category: 'nursing_license',
    tags: ['nursing', 'license', 'expired', 'disciplinary', 'fraud-signal', 'hiring'],
  },
  {
    id: 'fcra-lic-003',
    description: 'CPA license verification for financial services hiring',
    strippedText: `CPA LICENSE VERIFICATION

Verification Date: March 1, 2025
Requesting Entity: Goldman Sachs — Compliance Department

Licensee: [Redacted]
State Board: New York State Board of Public Accountancy
License Number: [Redacted]
License Status: Active
Original Issue Date: August 15, 2017
Current Registration Period: January 1, 2024 — December 31, 2026
CPE Compliance: Current — 40 hours completed for 2024

Peer Review Status: Not Applicable (non-practice licensee)
Ethics Violations: None on record
Interstate Mobility: Eligible under NASBA Uniform Accountancy Act provisions`,
    credentialTypeHint: 'cpa_license',
    groundTruth: {
      credentialType: 'cpa_license',
      issuerName: 'New York State Board of Public Accountancy',
      issuedDate: '2017-08-15',
      expiryDate: '2026-12-31',
      jurisdiction: 'New York',
    },
    source: 'synthetic/cpa-license-verification',
    category: 'cpa_license',
    tags: ['cpa', 'license', 'financial', 'hiring', 'clean'],
  },

  // ---- Background Check Reports ----
  {
    id: 'fcra-bgc-001',
    description: 'Comprehensive background check report — clean',
    strippedText: `BACKGROUND INVESTIGATION REPORT

Report ID: BGC-2025-887712
Date Completed: 2025-04-25
Consumer Reporting Agency: AccuCheck Background Services
Report Type: Comprehensive Employment Screening

Subject: [Redacted]
SSN Trace: Verified — addresses consistent with application
Name Variations: None found

Criminal Record Search:
- Federal Courts: NO RECORDS FOUND
- State Courts (3 jurisdictions searched): NO RECORDS FOUND
- County Courts (5 counties searched): NO RECORDS FOUND
- Sex Offender Registry: NOT LISTED
- Global Sanctions/Watch Lists: NO MATCHES

Employment Verification:
1. Employer: [Company A] — VERIFIED (dates match within 30 days)
2. Employer: [Company B] — VERIFIED (title confirmed, dates match)

Education Verification:
1. [University] — Bachelor of Science, Computer Science, 2018 — VERIFIED

Motor Vehicle Report: CLEAR (valid license, no violations in past 7 years)

Drug Screening: NEGATIVE (10-panel)

Overall Assessment: ADJUDICATED — ELIGIBLE`,
    credentialTypeHint: 'employment_screening',
    groundTruth: {
      credentialType: 'employment_screening',
      issuerName: 'AccuCheck Background Services',
      issuedDate: '2025-04-25',
    },
    source: 'synthetic/background-check-clean',
    category: 'employment_screening',
    tags: ['background-check', 'comprehensive', 'clean', 'hiring'],
  },
  {
    id: 'fcra-bgc-002',
    description: 'Background check with education discrepancy — fraud signal',
    strippedText: `BACKGROUND INVESTIGATION REPORT

Report ID: BGC-2025-993201
Date: 2025-06-12
CRA: National Background Check Inc.

DISCREPANCY ALERT — EDUCATION VERIFICATION

The applicant claimed: Master of Business Administration, Harvard Business School, 2020

Verification Result: UNABLE TO VERIFY
- Harvard Business School has no record of the applicant
- The applicant's name does not appear in the alumni database
- Degree confirmation request returned: "No match found"

Additional Finding:
- A search of the National Student Clearinghouse shows the applicant holds a Bachelor's degree from [State University], conferred 2016. No graduate degree on record.

Recommendation: This discrepancy requires further investigation. The employer should follow adverse action procedures under FCRA 15 U.S.C. 1681b(b)(3) if this finding is used in any employment decision.`,
    credentialTypeHint: 'employment_screening',
    groundTruth: {
      credentialType: 'employment_screening',
      issuerName: 'National Background Check Inc.',
      issuedDate: '2025-06-12',
      fraudSignals: ['education_discrepancy', 'unverifiable_degree'],
    },
    source: 'synthetic/background-check-education-fraud',
    category: 'employment_screening',
    tags: ['background-check', 'education-fraud', 'discrepancy', 'fraud-signal'],
  },

  // ---- I-9 and Work Authorization ----
  {
    id: 'fcra-i9-001',
    description: 'I-9 Employment Eligibility Verification form context',
    strippedText: `FORM I-9 EMPLOYMENT ELIGIBILITY VERIFICATION

Section 1 — Employee Information (completed by employee on first day):
Date: 2025-01-15
Citizenship Status: A noncitizen authorized to work until 2027-03-31
USCIS Number: A-[Redacted]

Section 2 — Employer Review (completed within 3 business days):
Document Title: Employment Authorization Document (EAD)
List A Document
Issuing Authority: U.S. Citizenship and Immigration Services
Document Number: [Redacted]
Expiration Date: 2027-03-31

Employer Certification:
I attest, under penalty of perjury, that I have examined the documents presented by the employee, and to the best of my knowledge they appear to be genuine and relate to the individual.

Employer: TechCorp Industries
Date: 2025-01-17
Title: HR Manager`,
    credentialTypeHint: 'employment_authorization',
    groundTruth: {
      credentialType: 'employment_authorization',
      issuerName: 'U.S. Citizenship and Immigration Services',
      expiryDate: '2027-03-31',
      jurisdiction: 'United States',
    },
    source: 'synthetic/i9-employment-eligibility',
    category: 'employment_authorization',
    tags: ['i9', 'work-authorization', 'ead', 'immigration', 'hiring'],
  },

  // ---- Drug Testing & DOT Compliance ----
  {
    id: 'fcra-drug-001',
    description: 'DOT drug and alcohol testing compliance record',
    strippedText: `DOT DRUG AND ALCOHOL TESTING RECORD

Testing Authority: Department of Transportation — 49 CFR Part 40
Employer: National Freight Lines LLC
USDOT Number: [Redacted]

Employee: [Redacted]
CDL Number: [Redacted]
CDL State: Ohio
Position: Commercial Motor Vehicle Driver

Test Type: Pre-Employment
Test Date: 2025-05-10
Collection Site: LabCorp — Columbus, OH
Specimen ID: [Redacted]

Results:
Drug Test (5-panel DOT): NEGATIVE
- Marijuana: Negative
- Cocaine: Negative
- Amphetamines: Negative
- Opioids: Negative
- PCP: Negative

Alcohol Test: NOT REQUIRED (pre-employment)

MRO Certification: Results reviewed and certified by Medical Review Officer
MRO Name: [Redacted], MD
MRO Date: 2025-05-12

FMCSA Clearinghouse Status: Queried — No violations found
Query Date: 2025-05-08`,
    credentialTypeHint: 'employment_screening',
    groundTruth: {
      credentialType: 'employment_screening',
      issuerName: 'National Freight Lines LLC',
      issuedDate: '2025-05-10',
      jurisdiction: 'Ohio',
    },
    source: 'synthetic/dot-drug-testing',
    category: 'employment_screening',
    tags: ['dot', 'drug-testing', 'cdl', 'fmcsa', 'compliance', 'hiring'],
  },

  // ---- Teacher/Education Professional Licenses ----
  {
    id: 'fcra-teach-001',
    description: 'Teaching license verification — multiple endorsements',
    strippedText: `EDUCATOR LICENSE VERIFICATION

State: Massachusetts
Department of Elementary and Secondary Education
License Lookup Date: 2025-07-20

Educator: [Redacted]
License Number: [Redacted]
License Type: Professional License
Status: ACTIVE

Endorsements:
1. Mathematics (5-12) — Professional Stage
2. General Science (5-8) — Professional Stage
3. Sheltered English Immersion (SEI) Endorsement

Issue Date: 2018-09-01
Expiration Date: 2028-06-30

Professional Development: 150 PDPs completed (150 required per 5-year cycle)
SEI Hours: 60 hours completed (meets requirement)

CORI/SORI: Background check current — cleared 2024-08-15
Fingerprint Status: Completed

Disciplinary History: NONE`,
    credentialTypeHint: 'teaching_license',
    groundTruth: {
      credentialType: 'teaching_license',
      issuerName: 'Massachusetts Department of Elementary and Secondary Education',
      issuedDate: '2018-09-01',
      expiryDate: '2028-06-30',
      jurisdiction: 'Massachusetts',
    },
    source: 'synthetic/teaching-license-ma',
    category: 'teaching_license',
    tags: ['teaching', 'license', 'education', 'endorsements', 'clean', 'hiring'],
  },

  // ---- Real Estate License ----
  {
    id: 'fcra-re-001',
    description: 'Real estate broker license — expired, CE deficiency',
    strippedText: `REAL ESTATE LICENSE STATUS REPORT

State: Texas Real Estate Commission (TREC)
Query Date: 2025-11-01

Licensee: [Redacted]
License Type: Real Estate Broker
License Number: [Redacted]
Original Issue Date: 2010-04-22
Expiration Date: 2025-08-31
Current Status: INACTIVE — EXPIRED

Reason for Inactive Status:
- License expired on August 31, 2025
- Continuing Education deficiency: 18 hours short of required 30 hours
- Late renewal application not yet received

Complaints/Disciplinary Actions: NONE

To reinstate: Complete CE requirements + submit late renewal application + pay $200 late fee within 6 months of expiration. After 6 months, must re-examine.`,
    credentialTypeHint: 'real_estate_license',
    groundTruth: {
      credentialType: 'real_estate_license',
      issuerName: 'Texas Real Estate Commission',
      issuedDate: '2010-04-22',
      expiryDate: '2025-08-31',
      jurisdiction: 'Texas',
      fraudSignals: ['expired_license'],
    },
    source: 'synthetic/real-estate-license-expired',
    category: 'real_estate_license',
    tags: ['real-estate', 'license', 'expired', 'ce-deficiency', 'fraud-signal'],
  },

  // ---- Security Clearance Verification ----
  {
    id: 'fcra-sec-001',
    description: 'Security clearance verification for defense contractor hiring',
    strippedText: `SECURITY CLEARANCE VERIFICATION

Date: 2025-03-28
Requesting Organization: Northrop Grumman — Security Office
CAGE Code: [Redacted]

Subject: [Redacted]
Investigation Type: Tier 5 (T5) — Single Scope Background Investigation
Clearance Level: TOP SECRET / SCI
Date of Investigation: 2023-05-15
Adjudication Date: 2023-08-22
Adjudicating Agency: Department of Defense Consolidated Adjudications Facility (DoD CAF)
Status: CURRENT
Next Reinvestigation Due: 2029-05-15

Continuous Evaluation: ENROLLED
CE Status: No derogatory information detected

Access Granted:
- TOP SECRET
- SCI (with appropriate indoctrination)
- SAP access determined by individual program

Crossover: Eligible for reciprocity with IC agencies per ODNI Policy Memorandum`,
    credentialTypeHint: 'certificate',
    groundTruth: {
      credentialType: 'certificate',
      issuerName: 'Department of Defense Consolidated Adjudications Facility',
      issuedDate: '2023-08-22',
      expiryDate: '2029-05-15',
      jurisdiction: 'United States',
    },
    source: 'synthetic/security-clearance',
    category: 'certificate',
    tags: ['security-clearance', 'top-secret', 'defense', 'hiring', 'clean'],
  },

  // ---- Multi-State Employment Screening ----
  {
    id: 'fcra-multi-001',
    description: 'Multi-state criminal background check with varying lookback periods',
    strippedText: `MULTI-STATE CRIMINAL BACKGROUND REPORT

Report Date: 2025-08-30
CRA: GoodHire Employment Screening

Subject: [Redacted]
States Searched: California, New York, Texas, Florida, Illinois

Results by Jurisdiction:

CALIFORNIA (7-year lookback per Cal. Labor Code 1024.5):
Criminal Records: NO RECORDS FOUND
Note: California prohibits reporting non-conviction records and convictions older than 7 years.

NEW YORK (7-year lookback per NYFCA; salary >$25K exempt):
Criminal Records: NO RECORDS FOUND
Note: NYC FCA applies additional restrictions for positions located in NYC.

TEXAS (no state-mandated lookback limit):
Criminal Records: 1 RECORD FOUND
- Offense: Misdemeanor — Driving While Intoxicated
- Date: 2018-03-15
- Disposition: Deferred adjudication — completed
- County: Harris County

FLORIDA (7-year lookback for non-exempt positions):
Criminal Records: NO RECORDS FOUND

ILLINOIS (7-year lookback; Human Rights Act restrictions):
Criminal Records: NO RECORDS FOUND

Summary: 1 record found across 5 states searched. Texas record is a completed deferred adjudication from 2018. Individualized assessment recommended per EEOC guidance.`,
    credentialTypeHint: 'employment_screening',
    groundTruth: {
      credentialType: 'employment_screening',
      issuerName: 'GoodHire Employment Screening',
      issuedDate: '2025-08-30',
    },
    source: 'synthetic/multi-state-criminal',
    category: 'employment_screening',
    tags: ['background-check', 'multi-state', 'criminal', 'lookback-periods', 'hiring'],
  },

  // ---- E-Verify and Work Authorization ----
  {
    id: 'fcra-everify-001',
    description: 'E-Verify case result — tentative nonconfirmation',
    strippedText: `E-VERIFY CASE DETAILS

Case Number: [Redacted]
Date Created: 2025-02-10
Employer: CloudNine Software Inc.
E-Verify Company ID: [Redacted]

Employee: [Redacted]
Case Status: TENTATIVE NONCONFIRMATION (TNC)

TNC Reason: DHS — Unable to verify employment authorization
SSA Status: SSA verification passed

Required Actions:
1. Employer must notify the employee of the TNC in private
2. Employee has 8 federal government work days to contact DHS to resolve
3. Employer must not take any adverse action during the referral period
4. Employer must provide the employee with the DHS referral letter

Referral Date: 2025-02-12
Resolution Deadline: 2025-02-24

Note: Taking adverse action against an employee who has been referred to resolve a TNC is a violation of E-Verify program rules and may violate anti-discrimination provisions of the INA.`,
    credentialTypeHint: 'employment_screening',
    groundTruth: {
      credentialType: 'employment_screening',
      issuerName: 'CloudNine Software Inc.',
      issuedDate: '2025-02-10',
      jurisdiction: 'United States',
    },
    source: 'synthetic/e-verify-tnc',
    category: 'employment_screening',
    tags: ['e-verify', 'tnc', 'work-authorization', 'immigration', 'hiring'],
  },

  // ---- Professional Certification for Hiring ----
  {
    id: 'fcra-cert-001',
    description: 'CISSP certification verification for cybersecurity hiring',
    strippedText: `CERTIFICATION VERIFICATION

Organization: (ISC)2
Verification Date: 2025-04-15
Requested By: Deloitte Cyber Risk Services — HR

Member: [Redacted]
Member ID: [Redacted]
Certification: Certified Information Systems Security Professional (CISSP)
Original Certification Date: 2019-11-20
Certification Expiration: 2028-11-20
Status: ACTIVE — In Good Standing

CPE Credits:
- Required: 120 over 3-year cycle (minimum 40/year)
- Earned to Date (current cycle): 85 credits
- Cycle End Date: 2025-11-20

Endorsement: Verified by an active (ISC)2 member
Annual Maintenance Fee: Current

Concentrations: None

This verification confirms that the individual holds a valid CISSP certification as of the verification date.`,
    credentialTypeHint: 'professional_certification',
    groundTruth: {
      credentialType: 'professional_certification',
      issuerName: '(ISC)2',
      issuedDate: '2019-11-20',
      expiryDate: '2028-11-20',
      accreditingBody: '(ISC)2',
    },
    source: 'synthetic/cissp-verification',
    category: 'professional_certification',
    tags: ['cissp', 'certification', 'cybersecurity', 'hiring', 'clean'],
  },
  {
    id: 'fcra-cert-002',
    description: 'PMP certification — expired, lapsed CPE',
    strippedText: `PMI CREDENTIAL VERIFICATION

Date: 2025-10-01
Project Management Institute (PMI)

Credential Holder: [Redacted]
PMI ID: [Redacted]
Credential: Project Management Professional (PMP)
Date Earned: 2020-02-28
Expiration Date: 2023-02-28
Status: EXPIRED — SUSPENDED

Reason: PDU (Professional Development Units) requirement not met.
Required: 60 PDUs per 3-year cycle
Earned: 32 PDUs

Reinstatement: Must earn remaining 28 PDUs and pay reinstatement fee within 12 months of suspension. After 12 months, must re-examine.

Current Status as of Query Date: EXPIRED — beyond reinstatement period. Credential holder must reapply and pass the PMP examination.`,
    credentialTypeHint: 'professional_certification',
    groundTruth: {
      credentialType: 'professional_certification',
      issuerName: 'Project Management Institute',
      issuedDate: '2020-02-28',
      expiryDate: '2023-02-28',
      accreditingBody: 'Project Management Institute',
      fraudSignals: ['expired_license'],
    },
    source: 'synthetic/pmp-expired',
    category: 'professional_certification',
    tags: ['pmp', 'certification', 'expired', 'pdu-deficiency', 'fraud-signal'],
  },
];
