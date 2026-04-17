/**
 * NVI-11 — FCRA gold-standard benchmark (SCRUM-815).
 *
 * This file is the deliverable target of an external FCRA compliance
 * attorney engagement (Morgan Lewis / Seyfarth / specialised practitioner,
 * $1.5–3K). Until the attorney produces the final 50 questions, this
 * file holds placeholder slots matching the required shape so the
 * benchmark framework is wired end-to-end.
 *
 * Quota:
 *   - 10× pre-adverse (§604(b)(3))
 *   - 10× adverse-action (§615(a))
 *   -  8× permissible-purpose (§604(a))
 *   -  6× disputes + reinvestigation (§611, §623)
 *   -  6× state variations (CA / NY / IL / MA)
 *   -  6× risk patterns (ID fraud, diploma mill, sanctions)
 *   -  4× cross-reg (FCRA × ADA, Title VII, GINA, HIPAA)
 *
 * Each seed question below is a PROVISIONAL attorney-grade skeleton
 * authored in-house (credential: "pending attorney review"). The
 * engaged attorney will REPLACE these in full — they're here so the
 * benchmark framework passes validation + can run against candidate
 * models for a smoke baseline.
 */

import type { BenchmarkQuestion } from './benchmark';

const PLACEHOLDER_CREDENTIAL = 'pending attorney review — engineering-seeded skeleton';

export const FCRA_GOLD_STANDARD_BENCHMARK: BenchmarkQuestion[] = [
  // ─── Pre-adverse (1 of 10 seeded; 9 pending attorney) ───
  {
    id: 'bench-pre-adverse-001',
    quadrant: 'pre-adverse',
    question:
      'An employer in California sends a pre-adverse action letter on Monday and sends the final §615(a) adverse-action notice on Wednesday of the same week, with no applicant response received. Is this compliant with FCRA §604(b)(3)?',
    referenceAnswer: {
      analysis:
        'No. §604(b)(3) [15 U.S.C. §1681b(b)(3)] requires a "reasonable period" between pre-adverse and final adverse action for the applicant to receive the report, review it, and dispute inaccuracies. The Reardon v. Closetmaid line of cases and common FTC informal guidance establish 5 business days as the industry floor. 2 business days (Monday → Wednesday) is a prima-facie §604(b)(3) violation. Under Safeco v. Burr the shortness of the window + uniformity of the employer\'s practice supports a willfulness finding. California layers Cal. Civ. Code §1786.40 ICRAA content-of-notice requirements on top, but the federal timing defect is independently dispositive.',
      citations: [
        { record_id: 'fcra-604-b-3', quote: 'reasonable period', source: 'FCRA §604(b)(3)' },
        { record_id: 'safeco-2007', quote: 'willfulness', source: 'Safeco Insurance v. Burr (2007)' },
      ],
      risks: [
        '§604(b)(3) willful violation exposure under Safeco (2 days is well below 5-business-day floor)',
        'Class-action pattern: templated short-window AAs scale across affected applicants',
        'California §1786 ICRAA parallel state claim adds independent damages',
      ],
      recommendations: [
        'Pause the final AA and wait ≥5 business days from pre-adverse delivery',
        'Audit recent AAs for the same timing defect and consider corrective reopens',
        'Consult qualified FCRA counsel on §616 exposure quantification for affected applicants',
      ],
      confidence: 0.92,
      jurisdiction: 'CA',
      applicable_law: 'FCRA §604(b)(3) + Cal. Civ. Code §1786.40',
    },
    requiredCitations: ['fcra-604-b-3', 'safeco-2007'],
    requiredRiskKeywords: ['willful', '604(b)(3)', '5 business day'],
    requiredRecommendationKeywords: ['5 business day', 'audit', 'counsel'],
    rubric: {
      expertCriteria:
        '4/4: names §604(b)(3) + 5-business-day floor + Reardon / Safeco willfulness + CA §1786 overlay + audit remediation + counsel escalation',
      goodCriteria:
        '3/4: names §604(b)(3) floor + willfulness or class risk + audit remediation',
      adequateCriteria:
        '2/4: identifies timing is wrong + flags statutory-damages risk',
      partialCriteria:
        '1/4: flags timing concern without specific §604(b)(3) anchor',
      missedCriteria:
        '0/4: concludes compliant or ignores the timing entirely',
    },
    authorCredential: PLACEHOLDER_CREDENTIAL,
    heldOut: true,
  },
  // 9 more pre-adverse placeholders expected here — populated by attorney.

  // ─── Adverse-action (1 of 10 seeded) ───
  {
    id: 'bench-adverse-action-001',
    quadrant: 'adverse-action',
    question:
      'A §615(a) adverse-action notice omits the "the CRA did not make this decision" statement but includes everything else. Is the notice compliant? What\'s the exposure pattern?',
    referenceAnswer: {
      analysis:
        '§615(a)(2) requires the notice to include a statement that the CRA did not make the decision and is unable to provide the specific reasons. Omitting this element alone is a per-se §615(a) defect. The omission is a templated + knowable defect, which supports a Safeco willfulness finding.',
      citations: [
        { record_id: 'fcra-615-a', quote: 'statement … that the CRA did not make the decision', source: 'FCRA §615(a)' },
        { record_id: 'safeco-2007', quote: 'willfulness', source: 'Safeco Insurance v. Burr (2007)' },
      ],
      risks: [
        '§615(a) willful-violation exposure — $100–$1,000 per applicant',
        'Class-action pattern: template-wide defect scales across every recipient',
      ],
      recommendations: [
        'Add the CRA-did-not-decide statement and re-issue the notice',
        'Audit all prior AAs sent with the defective template',
        'Consult qualified FCRA counsel on class-exposure quantification',
      ],
      confidence: 0.94,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §615(a)',
    },
    requiredCitations: ['fcra-615-a'],
    requiredRiskKeywords: ['willful', '615(a)'],
    requiredRecommendationKeywords: ['re-issue', 'audit'],
    rubric: {
      expertCriteria: '4/4: names §615(a)(2) element + Safeco willfulness + class exposure + audit + re-issue + counsel',
      goodCriteria: '3/4: names the missing element + willfulness + audit',
      adequateCriteria: '2/4: flags missing element + defect-scales risk',
      partialCriteria: '1/4: flags missing element',
      missedCriteria: '0/4: concludes compliant',
    },
    authorCredential: PLACEHOLDER_CREDENTIAL,
    heldOut: true,
  },
  // 9 more adverse-action placeholders expected.

  // ─── Placeholders intentionally omitted to keep this file honest. ───
  // The engaged attorney will author the remaining 48 questions across
  // every quadrant following the shape above. The framework is
  // functional + validated against these 2 seeds.
];
