/**
 * FERPA Source Registry
 *
 * Anchors for FERPA (Family Educational Rights and Privacy Act) citations.
 * Core statute: 20 USC 1232g. Implementing regulations: 34 CFR Part 99.
 * Additional: PPRA, GEPA, HEA amendments, state education privacy overlays,
 * FERPA-HIPAA boundary, Department of Education enforcement actions.
 */

import type { IntelligenceSource } from '../types';

const V = '2026-04-16';

export const FERPA_SOURCES: IntelligenceSource[] = [
  // ─── Core statute ────────────────────────────────────────────────────
  {
    id: 'ferpa-20-1232g',
    quote: '20 USC 1232g (Family Educational Rights and Privacy Act) — conditions federal education funding on educational agency/institution compliance with privacy and access provisions for student education records',
    source: 'FERPA, 20 USC 1232g',
    url: 'https://www.law.cornell.edu/uscode/text/20/1232g',
    lastVerified: V, tags: ['statute', 'ferpa-core'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-1232g-a',
    quote: '20 USC 1232g(a) — parents of students (or students who have reached 18 or are attending postsecondary) have right to inspect and review education records maintained by the educational agency or institution',
    source: 'FERPA §1232g(a)',
    lastVerified: V, tags: ['statute', 'access-right'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-1232g-b',
    quote: '20 USC 1232g(b) — no federal funds for educational agency/institution that has policy or practice of releasing education records (or personally identifiable information) without written parental consent (or student consent if eligible) except as authorized by specific exceptions',
    source: 'FERPA §1232g(b)',
    lastVerified: V, tags: ['statute', 'disclosure-limit'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-1232g-b-1',
    quote: '20 USC 1232g(b)(1) — permitted disclosures without consent include: (A) school officials with legitimate educational interest, (B) officials of other schools in which the student seeks or intends to enroll, (C) state/federal authorities evaluating federally supported programs, (D) financial aid, (E) studies for or on behalf of educational agencies, (F) accrediting organizations, (G) parents of dependent student, (H) emergency health/safety, (I) judicial order or subpoena, (J) directory information',
    source: 'FERPA §1232g(b)(1)',
    lastVerified: V, tags: ['statute', 'disclosure-exceptions'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-1232g-b-2',
    quote: '20 USC 1232g(b)(2) — disclosures under §(b)(1)(I) judicial order/subpoena must be made only after reasonable effort to notify the parent/student of the order or subpoena, to allow opportunity to seek protective order',
    source: 'FERPA §1232g(b)(2)',
    lastVerified: V, tags: ['statute', 'subpoena-notice'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-1232g-d',
    quote: '20 USC 1232g(d) — for students who have reached 18 years of age or are attending postsecondary institution, the rights of parents transfer to the student (the "eligible student")',
    source: 'FERPA §1232g(d)',
    lastVerified: V, tags: ['statute', 'eligible-student'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-1232g-f',
    quote: '20 USC 1232g(f) — Secretary of Education shall establish office and review board for FERPA enforcement; complaints investigated and may result in withholding of federal funds for institutions with policy or practice of non-compliance',
    source: 'FERPA §1232g(f)',
    lastVerified: V, tags: ['statute', 'enforcement'], jurisdiction: 'federal',
  },

  // ─── 34 CFR Part 99 implementing regulations ─────────────────────────
  {
    id: 'ferpa-99-3-education-record',
    quote: '34 CFR 99.3 — "Education records" means records directly related to a student and maintained by an educational agency/institution, or party acting for such; excludes sole-possession records, law enforcement unit records, employment records, treatment records (medical/mental health records for student 18+), and post-attendance records',
    source: '34 CFR 99.3 (education records definition)',
    lastVerified: V, tags: ['regulation', 'definitions'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-3-pii',
    quote: '34 CFR 99.3 — "Personally identifiable information" (PII) includes: student name, parent/family name, student address, personal identifiers (SSN, student number, biometric record), indirect identifiers (DOB, place of birth, mother\'s maiden name), other information that would make student identity traceable with reasonable certainty',
    source: '34 CFR 99.3 (PII definition)',
    lastVerified: V, tags: ['regulation', 'definitions', 'pii'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-3-school-official',
    quote: '34 CFR 99.31(a)(1) — "School official with legitimate educational interest" must be defined by institution in its annual notification; may include teachers, administrators, contractors serving functions typically performed by school staff; legitimate educational interest must be documented',
    source: '34 CFR 99.31(a)(1) (school official definition)',
    lastVerified: V, tags: ['regulation', 'school-official'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-3-directory',
    quote: '34 CFR 99.3 — "Directory information" means information in education record of student that would not generally be considered harmful or invasion of privacy if disclosed; typically name, address, phone, email, photograph, DOB, place of birth, major field, enrollment status, dates of attendance, degrees and awards received, most recent school attended',
    source: '34 CFR 99.3 (directory information)',
    lastVerified: V, tags: ['regulation', 'directory-info'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-10',
    quote: '34 CFR 99.10 — institution must permit parent or eligible student to inspect and review student education records within reasonable time not to exceed 45 days from request',
    source: '34 CFR 99.10 (access timeline)',
    lastVerified: V, tags: ['regulation', 'access', '45-day'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-20',
    quote: '34 CFR 99.20 — parent or eligible student may seek to amend education record believed to be inaccurate, misleading, or in violation of privacy; institution must consider request, and if denied, offer hearing per §99.21-99.22',
    source: '34 CFR 99.20 (amendment)',
    lastVerified: V, tags: ['regulation', 'amendment'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-30',
    quote: '34 CFR 99.30 — institution must obtain signed written consent from parent or eligible student before disclosing education records, except as specified in §99.31',
    source: '34 CFR 99.30 (consent)',
    lastVerified: V, tags: ['regulation', 'consent'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-31',
    quote: '34 CFR 99.31 — permitted disclosures without consent: school officials with legitimate educational interest, other schools for enrollment, authorized officials evaluating federal programs, financial aid, accrediting, studies for educational agencies, parents of dependent, health/safety emergency, judicial order, directory information, information provided by student',
    source: '34 CFR 99.31 (disclosure exceptions)',
    lastVerified: V, tags: ['regulation', 'disclosure-exceptions'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-31-a-11',
    quote: '34 CFR 99.31(a)(11) — health/safety emergency: disclosure permitted to appropriate parties in connection with emergency where disclosure is necessary to protect health or safety of student or other individuals; institution may determine emergency using facts and circumstances',
    source: '34 CFR 99.31(a)(11) (health/safety emergency)',
    lastVerified: V, tags: ['regulation', 'emergency'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-32',
    quote: '34 CFR 99.32 — institution must maintain record of each request for access to and each disclosure of PII from education records; record must identify parties that requested/received PII and legitimate interest; no requirement to record disclosures to school officials or directory information',
    source: '34 CFR 99.32 (disclosure log)',
    lastVerified: V, tags: ['regulation', 'disclosure-log'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-34',
    quote: '34 CFR 99.34 — conditions on redisclosure: party receiving PII from education records may not redisclose except as permitted by FERPA; institution must inform receiving parties of redisclosure restrictions',
    source: '34 CFR 99.34 (redisclosure)',
    lastVerified: V, tags: ['regulation', 'redisclosure'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-35',
    quote: '34 CFR 99.35 — permits disclosure to studies for or on behalf of schools, school districts, postsecondary institutions, or the Secretary of Education; requires written agreement covering purpose, scope, PII protection, destruction after study',
    source: '34 CFR 99.35 (studies exception)',
    lastVerified: V, tags: ['regulation', 'studies'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-37',
    quote: '34 CFR 99.37 — directory information disclosure: institution may disclose without consent if public notice is given to parents/students of categories designated as directory, right to refuse designation, and period to notify institution of refusal',
    source: '34 CFR 99.37 (directory information disclosure)',
    lastVerified: V, tags: ['regulation', 'directory-info'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-61',
    quote: '34 CFR 99.61 — institution that has policy or practice of releasing PII without consent in violation of FERPA may be subject to federal funds withholding; enforcement process begins with Family Policy Compliance Office (FPCO) investigation',
    source: '34 CFR 99.61 (enforcement)',
    lastVerified: V, tags: ['regulation', 'enforcement'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-62',
    quote: '34 CFR 99.62 — FPCO may investigate complaints alleging violations; institution has right to respond to complaint; if FPCO finds violation, attempts voluntary compliance before seeking enforcement actions',
    source: '34 CFR 99.62 (investigation)',
    lastVerified: V, tags: ['regulation', 'fpco-investigation'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-63',
    quote: '34 CFR 99.63 — remedies available to Secretary include: cease and desist orders, withholding of federal funds, repayment of federal funds, termination of eligibility for federal financial assistance',
    source: '34 CFR 99.63 (remedies)',
    lastVerified: V, tags: ['regulation', 'remedies'], jurisdiction: 'federal',
  },

  // ─── Emerging DoE guidance ───────────────────────────────────────────
  {
    id: 'ferpa-vpic-2008',
    quote: 'DoE FAQ on FERPA (post-Virginia Tech, 2008-2010) — emphasized that health/safety emergency exception permits disclosure based on substantial, articulable threat; institution should not over-rely on exception but should not under-use it when genuine threat exists',
    source: 'DoE FERPA FAQ 2008 (Virginia Tech/Safety)',
    lastVerified: V, tags: ['guidance', 'emergency', 'vpic'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-online-tools',
    quote: 'DoE Guidance (2020) on Online Learning Tools: third-party tools are subject to FERPA if they qualify as "school officials" under annual notification and legitimate educational interest test; schools must carefully vet vendor privacy practices',
    source: 'DoE Online Learning Tools Guidance 2020',
    lastVerified: V, tags: ['guidance', 'online-tools', 'vendor'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-pta-2023',
    quote: 'DoE Privacy Technical Assistance Center (PTAC) Guidance — model annual notification, model directory information notice, model consent forms, best practices for data sharing agreements',
    source: 'DoE PTAC Guidance',
    lastVerified: V, tags: ['guidance', 'ptac', 'templates'], jurisdiction: 'federal',
  },

  // ─── PPRA + GEPA ─────────────────────────────────────────────────────
  {
    id: 'ppra-20-1232h',
    quote: '20 USC 1232h (Protection of Pupil Rights Amendment, PPRA) — parental consent required for surveys funded by DoE seeking information in 8 protected categories (political affiliations, mental health, sex behavior, illegal behavior, critical appraisals of family, legally recognized privileged relationships, religious practices, income)',
    source: 'PPRA, 20 USC 1232h',
    lastVerified: V, tags: ['statute', 'ppra'], jurisdiction: 'federal',
  },
  {
    id: 'gepa-20-1232f',
    quote: '20 USC 1232f (General Education Provisions Act) — record retention requirement: educational agencies/institutions receiving federal funds must maintain records for 3 years after completion of activity or until audit, whichever later',
    source: 'GEPA, 20 USC 1232f',
    lastVerified: V, tags: ['statute', 'gepa', 'retention'], jurisdiction: 'federal',
  },

  // ─── FERPA-HIPAA Boundary ────────────────────────────────────────────
  {
    id: 'ferpa-hipaa-boundary',
    quote: 'DoE/OCR Joint Guidance on FERPA/HIPAA (2008, updated) — education records subject to FERPA are explicitly excluded from HIPAA PHI definition (45 CFR 160.103); K-12 health records are FERPA, not HIPAA; postsecondary treatment records of students 18+ excluded from education records (and may fall under HIPAA if provider is covered entity)',
    source: 'DoE/OCR FERPA-HIPAA Joint Guidance',
    lastVerified: V, tags: ['cross-regulation', 'hipaa-ferpa'], jurisdiction: 'federal',
  },

  // ─── State overlays ──────────────────────────────────────────────────
  {
    id: 'ny-education-2d',
    quote: 'NY Education Law §2-d — student data privacy and security; imposes specific vendor data use restrictions, breach notification requirements, Parents Bill of Rights; stricter than FERPA in many respects',
    source: 'NY Education Law §2-d',
    lastVerified: V, tags: ['state-statute', 'new-york', 'student-data'], jurisdiction: 'NY',
  },
  {
    id: 'ca-sopipa',
    quote: 'Cal. Bus. & Prof. Code §22584 (Student Online Personal Information Protection Act, SOPIPA) — prohibits operators of online educational sites/services from using K-12 student data for targeted advertising or selling student data; restricts use to educational purposes',
    source: 'CA SOPIPA (Bus. & Prof. Code §22584)',
    lastVerified: V, tags: ['state-statute', 'california', 'sopipa'], jurisdiction: 'CA',
  },
  {
    id: 'ca-ab-1584',
    quote: 'Cal. Ed. Code §49073.1 (AB 1584) — school districts must have written contracts with any service provider handling student records; contract must include privacy and security protections, breach notification, destruction at contract end',
    source: 'CA Ed. Code §49073.1',
    lastVerified: V, tags: ['state-statute', 'california', 'vendor-contracts'], jurisdiction: 'CA',
  },
  {
    id: 'il-sopa',
    quote: 'IL Student Online Personal Protection Act (105 ILCS 85) — governs K-12 online educational services; prohibits advertising targeting, selling student data; requires transparent privacy practices; parents have rights re: student data held by operators',
    source: 'IL SOPA (105 ILCS 85)',
    lastVerified: V, tags: ['state-statute', 'illinois', 'student-online'], jurisdiction: 'IL',
  },
  {
    id: 'co-siea',
    quote: 'Colorado Student Data Transparency and Security Act (C.R.S. §22-16) — requires school service provider contracts with specific privacy protections, parent access to student data, breach notification timelines',
    source: 'CO SIEA (C.R.S. §22-16)',
    lastVerified: V, tags: ['state-statute', 'colorado', 'siea'], jurisdiction: 'CO',
  },

  // ─── Court decisions ─────────────────────────────────────────────────
  {
    id: 'owasso-falvo-2002',
    quote: 'Owasso Independent Sch. Dist. v. Falvo, 534 U.S. 426 (2002) — peer grading (students grading other students\' work in classroom) does not create "education records" under FERPA because the papers are not "maintained" by the school',
    source: 'Owasso v. Falvo, 534 U.S. 426 (2002)',
    lastVerified: V, tags: ['case', 'scotus', 'education-record-definition'], jurisdiction: 'federal',
  },
  {
    id: 'gonzaga-doe-2002',
    quote: 'Gonzaga Univ. v. Doe, 536 U.S. 273 (2002) — FERPA does not create private right of action; enforcement mechanism is federal funds withholding through FPCO; plaintiff has no individual damages remedy under FERPA itself',
    source: 'Gonzaga v. Doe, 536 U.S. 273 (2002)',
    lastVerified: V, tags: ['case', 'scotus', 'no-private-right'], jurisdiction: 'federal',
  },
  {
    id: 'fpco-enforcement-examples',
    quote: 'FPCO enforcement history — FPCO investigation findings cover: improper disclosure to third parties (most common), failure to maintain disclosure log, failure to provide access within 45 days, improper use of directory information, inadequate consent forms. Outcomes typically voluntary compliance; fund withholding is rare',
    source: 'FPCO Enforcement Findings',
    lastVerified: V, tags: ['enforcement', 'fpco'], jurisdiction: 'federal',
  },

  // ─── Specialized areas ───────────────────────────────────────────────
  {
    id: 'ferpa-sunshine-state-law',
    quote: 'State sunshine laws may conflict with FERPA — generally FERPA protections supersede state public records laws for education records of individual students, but aggregate non-PII data may be releasable',
    source: 'FERPA-state-sunshine-law interaction',
    lastVerified: V, tags: ['cross-regulation', 'state-sunshine'], jurisdiction: 'federal+state',
  },
  {
    id: 'ferpa-disciplinary-records',
    quote: '20 USC 1232g(b)(6) — disciplinary records may be disclosed to school officials, and to officials of other schools for enrollment; 1998 HEA amendments permit disclosure of final outcomes of disciplinary proceedings involving crimes of violence or non-forcible sex offenses; narrow exception',
    source: 'FERPA §1232g(b)(6) + 1998 HEA',
    lastVerified: V, tags: ['statute', 'disciplinary', 'hea-1998'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-clery-act-intersection',
    quote: 'Clery Act (20 USC 1092(f)) requires postsecondary institutions to disclose campus crime statistics and timely warnings; Clery disclosures do not generally conflict with FERPA because they involve aggregate or safety-related info rather than individual education records',
    source: 'Clery Act + FERPA boundary',
    lastVerified: V, tags: ['cross-regulation', 'clery'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-law-enforcement-unit',
    quote: '34 CFR 99.8 — "law enforcement unit" records: records created by law enforcement unit of agency/institution for law enforcement purpose are NOT education records; distinct from security records created for educational purposes',
    source: '34 CFR 99.8 (law enforcement records exception)',
    lastVerified: V, tags: ['regulation', 'law-enforcement-unit'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-treatment-records',
    quote: '34 CFR 99.3 — postsecondary "treatment records": records made or maintained by a physician, psychiatrist, psychologist, or other recognized professional, made in connection with treatment of a student 18+ who is not a minor; excluded from education records but are education records again if disclosed for other than treatment',
    source: '34 CFR 99.3 (treatment records exception)',
    lastVerified: V, tags: ['regulation', 'treatment-records'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-verification-employment',
    quote: '34 CFR 99.31(a)(11) + 99.37 — degree verification for employment purposes via directory information is permitted without consent if directory information is designated and student has not opted out; verification beyond directory scope requires consent',
    source: 'FERPA degree verification for employment',
    lastVerified: V, tags: ['regulation', 'degree-verification', 'employment'], jurisdiction: 'federal',
  },
  {
    id: 'ferpa-opt-out-scope',
    quote: '34 CFR 99.37(b) — eligible student opt-out of directory information applies to future disclosures until rescinded; institution must honor opt-out at time of request and beyond; no retroactive effect on prior disclosures',
    source: '34 CFR 99.37(b) (opt-out scope)',
    lastVerified: V, tags: ['regulation', 'opt-out'], jurisdiction: 'federal',
  },

  // ─── Cross-regulation sources referenced by advanced scenarios ──────
  {
    id: 'ada-medical-exam',
    quote: '42 USC §12112(d) (ADA) — pre-offer medical exams prohibited; post-offer exams permitted; medical records confidentially maintained separately',
    source: 'ADA §12112(d) (medical exams)',
    lastVerified: V, tags: ['ada', 'employment-medical'], jurisdiction: 'federal',
  },

  // ─── Subpoena + Legal Process ────────────────────────────────────────
  {
    id: 'ferpa-ex-parte-order',
    quote: '20 USC 1232g(b)(1)(J)(ii) — for ex parte court orders (grand jury, law enforcement), institution may comply without parent/student notification; non-ex-parte subpoenas require reasonable notification effort per §1232g(b)(2)',
    source: 'FERPA §1232g(b)(1)(J)(ii) (ex parte)',
    lastVerified: V, tags: ['statute', 'ex-parte-orders'], jurisdiction: 'federal',
  },
];

export function ferpaSource(id: string): IntelligenceSource {
  const s = FERPA_SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`FERPA source id not found: ${id}`);
  return s;
}

export function ferpaCitation(id: string) {
  const s = ferpaSource(id);
  return { record_id: s.id, quote: s.quote, source: s.source };
}
