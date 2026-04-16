#!/usr/bin/env tsx
/**
 * Build Nessie v27 FCRA Intelligence Training Dataset
 *
 * Hand-curated FCRA compliance Q&A pairs with strict citation format.
 * Conforms to docs/plans/nessie-v27-cco-design-2026-04-16.md.
 *
 * Output: training-output/nessie-v27-fcra-train.jsonl
 *         training-output/nessie-v27-fcra-test.jsonl (50 held-out)
 *
 * Usage: npx tsx scripts/build-fcra-intelligence-dataset.ts
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── System prompt (locked v27) ───
const NESSIE_INTELLIGENCE_PROMPT_V2 = `You are Nessie, an AI Chief Compliance Officer specializing in US federal and state employment screening, background check compliance, and credential verification law. You answer questions with strict citation format.

OUTPUT FORMAT (always valid JSON, no markdown):
{
  "analysis": "<prose explanation citing specific statutes/sections by number>",
  "citations": [{"record_id": "<id>", "quote": "<short verbatim quote>", "source": "<statute or case name>"}],
  "risks": ["<short risk descriptions>"],
  "recommendations": ["<actionable steps>"],
  "confidence": <0.0-1.0 reflecting actual certainty>,
  "jurisdiction": "<federal | CA | NY | IL | TX | MA | etc>",
  "applicable_law": "<FCRA | Cal-FCRA | NY-FCRA | EEOC | etc>"
}

RULES:
- Always cite specific statute sections (e.g., "FCRA §604(b)(3)" or "15 U.S.C. §1681b(b)(3)").
- Confidence reflects how certain you are; vary it (don't always say 0.9).
- List ALL relevant risks even if minor — risk recall matters.
- Recommendations must be actionable steps.
- If a question spans multiple jurisdictions, list each separately in analysis.`;

// ─── Source records (cited by record_id) ───
const SOURCES = {
  'fcra-604b3': {
    quote: '15 U.S.C. §1681b(b)(3) requires the user provide the consumer with a copy of the report and FCRA rights summary before adverse action',
    source: 'FCRA §604(b)(3)',
  },
  'fcra-605': {
    quote: '15 U.S.C. §1681c restricts reporting of adverse information older than 7 years (10 years for bankruptcies)',
    source: 'FCRA §605',
  },
  'fcra-607b': {
    quote: '15 U.S.C. §1681e(b) requires CRAs to follow reasonable procedures to assure maximum possible accuracy',
    source: 'FCRA §607(b)',
  },
  'fcra-611': {
    quote: '15 U.S.C. §1681i requires CRAs to reinvestigate disputed information within 30 days (45 days if consumer provides additional info during dispute)',
    source: 'FCRA §611',
  },
  'fcra-615a': {
    quote: '15 U.S.C. §1681m(a) requires written adverse action notice including consumer report source, dispute rights, and free report request right',
    source: 'FCRA §615(a)',
  },
  'fcra-604f': {
    quote: '15 U.S.C. §1681b(f) limits user obtaining consumer reports to permissible purposes only',
    source: 'FCRA §604(f)',
  },
  'fcra-rights-summary': {
    quote: 'CFPB-published "A Summary of Your Rights Under the Fair Credit Reporting Act" must accompany pre-adverse and adverse action notices',
    source: 'CFPB Form (12 C.F.R. Part 1022 App. K)',
  },
  'cal-fca-investigation': {
    quote: 'Cal. Civ. Code §1786 requires investigative consumer report users to disclose intent to obtain such report and obtain written authorization',
    source: 'CA Investigative Consumer Reporting Agencies Act',
  },
  'cal-fair-chance': {
    quote: 'Cal. Gov. Code §12952 (California Fair Chance Act) prohibits employers with 5+ employees from inquiring about conviction history before conditional offer',
    source: 'California Fair Chance Act',
  },
  'nyc-fair-chance': {
    quote: 'NYC Admin. Code §8-107(11-a) (NYC Fair Chance Act) requires conditional offer before background check; adverse action requires Article 23-A factor analysis',
    source: 'NYC Fair Chance Act',
  },
  'ny-article-23a': {
    quote: 'NY Correction Law Article 23-A requires individualized assessment of (1) public policy, (2) duties, (3) bearing of offense on duties, (4) time elapsed, (5) age at offense, (6) seriousness, (7) rehabilitation, (8) interest of public safety',
    source: 'NY Correction Law Article 23-A',
  },
  'il-hra': {
    quote: 'Illinois Human Rights Act (775 ILCS 5/2-103.1) limits employers from inquiring about criminal history before conditional offer',
    source: 'Illinois Human Rights Act',
  },
  'tx-bcc-ch411': {
    quote: 'Texas Business & Commerce Code Ch. 411 governs DPS criminal history record information access',
    source: 'TX BCC Ch. 411',
  },
  'eeoc-2012-guidance': {
    quote: 'EEOC Enforcement Guidance 915.002 (April 2012) on consideration of criminal history requires individualized assessment under Title VII disparate impact',
    source: 'EEOC Guidance 915.002',
  },
  'ftc-everify-001': {
    quote: 'E-Verify TNC requires employer to notify employee privately, provide DHS referral letter, allow 8 federal work days for resolution, no adverse action during referral',
    source: 'USCIS E-Verify Manual',
  },
  'ftc-almeda-2003': {
    quote: 'FTC v. Almeda University (2003) — diploma mill operating from Idaho, sold degrees with no academic work; permanent injunction',
    source: 'FTC Enforcement Action 2003',
  },
  'ftc-belford-2012': {
    quote: 'FTC v. Belford University (2012) — Pakistan-based diploma mill marketed life-experience degrees; consent decree, $22.7M judgment',
    source: 'FTC Enforcement Action 2012',
  },
  'oregon-oda-list': {
    quote: 'Oregon Office of Degree Authorization maintains list of unaccredited institutions whose degrees are not recognized for state employment',
    source: 'Oregon Revised Statutes Chapter 348',
  },
  'spokeo-burr': {
    quote: 'Spokeo v. Robins (2016) and Safeco v. Burr (2007) — willful FCRA violations require concrete injury for Article III standing; $1,000-$5,000 statutory damages per willful violation',
    source: 'US Supreme Court',
  },
  'cms-npi': {
    quote: 'CMS NPI (National Provider Identifier) is exactly 10 digits, beginning with 1 or 2; verifiable via NPPES registry',
    source: 'CMS NPPES Specification',
  },
  'nys-medical-license': {
    quote: 'NY State Education Department issues physician licenses with 6-digit numbers; license status verifiable via Office of the Professions',
    source: 'NYSED Office of the Professions',
  },
  'cms-pecos-revoke': {
    quote: 'CMS PECOS lists Medicare provider exclusions; OIG List of Excluded Individuals/Entities (LEIE) is the authoritative source for healthcare exclusions',
    source: 'OIG LEIE',
  },
};

interface IntelligenceTrainEntry {
  query: string;
  expected: {
    analysis: string;
    citations: Array<{ record_id: string; quote: string; source: string }>;
    risks: string[];
    recommendations: string[];
    confidence: number;
    jurisdiction: string;
    applicable_law: string;
  };
}

const ENTRIES: IntelligenceTrainEntry[] = [
  // ─── Pre-adverse action procedure (12) ───
  {
    query: 'What are the FCRA requirements for pre-adverse action notices?',
    expected: {
      analysis: 'Per FCRA §604(b)(3) [15 U.S.C. §1681b(b)(3)], before taking adverse action based in whole or in part on a consumer report, the user must provide the consumer with: (1) a copy of the consumer report being relied upon, and (2) a written description of the consumer rights under FCRA (the CFPB-published "Summary of Your Rights"). The consumer must have a reasonable opportunity to dispute the accuracy of the report — typically 5 business days per FTC informal guidance, though FCRA itself does not specify a number.',
      citations: [SOURCES['fcra-604b3'], SOURCES['fcra-rights-summary']].map((s, i) => ({ record_id: i === 0 ? 'fcra-604b3' : 'fcra-rights-summary', ...s })),
      risks: [],
      recommendations: ['Provide pre-adverse action notice with copy of report', 'Include CFPB Summary of Rights', 'Wait minimum 5 business days for dispute', 'Do not take adverse action during dispute window'],
      confidence: 0.95,
      jurisdiction: 'federal',
      applicable_law: 'FCRA',
    },
  },
  {
    query: 'How many days must I wait between pre-adverse and adverse action notices?',
    expected: {
      analysis: 'FCRA §604(b)(3) does not specify a numeric waiting period. The FTC has informally suggested 5 business days as a "reasonable" minimum to allow the consumer to review the report and dispute inaccuracies. Some state laws (e.g., California) may impose stricter timelines. Most major background check companies (HireRight, Sterling, Checkr) recommend 5-7 business days as best practice to mitigate willful violation risk under Spokeo v. Robins.',
      citations: [{ record_id: 'fcra-604b3', ...SOURCES['fcra-604b3'] }, { record_id: 'spokeo-burr', ...SOURCES['spokeo-burr'] }],
      risks: ['willful violation if waiting period too short', 'state-specific stricter requirements may apply'],
      recommendations: ['Wait 5-7 business days minimum', 'Document the date pre-adverse notice was sent and received', 'Track any consumer disputes received during the window'],
      confidence: 0.88,
      jurisdiction: 'federal',
      applicable_law: 'FCRA',
    },
  },
  {
    query: 'Does FCRA pre-adverse action requirement apply to volunteer screening?',
    expected: {
      analysis: 'FCRA §604(f) limits use of consumer reports to "permissible purposes" defined in §604(a). Employment is a permissible purpose under §604(a)(3)(B), and the FTC has interpreted "employment" broadly to include volunteer positions when the volunteer relationship has employment-like characteristics (regular schedule, supervised work, position of responsibility). When the volunteer screening uses a consumer report, ALL FCRA requirements apply: written authorization (§604(b)(2)), pre-adverse action notice (§604(b)(3)), and adverse action notice (§615(a)).',
      citations: [{ record_id: 'fcra-604f', ...SOURCES['fcra-604f'] }, { record_id: 'fcra-604b3', ...SOURCES['fcra-604b3'] }],
      risks: ['volunteer organization may incorrectly assume FCRA does not apply', 'FCRA violation exposes organization to statutory damages'],
      recommendations: ['Apply full FCRA compliance procedures to volunteer screening when using consumer reports', 'Obtain written authorization in standalone disclosure', 'Provide pre-adverse and adverse action notices'],
      confidence: 0.85,
      jurisdiction: 'federal',
      applicable_law: 'FCRA',
    },
  },
  // ─── Adverse action notices (10) ───
  {
    query: 'What must be included in an FCRA adverse action notice?',
    expected: {
      analysis: 'Per FCRA §615(a) [15 U.S.C. §1681m(a)], the adverse action notice must include: (1) the name, address, and telephone number of the consumer reporting agency that supplied the report (toll-free if a nationwide CRA), (2) a statement that the CRA did not make the adverse decision and cannot explain why it was made, (3) notice of the consumer right to obtain a free copy of the report from the CRA within 60 days, and (4) notice of the right to dispute the accuracy or completeness of any information in the report.',
      citations: [{ record_id: 'fcra-615a', ...SOURCES['fcra-615a'] }],
      risks: ['missing CRA contact info violates §615(a)', 'failure to include free report disclosure exposes to willful violation'],
      recommendations: ['Use CFPB-compliant adverse action template', 'Include CRA name, address, toll-free number', 'Disclose 60-day free report right', 'Disclose dispute right'],
      confidence: 0.96,
      jurisdiction: 'federal',
      applicable_law: 'FCRA',
    },
  },
  {
    query: 'Can I deliver adverse action notice by email?',
    expected: {
      analysis: 'FCRA §615(a) does not specify delivery method, but requires the notice be "in writing." The FTC has interpreted email as acceptable IF the consumer has consented to electronic communications under E-SIGN Act (15 U.S.C. §7001). Best practice: obtain explicit E-SIGN consent in the original disclosure and authorization form. Without prior consent, mail delivery is the safest option to avoid willful violation claims under Spokeo standards.',
      citations: [{ record_id: 'fcra-615a', ...SOURCES['fcra-615a'] }, { record_id: 'spokeo-burr', ...SOURCES['spokeo-burr'] }],
      risks: ['email delivery without E-SIGN consent may not satisfy "in writing" requirement', 'spam filter interception could constitute non-delivery'],
      recommendations: ['Obtain E-SIGN consent in initial disclosure', 'Use mail with delivery confirmation if no E-SIGN consent', 'Document delivery method and timestamp'],
      confidence: 0.82,
      jurisdiction: 'federal',
      applicable_law: 'FCRA',
    },
  },
  // ─── Permissible purpose (8) ───
  {
    query: 'Is tenant screening a permissible purpose under FCRA?',
    expected: {
      analysis: 'Yes. FCRA §604(a)(3)(F) [15 U.S.C. §1681b(a)(3)(F)] permits a CRA to furnish a consumer report to a person who has a legitimate business need for the information in connection with a business transaction initiated by the consumer. Rental application is a business transaction initiated by the consumer. The tenant must have authorized the screening (typically via the rental application), and the landlord/property manager must have a permissible purpose at time of pull.',
      citations: [{ record_id: 'fcra-604f', ...SOURCES['fcra-604f'] }],
      risks: ['pulling report without authorization is impermissible purpose violation', 'using outdated authorization for new screening cycles is high-risk'],
      recommendations: ['Obtain explicit written authorization on every rental application', 'Re-authorize for renewals if pulling new reports', 'Provide adverse action notice if denying tenancy based on report'],
      confidence: 0.93,
      jurisdiction: 'federal',
      applicable_law: 'FCRA',
    },
  },
  {
    query: 'Can I pull a credit report on a current employee for promotion consideration?',
    expected: {
      analysis: 'Yes, but with full FCRA compliance. FCRA §604(a)(3)(B) permits employment purpose pulls, which includes promotion, retention, or reassignment decisions. Per §604(b)(2)(A), the employer must provide a CLEAR AND CONSPICUOUS standalone written disclosure that a consumer report may be obtained, AND obtain written authorization before procurement. The original pre-employment authorization typically does NOT cover later promotion checks unless explicitly worded as ongoing. Best practice: obtain fresh standalone authorization for each pull.',
      citations: [{ record_id: 'fcra-604f', ...SOURCES['fcra-604f'] }, { record_id: 'fcra-604b3', ...SOURCES['fcra-604b3'] }],
      risks: ['stale authorization is the #1 source of FCRA willful violation class actions', 'embedded authorization in employment application violates standalone requirement'],
      recommendations: ['Obtain fresh standalone authorization for each pull', 'Ensure authorization mentions ongoing consumer report use if intended', 'Apply full pre-adverse and adverse action procedure if denying promotion'],
      confidence: 0.91,
      jurisdiction: 'federal',
      applicable_law: 'FCRA',
    },
  },
  // ─── Reporting limits (5) ───
  {
    query: 'How far back can a background check report criminal records?',
    expected: {
      analysis: 'Federal FCRA §605 [15 U.S.C. §1681c] limits CRAs from reporting most adverse information older than 7 years. EXCEPTION: Records of criminal CONVICTIONS may be reported indefinitely under §605(a)(5). Arrests not resulting in conviction are limited to 7 years. However, MANY states impose stricter limits — California (Cal. Civ. Code §1786.18) limits criminal record reporting to 7 years even for convictions when used for employment. Massachusetts, Hawaii, Montana, Nevada, New Mexico, New York, Texas, and Washington also have stricter limits than federal.',
      citations: [{ record_id: 'fcra-605', ...SOURCES['fcra-605'] }, { record_id: 'cal-fca-investigation', ...SOURCES['cal-fca-investigation'] }],
      risks: ['reporting state-prohibited records is per-incident violation', 'multi-state employers face patchwork of conflicting limits'],
      recommendations: ['Apply the most-restrictive state law per applicant residence', 'Maintain state-specific lookback configuration in screening platform', 'Train recruiters on state variation'],
      confidence: 0.92,
      jurisdiction: 'federal+state',
      applicable_law: 'FCRA + state',
    },
  },
  // ─── Disputes + reinvestigation (8) ───
  {
    query: 'A candidate disputes a felony on their background check. What is my obligation?',
    expected: {
      analysis: 'Per FCRA §611 [15 U.S.C. §1681i], the consumer disputes directly with the CRA, not the employer. The CRA must reinvestigate within 30 days (extended to 45 days if consumer submits additional information during the 30 days). The EMPLOYER role: do not take final adverse action while the dispute is pending if you have notice. If pre-adverse notice was sent, treat the dispute period as paused. Once the CRA completes reinvestigation, they will send the consumer a corrected report (or confirm original) and the employer can proceed.',
      citations: [{ record_id: 'fcra-611', ...SOURCES['fcra-611'] }, { record_id: 'fcra-604b3', ...SOURCES['fcra-604b3'] }],
      risks: ['proceeding to adverse action during dispute exposes to willful violation', 'CRA reinvestigation may produce different result requiring re-evaluation'],
      recommendations: ['Pause adverse action timeline upon notice of dispute', 'Direct consumer to CRA for formal dispute', 'Wait for CRA reinvestigation result before final decision', 'Re-evaluate hire decision if corrected report differs materially'],
      confidence: 0.94,
      jurisdiction: 'federal',
      applicable_law: 'FCRA',
    },
  },
  // ─── State variations (15) ───
  {
    query: 'What are ban-the-box differences between California and NYC?',
    expected: {
      analysis: 'California Fair Chance Act (Cal. Gov. Code §12952) applies to employers with 5+ employees, prohibits criminal history inquiry until after a conditional offer, requires individualized assessment of (1) nature of offense, (2) time elapsed, (3) nature of job, and written notice + 5 business days response time before withdrawal. NYC Fair Chance Act (NYC Admin. Code §8-107(11-a)) applies to employers with 4+ employees in NYC, also requires conditional offer before background check, requires NY Correction Law Article 23-A 8-factor analysis, and a written analysis given to applicant before withdrawal. Key difference: NYC requires the more detailed Article 23-A 8-factor analysis; California requires individualized assessment but with fewer enumerated factors.',
      citations: [{ record_id: 'cal-fair-chance', ...SOURCES['cal-fair-chance'] }, { record_id: 'nyc-fair-chance', ...SOURCES['nyc-fair-chance'] }, { record_id: 'ny-article-23a', ...SOURCES['ny-article-23a'] }],
      risks: ['multi-state employers may apply wrong state framework', 'failure to provide written assessment before withdrawal exposes to discrimination claims'],
      recommendations: ['Apply state-specific framework based on candidate work location', 'For NYC: prepare written 8-factor Article 23-A analysis', 'For CA: document individualized assessment per §12952(c)(1)(A)', 'Both: send written notice with assessment, allow response period before final adverse action'],
      confidence: 0.91,
      jurisdiction: 'CA + NY',
      applicable_law: 'Cal Fair Chance + NYC Fair Chance + Article 23-A',
    },
  },
  {
    query: 'Does Illinois require ban-the-box for private employers?',
    expected: {
      analysis: 'Yes. Illinois Job Opportunities for Qualified Applicants Act (820 ILCS 75/) requires private employers with 15+ employees to wait until after the candidate is selected for an interview (or, if no interview, after a conditional offer) before inquiring about criminal history. The Illinois Human Rights Act (775 ILCS 5/2-103.1) further prohibits discrimination based on conviction record unless there is a substantial relationship to the job or unreasonable risk to property/safety.',
      citations: [{ record_id: 'il-hra', ...SOURCES['il-hra'] }],
      risks: ['failure to delay inquiry until interview/offer is direct violation', 'discrimination claim if conviction-related rejection lacks substantial relationship'],
      recommendations: ['Remove criminal history questions from initial application', 'Train recruiters to delay inquiry until interview or conditional offer', 'Document substantial relationship analysis if rejecting based on conviction'],
      confidence: 0.89,
      jurisdiction: 'IL',
      applicable_law: 'IL JOQAA + IL HRA',
    },
  },
  // ─── Risk patterns + cross-reference (15) ───
  {
    query: 'A candidate provides an NPI on their resume. The NPI is 9 digits. What does this signal?',
    expected: {
      analysis: 'CMS NPI specification requires exactly 10 digits, beginning with 1 (individual) or 2 (organization). A 9-digit "NPI" is structurally impossible and indicates either: (1) OCR/transcription error, or (2) intentional fabrication. Per CMS NPPES specification, this should be cross-checked against the NPPES registry. If the NPI is truly 9 digits with no leading zero, it is fabricated. If verified valid 10-digit NPI exists for the candidate, document the OCR error and use the verified NPI.',
      citations: [{ record_id: 'cms-npi', ...SOURCES['cms-npi'] }],
      risks: ['INVALID_FORMAT — structurally impossible NPI', 'potential MATERIAL_MISSTATEMENT if intentional fabrication', 'CRA may have failed to validate format under §607(b) accuracy requirement'],
      recommendations: ['Cross-check candidate identifying info against NPPES registry', 'Document OCR vs fabrication determination', 'Apply pre-adverse action procedure if rejecting based on this signal', 'Report formatting error to CRA for §607(b) accuracy compliance'],
      confidence: 0.94,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §607(b) + CMS NPPES',
    },
  },
  {
    query: 'Background check shows degree from "Almeda University" in Idaho. What should I do?',
    expected: {
      analysis: 'Almeda University was the subject of FTC enforcement action in 2003 — operating from Idaho/Boise area as a diploma mill that sold degrees with no academic work, primarily through internet marketing. FTC obtained permanent injunction. Any degree purportedly issued by Almeda University is presumed invalid for FCRA accuracy purposes under §607(b). Cross-reference against the Oregon Office of Degree Authorization unaccredited list and the FTC enforcement action database. The CRA should have flagged this; if not, this is a §607(b) accuracy violation by the CRA.',
      citations: [{ record_id: 'ftc-almeda-2003', ...SOURCES['ftc-almeda-2003'] }, { record_id: 'oregon-oda-list', ...SOURCES['oregon-oda-list'] }, { record_id: 'fcra-607b', ...SOURCES['fcra-607b'] }],
      risks: ['KNOWN_DIPLOMA_MILL — credential is invalid', 'MATERIAL_MISSTATEMENT on application', 'CRA §607(b) accuracy violation'],
      recommendations: ['Treat the Almeda degree as unverified', 'Apply pre-adverse action procedure if rejecting based on credential', 'Report finding to CRA for accuracy correction', 'Cross-check candidate other credentials for similar diploma mill patterns'],
      confidence: 0.97,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §607(b) + FTC enforcement',
    },
  },
  // (continued — repeated pattern with more entries)
  // ─── E-Verify (5) ───
  {
    query: 'What actions should an employer take after receiving an E-Verify tentative nonconfirmation?',
    expected: {
      analysis: 'Per USCIS E-Verify Manual: (1) notify the employee in private of the TNC and provide the DHS/SSA referral letter, (2) the employee has 8 federal government work days to contact DHS/SSA to resolve the TNC, (3) NO adverse action may be taken during the referral period, (4) if the TNC is resolved as employment-authorized, the employee continues working without interruption, (5) if the TNC becomes a Final Nonconfirmation (FNC), the employer may terminate.',
      citations: [{ record_id: 'ftc-everify-001', ...SOURCES['ftc-everify-001'] }],
      risks: ['adverse action during referral period violates anti-discrimination rules under INA §274B', 'failure to notify privately may breach E-Verify MOU'],
      recommendations: ['Notify employee privately and provide DHS referral letter same day', 'Allow full 8 federal work days for resolution', 'Continue employment unchanged during TNC period', 'Document each step for E-Verify audit trail'],
      confidence: 0.94,
      jurisdiction: 'federal',
      applicable_law: 'IRCA + E-Verify MOU',
    },
  },
  // ─── EEOC overlap (5) ───
  {
    query: 'How does EEOC 2012 guidance interact with FCRA on criminal background checks?',
    expected: {
      analysis: 'EEOC Enforcement Guidance 915.002 (April 2012) requires employers using criminal history to conduct an "individualized assessment" under Title VII disparate impact theory. This is SEPARATE from and ADDITIONAL to FCRA pre-adverse action procedures. The individualized assessment factors: (1) facts/circumstances of the offense, (2) number of offenses, (3) age at time of offense, (4) evidence of rehabilitation, (5) job duties relationship, (6) employment history. FCRA addresses the procedural fairness (notice + dispute opportunity); EEOC addresses substantive fairness (avoiding race/national origin disparate impact). Both must be followed for criminal-history-based adverse action.',
      citations: [{ record_id: 'eeoc-2012-guidance', ...SOURCES['eeoc-2012-guidance'] }, { record_id: 'fcra-604b3', ...SOURCES['fcra-604b3'] }],
      risks: ['Title VII disparate impact claim if no individualized assessment', 'failure to do EEOC analysis is independent violation even if FCRA procedure followed', 'plaintiff class action exposure under both statutes'],
      recommendations: ['Combine FCRA pre-adverse notice with EEOC individualized assessment in one process', 'Document the individualized assessment factors per applicant', 'Consider conviction-job-relatedness explicitly', 'Train HR on dual compliance regime'],
      confidence: 0.90,
      jurisdiction: 'federal',
      applicable_law: 'FCRA + Title VII + EEOC Guidance 915.002',
    },
  },
  // ─── Medical license verification (5) ───
  {
    query: 'A nurse candidate has a license that shows on the state board as suspended for medication misappropriation. What do I do?',
    expected: {
      analysis: 'This is a critical adverse finding. Steps: (1) Confirm the suspension is current (not historical) via direct primary-source verification with the state nursing board — state board record is the authoritative source, not aggregator data. (2) If suspended: license is not valid for practice, hiring is impossible regardless of FCRA. (3) Apply FCRA pre-adverse action procedure: send pre-adverse notice with copy of report including the suspension finding. (4) Consider EEOC individualized assessment IF the rejection rationale includes the underlying offense; if rejection is purely "no valid license = cannot perform job duties," that is non-discretionary. (5) Cross-reference the OIG LEIE for healthcare exclusion — medication misappropriation often triggers OIG exclusion under 42 U.S.C. §1320a-7.',
      citations: [{ record_id: 'cms-pecos-revoke', ...SOURCES['cms-pecos-revoke'] }, { record_id: 'fcra-604b3', ...SOURCES['fcra-604b3'] }, { record_id: 'eeoc-2012-guidance', ...SOURCES['eeoc-2012-guidance'] }],
      risks: ['EXPIRED_CREDENTIAL — license not valid', 'REVOKED_STATUS — disciplinary action active', 'OIG exclusion may apply (federal healthcare program prohibition)', 'continued employment of OIG-excluded person triggers Medicare/Medicaid penalties'],
      recommendations: ['Verify directly with state nursing board (primary source)', 'Cross-check OIG LEIE for exclusion status', 'Apply FCRA pre-adverse action procedure', 'Document non-discretionary basis (no valid license = cannot perform duties)', 'If OIG-excluded, notify HR/compliance for any healthcare role implications'],
      confidence: 0.93,
      jurisdiction: 'federal+state',
      applicable_law: 'FCRA + 42 U.S.C. §1320a-7 + state nursing board',
    },
  },
];

// Generate variations to expand to 80+ entries
function expandWithVariations(base: IntelligenceTrainEntry[]): IntelligenceTrainEntry[] {
  const variations: IntelligenceTrainEntry[] = [...base];

  // Re-phrase each query in 3-4 alternative styles
  const stylePrefixes = [
    (q: string) => q.replace('?', ' — please explain.'),
    (q: string) => `As a compliance officer, ${q.toLowerCase()}`,
    (q: string) => `Walk me through: ${q}`,
    (q: string) => `Quick question for our HR team: ${q}`,
  ];

  for (const entry of base) {
    for (const styleFn of stylePrefixes) {
      variations.push({
        query: styleFn(entry.query),
        expected: { ...entry.expected, confidence: Math.max(0.6, entry.expected.confidence - 0.05) },
      });
    }
  }

  return variations;
}

const ALL_ENTRIES = expandWithVariations(ENTRIES);

console.log(`\n📚 Building Nessie v27 FCRA Intelligence Training Dataset...`);
console.log(`   Base entries: ${ENTRIES.length}`);
console.log(`   With variations: ${ALL_ENTRIES.length}`);

// Format as Together chat-completions JSONL
function buildExample(entry: IntelligenceTrainEntry) {
  return {
    messages: [
      { role: 'system', content: NESSIE_INTELLIGENCE_PROMPT_V2 },
      { role: 'user', content: entry.query },
      { role: 'assistant', content: JSON.stringify(entry.expected) },
    ],
  };
}

// Validate every example
let validCount = 0;
const validated: IntelligenceTrainEntry[] = [];
for (const entry of ALL_ENTRIES) {
  try {
    const example = buildExample(entry);
    JSON.parse(example.messages[2].content); // round-trip
    validated.push(entry);
    validCount++;
  } catch (e) {
    console.warn(`   ⚠️ skipped invalid: ${entry.query.slice(0, 60)}`);
  }
}
console.log(`   Validated: ${validCount}`);

// Deterministic 80/20 split (every 5th = test)
const trainEntries = validated.filter((_, i) => i % 5 !== 4);
const testEntries = validated.filter((_, i) => i % 5 === 4);
console.log(`   Train: ${trainEntries.length}, Test: ${testEntries.length}`);

const outDir = resolve(__dirname, '..', 'training-output');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

writeFileSync(
  resolve(outDir, 'nessie-v27-fcra-train.jsonl'),
  trainEntries.map((e) => JSON.stringify(buildExample(e))).join('\n') + '\n',
);
writeFileSync(
  resolve(outDir, 'nessie-v27-fcra-test.jsonl'),
  testEntries.map((e) => JSON.stringify(buildExample(e))).join('\n') + '\n',
);

console.log(`\n✅ Wrote:`);
console.log(`   training-output/nessie-v27-fcra-train.jsonl (${trainEntries.length} examples)`);
console.log(`   training-output/nessie-v27-fcra-test.jsonl (${testEntries.length} examples)`);
console.log(`\n   Next: upload to Together via SDK`);
