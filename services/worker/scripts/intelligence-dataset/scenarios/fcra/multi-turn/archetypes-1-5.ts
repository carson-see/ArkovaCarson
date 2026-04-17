/**
 * NVI-08 — Multi-turn FCRA scenarios (archetypes 1–5) (SCRUM-812).
 *
 * Covers:
 *   1. vague-initial           — no jurisdiction / role stated
 *   2. incomplete-facts        — facts present but key fact missing
 *   3. cross-regulation-scope  — multi-reg question, scope first
 *   4. multi-state-location    — applicant could work in several states
 *   5. retroactive-timing      — did event happen or is it prospective?
 *
 * 2 seed scenarios per archetype. Lift via NVI-07 distillation for
 * production volume.
 */

import { fcraCitation as c } from '../../../sources/fcra-sources';
import type { MultiTurnScenario } from '../../../multi-turn';

export const MULTI_TURN_SCENARIOS_1_5: MultiTurnScenario[] = [
  // ─── 1. vague-initial ───
  {
    id: 'mt-vague-001',
    category: 'permissible-purpose',
    archetype: 'vague-initial',
    turns: [
      { role: 'user', content: 'We want to run a background check. Is that OK?' },
      {
        role: 'assistant',
        content:
          'Happy to help — a few facts I need first: (1) which state(s) is the applicant based in, (2) is this for employment, tenant screening, or another purpose, (3) has an offer already been extended or is this pre-offer? Those determine whether you need FCRA §604(b)(2) disclosure, state ban-the-box compliance, and any state credit-inquiry restrictions.',
      },
      {
        role: 'user',
        content: 'California. Employment. Pre-offer — we\'re narrowing down the candidate pool.',
      },
      {
        role: 'assistant',
        content: '',
        isFinal: true,
        expected: {
          analysis:
            'Under federal FCRA, pre-offer consumer-report pulls are permissible with §604(b)(2) standalone disclosure + authorization. California adds two layers: (1) §12952 Fair Chance Act prohibits asking about conviction history before a conditional offer; (2) Cal. Lab. Code §1024.5 restricts employer use of credit reports to specific positions (managerial, access to >$10k, law enforcement, confidential info). Doing routine pre-offer credit checks on general roles in California is a §1024.5 violation regardless of FCRA compliance.',
          citations: [c('fcra-604-b-2'), c('cal-fair-chance'), c('cal-civ-1786-18')],
          risks: [
            '§12952 Fair Chance Act violation (conviction inquiry pre-offer)',
            'Cal. Lab. Code §1024.5 violation if credit content is pulled for non-exempt role',
            'Title VII disparate impact if conviction screen is applied uniformly',
          ],
          recommendations: [
            'Defer any criminal-history component of the screen until after a conditional offer',
            'For credit content, confirm the role meets §1024.5\'s enumerated categories',
            'Use §604(b)(2)-compliant standalone disclosure + authorization',
            'Train recruiters not to view criminal history during pool narrowing',
          ],
          confidence: 0.9,
          jurisdiction: 'CA',
          applicable_law: 'FCRA §604(b)(2) + Cal. Gov. Code §12952 + Cal. Lab. Code §1024.5',
        },
      },
    ],
  },
  {
    id: 'mt-vague-002',
    category: 'adverse-action',
    archetype: 'vague-initial',
    turns: [
      { role: 'user', content: 'Do we owe anything to a candidate we just rejected?' },
      {
        role: 'assistant',
        content:
          'To answer accurately: (a) was a consumer report used in the rejection decision, (b) in which state is the applicant, and (c) did you already send a pre-adverse-action notice? FCRA §615(a) final adverse-action-notice obligations only trigger if a consumer report was a basis for the decision.',
      },
      { role: 'user', content: 'Yes, report was used. New York. Pre-adverse went out 6 business days ago with no dispute filed.' },
      {
        role: 'assistant',
        content: '',
        isFinal: true,
        expected: {
          analysis:
            'You\'re cleared to finalize. FCRA §604(b)(3) requires a "reasonable period" after pre-adverse — 5 business days is the common safe-harbor, and 6 exceeds that. No dispute filed means you can take final action. The §615(a) adverse-action notice must include: (i) notice of adverse action, (ii) CRA name + address + toll-free number, (iii) statement that the CRA did not make the decision, (iv) consumer\'s right to dispute and to a free copy of the report within 60 days. New York Article 23-A also requires that you articulate how the conviction (if criminal-history-driven) relates to the position — failure to do so is an unlawful discriminatory practice even if FCRA compliance is perfect.',
          citations: [c('fcra-604-b-3'), c('fcra-615-a'), c('ny-article-23a')],
          risks: [
            '§615(a) defect if CRA contact info or dispute-rights statement are missing',
            'NY Article 23-A discrimination claim if conviction-based without individualised assessment',
            '§616 willful-violation exposure if adverse-action notice sent before §615(a) requirements met',
          ],
          recommendations: [
            'Send §615(a) notice with all four required elements today',
            'If rejection was conviction-based, document individualised-assessment factors (Article 23-A)',
            'Retain pre-adverse + adverse-action records per §618 preservation schedule',
          ],
          confidence: 0.92,
          jurisdiction: 'NY',
          applicable_law: 'FCRA §615(a) + NY Correction Law Article 23-A',
        },
      },
    ],
  },
  // ─── 2. incomplete-facts ───
  {
    id: 'mt-incomplete-001',
    category: 'reporting-limits',
    archetype: 'incomplete-facts',
    turns: [
      { role: 'user', content: 'Can we report an 8-year-old civil judgment on a tenant screening report?' },
      {
        role: 'assistant',
        content:
          'Key missing fact: FCRA §605(a) reporting caps apply different ways depending on whether the judgment is paid/satisfied or unpaid, and whether the antecedent action is still live. Is the 8-year clock measured from the judgment date, satisfaction date, or filing date? And is it a paid judgment or unsatisfied?',
      },
      { role: 'user', content: 'Measured from judgment date. Fully paid and satisfied 5 years ago.' },
      {
        role: 'assistant',
        content: '',
        isFinal: true,
        expected: {
          analysis:
            '§605(a)(2) caps civil-suit / civil-judgment reporting at 7 years from date of entry of judgment. An 8-year-old judgment, paid or unpaid, cannot be reported on a tenant-screening consumer report under FCRA. Note: the 2018 NCAP accord removed most civil judgments from CRA tradelines voluntarily, but FCRA §605(a)(2) itself is the binding cap — no salary-threshold carve-out applies to tenant screening (the §605(b) exceptions only reach employment + insurance + credit amounts above $150k).',
          citations: [c('fcra-605-a'), c('fcra-605-b')],
          risks: [
            '§616 willful violation for reporting outside the 7-year window — statutory damages $100-$1,000 per consumer',
            'FTC enforcement precedent: RealPage 2018 $3M settlement for tenant-screening accuracy failures',
            'Class-action exposure under §617 for systematic over-reporting',
          ],
          recommendations: [
            'Do not include the 8-year judgment on the report',
            'Audit recent tenant-screening outputs for any §605(a) violations',
            'Update CRA-side rules engine to hard-block judgments beyond 7 years',
          ],
          confidence: 0.95,
          jurisdiction: 'federal',
          applicable_law: 'FCRA §605(a)(2)',
        },
      },
    ],
  },
  {
    id: 'mt-incomplete-002',
    category: 'pre-adverse',
    archetype: 'incomplete-facts',
    turns: [
      { role: 'user', content: 'The applicant hasn\'t responded to our pre-adverse notice. Can we proceed?' },
      {
        role: 'assistant',
        content:
          'Three facts needed: (1) when was the pre-adverse notice sent, (2) how was it delivered (email, postal, certified), and (3) what state is the applicant in — some states layer on additional wait periods beyond federal §604(b)(3).',
      },
      { role: 'user', content: 'Sent 3 business days ago by email only. Applicant is in Minnesota.' },
      {
        role: 'assistant',
        content: '',
        isFinal: true,
        expected: {
          analysis:
            'Too early under both federal and state standards. §604(b)(3) requires a "reasonable period" — case law (e.g. Reardon v. Closetmaid) treats 5 business days as the industry floor. Minnesota §13C.02 Subd. 3 does not extend the federal window but requires that the notice include MN-specific content (consumer\'s right to request a free copy of the report from the user, not just the CRA). Email-only delivery is legally permissible under E-SIGN but raises proof-of-delivery risk: if the applicant later disputes receipt, you have no certified record.',
          citations: [c('fcra-604-b-3'), c('mn-crim-record')],
          risks: [
            'Acting before 5 business days is prima-facie §604(b)(3) violation — willful if procedures showed knowledge of the floor',
            'Email-only delivery fails Minnesota §13C.02 if notice is returned undeliverable',
            'Class-action pattern under §616: early-action-after-pre-adverse is one of the most common FCRA class bases',
          ],
          recommendations: [
            'Wait until the 5-business-day floor has passed (day 5 or later)',
            'Send a follow-up via certified mail in parallel to establish delivery',
            'Revise the pre-adverse template to include MN §13C.02 consumer-rights language',
          ],
          confidence: 0.88,
          jurisdiction: 'MN',
          applicable_law: 'FCRA §604(b)(3) + Minn. Stat. §13C.02',
        },
      },
    ],
  },
  // ─── 3. cross-regulation-scope ───
  {
    id: 'mt-cross-001',
    category: 'credential-specific',
    archetype: 'cross-regulation-scope',
    turns: [
      { role: 'user', content: 'We\'re running medical-license verification on nurse applicants. What rules apply?' },
      {
        role: 'assistant',
        content:
          'Medical-licensure screening typically touches four regimes — FCRA (consumer-report handling), HIPAA (any PHI that surfaces via NPDB / state medical board records), ADA (medical-inquiry timing), and state licensing statutes (primary-source verification requirements). Which of those is your specific question about, and in which state are you hiring?',
      },
      { role: 'user', content: 'FCRA handling plus California state licensing. We use a CRA that pulls CA RN records.' },
      {
        role: 'assistant',
        content: '',
        isFinal: true,
        expected: {
          analysis:
            'Under FCRA, the CRA is a consumer reporting agency furnishing a consumer report, so §604 permissible-purpose (employment under §604(a)(3)(B)), §604(b)(2) standalone disclosure + authorization, and §615 adverse-action rules all apply. California Business & Professions Code §2732.1 (and the Cal. Board of Registered Nursing rules) requires primary-source verification with the board itself — a CRA re-selling a scraped board-website list is NOT primary-source and is not a substitute. You must either verify directly with the CA BRN or confirm the CRA holds a data-use agreement with the BRN. The CA Medical Practice Act §2054 also requires license-verification records be retained for 7 years.',
          citations: [c('fcra-604-a'), c('fcra-604-b-2'), c('fcra-615-a'), c('medical-board-ca')],
          risks: [
            '§604(f) impermissible-purpose claim if the CRA source isn\'t a bona fide consumer-report chain',
            'California BRN practice-act violation for non-primary-source verification',
            '§616 willfulness exposure if CRA tier is a known scrape',
          ],
          recommendations: [
            'Obtain primary-source verification via breeze.ca.gov or CA BRN direct-query API',
            'Confirm CRA\'s data-provenance documentation',
            'Retain verification records 7 years per §2054 + §618',
            'Apply §604(b)(2) + §615 workflow to any decisions based on the verification',
          ],
          confidence: 0.86,
          jurisdiction: 'CA',
          applicable_law: 'FCRA §604 + Cal. Bus. & Prof. §2732.1 + §2054',
        },
      },
    ],
  },
  // ─── 4. multi-state-location ───
  {
    id: 'mt-multistate-001',
    category: 'state-variations',
    archetype: 'multi-state-location',
    turns: [
      { role: 'user', content: 'The applicant is fully remote. Which state\'s FCRA-overlay rules apply?' },
      {
        role: 'assistant',
        content:
          'Remote-work makes this complex. The controlling jurisdiction is usually: (a) the state where the applicant will physically work, (b) the state where the employer is HQ\'d (sometimes secondary), and (c) the state where the applicant resides at the time of the inquiry (relevant for state-law standing). Can you tell me (1) applicant\'s residence state and (2) the state where you\'ll treat them as being employed for tax + workers\'-comp purposes?',
      },
      { role: 'user', content: 'Applicant lives in NJ. We\'ll employ them as working out of our Chicago office (IL).' },
      {
        role: 'assistant',
        content: '',
        isFinal: true,
        expected: {
          analysis:
            'Apply BOTH states\' rules. NJ Opportunity to Compete Act governs pre-employment criminal-history inquiry timing for applicants residing in NJ (courts have treated "employed in NJ" and "resident in NJ" as independent triggers). Illinois JOQAA applies to jobs physically located in Illinois — if the applicant will be treated as working from the Chicago office, the job is IL-located regardless of the applicant\'s physical commute. You should run the inquiry under whichever rule is stricter at each step: NJ Opportunity Act for timing (post-offer criminal inquiry), JOQAA for individualized-assessment documentation, federal FCRA §604 + §615 for the consumer-report mechanics.',
          citations: [c('fcra-604-a'), c('il-joqaa'), c('nj-opportunity-act')],
          risks: [
            'Single-state compliance on a multi-state applicant is the #1 source of FCRA-plus-overlay class actions',
            'NJ Opportunity Act + JOQAA overlapping claims if procedures only respect one',
            'Title VII + state-specific disparate-impact claims compounded by remote-work ambiguity',
          ],
          recommendations: [
            'Document the rationale for jurisdiction determination (work location + residence) in the applicant file',
            'Apply the stricter rule at each compliance step',
            'Flag remote-hire workflow in the ATS with dual-state rule set',
            'Consult counsel if NJ + IL rules conflict on any specific step',
          ],
          confidence: 0.82,
          jurisdiction: 'federal+state',
          applicable_law: 'FCRA §604 + NJ Opportunity to Compete Act + Illinois JOQAA',
        },
      },
    ],
  },
  // ─── 5. retroactive-timing ───
  {
    id: 'mt-retro-001',
    category: 'disputes',
    archetype: 'retroactive-timing',
    turns: [
      { role: 'user', content: 'An applicant is claiming their consumer report was wrong. What do I owe them?' },
      {
        role: 'assistant',
        content:
          'Timing matters. Did they flag the dispute BEFORE you took an adverse action, or AFTER the rejection? Pre-adverse is a §611 reinvestigation matter with the CRA; post-adverse may implicate §615(a) rights + §616/§617 damages exposure if the inaccuracy caused the rejection.',
      },
      { role: 'user', content: 'Post-adverse. We already rescinded the offer last week.' },
      {
        role: 'assistant',
        content: '',
        isFinal: true,
        expected: {
          analysis:
            'The applicant has two parallel paths: (1) §611 dispute with the CRA — CRA has 30 days (45 if additional info is submitted) to reinvestigate and correct; (2) §1681o / §616 consumer claim against you (the user) if your adverse action was based on a report you had reason to know was inaccurate. Your exposure depends on whether you took "reasonable procedures to assure maximum possible accuracy" per §607(b) — which as a user you inherit from the CRA chain. If the applicant prevails on §611 with a correction, you should offer to revisit the adverse decision; some states (e.g. CA §1785.16.2) require the user to re-review on request.',
          citations: [c('fcra-611-a'), c('fcra-615-a'), c('fcra-616')],
          risks: [
            '§616 willful-violation claim if user knew or should have known the report was inaccurate',
            '§617 negligent-violation claim even without knowledge — actual damages + attorney fees',
            'State re-review statutes (CA §1785.16.2) create independent duty post-correction',
          ],
          recommendations: [
            'Instruct the CRA to run a §611 reinvestigation immediately',
            'Preserve the full adverse-decision file (report, pre-adverse, adverse notice, internal notes)',
            'Offer to re-review the hiring decision if the dispute corrects material facts',
            'Document the "reasonable procedures" the user followed for §607(b) defense',
          ],
          confidence: 0.87,
          jurisdiction: 'federal',
          applicable_law: 'FCRA §611 + §615(a) + §616 + §617',
        },
      },
    ],
  },
];
