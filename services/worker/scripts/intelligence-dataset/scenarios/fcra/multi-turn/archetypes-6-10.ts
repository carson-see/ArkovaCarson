/**
 * NVI-08 — Multi-turn FCRA scenarios (archetypes 6–10) (SCRUM-812).
 *
 * Covers:
 *   6. applicant-type       — individual vs class, employee vs contractor vs gig
 *   7. role-sensitivity     — regulated role (healthcare, childcare, finance)
 *   8. employer-size        — above/below state threshold
 *   9. document-specifics   — user references a document — Nessie asks what it says
 *  10. cascading-followup   — initial answer implies a second issue
 *
 * 1–2 seed scenarios per archetype.
 */

import { fcraCitation as c } from '../../../sources/fcra-sources';
import type { MultiTurnScenario } from '../../../multi-turn';

export const MULTI_TURN_SCENARIOS_6_10: MultiTurnScenario[] = [
  // ─── 6. applicant-type ───
  {
    id: 'mt-applicant-001',
    category: 'permissible-purpose',
    archetype: 'applicant-type',
    turns: [
      { role: 'user', content: 'We run background checks on our contractors. Same FCRA rules as W-2 employees?' },
      {
        role: 'assistant',
        content:
          'FCRA mechanics apply equally — §604(a)(3)(B) permissible purpose covers "employment purposes" broadly and includes engagement-style relationships. But some state overlays draw a line: Cal. Lab. Code §12952 covers "applicants for employment," and courts have split on whether gig-platform contractors qualify. Can you tell me (a) the state(s) where contractors will work, (b) whether they\'re classified 1099 or platform-gig (Prop 22 style in CA), and (c) whether your process matches how you screen W-2 employees?',
      },
      { role: 'user', content: 'California. 1099 independent contractors, not app-based gig. Identical screening process.' },
      {
        role: 'assistant',
        content: '',
        isFinal: true,
        expected: {
          analysis:
            'For 1099 contractors in California, FCRA applies fully under §604(a)(3)(B) + §604(b)(2) + §615. The §12952 Fair Chance Act explicitly reaches "applicants for employment" and has been interpreted by DFEH to include independent contractors engaged as W-2-adjacent workers. Cal. Lab. Code §1024.5 credit-inquiry restrictions apply when the contractor\'s role falls in the enumerated categories. You should treat the contractor screening workflow as identical to W-2 (disclosure, authorization, pre-adverse, adverse) rather than relying on contractor-status to exempt you.',
          citations: [c('fcra-604-a'), c('fcra-604-b-2'), c('cal-fair-chance'), c('cal-civ-1786-18')],
          risks: [
            '§12952 Fair Chance violation if pre-offer criminal inquiry on 1099 contractor',
            'Misclassification-compounded exposure: if DIR reclassifies contractors to employees, all FCRA defects become W-2 defects retroactively',
            'Title VII disparate impact applies via ADA Title I coverage of 1099s for some purposes',
          ],
          recommendations: [
            'Use the identical FCRA-compliant workflow for 1099 as for W-2',
            'Defer conviction inquiry until conditional offer even for 1099',
            'Apply §1024.5 credit-inquiry filter to the role, not the classification',
            'Document rationale in the contractor file to preserve the individual-assessment defense',
          ],
          confidence: 0.82,
          jurisdiction: 'CA',
          applicable_law: 'FCRA §604 + Cal. Gov. Code §12952 + Cal. Lab. Code §1024.5',
        },
      },
    ],
  },
  // ─── 7. role-sensitivity ───
  {
    id: 'mt-role-001',
    category: 'credential-specific',
    archetype: 'role-sensitivity',
    turns: [
      { role: 'user', content: 'We\'re hiring for a role that involves patient contact. Any extra FCRA steps?' },
      {
        role: 'assistant',
        content:
          'Healthcare roles add a second layer on top of FCRA. I need a couple of specifics: (a) is the role itself a licensed clinical position (RN, LPN, MD) or patient-adjacent (tech, aide, admin); (b) does your state require OIG / SAM.gov / state Medicaid exclusion check; and (c) does the role involve pediatric or elder-care populations, which typically trigger additional child/vulnerable-adult background-check statutes?',
      },
      { role: 'user', content: 'LPN role, adult patients, state is Texas. We already do SAM.gov and state Medicaid checks.' },
      {
        role: 'assistant',
        content: '',
        isFinal: true,
        expected: {
          analysis:
            'On top of FCRA §604 + §615, Texas requires: (1) Texas Board of Nursing primary-source license verification via Nursys — CRA-sourced claim is insufficient, and (2) Texas Gov. Code §411.08 criminal-history check for license-eligible positions with unique cross-reference to DPS records, not merely CRA data. OIG exclusion + state Medicaid check you\'re already doing meet the federal 42 CFR 1001.1901 "reasonable inquiry" duty. No pediatric / elder-care overlay since it\'s adult patients (Texas HRC §250.006 applies to residential-care facilities specifically).',
          citations: [c('fcra-604-a'), c('fcra-615-a'), c('npdb-hipdb'), c('tx-bcc-411')],
          risks: [
            'Texas BON enforcement if license verification isn\'t primary-source',
            'OIG / SAM.gov exclusion-miss creates False Claims Act exposure if federal billing occurs',
            'FCRA §615 notice defects on adverse decisions compound all of the above',
          ],
          recommendations: [
            'Verify licenses directly via Nursys, not through the CRA summary',
            'Retain Texas DPS criminal-history results separately — they have different retention rules than CRA reports',
            'Flag OIG / SAM re-check cadence (monthly for billing-eligible roles)',
            'Apply §604(b)(2) + §615 workflow for any CRA-report-based decision',
          ],
          confidence: 0.87,
          jurisdiction: 'TX',
          applicable_law: 'FCRA §604 + Texas Gov. Code §411.08 + 42 CFR 1001.1901',
        },
      },
    ],
  },
  // ─── 8. employer-size ───
  {
    id: 'mt-size-001',
    category: 'state-variations',
    archetype: 'employer-size',
    turns: [
      { role: 'user', content: 'Do Illinois ban-the-box rules apply to us?' },
      {
        role: 'assistant',
        content:
          'Illinois JOQAA applies to employers with 15+ employees. How many employees do you have in Illinois specifically, and do you have multi-state operations where the IL-location headcount is different from the total?',
      },
      { role: 'user', content: '12 people total, all in IL. National company has 400 people but only 12 are in IL.' },
      {
        role: 'assistant',
        content: '',
        isFinal: true,
        expected: {
          analysis:
            'JOQAA applies to "employers with 15 or more employees in Illinois" — the statute is IL-location-specific. At 12 IL employees you are below the threshold and JOQAA does not apply. However, Cook County Ordinance 17-0-17 (if any hiring is in Cook County) applies to employers of any size and prohibits conviction-history inquiry before a conditional offer. Also: the Illinois Human Rights Act criminal-history provisions (IHRA §103(A)(11)) apply to employers of 15+ — same threshold. Federal FCRA §604 + §615 + Title VII disparate-impact analysis apply at any size.',
          citations: [c('fcra-604-a'), c('fcra-615-a'), c('il-joqaa'), c('cook-county-fair-chance')],
          risks: [
            'Misreading total-company-size vs IL-headcount is a common JOQAA-exposure pattern',
            'Cook County ordinance creates liability even for 1-person IL operations',
            'Growth above 15 IL employees triggers JOQAA mid-quarter — screening workflow must scale',
          ],
          recommendations: [
            'Apply Cook County Ordinance 17-0-17 for any Cook County hiring regardless of size',
            'Track IL headcount monthly; prepare JOQAA-compliant workflow for when you cross 15',
            'Meanwhile apply federal FCRA + Title VII at all sizes',
            'Document size-threshold analysis in the hiring file',
          ],
          confidence: 0.86,
          jurisdiction: 'IL',
          applicable_law: 'FCRA §604 + Illinois JOQAA + Cook County Ord. 17-0-17',
        },
      },
    ],
  },
  // ─── 9. document-specifics ───
  {
    id: 'mt-document-001',
    category: 'adverse-action',
    archetype: 'document-specifics',
    turns: [
      { role: 'user', content: 'Our adverse-action template is attached. Can you review it?' },
      {
        role: 'assistant',
        content:
          'I don\'t see an attached document — can you paste the template text directly? I need to check for the four §615(a) required elements: (1) notice that adverse action is being taken, (2) CRA name + address + toll-free number, (3) statement that the CRA did not make the decision, (4) consumer\'s right to dispute + free-report right within 60 days. State-specific additions depend on jurisdiction — which state is the applicant in?',
      },
      {
        role: 'user',
        content:
          'TEMPLATE: "Dear Applicant, we cannot proceed with your application at this time. Thank you for your interest. [Acme CRA, 555-1234]." State: California.',
      },
      {
        role: 'assistant',
        content: '',
        isFinal: true,
        expected: {
          analysis:
            'This template fails §615(a) on three of four required elements: (1) missing explicit statement that the CRA did not make the decision, (2) missing consumer\'s right to dispute + free-report right within 60 days, (3) CRA contact info lacks address and the "toll-free" qualifier. Further, Cal. Civ. Code §1786.40 (ICRAA) layers on top of FCRA §615(a) for California — the California notice must additionally (a) provide the specific information relied upon from the report, and (b) include the CA-specific rights summary. The template must be redrafted before any more California adverse actions are sent.',
          citations: [c('fcra-615-a'), c('cfpb-summary-of-rights')],
          risks: [
            '§615(a) statutory-violation exposure: $100-$1,000 per notice if willful',
            'Cal. Civ. §1786 ICRAA violation carries independent damages + attorneys\' fees',
            'Class-action pattern: defective adverse-action templates are the #1 source of FCRA class exposure',
          ],
          recommendations: [
            'Replace the template with a compliant one including all four §615(a) elements',
            'Add California-specific §1786.40 content for CA applicants',
            'Include the CFPB Summary of Consumer Rights (the "long-form" version) in the adverse-action packet',
            'Apply the new template retroactively for any open adverse actions',
          ],
          confidence: 0.94,
          jurisdiction: 'CA',
          applicable_law: 'FCRA §615(a) + Cal. Civ. Code §1786.40 (ICRAA)',
        },
      },
    ],
  },
  // ─── 10. cascading-followup ───
  {
    id: 'mt-cascading-001',
    category: 'disputes',
    archetype: 'cascading-followup',
    turns: [
      { role: 'user', content: 'The candidate disputed the report and the CRA corrected it. Are we done?' },
      {
        role: 'assistant',
        content:
          'Not quite — one correction raises a second issue. Was the original report used as a basis for an adverse action you already took? If so, §611/§615 implications cascade: (a) re-run the hiring decision against the corrected facts, (b) update the adverse-action record, (c) consider whether the original adverse action was itself a §616/§617 actionable defect.',
      },
      { role: 'user', content: 'Yes we already rejected the candidate. The correction removed the conviction that was the main basis.' },
      {
        role: 'assistant',
        content: '',
        isFinal: true,
        expected: {
          analysis:
            'This cascades into three parallel obligations: (1) §607(b) "maximum possible accuracy" defense requires you to show you took reasonable procedures at the time of the original decision — if the CRA had the inaccurate conviction because of data-provider error not known to you, you likely have a §607(b) defense against the candidate\'s damages claim. (2) Best practice (and in some states, required — e.g. CA §1785.16.2) is to offer the candidate re-consideration against the corrected facts. (3) Because conviction removal was material to the original adverse action, document the timeline carefully — this is a common pattern for §616 willful-violation claims where the user ignored the correction and refused re-review.',
          citations: [c('fcra-611-a'), c('fcra-615-a'), c('fcra-616')],
          risks: [
            '§616 willful-violation claim if the user refuses to re-review against corrected facts',
            '§617 negligent claim for actual damages even absent willfulness',
            'California §1785.16.2 parallel state claim',
            'Reputational / public-record risk if the candidate escalates to CFPB complaint',
          ],
          recommendations: [
            'Offer the candidate a reconsideration interview within 10 business days of the correction',
            'Document the original §607(b) procedures for defense purposes',
            'Retain the corrected report in the applicant file alongside the original',
            'If reconsideration is declined, send a new §615(a)-compliant adverse-action notice citing the corrected facts',
          ],
          confidence: 0.83,
          jurisdiction: 'federal+state',
          applicable_law: 'FCRA §611 + §615(a) + §616 + §617 (+ Cal. Civ. §1785.16.2 if applicant is CA)',
        },
      },
    ],
  },
];
