/**
 * Golden Dataset Phase 12 — Targeted Weakness Remediation
 *
 * 80 entries addressing the 4 weaknesses from Gemini Golden v2 eval:
 * 1. PUBLICATION: 20 entries (journals, conferences, preprints, books, technical reports)
 * 2. MILITARY: 15 entries (DD-214, service records, VA docs, discharge papers)
 * 3. IDENTITY: 15 entries (passports, driver's licenses, national IDs)
 * 4. REGULATION: 15 entries (CFR, state regs, executive orders, agency rules)
 * 5. DEGREE with tricky degreeLevel: 15 entries (non-standard nomenclature)
 *
 * GD-1686 through GD-1765
 */

import type { GoldenDatasetEntry } from './types.js';

export const GOLDEN_DATASET_PHASE12: GoldenDatasetEntry[] = [
  // ============================================================
  // PUBLICATION (20 entries) — GD-1686 to GD-1705
  // ============================================================
  {
    id: 'GD-1686',
    description: 'Peer-reviewed journal article in Nature',
    strippedText: 'ORIGINAL ARTICLE. Title: "Quantum Error Correction in Superconducting Circuits." Authors: [NAME_REDACTED], [NAME_REDACTED], [NAME_REDACTED]. Published in: Nature, Volume 621, Pages 283-290. DOI: 10.1038/s41586-025-07821-4. Received: August 14, 2025. Accepted: November 2, 2025. Published: January 8, 2026. Affiliation: [ORG_REDACTED], Department of Physics.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'Nature', issuedDate: '2026-01-08', fieldOfStudy: 'Quantum Physics', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'journal', 'clean'],
  },
  {
    id: 'GD-1687',
    description: 'Conference paper at NeurIPS',
    strippedText: 'Conference Paper. Title: Efficient Attention Mechanisms for Long-Context Language Models. Conference: Advances in Neural Information Processing Systems (NeurIPS 2025). Proceedings pages 14,521-14,536. Authors: [NAME_REDACTED] et al. Presented: December 12, 2025, Vancouver, Canada. Track: Main Conference (Oral Presentation).',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'NeurIPS', issuedDate: '2025-12-12', fieldOfStudy: 'Machine Learning', jurisdiction: 'Canada', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'conference', 'clean'],
  },
  {
    id: 'GD-1688',
    description: 'arXiv preprint',
    strippedText: 'arXiv:2601.04827v2 [cs.CL] 19 Jan 2026. Title: Chain-of-Verification: Reducing Hallucination in Large Language Models. Authors: [NAME_REDACTED], [NAME_REDACTED]. Abstract: We present a novel approach to reducing factual hallucination... Submitted January 10, 2026. Revised January 19, 2026.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'arXiv', issuedDate: '2026-01-19', fieldOfStudy: 'Computer Science', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'preprint', 'clean'],
  },
  {
    id: 'GD-1689',
    description: 'Published book by academic press',
    strippedText: 'Book. Title: Foundations of Cryptographic Verification. Publisher: Cambridge University Press. ISBN: 978-1-108-83421-7. Publication Date: March 2026. Edition: First Edition. Author: [NAME_REDACTED], Professor of Computer Science. Pages: 412. Series: Cambridge Texts in Applied Mathematics.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'Cambridge University Press', issuedDate: '2026-03-01', fieldOfStudy: 'Cryptography', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'book', 'clean'],
  },
  {
    id: 'GD-1690',
    description: 'Government technical report',
    strippedText: 'NIST Special Publication 800-233. Title: Guidelines for Post-Quantum Cryptographic Key Management. Authors: [NAME_REDACTED], [NAME_REDACTED]. National Institute of Standards and Technology. Published: February 2026. DOI: 10.6028/NIST.SP.800-233. Supersedes: NIST SP 800-131A Rev. 2.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'National Institute of Standards and Technology', issuedDate: '2026-02-01', fieldOfStudy: 'Cryptography', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'technical-report', 'clean'],
  },
  {
    id: 'GD-1691',
    description: 'Medical journal article in JAMA',
    strippedText: 'Research Article. Efficacy of Novel mRNA Vaccines Against Respiratory Syncytial Virus in Adults Over 65. JAMA: The Journal of the American Medical Association. 2026;335(4):412-423. doi:10.1001/jama.2025.28471. Published online January 28, 2026. Authors: [NAME_REDACTED], MD; [NAME_REDACTED], PhD.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'JAMA', issuedDate: '2026-01-28', fieldOfStudy: 'Medicine', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'journal', 'clean'],
  },
  {
    id: 'GD-1692',
    description: 'IEEE conference proceedings',
    strippedText: 'Proceedings of the IEEE International Conference on Robotics and Automation (ICRA 2025). Paper ID: 4827. Title: Adaptive Manipulation Planning with Tactile Feedback. Pages: 8721-8728. DOI: 10.1109/ICRA48891.2025.0094827. Date: May 26-30, 2025. Location: Atlanta, GA.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'IEEE', issuedDate: '2025-05-26', fieldOfStudy: 'Robotics', jurisdiction: 'Georgia', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'conference', 'clean'],
  },
  {
    id: 'GD-1693',
    description: 'Dissertation/thesis',
    strippedText: 'DOCTORAL DISSERTATION. Title: Provable Security of Blockchain-Based Credential Verification Systems. [NAME_REDACTED]. Submitted to the Faculty of the Graduate School of Stanford University in partial fulfillment of the requirements for the degree of Doctor of Philosophy. Department of Computer Science. June 2025. Committee: [NAME_REDACTED] (Chair), [NAME_REDACTED], [NAME_REDACTED].',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'Stanford University', issuedDate: '2025-06-01', fieldOfStudy: 'Computer Science', degreeLevel: 'Doctorate', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'dissertation', 'clean'],
  },
  {
    id: 'GD-1694',
    description: 'White paper by industry group',
    strippedText: 'WHITE PAPER. Digital Identity Verification Standards for Financial Institutions. Published by: The Financial Industry Regulatory Authority (FINRA). Version 3.2. Release Date: November 15, 2025. Classification: Public. Authors: FINRA Digital Identity Working Group.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'Financial Industry Regulatory Authority', issuedDate: '2025-11-15', fieldOfStudy: 'Financial Regulation', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'whitepaper', 'clean'],
  },
  {
    id: 'GD-1695',
    description: 'Law review article',
    strippedText: 'Harvard Law Review. Volume 139, Number 3, January 2026. Article: "The Legal Status of AI-Generated Evidence in Federal Courts." [NAME_REDACTED], J.D., Ph.D. Pages 721-798. ISSN: 0017-811X.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'Harvard Law Review', issuedDate: '2026-01-01', fieldOfStudy: 'Law', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'journal', 'clean'],
  },
  {
    id: 'GD-1696', description: 'ACM journal article',
    strippedText: 'ACM Computing Surveys, Vol. 58, No. 2, Article 31 (March 2026). A Survey of Verified Computation: From Theory to Practice. [NAME_REDACTED], [NAME_REDACTED]. DOI: 10.1145/3612345. Published March 1, 2026.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'ACM', issuedDate: '2026-03-01', fieldOfStudy: 'Computer Science', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'journal', 'clean'],
  },
  {
    id: 'GD-1697', description: 'World Bank policy report',
    strippedText: 'World Bank Policy Research Working Paper 10892. Digital Credential Infrastructure in Low-Income Countries: Barriers and Opportunities. March 2026. Authors: [NAME_REDACTED], [NAME_REDACTED]. Washington, D.C.: World Bank Group.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'World Bank', issuedDate: '2026-03-01', fieldOfStudy: 'Economic Development', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'policy-report', 'clean'],
  },
  {
    id: 'GD-1698', description: 'Elsevier journal with OCR noise',
    strippedText: 'Comp uters & Security, Vo1ume 142 (2026) 103847. Tit1e: Zero-Kn0wledge Proofs for Document Authenticity Verification. D0I: 10.1016/j.cose.2025.103847. Received 15 September 2025, Accepted 3 January 2026, Avai1able online 10 January 2026.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'Computers & Security', issuedDate: '2026-01-10', fieldOfStudy: 'Computer Security', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'journal', 'ocr-noise'],
  },
  {
    id: 'GD-1699', description: 'Book chapter in edited volume',
    strippedText: 'Chapter 7: Regulatory Compliance in the Age of AI. In: Handbook of AI Governance, edited by [NAME_REDACTED] and [NAME_REDACTED]. Springer Nature, 2026. Pages 143-178. ISBN: 978-3-031-54321-0. DOI: 10.1007/978-3-031-54321-0_7.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'Springer Nature', issuedDate: '2026-01-01', fieldOfStudy: 'AI Governance', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'book-chapter', 'clean'],
  },
  {
    id: 'GD-1700', description: 'Patent application publication',
    strippedText: 'United States Patent Application Publication. Pub. No.: US 2026/0012345 A1. Pub. Date: Jan. 15, 2026. Title: System and Method for Cryptographic Document Verification Using Distributed Ledger Technology. Inventor: [NAME_REDACTED]. Assignee: [ORG_REDACTED]. Filed: July 8, 2025. Appl. No.: 18/347,892.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'United States Patent and Trademark Office', issuedDate: '2026-01-15', fieldOfStudy: 'Cryptography', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'patent-pub', 'clean'],
  },
  {
    id: 'GD-1701', description: 'UN technical document',
    strippedText: 'United Nations Conference on Trade and Development. UNCTAD/DTL/STICT/2026/2. Digital Identity Systems and Trade Facilitation. New York and Geneva, 2026. Sales No. E.26.II.D.4.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'United Nations Conference on Trade and Development', issuedDate: '2026-01-01', fieldOfStudy: 'International Trade', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'un-report', 'clean'],
  },
  {
    id: 'GD-1702', description: 'Lancet clinical trial',
    strippedText: 'The Lancet. Volume 407, Issue 10324, Pages 312-325. 24 January 2026. Phase 3 Randomised Trial of Digital Biomarker-Guided Therapy in Treatment-Resistant Depression. [NAME_REDACTED] et al. DOI: https://doi.org/10.1016/S0140-6736(25)02847-3.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'The Lancet', issuedDate: '2026-01-24', fieldOfStudy: 'Psychiatry', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'journal', 'clean'],
  },
  {
    id: 'GD-1703', description: 'Working paper from think tank',
    strippedText: 'Brookings Institution Working Paper #187. The Future of Credential Verification: Policy Implications for Higher Education. Author: [NAME_REDACTED]. Released: February 2026. Economic Studies Program.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'Brookings Institution', issuedDate: '2026-02-01', fieldOfStudy: 'Education Policy', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'working-paper', 'clean'],
  },
  {
    id: 'GD-1704', description: 'Open access PLOS ONE article',
    strippedText: 'PLOS ONE | https://doi.org/10.1371/journal.pone.0298765. Validation of Machine Learning Models for Automated Credential Fraud Detection. [NAME_REDACTED], [NAME_REDACTED], [NAME_REDACTED]. Published: March 14, 2026. Editor: [NAME_REDACTED]. This is an open access article distributed under the terms of the Creative Commons Attribution License.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'PLOS ONE', issuedDate: '2026-03-14', fieldOfStudy: 'Computer Science', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'journal', 'clean'],
  },
  {
    id: 'GD-1705', description: 'Annual review article',
    strippedText: 'Annual Review of Law and Technology, Vol. 3, pp. 47-89, 2026. Blockchain-Based Evidence: Admissibility, Authentication, and Best Evidence Rule Implications. [NAME_REDACTED], [NAME_REDACTED]. Annual Reviews Inc.',
    credentialTypeHint: 'PUBLICATION',
    groundTruth: { credentialType: 'PUBLICATION', issuerName: 'Annual Reviews', issuedDate: '2026-01-01', fieldOfStudy: 'Law and Technology', fraudSignals: [] },
    source: 'synthetic-publication', category: 'publication', tags: ['synthetic', 'review', 'clean'],
  },

  // ============================================================
  // MILITARY (15 entries) — GD-1706 to GD-1720
  // ============================================================
  {
    id: 'GD-1706', description: 'DD-214 honorable discharge',
    strippedText: 'DEPARTMENT OF DEFENSE. DD Form 214. Certificate of Release or Discharge from Active Duty. [NAME_REDACTED]. Grade: E-5 / Sergeant. Date of Entry: [DATE_REDACTED]. Date of Separation: March 15, 2024. Character of Service: Honorable. Branch: United States Army. Primary Specialty: 25B Information Technology Specialist.',
    credentialTypeHint: 'MILITARY',
    groundTruth: { credentialType: 'MILITARY', issuerName: 'United States Army', issuedDate: '2024-03-15', fieldOfStudy: 'Information Technology', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'dd214', 'clean'],
  },
  {
    id: 'GD-1707', description: 'Navy service record',
    strippedText: 'NAVPERS 1070/604. Enlisted Service Record. [NAME_REDACTED]. Rate/Rating: HM2 (Hospital Corpsman Second Class). Active Duty Service: [DATE_REDACTED] to February 28, 2025. Branch: United States Navy. Duty Station: Naval Medical Center San Diego. Awards: Navy and Marine Corps Achievement Medal, Global War on Terrorism Service Medal.',
    credentialTypeHint: 'MILITARY',
    groundTruth: { credentialType: 'MILITARY', issuerName: 'United States Navy', issuedDate: '2025-02-28', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'service-record', 'clean'],
  },
  {
    id: 'GD-1708', description: 'VA disability rating letter',
    strippedText: 'Department of Veterans Affairs. Rating Decision. Date of Letter: April 10, 2025. Dear [NAME_REDACTED]: We have made a decision on your claim for disability compensation. Service-Connected Disabilities: Post-Traumatic Stress Disorder — 70%, Tinnitus — 10%. Combined Rating: 73%, rounded to 70%. Effective Date: November 1, 2024.',
    credentialTypeHint: 'MILITARY',
    groundTruth: { credentialType: 'MILITARY', issuerName: 'Department of Veterans Affairs', issuedDate: '2025-04-10', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'va-letter', 'clean'],
  },
  {
    id: 'GD-1709', description: 'Air Force officer commissioning',
    strippedText: 'DEPARTMENT OF THE AIR FORCE. Certificate of Commissioning. This is to certify that [NAME_REDACTED] has been appointed a Second Lieutenant in the United States Air Force. Date of Appointment: May 23, 2025. Commissioning Source: Air Force ROTC, Detachment 875. Specialty Code: 17D Cyberspace Operations Officer.',
    credentialTypeHint: 'MILITARY',
    groundTruth: { credentialType: 'MILITARY', issuerName: 'United States Air Force', issuedDate: '2025-05-23', fieldOfStudy: 'Cyberspace Operations', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'commissioning', 'clean'],
  },
  {
    id: 'GD-1710', description: 'Marine Corps promotion warrant',
    strippedText: 'UNITED STATES MARINE CORPS. Promotion Warrant. To All Who Shall See These Presents: Know that [NAME_REDACTED] having been selected for promotion, is promoted to the grade of Staff Sergeant (E-6) in the United States Marine Corps. Effective Date: August 1, 2025. MOS: 0311 Rifleman.',
    credentialTypeHint: 'MILITARY',
    groundTruth: { credentialType: 'MILITARY', issuerName: 'United States Marine Corps', issuedDate: '2025-08-01', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'promotion', 'clean'],
  },
  {
    id: 'GD-1711', description: 'Military training certificate',
    strippedText: 'CERTIFICATE OF COMPLETION. [NAME_REDACTED] has successfully completed the Advanced Individual Training course in Military Intelligence (MOS 35F). Training Location: Fort Huachuca, Arizona. Graduation Date: September 12, 2025. Course Hours: 480. Commanding Officer: [NAME_REDACTED], Colonel, MI.',
    credentialTypeHint: 'MILITARY',
    groundTruth: { credentialType: 'MILITARY', issuerName: 'United States Army', issuedDate: '2025-09-12', fieldOfStudy: 'Military Intelligence', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'training', 'clean'],
  },
  {
    id: 'GD-1712', description: 'Coast Guard discharge', strippedText: 'U.S. COAST GUARD. DD Form 214. [NAME_REDACTED]. Rate: BM1 (Boatswain\'s Mate First Class). Separation Date: January 31, 2026. Character of Service: Honorable. Years of Service: 12 years, 4 months. Branch: United States Coast Guard.',
    credentialTypeHint: 'MILITARY', groundTruth: { credentialType: 'MILITARY', issuerName: 'United States Coast Guard', issuedDate: '2026-01-31', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'dd214', 'clean'],
  },
  {
    id: 'GD-1713', description: 'National Guard deployment order', strippedText: 'DEPARTMENT OF THE ARMY. Orders 025-001. [NAME_REDACTED], SPC, [SSN_REDACTED], [ORG_REDACTED], is ordered to active duty under Title 10 USC. Reporting Date: March 1, 2025. Duration: 12 months. Deployment: Operation Inherent Resolve.',
    credentialTypeHint: 'MILITARY', groundTruth: { credentialType: 'MILITARY', issuerName: 'United States Army', issuedDate: '2025-03-01', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'deployment', 'clean'],
  },
  {
    id: 'GD-1714', description: 'Military award certificate', strippedText: 'THE UNITED STATES OF AMERICA. TO ALL WHO SHALL SEE THESE PRESENTS: This is to certify that the President of the United States has awarded the Bronze Star Medal to [NAME_REDACTED], Captain, United States Army, for meritorious service during combat operations. Date of Action: July 2024. General Orders Number: 2025-047.',
    credentialTypeHint: 'MILITARY', groundTruth: { credentialType: 'MILITARY', issuerName: 'United States Army', issuedDate: '2025-01-01', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'award', 'clean'],
  },
  {
    id: 'GD-1715', description: 'Space Force technical cert', strippedText: 'UNITED STATES SPACE FORCE. Certificate of Qualification. [NAME_REDACTED] is qualified in Space Systems Operations (1C6X1). Certification Date: October 15, 2025. Unit: Space Delta 4, Buckley Space Force Base, Colorado.',
    credentialTypeHint: 'MILITARY', groundTruth: { credentialType: 'MILITARY', issuerName: 'United States Space Force', issuedDate: '2025-10-15', fieldOfStudy: 'Space Systems Operations', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'qualification', 'clean'],
  },
  {
    id: 'GD-1716', description: 'Military medical examination', strippedText: 'DD Form 2808. Report of Medical Examination. [NAME_REDACTED]. Purpose: Separation Physical. Date of Examination: November 3, 2025. Examining Facility: Tripler Army Medical Center. Result: Qualified for separation. Examining Physician: [NAME_REDACTED], M.D.',
    credentialTypeHint: 'MILITARY', groundTruth: { credentialType: 'MILITARY', issuerName: 'Tripler Army Medical Center', issuedDate: '2025-11-03', jurisdiction: 'Hawaii', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'medical', 'clean'],
  },
  {
    id: 'GD-1717', description: 'Veterans ID card', strippedText: 'VETERAN HEALTH IDENTIFICATION CARD. Department of Veterans Affairs. [NAME_REDACTED]. Branch: USMC. Service Dates: [DATE_REDACTED] — [DATE_REDACTED]. Card Issued: June 2025. Card Number: [REDACTED]. This card identifies the bearer as an enrolled VA health care beneficiary.',
    credentialTypeHint: 'MILITARY', groundTruth: { credentialType: 'MILITARY', issuerName: 'Department of Veterans Affairs', issuedDate: '2025-06-01', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'id-card', 'clean'],
  },
  {
    id: 'GD-1718', description: 'Military retirement certificate', strippedText: 'CERTIFICATE OF RETIREMENT FROM THE ARMED FORCES OF THE UNITED STATES. [NAME_REDACTED], Colonel, United States Army, having served faithfully and honorably, is retired from active service this 30th day of September 2025, after 26 years of service.',
    credentialTypeHint: 'MILITARY', groundTruth: { credentialType: 'MILITARY', issuerName: 'United States Army', issuedDate: '2025-09-30', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'retirement', 'clean'],
  },
  {
    id: 'GD-1719', description: 'Military GI Bill benefit letter', strippedText: 'Department of Veterans Affairs. Education Service. Certificate of Eligibility. [NAME_REDACTED] is eligible for education benefits under Chapter 33 (Post-9/11 GI Bill). Benefit Level: 100%. Remaining Entitlement: 36 months, 0 days. Date of Determination: January 2026.',
    credentialTypeHint: 'MILITARY', groundTruth: { credentialType: 'MILITARY', issuerName: 'Department of Veterans Affairs', issuedDate: '2026-01-01', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'gi-bill', 'clean'],
  },
  {
    id: 'GD-1720', description: 'Suspicious military credential', strippedText: 'CERTIFICATE OF DISCHARGE. [NAME_REDACTED]. Rank: General of the Armies. Branch: U.S. Army Special Operations. Service Period: 2020-2021 (1 year). Awarded: Medal of Honor, Distinguished Service Cross, Silver Star, Bronze Star (all in one year). Character: Honorable. Signed by: [NAME_REDACTED].',
    credentialTypeHint: 'MILITARY', groundTruth: { credentialType: 'MILITARY', issuerName: 'U.S. Army', issuedDate: '2021-01-01', jurisdiction: 'United States', fraudSignals: ['SUSPICIOUS_TIMELINE', 'INVALID_FORMAT'] },
    source: 'synthetic-military', category: 'military', tags: ['synthetic', 'fraud', 'suspicious'],
  },

  // ============================================================
  // IDENTITY (15 entries) — GD-1721 to GD-1735
  // ============================================================
  {
    id: 'GD-1721', description: 'US passport',
    strippedText: 'UNITED STATES OF AMERICA. PASSPORT. Type: P. Nationality: UNITED STATES OF AMERICA. Surname: [NAME_REDACTED]. Given Names: [NAME_REDACTED]. Date of Birth: [DOB_REDACTED]. Sex: M. Place of Birth: [CITY_REDACTED], California. Date of Issue: August 15, 2023. Date of Expiration: August 14, 2033. Passport No.: [REDACTED].',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'United States Department of State', issuedDate: '2023-08-15', expiryDate: '2033-08-14', jurisdiction: 'California', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'passport', 'clean'],
  },
  {
    id: 'GD-1722', description: 'California driver license',
    strippedText: 'STATE OF CALIFORNIA. DEPARTMENT OF MOTOR VEHICLES. DRIVER LICENSE. DL [REDACTED]. Class: C. Exp: [DATE_REDACTED]. ISS: 03/20/2024. DOB: [DOB_REDACTED]. [NAME_REDACTED]. [ADDRESS_REDACTED]. SEX: F. HGT: 5\'06". WGT: 130. EYES: BRN. RSTR: CORRECTIVE LENSES.',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'California Department of Motor Vehicles', issuedDate: '2024-03-20', jurisdiction: 'California', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'drivers-license', 'clean'],
  },
  {
    id: 'GD-1723', description: 'Social Security card (redacted)',
    strippedText: 'SOCIAL SECURITY. [SSN_REDACTED]. THIS NUMBER HAS BEEN ESTABLISHED FOR [NAME_REDACTED]. Signature: [SIGNATURE_REDACTED]. SOCIAL SECURITY ADMINISTRATION.',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'Social Security Administration', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'ssn-card', 'clean'],
  },
  {
    id: 'GD-1724', description: 'UK passport',
    strippedText: 'UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND. PASSPORT. Type: P. Code: GBR. Surname: [NAME_REDACTED]. Given names: [NAME_REDACTED]. Nationality: BRITISH CITIZEN. Date of birth: [DOB_REDACTED]. Sex: F. Place of birth: [CITY_REDACTED]. Date of issue: 14 JAN 2024. Date of expiry: 14 JAN 2034. Authority: IPS.',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'HM Passport Office', issuedDate: '2024-01-14', expiryDate: '2034-01-14', jurisdiction: 'United Kingdom', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'passport', 'international'],
  },
  {
    id: 'GD-1725', description: 'Texas ID card',
    strippedText: 'TEXAS DEPARTMENT OF PUBLIC SAFETY. IDENTIFICATION CARD. ID No: [REDACTED]. [NAME_REDACTED]. DOB: [DOB_REDACTED]. ISS: 11/15/2025. EXP: 11/15/2031. SEX: M. HGT: 5-11. EYES: BLU. [ADDRESS_REDACTED].',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'Texas Department of Public Safety', issuedDate: '2025-11-15', expiryDate: '2031-11-15', jurisdiction: 'Texas', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'state-id', 'clean'],
  },
  {
    id: 'GD-1726', description: 'Canadian permanent resident card',
    strippedText: 'CANADA. PERMANENT RESIDENT CARD / CARTE DE RÉSIDENT PERMANENT. [NAME_REDACTED]. Country of Birth: [COUNTRY_REDACTED]. Date of Birth: [DOB_REDACTED]. Sex/Sexe: M. Issue Date: 2025-02-10. Expiry Date: 2030-02-10. Document No: [REDACTED].',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'Immigration, Refugees and Citizenship Canada', issuedDate: '2025-02-10', expiryDate: '2030-02-10', jurisdiction: 'Canada', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'pr-card', 'international'],
  },
  {
    id: 'GD-1727', description: 'Voter registration card',
    strippedText: 'VOTER REGISTRATION CERTIFICATE. State of Florida. [NAME_REDACTED]. Voter ID: [REDACTED]. Party: NPA (No Party Affiliation). Precinct: 4127. Registration Date: January 5, 2024. County: Miami-Dade. Status: Active.',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'Miami-Dade County Supervisor of Elections', issuedDate: '2024-01-05', jurisdiction: 'Florida', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'voter-reg', 'clean'],
  },
  {
    id: 'GD-1728', description: 'REAL ID compliant license',
    strippedText: 'COMMONWEALTH OF VIRGINIA. DEPARTMENT OF MOTOR VEHICLES. REAL ID DRIVER\'S LICENSE. ★ COMPLIANT. [NAME_REDACTED]. DL: [REDACTED]. DOB: [DOB_REDACTED]. ISS: 09/01/2025. EXP: 09/01/2033. Class: D. Endorsements: None. Restrictions: B (Corrective Lenses).',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'Virginia Department of Motor Vehicles', issuedDate: '2025-09-01', expiryDate: '2033-09-01', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'real-id', 'clean'],
  },
  {
    id: 'GD-1729', description: 'German national ID card',
    strippedText: 'BUNDESREPUBLIK DEUTSCHLAND. PERSONALAUSWEIS / IDENTITY CARD. Name: [NAME_REDACTED]. Geburtsdatum/Date of birth: [DOB_REDACTED]. Staatsangehörigkeit/Nationality: DEUTSCH. Gültig bis/Date of expiry: 05.03.2035. Ausstellungsdatum/Date of issue: 05.03.2025. Behörde/Authority: Stadt München.',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'Stadt München', issuedDate: '2025-03-05', expiryDate: '2035-03-05', jurisdiction: 'Germany', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'national-id', 'international'],
  },
  {
    id: 'GD-1730', description: 'Global Entry card',
    strippedText: 'U.S. CUSTOMS AND BORDER PROTECTION. GLOBAL ENTRY. TRUSTED TRAVELER PROGRAM. [NAME_REDACTED]. PASSID: [REDACTED]. Membership Expires: December 2029. GOES ID: [REDACTED]. Issued: December 2024.',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'U.S. Customs and Border Protection', issuedDate: '2024-12-01', expiryDate: '2029-12-01', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'global-entry', 'clean'],
  },
  {
    id: 'GD-1731', description: 'Birth certificate extract',
    strippedText: 'CERTIFICATE OF LIVE BIRTH. State of New York. Department of Health. File Number: [REDACTED]. Child\'s Name: [NAME_REDACTED]. Date of Birth: [DOB_REDACTED]. Place of Birth: [HOSPITAL_REDACTED], New York, NY. Mother: [NAME_REDACTED]. Father: [NAME_REDACTED]. Date Filed: [DATE_REDACTED]. Registrar: [NAME_REDACTED].',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'New York State Department of Health', jurisdiction: 'New York', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'birth-cert', 'clean'],
  },
  {
    id: 'GD-1732', description: 'Naturalization certificate',
    strippedText: 'UNITED STATES OF AMERICA. CERTIFICATE OF NATURALIZATION. No. [REDACTED]. [NAME_REDACTED] having complied in all respects with the requirements of the naturalization laws of the United States is admitted as a citizen. Date: March 15, 2025. Court: U.S. District Court for the Southern District of California.',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'U.S. Citizenship and Immigration Services', issuedDate: '2025-03-15', jurisdiction: 'California', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'naturalization', 'clean'],
  },
  {
    id: 'GD-1733', description: 'Tribal ID card',
    strippedText: 'NAVAJO NATION. TRIBAL ENROLLMENT CARD. [NAME_REDACTED]. Enrollment No.: [REDACTED]. Clan: [REDACTED]. Date of Birth: [DOB_REDACTED]. Blood Quantum: [REDACTED]. Issued: July 2025. Expires: July 2030. Window Rock, Arizona.',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'Navajo Nation', issuedDate: '2025-07-01', expiryDate: '2030-07-01', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'tribal-id', 'clean'],
  },
  {
    id: 'GD-1734', description: 'NEXUS card (US-Canada)',
    strippedText: 'NEXUS PROGRAM. Canada Border Services Agency / U.S. Customs and Border Protection. [NAME_REDACTED]. Membership ID: [REDACTED]. Valid Through: 08/2030. Issued: 08/2025. This card is the property of the Government of Canada and the U.S. Government.',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'NEXUS Program', issuedDate: '2025-08-01', expiryDate: '2030-08-01', jurisdiction: 'Canada', fraudSignals: [] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'nexus', 'international'],
  },
  {
    id: 'GD-1735', description: 'Suspicious identity document',
    strippedText: 'REPUBLIC OF GENERICA. NATIONAL IDENTIFICATION DOCUMENT. [NAME_REDACTED]. ID Number: [REDACTED]. Date of Issue: January 1, 2020. No Expiry. Issuing Authority: Ministry of Internal Affairs, Generica City. Note: This document was issued by a non-recognized sovereign entity.',
    credentialTypeHint: 'IDENTITY', groundTruth: { credentialType: 'IDENTITY', issuerName: 'Republic of Generica', issuedDate: '2020-01-01', fraudSignals: ['UNVERIFIABLE_ISSUER', 'INVALID_FORMAT'] },
    source: 'synthetic-identity', category: 'identity', tags: ['synthetic', 'fraud', 'suspicious'],
  },

  // ============================================================
  // REGULATION (15 entries) — GD-1736 to GD-1750
  // ============================================================
  {
    id: 'GD-1736', description: 'Federal Register final rule',
    strippedText: 'Federal Register / Vol. 91, No. 12 / Wednesday, January 15, 2026 / Rules and Regulations. DEPARTMENT OF EDUCATION. 34 CFR Parts 600, 602, 668. RIN 1840-AD89. Final Rule: Institutional and Programmatic Eligibility; Student Assistance General Provisions. Effective Date: July 1, 2026.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'Department of Education', issuedDate: '2026-01-15', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'final-rule', 'clean'],
  },
  {
    id: 'GD-1737', description: 'SEC proposed rule',
    strippedText: 'SECURITIES AND EXCHANGE COMMISSION. 17 CFR Parts 229, 232, 240, 249. Release No. 34-99421; File No. S7-02-26. RIN 3235-AM42. Proposed Rule: Climate-Related Financial Risk Disclosures for Digital Asset Issuers. Comments Due: April 30, 2026.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'Securities and Exchange Commission', issuedDate: '2026-01-01', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'proposed-rule', 'clean'],
  },
  {
    id: 'GD-1738', description: 'State licensing regulation',
    strippedText: 'CALIFORNIA CODE OF REGULATIONS. Title 16. Professional and Vocational Regulations. Division 5. Board of Professional Engineers. Article 3. Continuing Education Requirements. Section 424. Required Hours: 36 professional development hours per biennial renewal period. Effective: January 1, 2026.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'California Board of Professional Engineers', issuedDate: '2026-01-01', jurisdiction: 'California', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'state-reg', 'clean'],
  },
  {
    id: 'GD-1739', description: 'HIPAA update notice',
    strippedText: 'DEPARTMENT OF HEALTH AND HUMAN SERVICES. Office for Civil Rights. 45 CFR Parts 160, 162, 164. HIPAA Security Rule Update: Requirements for Electronic Protected Health Information in Cloud Computing Environments. Final Rule. Published: February 20, 2026. Effective: August 20, 2026.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'Department of Health and Human Services', issuedDate: '2026-02-20', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'hipaa', 'clean'],
  },
  {
    id: 'GD-1740', description: 'Executive order',
    strippedText: 'THE WHITE HOUSE. Executive Order 14178. Executive Order on Safe, Secure, and Trustworthy Development and Use of Artificial Intelligence — Amendment No. 2. Signed: March 1, 2026. Federal Register Citation: 91 FR 15234.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'The White House', issuedDate: '2026-03-01', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'executive-order', 'clean'],
  },
  {
    id: 'GD-1741', description: 'EPA environmental regulation',
    strippedText: 'ENVIRONMENTAL PROTECTION AGENCY. 40 CFR Part 63. National Emission Standards for Hazardous Air Pollutants: Industrial Process Cooling Towers. Final Rule. EPA-HQ-OAR-2024-0412. Published: January 8, 2026.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'Environmental Protection Agency', issuedDate: '2026-01-08', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'epa', 'clean'],
  },
  {
    id: 'GD-1742', description: 'FTC guidance document',
    strippedText: 'FEDERAL TRADE COMMISSION. FTC Staff Report. Protecting Consumer Privacy in an Era of AI-Powered Credential Verification. February 2026. Commissioners: [NAME_REDACTED] (Chair), [NAME_REDACTED], [NAME_REDACTED]. Available at ftc.gov.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'Federal Trade Commission', issuedDate: '2026-02-01', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'guidance', 'clean'],
  },
  {
    id: 'GD-1743', description: 'EU AI Act implementing regulation',
    strippedText: 'EUROPEAN COMMISSION. Commission Implementing Regulation (EU) 2026/234. Laying down rules for the application of Regulation (EU) 2024/1689 (AI Act) as regards the classification of high-risk AI systems in credential verification. Official Journal L 45, 15.2.2026, p. 1-28.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'European Commission', issuedDate: '2026-02-15', jurisdiction: 'European Union', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'eu-regulation', 'international'],
  },
  {
    id: 'GD-1744', description: 'FDIC banking regulation',
    strippedText: 'FEDERAL DEPOSIT INSURANCE CORPORATION. 12 CFR Part 364. Interagency Guidelines for Digital Identity Verification in Banking. Appendix B to Part 364. Effective: April 1, 2026. Supersedes: Previous guidance issued November 2023.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'Federal Deposit Insurance Corporation', issuedDate: '2026-04-01', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'banking', 'clean'],
  },
  {
    id: 'GD-1745', description: 'NIST framework update',
    strippedText: 'NIST Cybersecurity Framework 2.1. National Institute of Standards and Technology. NIST CSWP 29 Rev. 1. February 2026. This update incorporates AI-specific governance functions and digital credential security controls.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'National Institute of Standards and Technology', issuedDate: '2026-02-01', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'nist', 'clean'],
  },
  {
    id: 'GD-1746', description: 'State data privacy law',
    strippedText: 'STATE OF TEXAS. TEXAS DATA PRIVACY AND SECURITY ACT. HB 4. Effective September 1, 2025. Chapter 541. Business and Commerce Code. Subchapter A. General Provisions. Sec. 541.001. DEFINITIONS. "Credential data" means personal data processed for the purpose of verifying qualifications.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'Texas Legislature', issuedDate: '2025-09-01', jurisdiction: 'Texas', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'state-law', 'clean'],
  },
  {
    id: 'GD-1747', description: 'DOL labor regulation',
    strippedText: 'DEPARTMENT OF LABOR. Employment and Training Administration. 20 CFR Part 655. RIN 1205-AC12. Modernization of Prevailing Wage Requirements: Digital Credential Verification for H-1B Applications. Interim Final Rule. March 15, 2026.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'Department of Labor', issuedDate: '2026-03-15', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'labor', 'clean'],
  },
  {
    id: 'GD-1748', description: 'OCC fintech guidance',
    strippedText: 'OFFICE OF THE COMPTROLLER OF THE CURRENCY. OCC Bulletin 2026-7. Supervisory Guidance on Third-Party Credential Verification Services. February 28, 2026. To: Chief Executive Officers of All National Banks and Federal Savings Associations.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'Office of the Comptroller of the Currency', issuedDate: '2026-02-28', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'occ', 'clean'],
  },
  {
    id: 'GD-1749', description: 'Canadian privacy regulation',
    strippedText: 'GOVERNMENT OF CANADA. Canada Gazette, Part II, Volume 160, Number 4. SOR/2026-15. Digital Identity Verification Regulations under the Personal Information Protection and Electronic Documents Act (PIPEDA). Registration: February 12, 2026.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'Government of Canada', issuedDate: '2026-02-12', jurisdiction: 'Canada', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'canadian', 'international'],
  },
  {
    id: 'GD-1750', description: 'FERPA amendment',
    strippedText: 'DEPARTMENT OF EDUCATION. 34 CFR Part 99. Family Educational Rights and Privacy Act (FERPA). Final Rule: Amendment to permit disclosure of education records to authorized credential verification services with student consent. Published March 5, 2026. Effective July 1, 2026.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', issuerName: 'Department of Education', issuedDate: '2026-03-05', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-regulation', category: 'regulation', tags: ['synthetic', 'ferpa', 'clean'],
  },

  // ============================================================
  // DEGREE with tricky degreeLevel (15 entries) — GD-1751 to GD-1765
  // ============================================================
  {
    id: 'GD-1751', description: 'Ph.D. spelled out',
    strippedText: 'The Board of Trustees of The University of Chicago certifies that [NAME_REDACTED] has satisfactorily completed the requirements for the degree of Doctor of Philosophy in Economics. Conferred June 14, 2025. Signed by the President and the University Registrar.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'University of Chicago', issuedDate: '2025-06-14', degreeLevel: 'Doctorate', fieldOfStudy: 'Economics', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'doctorate', 'clean'],
  },
  {
    id: 'GD-1752', description: 'MBA abbreviated',
    strippedText: 'WHARTON SCHOOL. UNIVERSITY OF PENNSYLVANIA. This certifies that [NAME_REDACTED] has been awarded the MBA degree. Major: Finance and Strategic Management. Date of Conferral: May 18, 2025.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'University of Pennsylvania', issuedDate: '2025-05-18', degreeLevel: 'Master', fieldOfStudy: 'Finance and Strategic Management', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'master', 'clean'],
  },
  {
    id: 'GD-1753', description: 'M.D. degree',
    strippedText: 'JOHNS HOPKINS UNIVERSITY SCHOOL OF MEDICINE. The Faculty of Medicine hereby certifies that [NAME_REDACTED] has completed all requirements and is awarded the degree of Doctor of Medicine (M.D.). May 2025. Baltimore, Maryland.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'Johns Hopkins University', issuedDate: '2025-05-01', degreeLevel: 'Doctorate', fieldOfStudy: 'Medicine', jurisdiction: 'Maryland', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'doctorate', 'clean'],
  },
  {
    id: 'GD-1754', description: 'J.D. law degree',
    strippedText: 'YALE LAW SCHOOL. Yale University. The Corporation of Yale University certifies that [NAME_REDACTED] has fulfilled the requirements for the degree of Juris Doctor. Conferred May 19, 2025. New Haven, Connecticut.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'Yale University', issuedDate: '2025-05-19', degreeLevel: 'Doctorate', fieldOfStudy: 'Law', jurisdiction: 'Connecticut', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'doctorate', 'clean'],
  },
  {
    id: 'GD-1755', description: 'Associate of Applied Science',
    strippedText: 'MARICOPA COMMUNITY COLLEGES. Mesa Community College. This is to certify that [NAME_REDACTED] has earned the Associate of Applied Science degree in Cybersecurity. Awarded: December 2025. Mesa, Arizona.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'Mesa Community College', issuedDate: '2025-12-01', degreeLevel: 'Associate', fieldOfStudy: 'Cybersecurity', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'associate', 'clean'],
  },
  {
    id: 'GD-1756', description: 'Master of Public Health',
    strippedText: 'HARVARD T.H. CHAN SCHOOL OF PUBLIC HEALTH. Harvard University. [NAME_REDACTED] has completed all requirements for the degree of Master of Public Health (MPH). Concentration: Epidemiology. May 29, 2025.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'Harvard University', issuedDate: '2025-05-29', degreeLevel: 'Master', fieldOfStudy: 'Epidemiology', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'master', 'clean'],
  },
  {
    id: 'GD-1757', description: 'Ed.D. education doctorate',
    strippedText: 'TEACHERS COLLEGE, COLUMBIA UNIVERSITY. The Trustees of Columbia University certify that [NAME_REDACTED] has earned the degree of Doctor of Education (Ed.D.) in Organizational Leadership. February 2026.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'Columbia University', issuedDate: '2026-02-01', degreeLevel: 'Doctorate', fieldOfStudy: 'Organizational Leadership', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'doctorate', 'clean'],
  },
  {
    id: 'GD-1758', description: 'B.S. in Engineering',
    strippedText: 'GEORGIA INSTITUTE OF TECHNOLOGY. The Board of Regents of the University System of Georgia certifies that [NAME_REDACTED] has earned the Bachelor of Science in Mechanical Engineering degree. Cum Laude. December 2025. Atlanta, Georgia.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'Georgia Institute of Technology', issuedDate: '2025-12-01', degreeLevel: 'Bachelor', fieldOfStudy: 'Mechanical Engineering', jurisdiction: 'Georgia', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'bachelor', 'clean'],
  },
  {
    id: 'GD-1759', description: 'PharmD pharmacy doctorate',
    strippedText: 'UNIVERSITY OF CALIFORNIA, SAN FRANCISCO. Skaggs School of Pharmacy and Pharmaceutical Sciences. [NAME_REDACTED] is awarded the degree of Doctor of Pharmacy (Pharm.D.). June 2025.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'University of California, San Francisco', issuedDate: '2025-06-01', degreeLevel: 'Doctorate', fieldOfStudy: 'Pharmacy', jurisdiction: 'California', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'doctorate', 'clean'],
  },
  {
    id: 'GD-1760', description: 'Master of Fine Arts',
    strippedText: 'RHODE ISLAND SCHOOL OF DESIGN. MFA in Graphic Design. [NAME_REDACTED] has fulfilled all requirements. Conferred May 2025. Providence, Rhode Island.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'Rhode Island School of Design', issuedDate: '2025-05-01', degreeLevel: 'Master', fieldOfStudy: 'Graphic Design', jurisdiction: 'Rhode Island', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'master', 'clean'],
  },
  {
    id: 'GD-1761', description: 'DNP nursing doctorate',
    strippedText: 'UNIVERSITY OF PENNSYLVANIA SCHOOL OF NURSING. The Trustees certify that [NAME_REDACTED] has completed the Doctor of Nursing Practice (DNP) program. Specialty: Family Nurse Practitioner. August 2025.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'University of Pennsylvania', issuedDate: '2025-08-01', degreeLevel: 'Doctorate', fieldOfStudy: 'Nursing Practice', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'doctorate', 'clean'],
  },
  {
    id: 'GD-1762', description: 'LLM law master',
    strippedText: 'NEW YORK UNIVERSITY SCHOOL OF LAW. [NAME_REDACTED] is awarded the Master of Laws (LL.M.) in International Taxation. May 2025. New York, New York.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'New York University', issuedDate: '2025-05-01', degreeLevel: 'Master', fieldOfStudy: 'International Taxation', jurisdiction: 'New York', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'master', 'clean'],
  },
  {
    id: 'GD-1763', description: 'DBA business doctorate',
    strippedText: 'CASE WESTERN RESERVE UNIVERSITY. Weatherhead School of Management. Doctor of Business Administration (DBA). [NAME_REDACTED]. Dissertation: "Blockchain-Based Supply Chain Verification." Conferred January 2026. Cleveland, Ohio.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'Case Western Reserve University', issuedDate: '2026-01-01', degreeLevel: 'Doctorate', fieldOfStudy: 'Business Administration', jurisdiction: 'Ohio', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'doctorate', 'clean'],
  },
  {
    id: 'GD-1764', description: 'International degree (UK Honours)',
    strippedText: 'THE UNIVERSITY OF OXFORD. This is to certify that [NAME_REDACTED] was admitted to the Degree of Master of Science (M.Sc.) in Computer Science. Michaelmas Term 2025. Awarded with Distinction.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'University of Oxford', issuedDate: '2025-12-01', degreeLevel: 'Master', fieldOfStudy: 'Computer Science', jurisdiction: 'United Kingdom', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'master', 'international'],
  },
  {
    id: 'GD-1765', description: 'PsyD psychology doctorate',
    strippedText: 'RUTGERS UNIVERSITY. Graduate School of Applied and Professional Psychology. [NAME_REDACTED] has completed the requirements for the degree of Doctor of Psychology (Psy.D.) in Clinical Psychology. May 2025. New Brunswick, New Jersey.',
    credentialTypeHint: 'DEGREE', groundTruth: { credentialType: 'DEGREE', issuerName: 'Rutgers University', issuedDate: '2025-05-01', degreeLevel: 'Doctorate', fieldOfStudy: 'Clinical Psychology', jurisdiction: 'New Jersey', fraudSignals: [] },
    source: 'synthetic-degree', category: 'degree', tags: ['synthetic', 'doctorate', 'clean'],
  },
];
