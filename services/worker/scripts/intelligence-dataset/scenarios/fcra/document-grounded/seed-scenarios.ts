/**
 * NVI-09 — Seed document-grounded FCRA scenarios (SCRUM-813).
 *
 * 16 seed scenarios (2 per corpus entry for 8 documents). Lift via
 * NVI-07 distillation to hit the 150+ target.
 */

import { fcraCitation as c } from '../../../sources/fcra-sources';
import type { DocumentGroundedScenario } from '../../../document-grounded';

export const FCRA_DOC_GROUNDED_SEED: DocumentGroundedScenario[] = [
  // ─── aa-notice-deficient-001 ───
  {
    id: 'dg-aa-deficient-001',
    category: 'adverse-action',
    documentCorpusId: 'aa-notice-deficient-001',
    query: 'Is this adverse-action notice FCRA §615(a)-compliant? If not, what must be added?',
    expected: {
      analysis:
        '§615(a) [15 U.S.C. §1681m(a)] requires four elements in every adverse-action notice when the adverse action is based in whole or in part on a consumer report: (1) explicit notice that adverse action is being taken, (2) the CRA\'s name + address + toll-free number, (3) a statement that the CRA did not make the decision and cannot provide reasons, (4) the consumer\'s right to obtain a free report copy within 60 days and to dispute inaccuracies. This notice provides only (1) and fails on (2), (3), and (4).',
      citations: [c('fcra-615-a'), c('cfpb-summary-of-rights')],
      risks: [
        '§615(a) willful-violation exposure: $100–$1,000 statutory damages per notice, plus attorneys\' fees (§616)',
        'Class-action pattern — defective adverse-action templates are the single most common FCRA class source',
        'Per-notice exposure scales across every affected applicant',
      ],
      recommendations: [
        'Redraft the notice to include CRA name + mailing address + toll-free number',
        'Add the CRA-did-not-decide statement and the 60-day free-report + dispute rights',
        'Attach the CFPB Summary of Your Rights Under the FCRA (long form)',
        'Identify every similar notice sent in the last 2 years and consider corrective re-issue + §616 risk memo',
      ],
      confidence: 0.95,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §615(a)',
    },
  },
  {
    id: 'dg-aa-deficient-002',
    category: 'adverse-action',
    documentCorpusId: 'aa-notice-deficient-001',
    query: 'What class-action exposure pattern does this notice fit?',
    expected: {
      analysis:
        'Missing §615(a) elements in a templated notice is a classic FCRA class pattern because every applicant who received the same template suffered the same statutory-violation injury. Under Spokeo v. Robins, intangible informational injury can support standing when the statute creates a procedural right to specific content (§615(a) does). Willfulness is typically inferred from the uniformity + simplicity of the template defect — "reckless disregard" per Safeco Insurance v. Burr.',
      citations: [c('fcra-615-a'), c('fcra-616'), c('spokeo-2016'), c('safeco-2007')],
      risks: [
        'Class cert likely given templated conduct across applicants',
        '§616 willful damages ($100–$1,000 per notice) aggregate into significant exposure at scale',
        'Attorneys\' fees under §616(a)(3) shift with even a small recovery',
      ],
      recommendations: [
        'Quantify exposed population (every applicant who received this template over the last 2–5 years)',
        'Engage class-action defense counsel before any tolling agreement request arrives',
        'Cease use of the deficient template immediately and document the remediation',
        'Preserve all related records under §618 + litigation-hold protocol',
      ],
      confidence: 0.9,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §615(a) + §616 + Spokeo standing + Safeco willfulness',
    },
  },
  // ─── aa-notice-compliant-001 ───
  {
    id: 'dg-aa-compliant-001',
    category: 'adverse-action',
    documentCorpusId: 'aa-notice-compliant-001',
    query: 'Does this notice comply with FCRA §615(a)?',
    expected: {
      analysis:
        'Yes. All four §615(a) elements are present: (1) explicit adverse-action language, (2) CRA name + full address + toll-free number, (3) "ACME did not make the decision" disclaimer, (4) 60-day free-report right + dispute right. The enclosed Summary of Your Rights is the CFPB-published long form. One thing to confirm: that the "A Summary of Your Rights Under the Fair Credit Reporting Act" is actually enclosed — the notice says "enclosed" but we can\'t see the attachment from this single page.',
      citations: [c('fcra-615-a'), c('cfpb-summary-of-rights')],
      risks: [
        'If the Summary is not actually attached despite the notice claim, that\'s its own §615(a) + §609(c) defect',
        'State overlays may require additional content (CA §1786.40, NY §380-c) — not addressed by a federally-compliant template alone',
      ],
      recommendations: [
        'Audit packet-assembly process to confirm the Summary is physically attached',
        'For CA / NY applicants, include state-specific rights summary in addition to the federal one',
        'Preserve the notice + enclosure as a unit in the applicant file',
      ],
      confidence: 0.9,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §615(a) + §609(c)',
    },
  },
  // ─── pre-adverse-deficient-001 ───
  {
    id: 'dg-pre-adverse-timing-001',
    category: 'pre-adverse',
    documentCorpusId: 'pre-adverse-deficient-001',
    query: 'Is the timeline in this pre-adverse notice FCRA-compliant?',
    expected: {
      analysis:
        '§604(b)(3) requires a "reasonable period" between pre-adverse and final adverse action for the applicant to dispute the report. Case law (Reardon v. Closetmaid) and FTC informal guidance settle on 5 business days as the industry floor. A "we intend to finalize tomorrow" timeline is 1 business day, well below the floor, and is a §604(b)(3) defect that supports a willfulness finding under Safeco because the 5-business-day standard is broadly known.',
      citations: [c('fcra-604-b-3'), c('safeco-2007')],
      risks: [
        '§604(b)(3) statutory-violation class risk',
        '§616 willful-violation damages ($100–$1,000 per applicant) given the knowing-disregard pattern',
        'Courts can consider the short window as evidence of pretextual process',
      ],
      recommendations: [
        'Withdraw the 24-hour timeline immediately and restart the pre-adverse clock',
        'Revise pre-adverse template to state a 5-business-day wait',
        'Audit recent adverse actions for the same defect and consider corrective reopens',
      ],
      confidence: 0.93,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §604(b)(3) + Safeco willfulness',
    },
  },
  // ─── disclosure-syed-violation-001 ───
  {
    id: 'dg-syed-violation-001',
    category: 'pre-adverse',
    documentCorpusId: 'disclosure-syed-violation-001',
    query: 'Is this §604(b)(2) disclosure compliant? What\'s the risk pattern?',
    expected: {
      analysis:
        '§604(b)(2) requires the disclosure to be "in a document that consists SOLELY of the disclosure." Embedding it in the application form alongside authorization + a liability-release waiver triggers both Syed v. M.I. Windows & Doors (9th Cir. 2017 — liability waivers in the disclosure document are standalone violations) and Gilberg v. California Check Cashing Stores (9th Cir. 2019 — extraneous language in the disclosure defeats standalone status). This document fails both grounds.',
      citations: [c('fcra-604-b-2'), c('syed-2017'), c('gilberg-2019')],
      risks: [
        '§604(b)(2) willful-violation class exposure — $100–$1,000 per applicant',
        'Syed + Gilberg patterns are broadly known; class certification + willfulness findings are routine',
        'Injunctive-relief exposure in addition to damages',
      ],
      recommendations: [
        'Replace with a standalone disclosure form containing only §604(b)(2)-required content',
        'Separate authorization onto its own form',
        'Remove the liability-release waiver entirely from any consumer-report-adjacent document',
        'Audit past applicants who signed this form; consider §616 exposure counselling',
      ],
      confidence: 0.95,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §604(b)(2) + Syed + Gilberg',
    },
  },
  // ─── disclosure-compliant-001 ───
  {
    id: 'dg-disclosure-compliant-001',
    category: 'pre-adverse',
    documentCorpusId: 'disclosure-compliant-001',
    query: 'Does this §604(b)(2) disclosure comply?',
    expected: {
      analysis:
        'Yes. The document describes the consumer-report procurement in clear and conspicuous language, lives as a standalone document with no embedded authorization or liability waiver, and does not include extraneous application content. This satisfies §604(b)(2) as interpreted in Syed and Gilberg. Authorization on a separate form is the correct pattern.',
      citations: [c('fcra-604-b-2'), c('syed-2017'), c('gilberg-2019')],
      risks: [
        'If the "separate form" for authorization has its own Syed/Gilberg issues, those stand alone as defects',
        'State overlays (CA §1786.16, NY §380-c) require additional content in the disclosure — confirm state-specific versions',
      ],
      recommendations: [
        'Pair with a bare authorization form — no waivers or extraneous clauses',
        'Add state-specific disclosure inserts for CA / NY / MA / OR applicants',
        'Version-control the disclosure template so future edits don\'t re-introduce extraneous content',
      ],
      confidence: 0.92,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §604(b)(2)',
    },
  },
  // ─── consumer-report-expired-001 ───
  {
    id: 'dg-expired-judgment-001',
    category: 'reporting-limits',
    documentCorpusId: 'consumer-report-expired-001',
    query: 'Are both judgments on this tenant-screening report reportable under FCRA?',
    expected: {
      analysis:
        '§605(a)(2) caps civil-judgment reporting at 7 years from date of entry. The 2017-02 satisfied judgment is 9 years old — beyond the cap and NOT reportable regardless of satisfaction. The 2023-06 outstanding judgment is within the 7-year window and is reportable. Note: the §605(b) salary-threshold exception only applies to employment / insurance / credit amounts above $150k — tenant screening is not a §605(b)-excepted use, so the 7-year cap is absolute.',
      citations: [c('fcra-605-a'), c('fcra-605-b')],
      risks: [
        '§616 willful violation for reporting the 2017 judgment past the §605(a) cap',
        'FTC enforcement precedent: RealPage 2018 $3M settlement for tenant-screening accuracy failures',
        'Class-action exposure under §617 for systematic over-reporting',
      ],
      recommendations: [
        'Suppress the 2017 judgment before issuing the report',
        'Keep the 2023 judgment — within the §605(a) window',
        'Audit CRA rules-engine to hard-block civil-suit / civil-judgment items beyond 7 years',
        'Notify the requesting tenant-screening customer of the correction before they act on the original',
      ],
      confidence: 0.96,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §605(a)(2)',
    },
  },
  // ─── credential-diploma-mill-001 ───
  {
    id: 'dg-diploma-mill-001',
    category: 'credential-specific',
    documentCorpusId: 'credential-diploma-mill-001',
    query: 'What compliance issues does this degree verification raise?',
    expected: {
      analysis:
        'Two overlapping issues. First, "Oregon Pacific University" appears on the Oregon Office of Degree Authorization unaccredited-institutions list — no degree from this institution is a bona fide credential under Oregon law (ORS 348.609 prohibits use of the title in Oregon without disclosure). Second, "direct confirmation with registrar email listed on institution website" is not primary-source verification; it is a self-attested source that does not meet §607(b) "reasonable procedures to assure maximum possible accuracy" for a CRA, nor does it meet credential-primary-source standards for licensed positions.',
      citations: [c('fcra-607-b'), c('oregon-oda-list')],
      risks: [
        '§607(b) accuracy-duty violation if this verification is passed to an employer as a credential-report',
        'State-law misrepresentation claim in Oregon if the employer hires based on the degree representation',
        'Professional-licensure risk if the role requires board-verified credentials',
      ],
      recommendations: [
        'Flag this verification as "institution on Oregon ODA unaccredited list — no bona fide degree"',
        'Do not rely on the self-attested registrar email as primary-source',
        'Require accredited-registrar database confirmation (NSC Clearinghouse or equivalent) before issuing a credential-report',
        'Retain the Oregon ODA snapshot with the verification file',
      ],
      confidence: 0.9,
      jurisdiction: 'federal+state',
      applicable_law: 'FCRA §607(b) + Oregon ORS 348.609',
    },
  },
  // ─── tenant-screening-realpage-001 ───
  {
    id: 'dg-realpage-pattern-001',
    category: 'risk-patterns',
    documentCorpusId: 'tenant-screening-realpage-001',
    query: 'What FCRA accuracy issue does this tenant-screening summary raise?',
    expected: {
      analysis:
        'Name-only matching for a criminal record fails §607(b)\'s "reasonable procedures to assure maximum possible accuracy" duty. The 2018 FTC v. RealPage settlement ($3M) was explicitly premised on CRA liability for declining applicants based on name-only criminal matches without confirming DOB, address, or other identifiers. The summary here replicates that pattern — the "matched on name only" language is exactly what the FTC enforcement action targeted.',
      citations: [c('fcra-607-b'), c('spokeo-2016')],
      risks: [
        '§607(b) accuracy-duty class risk',
        'FTC / CFPB enforcement exposure mirroring the RealPage pattern',
        '§616 willful exposure if the CRA\'s procedures documentation shows known name-only-match limitations',
        'State-specific tenant-screening statutes (CA AB-2282, NY S.B. 2192) add independent claims',
      ],
      recommendations: [
        'Do not decline based on the name-only match — confirm DOB + address before any adverse use',
        'Require multi-identifier matching in CRA rules-engine as a pre-condition to including criminal items',
        'Re-review any prior adverse tenant-screening decisions that relied on name-only matches',
        'Apply §615 notice-and-dispute process proactively if the match is uncertain',
      ],
      confidence: 0.94,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §607(b) + FTC RealPage enforcement',
    },
  },
];
