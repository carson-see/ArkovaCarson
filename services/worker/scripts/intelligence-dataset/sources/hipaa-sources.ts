/**
 * HIPAA Source Registry
 *
 * Anchors for every HIPAA citation the Nessie model may emit.
 * Scope: Privacy Rule (45 CFR 164 Subpart E), Security Rule (Subpart C),
 * Breach Notification Rule (Subpart D), Enforcement Rule (45 CFR 160
 * Subpart C), HITECH Act amendments, OCR guidance, state overlays
 * (CA CMIA, TX HB300, NY SHIELD, IL PHIPA/MHDDCA), DEA controlled
 * substance + HIPAA intersection.
 */

import type { IntelligenceSource } from '../types';

const V = '2026-04-16';

export const HIPAA_SOURCES: IntelligenceSource[] = [
  // ─── Core statute ────────────────────────────────────────────────────
  {
    id: 'hipaa-act-1996',
    quote: 'Health Insurance Portability and Accountability Act of 1996 (Pub. L. 104-191) — established federal standards for health information privacy and security; authorized HHS to promulgate Privacy, Security, and Breach Notification Rules',
    source: 'HIPAA Act of 1996 (Pub. L. 104-191)',
    lastVerified: V, tags: ['statute', 'hipaa-core'], jurisdiction: 'federal',
  },
  {
    id: 'hitech-2009',
    quote: 'Health Information Technology for Economic and Clinical Health (HITECH) Act (Pub. L. 111-5, Subtitle D) — strengthened HIPAA privacy/security, extended obligations to business associates directly, established tiered civil penalties, required breach notification',
    source: 'HITECH Act 2009',
    lastVerified: V, tags: ['statute', 'hitech'], jurisdiction: 'federal',
  },

  // ─── Definitions (45 CFR 160.103) ────────────────────────────────────
  {
    id: 'hipaa-160-103-phi',
    quote: '45 CFR 160.103 — "Protected Health Information" (PHI) means individually identifiable health information transmitted or maintained in any form or medium, excluding employment records held by a covered entity in its role as employer and education records covered by FERPA',
    source: '45 CFR 160.103 (PHI definition)',
    lastVerified: V, tags: ['regulation', 'definitions', 'phi'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-160-103-ce',
    quote: '45 CFR 160.103 — "Covered Entity" means (1) a health plan, (2) a health care clearinghouse, or (3) a health care provider who transmits any health information in electronic form in connection with a transaction covered by HIPAA',
    source: '45 CFR 160.103 (Covered Entity definition)',
    lastVerified: V, tags: ['regulation', 'definitions', 'covered-entity'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-160-103-ba',
    quote: '45 CFR 160.103 — "Business Associate" means a person who performs functions or activities on behalf of or provides services to a covered entity that involve use or disclosure of PHI, including claims processing, data analysis, utilization review, billing, or legal/accounting/consulting services',
    source: '45 CFR 160.103 (Business Associate definition)',
    lastVerified: V, tags: ['regulation', 'definitions', 'business-associate'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-160-103-ephi',
    quote: '45 CFR 160.103 — "Electronic Protected Health Information" (ePHI) means PHI transmitted by or maintained in electronic media',
    source: '45 CFR 160.103 (ePHI definition)',
    lastVerified: V, tags: ['regulation', 'definitions', 'ephi'], jurisdiction: 'federal',
  },

  // ─── Privacy Rule (45 CFR 164 Subpart E) ─────────────────────────────
  {
    id: 'hipaa-164-502',
    quote: '45 CFR 164.502(a) — general rule: a covered entity may not use or disclose PHI except as permitted or required by the Privacy Rule. Uses and disclosures to the individual or pursuant to valid authorization are permitted; treatment, payment, and health care operations (TPO) are permitted without authorization',
    source: '45 CFR 164.502',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'general-rule', 'tpo'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-502-minimum-necessary',
    quote: '45 CFR 164.502(b) — minimum necessary: when using or disclosing PHI, the covered entity must make reasonable efforts to limit PHI to the minimum necessary to accomplish the intended purpose',
    source: '45 CFR 164.502(b) (minimum necessary)',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'minimum-necessary'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-506-tpo',
    quote: '45 CFR 164.506 — treatment, payment, and health care operations (TPO) uses and disclosures permitted without authorization; consent may be required by state law but not by HIPAA',
    source: '45 CFR 164.506',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'tpo'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-508-authorization',
    quote: '45 CFR 164.508 — authorization required for uses and disclosures of PHI not otherwise permitted; must be in plain language, specify PHI to be used/disclosed, identify recipients, state expiration date or event, include right-to-revoke notice, and be signed by the individual',
    source: '45 CFR 164.508 (authorization)',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'authorization'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-508-psychotherapy',
    quote: '45 CFR 164.508(a)(2) — psychotherapy notes require specific authorization; may not be combined with other authorizations; psychotherapy notes are afforded heightened privacy protection',
    source: '45 CFR 164.508(a)(2) (psychotherapy notes)',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'psychotherapy-notes'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-510-opportunity',
    quote: '45 CFR 164.510 — uses and disclosures requiring opportunity to agree or object: facility directory, disclosures to family/friends involved in care or payment, disaster relief',
    source: '45 CFR 164.510',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'opportunity-to-object'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-512-public-health',
    quote: '45 CFR 164.512 — permitted disclosures without authorization for specific public interest purposes: public health activities, abuse reporting, health oversight, judicial proceedings, law enforcement, coroners, research, workers\' compensation',
    source: '45 CFR 164.512',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'public-interest', 'law-enforcement'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-512-e',
    quote: '45 CFR 164.512(e) — disclosure for judicial and administrative proceedings: permitted in response to court order, or in response to subpoena accompanied by (1) satisfactory assurance that notice was given to the individual, or (2) qualified protective order',
    source: '45 CFR 164.512(e) (judicial proceedings)',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'judicial-disclosure'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-512-f',
    quote: '45 CFR 164.512(f) — disclosure to law enforcement: permitted for required-by-law reporting, identification of suspect, response to grand jury subpoena, emergency circumstances involving serious harm',
    source: '45 CFR 164.512(f) (law enforcement)',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'law-enforcement'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-514-deidentification',
    quote: '45 CFR 164.514(b) — de-identification: PHI is not PHI if (1) a qualified statistician determines risk of re-identification is very small OR (2) 18 specified identifiers are removed (Safe Harbor method)',
    source: '45 CFR 164.514 (de-identification)',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'deidentification', 'safe-harbor'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-520-npp',
    quote: '45 CFR 164.520 — Notice of Privacy Practices (NPP): covered entities must provide NPP describing uses and disclosures, individual rights, covered entity duties, and contact information; must be displayed, distributed, and updated when material changes occur',
    source: '45 CFR 164.520 (NPP)',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'npp'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-522-restriction',
    quote: '45 CFR 164.522 — individual right to request restrictions on uses/disclosures; covered entity generally not required to agree except for disclosures to health plan for items paid out-of-pocket in full (§164.522(a)(1)(vi))',
    source: '45 CFR 164.522 (right to request restrictions)',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'restrictions', 'patient-rights'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-524-access',
    quote: '45 CFR 164.524 — individual right of access: right to inspect and obtain copy of PHI in designated record set; covered entity must act on request within 30 days (one 30-day extension permitted); may charge only reasonable cost-based fee',
    source: '45 CFR 164.524 (right of access)',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'access', 'patient-rights'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-526-amendment',
    quote: '45 CFR 164.526 — individual right to amend PHI: covered entity must permit amendment of PHI if the requestor indicates the information is inaccurate or incomplete; must act within 60 days',
    source: '45 CFR 164.526 (right to amend)',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'amendment', 'patient-rights'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-528-accounting',
    quote: '45 CFR 164.528 — individual right to accounting of disclosures: right to receive list of disclosures made in the prior 6 years (excluding TPO, disclosures to the individual, incidental, and authorized disclosures)',
    source: '45 CFR 164.528 (accounting of disclosures)',
    lastVerified: V, tags: ['regulation', 'privacy-rule', 'accounting'], jurisdiction: 'federal',
  },

  // ─── Security Rule (45 CFR 164 Subpart C) ────────────────────────────
  {
    id: 'hipaa-164-308-admin',
    quote: '45 CFR 164.308 — administrative safeguards: security management process, assigned security responsibility, workforce security, information access management, security awareness and training, security incident procedures, contingency plan, evaluation',
    source: '45 CFR 164.308 (administrative safeguards)',
    lastVerified: V, tags: ['regulation', 'security-rule', 'administrative'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-308-a1',
    quote: '45 CFR 164.308(a)(1)(ii)(A) — risk analysis (required): accurate and thorough assessment of potential risks and vulnerabilities to confidentiality, integrity, and availability of ePHI',
    source: '45 CFR 164.308(a)(1)(ii)(A) (risk analysis)',
    lastVerified: V, tags: ['regulation', 'security-rule', 'risk-analysis'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-308-a5',
    quote: '45 CFR 164.308(a)(5) — security awareness and training: implement program for all workforce members, including periodic security reminders, protection from malicious software, log-in monitoring, and password management',
    source: '45 CFR 164.308(a)(5) (training)',
    lastVerified: V, tags: ['regulation', 'security-rule', 'training'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-310-physical',
    quote: '45 CFR 164.310 — physical safeguards: facility access controls, workstation use, workstation security, device and media controls (disposal, reuse, accountability, backup)',
    source: '45 CFR 164.310 (physical safeguards)',
    lastVerified: V, tags: ['regulation', 'security-rule', 'physical'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-312-technical',
    quote: '45 CFR 164.312 — technical safeguards: access control (unique user ID, emergency access, automatic logoff, encryption-decryption), audit controls, integrity controls, person or entity authentication, transmission security',
    source: '45 CFR 164.312 (technical safeguards)',
    lastVerified: V, tags: ['regulation', 'security-rule', 'technical'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-312-a2-iv',
    quote: '45 CFR 164.312(a)(2)(iv) — encryption and decryption (addressable): implement a mechanism to encrypt and decrypt ePHI; addressable means covered entity must implement OR document rationale for alternative',
    source: '45 CFR 164.312(a)(2)(iv) (encryption addressable)',
    lastVerified: V, tags: ['regulation', 'security-rule', 'encryption'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-312-d',
    quote: '45 CFR 164.312(d) — person or entity authentication: implement procedures to verify that a person or entity seeking access to ePHI is the one claimed; multi-factor authentication is a recognized implementation',
    source: '45 CFR 164.312(d) (authentication)',
    lastVerified: V, tags: ['regulation', 'security-rule', 'authentication', 'mfa'], jurisdiction: 'federal',
  },

  // ─── Breach Notification Rule (45 CFR 164 Subpart D) ─────────────────
  {
    id: 'hipaa-164-402-breach',
    quote: '45 CFR 164.402 — "breach" means the acquisition, access, use, or disclosure of PHI in a manner not permitted that compromises the security or privacy of the PHI; presumed breach unless low probability of compromise based on risk assessment',
    source: '45 CFR 164.402 (breach definition)',
    lastVerified: V, tags: ['regulation', 'breach-rule', 'definition'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-404-individual',
    quote: '45 CFR 164.404 — notification to individuals: covered entity must notify each affected individual without unreasonable delay and no later than 60 calendar days after discovery of breach',
    source: '45 CFR 164.404 (individual notification)',
    lastVerified: V, tags: ['regulation', 'breach-rule', 'individual-notice'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-406-media',
    quote: '45 CFR 164.406 — notification to media required for breach affecting 500+ residents of a State or jurisdiction; must be provided to prominent media outlets without unreasonable delay and no later than 60 calendar days',
    source: '45 CFR 164.406 (media notification)',
    lastVerified: V, tags: ['regulation', 'breach-rule', 'media-notice', '500-threshold'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-408-hhs',
    quote: '45 CFR 164.408 — notification to HHS: breach affecting 500+ individuals reported contemporaneously with individual notice; breaches under 500 reported annually to HHS within 60 days of year-end',
    source: '45 CFR 164.408 (HHS notification)',
    lastVerified: V, tags: ['regulation', 'breach-rule', 'hhs-notice'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-410-ba',
    quote: '45 CFR 164.410 — business associate notification: BA must notify covered entity without unreasonable delay and no later than 60 days after discovery; covered entity timeline begins at BA notice (not BA discovery)',
    source: '45 CFR 164.410 (BA notification)',
    lastVerified: V, tags: ['regulation', 'breach-rule', 'ba-notification'], jurisdiction: 'federal',
  },

  // ─── Business Associate Agreements ───────────────────────────────────
  {
    id: 'hipaa-164-504-baa',
    quote: '45 CFR 164.504(e) — Business Associate Agreement (BAA) required; must establish permitted and required uses and disclosures of PHI, prohibit uses beyond BAA terms, require safeguards, require subcontractor BAAs, require breach reporting to CE',
    source: '45 CFR 164.504(e) (BAA)',
    lastVerified: V, tags: ['regulation', 'baa', 'business-associate'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-164-314-ba-security',
    quote: '45 CFR 164.314(a) — business associate contract: must require BA to comply with Security Rule, report security incidents, ensure subcontractor compliance',
    source: '45 CFR 164.314(a) (BA security obligations)',
    lastVerified: V, tags: ['regulation', 'security-rule', 'ba'], jurisdiction: 'federal',
  },

  // ─── Enforcement Rule + penalties (45 CFR 160 Subpart C) ─────────────
  {
    id: 'hipaa-160-402-tier',
    quote: '45 CFR 160.404 — civil monetary penalty tiers: (1) lack of knowledge: $137-$68,928 per violation, (2) reasonable cause: $1,379-$68,928, (3) willful neglect corrected: $13,785-$68,928, (4) willful neglect uncorrected: $68,928+ per violation; annual max $2,067,813 per type (2024 inflation-adjusted)',
    source: '45 CFR 160.404 (CMP tiers)',
    lastVerified: V, tags: ['regulation', 'enforcement', 'penalties'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-160-410-safe-harbor',
    quote: '45 CFR 160.410 — affirmative defense: covered entity may avoid penalty for violation if (1) not due to willful neglect AND (2) corrected within 30 days of discovery',
    source: '45 CFR 160.410 (safe harbor)',
    lastVerified: V, tags: ['regulation', 'enforcement', 'safe-harbor'], jurisdiction: 'federal',
  },

  // ─── OCR Enforcement Actions ─────────────────────────────────────────
  {
    id: 'ocr-anthem-2018',
    quote: 'HHS/OCR v. Anthem (2018) — $16M settlement for 78.8M-record breach; systemic failures in risk analysis, system activity review, access controls, and workforce training',
    source: 'OCR v. Anthem (2018)',
    lastVerified: V, tags: ['ocr-action', 'breach', 'record-size'], jurisdiction: 'federal',
  },
  {
    id: 'ocr-memorial-2017',
    quote: 'HHS/OCR v. Memorial Healthcare System (2017) — $5.5M settlement for 115K-patient breach; inadequate access controls and absence of audit logs permitted unauthorized employee access over 12 months',
    source: 'OCR v. Memorial Healthcare System (2017)',
    lastVerified: V, tags: ['ocr-action', 'access-controls', 'audit-logs'], jurisdiction: 'federal',
  },
  {
    id: 'ocr-premera-2019',
    quote: 'HHS/OCR v. Premera Blue Cross (2019) — $6.85M settlement plus corrective action plan for 10.4M-record breach; extensive Security Rule violations including risk analysis, system monitoring',
    source: 'OCR v. Premera Blue Cross (2019)',
    lastVerified: V, tags: ['ocr-action', 'breach', 'risk-analysis'], jurisdiction: 'federal',
  },
  {
    id: 'ocr-right-of-access-2019',
    quote: 'OCR Right of Access Initiative (2019-ongoing) — series of enforcement actions for failure to timely respond to §164.524 access requests; settlements ranging $3,500-$85,000 for relatively small CEs',
    source: 'OCR Right of Access Initiative',
    lastVerified: V, tags: ['ocr-action', 'access', 'right-of-access'], jurisdiction: 'federal',
  },

  // ─── State overlays ──────────────────────────────────────────────────
  {
    id: 'ca-cmia',
    quote: 'Cal. Civ. Code §56 et seq. (Confidentiality of Medical Information Act, CMIA) — California state-law parallel to HIPAA; applies to medical information beyond HIPAA scope (e.g. employee wellness programs, non-CE providers); private right of action with statutory damages of $1,000-$3,000 per violation',
    source: 'CA CMIA (Cal. Civ. Code §56)',
    lastVerified: V, tags: ['state-statute', 'california', 'medical-confidentiality'], jurisdiction: 'CA',
  },
  {
    id: 'ca-cmia-1798-82',
    quote: 'Cal. Civ. Code §1798.82 — California breach notification: must notify affected California residents without unreasonable delay following discovery of unauthorized access to personal information; extends beyond HIPAA scope',
    source: 'Cal. Civ. Code §1798.82 (breach notification)',
    lastVerified: V, tags: ['state-statute', 'california', 'breach'], jurisdiction: 'CA',
  },
  {
    id: 'tx-hb300',
    quote: 'TX Health & Safety Code §181 (Texas HB 300) — state health privacy law stricter than HIPAA; requires disclosure log, biennial training for healthcare workforce, stricter electronic disclosure rules; covers "covered entities" defined more broadly than HIPAA',
    source: 'TX HB 300 (Health & Safety Code §181)',
    lastVerified: V, tags: ['state-statute', 'texas', 'hb300'], jurisdiction: 'TX',
  },
  {
    id: 'ny-shield-2019',
    quote: 'NY SHIELD Act (Gen. Bus. Law §899-aa) — requires reasonable administrative, physical, and technical safeguards for private information including health information; breach notification to NY residents; applicable to any business holding NY-resident data',
    source: 'NY SHIELD Act',
    lastVerified: V, tags: ['state-statute', 'new-york', 'shield'], jurisdiction: 'NY',
  },
  {
    id: 'il-mhddcc',
    quote: 'Illinois Mental Health and Developmental Disabilities Confidentiality Act (740 ILCS 110) — stricter than HIPAA for mental health records; written consent required for most disclosures beyond treatment',
    source: 'IL MHDDCA (740 ILCS 110)',
    lastVerified: V, tags: ['state-statute', 'illinois', 'mental-health'], jurisdiction: 'IL',
  },
  {
    id: 'fl-phic',
    quote: 'Florida Patient\'s Health Information Confidentiality Act (Fla. Stat. §456.057) — more protective than HIPAA for certain disclosures; authorization required for additional classes of disclosure',
    source: 'Fla. Stat. §456.057',
    lastVerified: V, tags: ['state-statute', 'florida', 'patient-confidentiality'], jurisdiction: 'FL',
  },

  // ─── NPDB + healthcare registries + state boards ─────────────────────
  {
    id: 'npdb-hipdb',
    quote: 'National Practitioner Data Bank (NPDB, 45 CFR Part 60) — healthcare practitioner adverse action repository; hospitals required to query NPDB at appointment, reappointment, and clinical privilege grants; mandatory reporting of adverse privilege actions lasting 30+ days',
    source: 'NPDB (45 CFR Part 60)',
    lastVerified: V, tags: ['federal-registry', 'healthcare', 'practitioner-data'], jurisdiction: 'federal',
  },
  {
    id: 'oig-leie',
    quote: 'OIG List of Excluded Individuals/Entities (LEIE) — authoritative federal source for healthcare exclusions; exclusion under 42 U.S.C. §1320a-7 bars Medicare/Medicaid participation',
    source: 'OIG LEIE (42 U.S.C. §1320a-7)',
    lastVerified: V, tags: ['federal-registry', 'healthcare', 'exclusion'], jurisdiction: 'federal',
  },
  {
    id: 'medical-board-ca',
    quote: 'Medical Board of California (Bus. & Prof. Code §2000 et seq.) — physician licenses 6 digits preceded by letter indicating license type; public verification with disciplinary history',
    source: 'Medical Board of California',
    lastVerified: V, tags: ['state-registry', 'california', 'licensing'], jurisdiction: 'CA',
  },
  {
    id: 'nysed-op',
    quote: 'NY State Education Department Office of the Professions — issues physician, nursing, and allied-health professional licenses; 6-digit license numbers, verifiable via public verification portal',
    source: 'NYSED Office of the Professions',
    lastVerified: V, tags: ['state-registry', 'new-york', 'licensing'], jurisdiction: 'NY',
  },

  // ─── Substance Use — 42 CFR Part 2 ───────────────────────────────────
  {
    id: 'part-2',
    quote: '42 CFR Part 2 — Confidentiality of Substance Use Disorder Patient Records: stricter than HIPAA for federally assisted SUD treatment programs; written consent required for most disclosures even for TPO; 2024 amendments aligned more closely with HIPAA but maintain stricter protections',
    source: '42 CFR Part 2 (SUD confidentiality)',
    lastVerified: V, tags: ['regulation', 'substance-use', 'part-2'], jurisdiction: 'federal',
  },

  // ─── HIPAA + FCRA intersection ───────────────────────────────────────
  {
    id: 'hipaa-employment-records',
    quote: '45 CFR 160.103 — PHI definition excludes "employment records held by a covered entity in its role as employer"; hiring-related background checks and workplace drug testing fall outside HIPAA when held by employer HR function',
    source: '45 CFR 160.103 (employment records exception)',
    lastVerified: V, tags: ['regulation', 'employment-records', 'fcra-intersection'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-hipaa-intersection',
    quote: 'When a CRA performs medical or drug testing verification, the CRA is a HIPAA Business Associate if acting for a covered entity; employer-requested testing outside CE relationship is FCRA-only. Cross-border uses require both HIPAA authorization and FCRA §604(b) procedure',
    source: 'HIPAA + FCRA intersection analysis',
    lastVerified: V, tags: ['cross-regulation', 'fcra-hipaa'], jurisdiction: 'federal',
  },

  // ─── Telehealth + emerging ───────────────────────────────────────────
  {
    id: 'hipaa-telehealth-2020',
    quote: 'OCR Notification of Enforcement Discretion for Telehealth (March 2020, expired 2023) — during COVID-19 PHE, OCR permitted use of non-BAA-compliant video conferencing for telehealth; post-PHE, full Security Rule compliance resumed',
    source: 'OCR Telehealth Enforcement Discretion (2020-2023)',
    lastVerified: V, tags: ['ocr-guidance', 'telehealth', 'covid'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-part-2-amendment-2024',
    quote: '42 CFR Part 2 (2024 amendments, effective February 2024) — aligned Part 2 consent with HIPAA for TPO; allowed Part 2 records in combined records with non-Part 2 records subject to safeguards; new civil and criminal penalty tiers aligned with HIPAA',
    source: '42 CFR Part 2 (2024 amendment)',
    lastVerified: V, tags: ['regulation', 'part-2', '2024-amendment'], jurisdiction: 'federal',
  },

  // ─── Workforce + training (45 CFR 164.308(a)(5)) ─────────────────────
  {
    id: 'hipaa-sanction-policy',
    quote: '45 CFR 164.308(a)(1)(ii)(C) — sanction policy (required): apply appropriate sanctions against workforce members who fail to comply with security policies and procedures',
    source: '45 CFR 164.308(a)(1)(ii)(C) (sanctions)',
    lastVerified: V, tags: ['regulation', 'security-rule', 'sanctions'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-workforce-training-2023',
    quote: 'OCR FAQ (2023) — HIPAA training frequency: at initial onboarding for new workforce members, when there are material changes to policies or procedures, and at least periodically (annual is common industry practice, not statutorily required)',
    source: 'OCR FAQ Training (2023)',
    lastVerified: V, tags: ['ocr-guidance', 'training', 'frequency'], jurisdiction: 'federal',
  },

  // ─── Specialized records categories ──────────────────────────────────
  {
    id: 'hipaa-genetic',
    quote: '45 CFR 164.501 (GINA-related) — genetic information is PHI when held by CE; GINA separately prohibits use of genetic information for underwriting or employment decisions; combined framework requires specific attention',
    source: '45 CFR 164 (GINA integration)',
    lastVerified: V, tags: ['regulation', 'genetic-info', 'gina'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-reproductive-2024',
    quote: '2024 HIPAA Rule on Reproductive Health Privacy (89 Fed. Reg. 32976) — strengthens privacy for reproductive health information; prohibits CE disclosure of PHI for investigation or prosecution of lawful reproductive health care',
    source: 'HIPAA Reproductive Health Rule (2024)',
    lastVerified: V, tags: ['regulation', 'reproductive-health', '2024-rule'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-minor',
    quote: '45 CFR 164.502(g) — personal representative rules for minors: generally parent or guardian; but state law may give minor rights over their own health information for certain services (reproductive, mental health, substance use)',
    source: '45 CFR 164.502(g) (minors)',
    lastVerified: V, tags: ['regulation', 'minors', 'personal-representative'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-deceased',
    quote: '45 CFR 164.502(f) — deceased individuals: PHI of deceased persons protected for 50 years after death; executor or administrator acts as personal representative',
    source: '45 CFR 164.502(f) (deceased)',
    lastVerified: V, tags: ['regulation', 'deceased', '50-year'], jurisdiction: 'federal',
  },

  // ─── Access fees + portable access ───────────────────────────────────
  {
    id: 'hipaa-access-fees',
    quote: '45 CFR 164.524(c)(4) — fee for copies: reasonable cost-based fee including labor for creating the copy, supplies, and postage; flat per-page fees generally not compliant; electronic access at no cost is increasingly the norm',
    source: '45 CFR 164.524(c)(4) (access fees)',
    lastVerified: V, tags: ['regulation', 'access', 'fees'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-api-access-2024',
    quote: 'ONC Cures Act Final Rule (45 CFR 170) — API-based patient access to EHI; covered entities must provide API-enabled access without unreasonable barriers; information blocking prohibited',
    source: 'ONC Cures Act Final Rule (45 CFR 170)',
    lastVerified: V, tags: ['regulation', 'api-access', 'interoperability'], jurisdiction: 'federal',
  },

  // ─── Employee health (HR-side nuances) ───────────────────────────────
  {
    id: 'hipaa-workplace-wellness',
    quote: 'EEOC ADA + HIPAA analysis on workplace wellness: voluntary wellness programs may collect health info but must be voluntary; PHI held by CE as employer is excluded from HIPAA but still ADA-restricted',
    source: 'EEOC + HIPAA workplace wellness framework',
    lastVerified: V, tags: ['cross-regulation', 'workplace-wellness'], jurisdiction: 'federal',
  },
  {
    id: 'ada-medical-exam',
    quote: '42 USC §12112(d) (ADA) — pre-offer medical exams prohibited; post-offer medical exams permitted if required of all entering employees in the job category; medical records confidentially maintained separately',
    source: 'ADA §12112(d) (medical exams)',
    lastVerified: V, tags: ['ada', 'employment-medical'], jurisdiction: 'federal',
  },
  {
    id: 'ginetic-nondiscrim',
    quote: 'Genetic Information Nondiscrimination Act (GINA) of 2008 — prohibits use of genetic information in employment decisions and health insurance underwriting; limited exceptions for wellness programs with voluntary participation',
    source: 'GINA 2008',
    lastVerified: V, tags: ['statute', 'gina', 'genetic'], jurisdiction: 'federal',
  },

  // ─── State breach overlays ───────────────────────────────────────────
  {
    id: 'state-breach-matrix',
    quote: 'State breach notification laws: California (Cal. Civ. Code §1798.82), New York (SHIELD Act), Texas (Tex. Bus. & Com. Code §521.053), Florida (Fla. Stat. §501.171), Massachusetts (M.G.L. c. 93H) — each has distinct notification timelines, thresholds, and content requirements in addition to HIPAA',
    source: 'State breach notification matrix',
    lastVerified: V, tags: ['state-statute', 'breach', 'multi-state'], jurisdiction: 'federal+state',
  },
];

/**
 * Lookup helpers.
 */
export function hipaaSource(id: string): IntelligenceSource {
  const s = HIPAA_SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`HIPAA source id not found: ${id}`);
  return s;
}

export function hipaaCitation(id: string) {
  const s = hipaaSource(id);
  return { record_id: s.id, quote: s.quote, source: s.source };
}
