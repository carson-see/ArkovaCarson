/**
 * NVI-07 — FCRA query templates (SCRUM-811).
 *
 * 18 seed templates across every FCRA category. Each template has slot
 * placeholders that let the variation generator produce 5–20 concrete
 * queries per template. At the default slot counts this seed alone yields
 * ~280 variations; maintainers get to 5,000 by adding templates and/or
 * expanding the slot arrays without touching the pipeline code.
 *
 * Expansion guidelines when adding templates:
 *   - Keep queries LEGAL-REAL. Vague trivia ("what is FCRA") isn't useful;
 *     concrete fact patterns with a decision to make are what the student
 *     model learns from.
 *   - Pick `expectedSources` from the verified-source registry — the
 *     validator rejects any teacher output that doesn't cite at least one
 *     verified source.
 *   - Prefer 2–3 slots max. Past that the cartesian product explodes
 *     without adding coverage.
 */

import type { QueryTemplate } from './types';

const US_STATES = ['California', 'New York', 'Illinois', 'Texas', 'Massachusetts', 'Colorado', 'Washington'];
const EMPLOYER_SIZES = ['small (<15 employees)', 'mid-size (50 employees)', 'large (500+ employees)'];
const CREDENTIAL_TYPES = ['employment', 'tenant screening', 'professional license'];

export const FCRA_DISTILL_TEMPLATES: QueryTemplate[] = [
  // Pre-adverse action
  {
    id: 'tmpl-pre-adverse-timing',
    category: 'pre-adverse',
    template: 'In {state}, how many business days must a {size} employer wait between the pre-adverse-action notice and the final decision under FCRA §604(b)(3)?',
    slots: { state: US_STATES, size: EMPLOYER_SIZES },
    expectedSources: ['fcra-604-b-3'],
  },
  {
    id: 'tmpl-pre-adverse-docs',
    category: 'pre-adverse',
    template: 'What documents must accompany the pre-adverse notice when the applicant is based in {state}?',
    slots: { state: US_STATES },
    expectedSources: ['fcra-604-b-3', 'cfpb-summary-of-rights'],
  },
  // Adverse action
  {
    id: 'tmpl-adverse-notice-contents',
    category: 'adverse-action',
    template: 'If a {size} employer denies a {credentialType} applicant based on a consumer report in {state}, what must the §615(a) adverse-action notice contain?',
    slots: { size: EMPLOYER_SIZES, state: US_STATES, credentialType: CREDENTIAL_TYPES },
    expectedSources: ['fcra-615-a'],
  },
  {
    id: 'tmpl-adverse-disclosure-source',
    category: 'adverse-action',
    template: 'Must the CRA be identified by name in an adverse-action notice sent from a {state}-based employer?',
    slots: { state: US_STATES },
    expectedSources: ['fcra-615-a'],
  },
  // Permissible purpose
  {
    id: 'tmpl-permissible-purpose-employment',
    category: 'permissible-purpose',
    template: 'Under §604(a)(3)(B), can a {size} employer in {state} pull a report before an offer has been made?',
    slots: { size: EMPLOYER_SIZES, state: US_STATES },
    expectedSources: ['fcra-604-a', 'fcra-604-b-2'],
  },
  {
    id: 'tmpl-permissible-purpose-tenant',
    category: 'permissible-purpose',
    template: 'Is routine tenant screening in {state} a permissible purpose under FCRA §604(a)(3)(F)?',
    slots: { state: US_STATES },
    expectedSources: ['fcra-604-a'],
  },
  // Disputes + reinvestigation
  {
    id: 'tmpl-dispute-reinvestigation-window',
    category: 'disputes',
    template: 'A consumer in {state} disputes inaccurate information on their consumer report. How long does the CRA have to complete the reinvestigation under §611?',
    slots: { state: US_STATES },
    expectedSources: ['fcra-611'],
  },
  {
    id: 'tmpl-dispute-furnisher-duties',
    category: 'disputes',
    template: 'What are the §623(b) duties of a furnisher after receiving a dispute notice from a CRA in a {state} case?',
    slots: { state: US_STATES },
    expectedSources: ['fcra-623-b'],
  },
  // Reporting limits
  {
    id: 'tmpl-reporting-limits-conviction',
    category: 'reporting-limits',
    template: 'Can a CRA report a {recordType} from 9 years ago for a {state} pre-employment check?',
    slots: {
      recordType: ['criminal conviction', 'civil judgment', 'arrest without disposition'],
      state: US_STATES,
    },
    expectedSources: ['fcra-605-a'],
  },
  {
    id: 'tmpl-reporting-limits-salary',
    category: 'reporting-limits',
    template: 'Does the §605(a)(5) 7-year cap apply when the expected salary for the role in {state} is above the §605(b) threshold?',
    slots: { state: US_STATES },
    expectedSources: ['fcra-605-a', 'fcra-605-b'],
  },
  // State variations
  {
    id: 'tmpl-state-ban-the-box',
    category: 'state-variations',
    template: 'What ban-the-box protections apply to a pre-offer criminal history inquiry on a {credentialType} application in {state}?',
    slots: { state: US_STATES, credentialType: CREDENTIAL_TYPES },
    expectedSources: ['cal-fair-chance', 'nyc-fair-chance', 'il-joqaa'],
  },
  {
    id: 'tmpl-state-credit-inquiry',
    category: 'state-variations',
    template: 'Does {state} restrict employer credit-report pulls beyond FCRA for a {size} employer?',
    slots: { state: US_STATES, size: EMPLOYER_SIZES },
    expectedSources: ['cal-1024-5', 'ny-380-b'],
  },
  // Risk patterns
  {
    id: 'tmpl-risk-willfulness',
    category: 'risk-patterns',
    template: 'What is the exposure if a {size} employer in {state} runs a report before getting §604(b)(2) authorization?',
    slots: { size: EMPLOYER_SIZES, state: US_STATES },
    expectedSources: ['fcra-604-b-2', 'fcra-616'],
  },
  {
    id: 'tmpl-risk-disparate-impact',
    category: 'risk-patterns',
    template: 'How does Title VII disparate-impact liability intersect with a FCRA-compliant adverse decision in {state}?',
    slots: { state: US_STATES },
    expectedSources: ['eeoc-2012-guidance'],
  },
  // Medical licensure
  {
    id: 'tmpl-medical-license-nursing',
    category: 'medical-license',
    template: 'What primary-source verification is required for a nursing license issued in {state}?',
    slots: { state: US_STATES },
    expectedSources: ['medical-board-ca', 'npdb-hipdb'],
  },
  // Education verification
  {
    id: 'tmpl-education-transcript',
    category: 'education-verification',
    template: 'A {state} employer wants to verify a candidate\'s transcript from a degree-mill school. What FCRA + FERPA obligations apply?',
    slots: { state: US_STATES },
    expectedSources: ['ferpa-99-31', 'fcra-604-a'],
  },
  // E-Verify / I-9
  {
    id: 'tmpl-everify-mandate',
    category: 'e-verify',
    template: 'Is E-Verify mandatory for a {size} employer hiring in {state}?',
    slots: { size: EMPLOYER_SIZES, state: US_STATES },
    expectedSources: ['uscis-everify'],
  },
  // EEOC overlap
  {
    id: 'tmpl-eeoc-individualized-assessment',
    category: 'eeoc-overlap',
    template: 'What does EEOC 2012 guidance require for an individualized assessment on a conviction-based denial in {state}?',
    slots: { state: US_STATES },
    expectedSources: ['eeoc-2012-guidance'],
  },
];
