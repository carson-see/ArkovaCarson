/**
 * S3 CPE/CLE extraction golden set (AI-01 / SCRUM-2381).
 *
 * 60 labeled fixtures, 100% SYNTHETIC / public-specimen-style: every provider,
 * course id, sponsor id, and date is invented; participant identifiers are
 * redaction tokens ([NAME_REDACTED]) exactly as extraction receives them after
 * on-device PII stripping. ZERO real PII, ZERO customer documents.
 *
 * Stratification (see cpe-cle-s3-manifest.json for the version-pinned counts):
 *   kind:        cpe (30) × cle (30)
 *   quality:     clean × degraded-scan (OCR-noise style artifacts)
 *   adversarial: ambiguous-provider | near-duplicate-credits | fractional-hours
 *                | multi-credit (3 per class per kind)
 *
 * Held-out split: 12 entries tagged `held-out` (1 clean, 1 degraded, 1 per
 * adversarial class, per kind). `eval-gates.ts` excludes `held-out` from every
 * merge gate (NON_GATE_SPLIT_TAGS), and `heldout-leakage.ts` fails the build if
 * a held-out fixture ever appears in a committed prompt/few-shot/tuning corpus.
 *
 * Fixtures are declared through the `cpe()` / `cle()` builders (round-1 review:
 * Sonar new-code duplication): each call carries ONLY that fixture's deltas —
 * shared structure (accrediting body, credit-type defaults, provider = issuer,
 * activity number = course id, empty fraud signals) lives in the builders. The
 * builders are declaration sugar; the emitted entries are identical to the
 * previous fully-expanded literals (verified by the manifest fingerprints).
 */

import type { GoldenDatasetEntry, GroundTruthFields } from './types.js';

export const S3_DATASET_TAG = 's3-cpe-cle';
export const S3_HELDOUT_TAG = 'held-out';
export const S3_QUALITY_TAGS = ['clean', 'degraded-scan'] as const;
export const S3_ADVERSARIAL_TAGS = [
  'ambiguous-provider',
  'near-duplicate-credits',
  'fractional-hours',
  'multi-credit',
] as const;

type S3Quality = (typeof S3_QUALITY_TAGS)[number];
type S3Adversarial = (typeof S3_ADVERSARIAL_TAGS)[number];

interface S3FixtureSpec {
  id: string;
  description: string;
  kind: 'cpe' | 'cle';
  quality: S3Quality;
  adversarial?: S3Adversarial;
  heldOut?: boolean;
  text: string;
  truth: GroundTruthFields;
  sourceSlug: string;
}

function toEntry(spec: S3FixtureSpec): GoldenDatasetEntry {
  return {
    id: spec.id,
    description: spec.description,
    strippedText: spec.text,
    credentialTypeHint: spec.kind.toUpperCase(),
    groundTruth: spec.truth,
    source: `synthetic/s3-cpe-cle/${spec.sourceSlug}`,
    category: 'professional-education',
    tags: [
      'synthetic',
      S3_DATASET_TAG,
      spec.kind,
      spec.quality,
      ...(spec.adversarial ? [spec.adversarial] : []),
      ...(spec.heldOut ? [S3_HELDOUT_TAG] : []),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders — shared structure lives here, fixtures carry only deltas.
// ─────────────────────────────────────────────────────────────────────────────

/** Deltas shared by both kinds. */
interface S3FixtureDelta {
  /** Sequence number → id `GD-S3-<KIND>-0NN`. */
  n: number;
  slug: string;
  description: string;
  /** Stripped document text EXACTLY as extraction receives it. */
  text: string;
  quality?: S3Quality;
  adversarial?: S3Adversarial;
  heldOut?: true;
  issuer: string;
  date: string;
  hours: number;
  delivery: string;
  creditType?: string;
  manualReviewExpected?: true;
  fraudSignals?: string[];
}

interface CpeFixtureDelta extends S3FixtureDelta {
  study: string;
  course: string;
  /** Defaults to 'United States'. */
  jurisdiction?: string;
  /** Defaults to 'active'. */
  nasbaStatus?: string;
  ethicsHours?: number;
}

interface CleFixtureDelta extends S3FixtureDelta {
  jurisdiction: string;
  activity: string;
  approvedBy: string;
  ethics: number;
}

function fixtureId(kind: 'cpe' | 'cle', n: number): string {
  return `GD-S3-${kind.toUpperCase()}-${String(n).padStart(3, '0')}`;
}

function baseSpec(kind: 'cpe' | 'cle', d: S3FixtureDelta): Omit<S3FixtureSpec, 'truth'> {
  return {
    id: fixtureId(kind, d.n),
    description: d.description,
    kind,
    quality: d.quality ?? 'clean',
    ...(d.adversarial ? { adversarial: d.adversarial } : {}),
    ...(d.heldOut ? { heldOut: true } : {}),
    sourceSlug: d.slug,
    text: d.text,
  };
}

function cpe(d: CpeFixtureDelta): S3FixtureSpec {
  return {
    ...baseSpec('cpe', d),
    truth: {
      credentialType: 'CPE',
      issuerName: d.issuer,
      issuedDate: d.date,
      fieldOfStudy: d.study,
      accreditingBody: 'NASBA',
      jurisdiction: d.jurisdiction ?? 'United States',
      creditHours: d.hours,
      creditType: d.creditType ?? 'CPE',
      providerName: d.issuer,
      courseId: d.course,
      activityNumber: d.course,
      deliveryMethod: d.delivery,
      nasbaStatus: d.nasbaStatus ?? 'active',
      ...(d.manualReviewExpected ? { manualReviewExpected: true } : {}),
      ...(d.ethicsHours !== undefined ? { ethicsHours: d.ethicsHours } : {}),
      fraudSignals: d.fraudSignals ?? [],
    },
  };
}

function cle(d: CleFixtureDelta): S3FixtureSpec {
  return {
    ...baseSpec('cle', d),
    truth: {
      credentialType: 'CLE',
      issuerName: d.issuer,
      issuedDate: d.date,
      jurisdiction: d.jurisdiction,
      creditHours: d.hours,
      creditType: d.creditType ?? 'CLE',
      providerName: d.issuer,
      approvedBy: d.approvedBy,
      activityNumber: d.activity,
      courseId: d.activity,
      deliveryMethod: d.delivery,
      ethicsHours: d.ethics,
      ...(d.manualReviewExpected ? { manualReviewExpected: true } : {}),
      fraudSignals: d.fraudSignals ?? [],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CPE — clean (001..010; 010 held out), degraded-scan (011..018; 018 held out;
// OCR-noise style: casing damage, stray pipes/dots, split tokens — ground truth
// remains the intended labeled value), adversarial (019..030).
// ─────────────────────────────────────────────────────────────────────────────

const CPE_SPECS: S3FixtureSpec[] = [
  cpe({
    n: 1, slug: 'cpe-clean-tax-update',
    description: 'Clean CPE certificate — tax update webinar',
    text: 'Certificate of Completion — Continuing Professional Education. Participant: [NAME_REDACTED], CPA. Course Title: Federal Tax Update for Pass-Through Entities. Course ID: RPEI-TAX-2026-041. CPE Credits: 8.0. Field of Study: Taxes. Delivery Method: Group Internet Based. Sponsor: Ridgeline Professional Education Institute. NASBA Registry Status: Active. Completion Date: April 14, 2026.',
    issuer: 'Ridgeline Professional Education Institute', date: '2026-04-14', study: 'Taxes',
    hours: 8, course: 'RPEI-TAX-2026-041', delivery: 'Group Internet Based',
  }),
  cpe({
    n: 2, slug: 'cpe-clean-audit-selfstudy',
    description: 'Clean CPE certificate — audit self-study',
    text: 'Blue Harbor CPA Academy hereby certifies that [NAME_REDACTED] has successfully completed the QAS Self Study program "Risk Assessment in Integrated Audits" (Program Code BHCA-AUD-2025-217) on November 3, 2025. Credits Awarded: 6.0 CPE. Field of Study: Auditing. NASBA Sponsor Registry: Active.',
    issuer: 'Blue Harbor CPA Academy', date: '2025-11-03', study: 'Auditing',
    hours: 6, course: 'BHCA-AUD-2025-217', delivery: 'QAS Self Study',
  }),
  cpe({
    n: 3, slug: 'cpe-clean-gov-accounting',
    description: 'Clean CPE certificate — governmental accounting group-live',
    text: 'Continuing Professional Education Record. Attendee: [NAME_REDACTED]. Course: GASB Update: Leases and Subscription-Based IT Arrangements. Course Number: SLL-GOV-2026-009. CPE Hours: 4.0. Field of Study: Accounting (Governmental). Delivery: Group Live. Provider: Summit Ledger Learning. NASBA Registry Status: Active. Date of Completion: January 22, 2026. Location: Denver, Colorado.',
    issuer: 'Summit Ledger Learning', date: '2026-01-22', study: 'Accounting (Governmental)',
    hours: 4, course: 'SLL-GOV-2026-009', delivery: 'Group Live',
    jurisdiction: 'Colorado',
  }),
  cpe({
    n: 4, slug: 'cpe-clean-ethics',
    description: 'Clean CPE certificate — ethics course with ethics hours',
    text: 'Certificate of CPE Completion. Participant: [NAME_REDACTED], CPA. Course: Professional Ethics for Texas CPAs. Course ID: NTI-ETH-2026-114. Credits: 4.0 CPE (4.0 Regulatory Ethics). Field of Study: Regulatory Ethics. Delivery Method: QAS Self Study. Sponsor: Northwind Tax Institute. NASBA Registry Status: Active. Completed: February 9, 2026. Approved for Texas State Board of Public Accountancy ethics requirement.',
    issuer: 'Northwind Tax Institute', date: '2026-02-09', study: 'Regulatory Ethics',
    hours: 4, course: 'NTI-ETH-2026-114', delivery: 'QAS Self Study',
    jurisdiction: 'Texas', creditType: 'CPE Ethics', ethicsHours: 4,
  }),
  cpe({
    n: 5, slug: 'cpe-clean-technology',
    description: 'Clean CPE certificate — technology field of study',
    text: 'Cascade Accounting Seminars LLC — Certificate of Attendance. This certifies that [NAME_REDACTED] attended "Data Analytics for Close Automation" on March 5, 2026. Program ID: CAS-TEC-2026-072. CPE Credit: 2.0. Field of Study: Information Technology. Delivery Method: Group Internet Based. NASBA National Registry of CPE Sponsors: Active.',
    issuer: 'Cascade Accounting Seminars LLC', date: '2026-03-05', study: 'Information Technology',
    hours: 2, course: 'CAS-TEC-2026-072', delivery: 'Group Internet Based',
  }),
  cpe({
    n: 6, slug: 'cpe-clean-state-society',
    description: 'Clean CPE certificate — state society sponsor',
    text: 'Harborview Society of Accountants CPE Certificate. Member: [NAME_REDACTED]. Course: Single Audit Fundamentals under Uniform Guidance. Course Code: HSA-AUD-2025-331. Credits Awarded: 8.0 CPE. Field of Study: Auditing (Governmental). Delivery: Group Live. Completion Date: October 16, 2025. NASBA Sponsor Status: Active. Jurisdiction: Washington.',
    issuer: 'Harborview Society of Accountants', date: '2025-10-16', study: 'Auditing (Governmental)',
    hours: 8, course: 'HSA-AUD-2025-331', delivery: 'Group Live',
    jurisdiction: 'Washington',
  }),
  cpe({
    n: 7, slug: 'cpe-clean-nano',
    description: 'Clean CPE certificate — finance field, nano-learning',
    text: 'Silverbirch Finance Education — Nano Learning Completion Certificate. Learner: [NAME_REDACTED]. Module: Working Capital Ratios in Distressed Entities. Module ID: SFE-FIN-2026-018. CPE Credit: 0.2. Field of Study: Finance. Delivery Method: Nano Learning. NASBA Registry Status: Active. Date: May 1, 2026.',
    issuer: 'Silverbirch Finance Education', date: '2026-05-01', study: 'Finance',
    hours: 0.2, course: 'SFE-FIN-2026-018', delivery: 'Nano Learning',
  }),
  cpe({
    n: 8, slug: 'cpe-clean-lapsed-sponsor',
    description: 'Clean CPE certificate — lapsed sponsor requires review',
    text: 'CPE Completion Record. Participant: [NAME_REDACTED]. Course: Revenue Recognition Refresh for Contractors. Course ID: CCP-ACC-2026-127. Credits: 5.0 CPE. Field of Study: Accounting. Delivery Method: QAS Self Study. Provider: Copperfield CPE Partners. NASBA Sponsor Status: Lapsed as of 2025-12-31. Completion Date: February 2, 2026. Note: verify sponsor standing before reporting credits.',
    issuer: 'Copperfield CPE Partners', date: '2026-02-02', study: 'Accounting',
    hours: 5, course: 'CCP-ACC-2026-127', delivery: 'QAS Self Study',
    nasbaStatus: 'lapsed', manualReviewExpected: true, fraudSignals: ['EXPIRED_ACCREDITATION'],
  }),
  cpe({
    n: 9, slug: 'cpe-clean-conference',
    description: 'Clean CPE certificate — blended learning conference',
    text: 'Gleneagle Professional Studies Annual Assurance Conference — CPE Transcript Extract. Attendee: [NAME_REDACTED], CPA. Sessions completed June 10-11, 2026. Total CPE Credits: 16.0. Field of Study: Auditing. Delivery Method: Blended Learning. Conference Code: GPS-CONF-2026-002. NASBA Registry Status: Active. Jurisdiction: Illinois.',
    issuer: 'Gleneagle Professional Studies', date: '2026-06-11', study: 'Auditing',
    hours: 16, course: 'GPS-CONF-2026-002', delivery: 'Blended Learning',
    jurisdiction: 'Illinois',
  }),
  cpe({
    n: 10, slug: 'cpe-heldout-clean-hr', heldOut: true,
    description: 'HELD-OUT clean CPE certificate — personnel/HR field of study',
    text: 'Juniper Audit Training Co. Certificate of Continuing Professional Education. Participant: [NAME_REDACTED]. Course: Managing Remote Engagement Teams. Course ID: JAT-PER-2026-055. CPE Credits: 3.0. Field of Study: Personnel/Human Resources. Delivery Method: Group Internet Based. NASBA Registry Status: Active. Completed: March 27, 2026.',
    issuer: 'Juniper Audit Training Co.', date: '2026-03-27', study: 'Personnel/Human Resources',
    hours: 3, course: 'JAT-PER-2026-055', delivery: 'Group Internet Based',
  }),
  cpe({
    n: 11, slug: 'cpe-degraded-tax', quality: 'degraded-scan',
    description: 'Degraded-scan CPE — tax course, casing/pipe noise',
    text: 'CERT1FICATE  OF  C0MPLETION | CONTINUING  PROFESSI0NAL  EDUCATION || Participant : [NAME_REDACTED] , CPA | Course : Partnership  Basis  Adjustments  Workshop | C o u r s e  ID : RPEI-TAX-2025-233 | CPE  Credits : 8.0 | Field of Study : Taxes | Delivery : Group  Internet  Based | Sponsor : Ridgeline  Professional  Education  Institute | NASBA  Registry : Active | Completion  Date : December 4 , 2025',
    issuer: 'Ridgeline Professional Education Institute', date: '2025-12-04', study: 'Taxes',
    hours: 8, course: 'RPEI-TAX-2025-233', delivery: 'Group Internet Based',
  }),
  cpe({
    n: 12, slug: 'cpe-degraded-audit', quality: 'degraded-scan',
    description: 'Degraded-scan CPE — audit course, line-break damage',
    text: 'Blue Harbor CPA Academy\nCerti ficate of Comple tion\nPartici pant: [NAME_REDACTED]\nCourse: SOC 1 Repor t Walk throughs for Ser vice Auditors\nProgram Code: BHCA-AUD-2026-078\nCred its Awar ded: 4.0 CPE\nField of Study: Audi ting\nDeli very: QAS Self Study\nNASBA Spon sor Regis try: Active\nComple ted: Janu ary 30, 2026',
    issuer: 'Blue Harbor CPA Academy', date: '2026-01-30', study: 'Auditing',
    hours: 4, course: 'BHCA-AUD-2026-078', delivery: 'QAS Self Study',
  }),
  cpe({
    n: 13, slug: 'cpe-degraded-ethics', quality: 'degraded-scan',
    description: 'Degraded-scan CPE — ethics, zero/O substitution',
    text: 'N0rthwind Tax Institute -- CPE C0mpletion Rec0rd. Participant: [NAME_REDACTED]. C0urse: Ethics and Independence f0r Tax Practiti0ners. C0urse ID: NTI-ETH-2025-402. Credits: 2.0 CPE (Regulat0ry Ethics). Delivery Meth0d: Gr0up Internet Based. NASBA Registry Status: Active. C0mpleti0n Date: September 18, 2025.',
    issuer: 'Northwind Tax Institute', date: '2025-09-18', study: 'Regulatory Ethics',
    hours: 2, course: 'NTI-ETH-2025-402', delivery: 'Group Internet Based',
    creditType: 'CPE Ethics', ethicsHours: 2,
  }),
  cpe({
    n: 14, slug: 'cpe-degraded-accounting', quality: 'degraded-scan',
    description: 'Degraded-scan CPE — accounting update, spacing noise in numbers',
    text: 'Summit Ledger Learning * CPE Certificate * Attendee [NAME_REDACTED] * Course : FASB Update : Credit Losses and Fair Value * Course Number SLL - ACC - 2026 - 141 * CPE Hours : 6 . 0 * Field of Study : Accounting * Delivery : Group Live * NASBA Registry Status : Active * Date of Completion : April 8 , 2026 * Location : Portland , Oregon',
    issuer: 'Summit Ledger Learning', date: '2026-04-08', study: 'Accounting',
    hours: 6, course: 'SLL-ACC-2026-141', delivery: 'Group Live',
    jurisdiction: 'Oregon',
  }),
  cpe({
    n: 15, slug: 'cpe-degraded-table', quality: 'degraded-scan',
    description: 'Degraded-scan CPE — header banner damage, table remnants',
    text: '~~ CASCADE ACCOUNTING SEMINARS LLC ~~ ||| CPE TRANSCRIPT EXTRACT ||| Row 14: [NAME_REDACTED] | Cybersecurity Assessment for Finance Teams | CAS-TEC-2025-388 | 3.0 | Information Technology | Group Internet Based | 2025-08-21 | NASBA: Active |',
    issuer: 'Cascade Accounting Seminars LLC', date: '2025-08-21', study: 'Information Technology',
    hours: 3, course: 'CAS-TEC-2025-388', delivery: 'Group Internet Based',
  }),
  cpe({
    n: 16, slug: 'cpe-degraded-faded', quality: 'degraded-scan',
    description: 'Degraded-scan CPE — faded stamp, partial sponsor status',
    text: 'Gleneagle Professional Studies / CPE Certifi... (edge cut). Participant: [NAME_REDACTED], CPA. Course: Estate and Gift Tax Compliance Intensive. ID: GPS-TAX-2026-091. CPE Cr edits: 8.0. Field of St udy: Taxes. Deliv ery: Group Live. NASBA Regi stry Sta tus: Act ive. Completed: Febr uary 26, 2026. [stamp illegible]',
    issuer: 'Gleneagle Professional Studies', date: '2026-02-26', study: 'Taxes',
    hours: 8, course: 'GPS-TAX-2026-091', delivery: 'Group Live',
  }),
  cpe({
    n: 17, slug: 'cpe-degraded-skew', quality: 'degraded-scan',
    description: 'Degraded-scan CPE — skewed columns, duplicated header words',
    text: 'CPE CPE CERTIFICATE CERTIFICATE — Silverbirch Finance Education. Learner: [NAME_REDACTED]. Course Course: Treasury Hedging Basics. Module ID: SFE-FIN-2025-260. CPE Credit: 1.0. Field of Study: Finance. Delivery Method: QAS Self Study. NASBA Registry Status: Active. Date: July 7, 2025.',
    issuer: 'Silverbirch Finance Education', date: '2025-07-07', study: 'Finance',
    hours: 1, course: 'SFE-FIN-2025-260', delivery: 'QAS Self Study',
  }),
  cpe({
    n: 18, slug: 'cpe-heldout-degraded-stats', quality: 'degraded-scan', heldOut: true,
    description: 'HELD-OUT degraded-scan CPE — statistics field, mixed noise',
    text: 'HARB0RVIEW S0CIETY 0F ACC0UNTANTS || C P E  CERT | Member : [NAME_REDACTED] | C0urse : Sampling  Meth0ds  f0r  Internal  Audit | C0de : HSA-STA-2026-166 | Credits Awarded : 5.0 CPE | Field 0f Study : Statistics | Delivery : Gr0up Internet Based | NASBA Sp0ns0r Status : Active | C0mpleti0n : May 19 , 2026 | Jurisdicti0n : Washingt0n',
    issuer: 'Harborview Society of Accountants', date: '2026-05-19', study: 'Statistics',
    hours: 5, course: 'HSA-STA-2026-166', delivery: 'Group Internet Based',
    jurisdiction: 'Washington',
  }),
  cpe({
    n: 19, slug: 'cpe-adv-ambiguous-provider-platform', adversarial: 'ambiguous-provider',
    description: 'Adversarial CPE — platform vs sponsor vs venue ambiguity',
    text: 'Certificate of CPE Completion. Participant: [NAME_REDACTED], CPA. Course: Lease Accounting Remeasurements. Course ID: RPEI-ACC-2026-133. CPE Credits: 4.0. Field of Study: Accounting. Delivered via the LearnStream Online Platform. Hosted by the Metro Finance Club. NASBA-Registered Sponsor of Record: Ridgeline Professional Education Institute (Registry Status: Active). Delivery Method: Group Internet Based. Completion Date: March 12, 2026.',
    issuer: 'Ridgeline Professional Education Institute', date: '2026-03-12', study: 'Accounting',
    hours: 4, course: 'RPEI-ACC-2026-133', delivery: 'Group Internet Based',
  }),
  cpe({
    n: 20, slug: 'cpe-adv-ambiguous-provider-cobrand', adversarial: 'ambiguous-provider',
    description: 'Adversarial CPE — co-branded certificate, sponsor buried mid-text',
    text: 'Brightpath Webinars and Copperfield CPE Partners jointly present: "Quality Management Standards Implementation." This certifies [NAME_REDACTED] completed the program on April 29, 2026. For CPE reporting purposes the sponsor of record is Copperfield CPE Partners, NASBA Registry Status Active. Brightpath Webinars provides marketing and streaming services only and awards no credit. Program ID: CCP-AUD-2026-208. CPE Credits: 2.0. Field of Study: Auditing. Delivery Method: Group Internet Based.',
    issuer: 'Copperfield CPE Partners', date: '2026-04-29', study: 'Auditing',
    hours: 2, course: 'CCP-AUD-2026-208', delivery: 'Group Internet Based',
  }),
  cpe({
    n: 21, slug: 'cpe-heldout-adv-ambiguous-provider', quality: 'degraded-scan', adversarial: 'ambiguous-provider', heldOut: true,
    description: 'HELD-OUT adversarial CPE — degraded scan with three org names',
    text: 'C P E   C E R T I F I C A T E || Venue : Lakeside C0nference Center || Streaming Partner : VidC0nnect Inc . || Sp0ns0r 0f Rec0rd ( NASBA Registry : Active ) : Blue Harb0r CPA Academy || Participant : [NAME_REDACTED] || C0urse : F0rensic Interview Techniques f0r Aud itors || Pr0gram C0de : BHCA-FOR-2026-119 || CPE Credits : 6.0 || Field 0f Study : Auditing ( F0rensic ) || Delivery : Gr0up Live || C0mpleted : June 3 , 2026',
    issuer: 'Blue Harbor CPA Academy', date: '2026-06-03', study: 'Auditing (Forensic)',
    hours: 6, course: 'BHCA-FOR-2026-119', delivery: 'Group Live',
  }),
  cpe({
    n: 22, slug: 'cpe-adv-neardup-minutes', adversarial: 'near-duplicate-credits',
    description: 'Adversarial CPE — minutes vs credits vs reporting hours',
    text: 'Northwind Tax Institute CPE Certificate. Participant: [NAME_REDACTED]. Course: SALT Nexus after Marketplace Facilitator Laws. Course ID: NTI-TAX-2026-171. Total instruction time: 400 minutes. CPE Credits Awarded: 8.0. Recommended state reporting hours: 8.0. Attendance polls answered: 12 of 12. Field of Study: Taxes. Delivery Method: Group Internet Based. NASBA Registry Status: Active. Completion Date: January 15, 2026.',
    issuer: 'Northwind Tax Institute', date: '2026-01-15', study: 'Taxes',
    hours: 8, course: 'NTI-TAX-2026-171', delivery: 'Group Internet Based',
  }),
  cpe({
    n: 23, slug: 'cpe-adv-neardup-recommended', adversarial: 'near-duplicate-credits',
    description: 'Adversarial CPE — recommended vs maximum vs awarded credits',
    text: 'Summit Ledger Learning — Certificate of Completion. Attendee: [NAME_REDACTED], CPA. Course: Consolidations and VIE Reassessment. Course Number: SLL-ACC-2025-299. Program design maximum: 10.0 CPE. Credits awarded to this attendee: 7.0 CPE (partial attendance). NASBA field-of-study recommendation: Accounting, 10.0 credits maximum. Delivery: Group Live. NASBA Registry Status: Active. Completion Date: November 20, 2025.',
    issuer: 'Summit Ledger Learning', date: '2025-11-20', study: 'Accounting',
    hours: 7, course: 'SLL-ACC-2025-299', delivery: 'Group Live',
  }),
  cpe({
    n: 24, slug: 'cpe-heldout-adv-neardup', quality: 'degraded-scan', adversarial: 'near-duplicate-credits', heldOut: true,
    description: 'HELD-OUT adversarial CPE — degraded scan, duplicate credit lines',
    text: 'CASCADE ACC0UNTING SEMINARS LLC | CPE REC0RD | Participant : [NAME_REDACTED] | C0urse : IT General C0ntr0ls Testing Lab | C0urse ID : CAS-TEC-2026-244 | CPE Credits ( r0w 1 ) : 4.0 | CPE Credits ( r0w 1 , rescanned ) : 4.0 | Certificates issued : 2 c0pies | CE Br0ker rep0rting h0urs : 4.0 | Field 0f Study : Inf0rmati0n Techn0l0gy | Delivery : Gr0up Internet Based | NASBA : Active | Date : April 22 , 2026',
    issuer: 'Cascade Accounting Seminars LLC', date: '2026-04-22', study: 'Information Technology',
    hours: 4, course: 'CAS-TEC-2026-244', delivery: 'Group Internet Based',
  }),
  cpe({
    n: 25, slug: 'cpe-adv-fractional-15', adversarial: 'fractional-hours',
    description: 'Adversarial CPE — fractional 1.5 credits',
    text: 'Silverbirch Finance Education Certificate. Learner: [NAME_REDACTED]. Course: Interest Rate Swap Valuation Walkthrough. Module ID: SFE-FIN-2026-042. CPE Credit: 1.5. Field of Study: Finance. Delivery Method: QAS Self Study. NASBA Registry Status: Active. Date: February 17, 2026.',
    issuer: 'Silverbirch Finance Education', date: '2026-02-17', study: 'Finance',
    hours: 1.5, course: 'SFE-FIN-2026-042', delivery: 'QAS Self Study',
  }),
  cpe({
    n: 26, slug: 'cpe-adv-fractional-725', adversarial: 'fractional-hours',
    description: 'Adversarial CPE — fractional 7.25 credits spelled two ways',
    text: 'Gleneagle Professional Studies CPE Certificate. Participant: [NAME_REDACTED], CPA. Course: Multistate Apportionment Deep Dive. Course ID: GPS-TAX-2025-310. Credits Awarded: 7.25 CPE (seven and one-quarter credits). Field of Study: Taxes. Delivery: Group Live. NASBA Registry Status: Active. Completion Date: October 2, 2025.',
    issuer: 'Gleneagle Professional Studies', date: '2025-10-02', study: 'Taxes',
    hours: 7.25, course: 'GPS-TAX-2025-310', delivery: 'Group Live',
  }),
  cpe({
    n: 27, slug: 'cpe-heldout-adv-fractional', quality: 'degraded-scan', adversarial: 'fractional-hours', heldOut: true,
    description: 'HELD-OUT adversarial CPE — degraded scan, fractional 0.6 nano credits',
    text: 'JUNIPER AUDIT TRAINING C0. | NAN0 LEARNING BUNDLE REC0RD | Learner : [NAME_REDACTED] | Bundle : Sampling Micr0-M0dules ( 3 x 0.2 ) | Bundle ID : JAT-STA-2026-089 | T0tal CPE Credit : 0.6 | Field 0f Study : Statistics | Delivery Meth0d : Nan0 Learning | NASBA Registry Status : Active | C0mpleted : March 9 , 2026',
    issuer: 'Juniper Audit Training Co.', date: '2026-03-09', study: 'Statistics',
    hours: 0.6, course: 'JAT-STA-2026-089', delivery: 'Nano Learning',
  }),
  cpe({
    n: 28, slug: 'cpe-adv-multicredit-tax-ethics', adversarial: 'multi-credit',
    description: 'Adversarial CPE — multi-credit cert: taxes + regulatory ethics split',
    text: 'Ridgeline Professional Education Institute — Combined Program Certificate. Participant: [NAME_REDACTED], CPA. Program: Annual Tax Compliance and Ethics Day. Program ID: RPEI-CMB-2026-007. Total CPE Credits: 8.0, allocated as 6.0 Taxes and 2.0 Regulatory Ethics. Delivery Method: Group Live. NASBA Registry Status: Active. Completion Date: January 8, 2026.',
    issuer: 'Ridgeline Professional Education Institute', date: '2026-01-08', study: 'Taxes',
    hours: 8, course: 'RPEI-CMB-2026-007', delivery: 'Group Live',
    ethicsHours: 2,
  }),
  cpe({
    n: 29, slug: 'cpe-adv-multicredit-three-fields', adversarial: 'multi-credit',
    description: 'Adversarial CPE — multi-credit cert: three fields of study',
    text: 'Harborview Society of Accountants — Cluster Certificate. Member: [NAME_REDACTED]. Cluster: Government Finance Week. Cluster Code: HSA-CLU-2025-054. Total CPE: 12.0 comprising Accounting (Governmental) 6.0, Auditing (Governmental) 4.0, and Regulatory Ethics 2.0. Delivery: Blended Learning. NASBA Sponsor Status: Active. Completion Date: December 12, 2025. Jurisdiction: Washington.',
    issuer: 'Harborview Society of Accountants', date: '2025-12-12', study: 'Accounting (Governmental)',
    hours: 12, course: 'HSA-CLU-2025-054', delivery: 'Blended Learning',
    jurisdiction: 'Washington', ethicsHours: 2,
  }),
  cpe({
    n: 30, slug: 'cpe-heldout-adv-multicredit', quality: 'degraded-scan', adversarial: 'multi-credit', heldOut: true,
    description: 'HELD-OUT adversarial CPE — degraded multi-credit allocation table',
    text: 'BLUE HARB0R CPA ACADEMY || C0MBINED CERTIFICATE || Participant : [NAME_REDACTED] || Pr0gram : Assurance + Ethics B0otcamp || ID : BHCA-CMB-2026-160 || All0cati0n Table : | Auditing | 5.0 | | Regulat0ry Ethics | 1.0 | | T0TAL | 6.0 | || Delivery Meth0d : Gr0up Internet Based || NASBA Registry Status : Active || C0mpleted : May 28 , 2026',
    issuer: 'Blue Harbor CPA Academy', date: '2026-05-28', study: 'Auditing',
    hours: 6, course: 'BHCA-CMB-2026-160', delivery: 'Group Internet Based',
    ethicsHours: 1,
  }),
];

// ─────────────────────────────────────────────────────────────────────────────
// CLE — clean (001..010; 010 held out), degraded-scan (011..018; 018 held out),
// adversarial (019..030).
// ─────────────────────────────────────────────────────────────────────────────

const CLE_SPECS: S3FixtureSpec[] = [
  cle({
    n: 1, slug: 'cle-clean-securities',
    description: 'Clean CLE certificate — securities law with ethics hour',
    text: 'Certificate of Attendance — Continuing Legal Education. Attorney: [NAME_REDACTED]. Course: Private Placement Exemptions after Regulation D Reform. Activity Number: LLEG-SEC-2026-031. Total CLE Credit Hours: 6.0, including 1.0 Ethics. Provider: Lakeshore Legal Education Group. Approved by the New Caldonia State Bar CLE Board. Delivery: Live Webcast. Completion Date: March 18, 2026.',
    issuer: 'Lakeshore Legal Education Group', date: '2026-03-18', jurisdiction: 'New Caldonia',
    hours: 6, activity: 'LLEG-SEC-2026-031', delivery: 'Live Webcast', ethics: 1,
    approvedBy: 'New Caldonia State Bar CLE Board',
  }),
  cle({
    n: 2, slug: 'cle-clean-ethics-only',
    description: 'Clean CLE certificate — pure ethics program',
    text: 'Clearwater Ethics Institute — CLE Completion Certificate. Attorney: [NAME_REDACTED]. Program: Conflicts of Interest in Multi-Party Litigation. Program Number: CEI-ETH-2026-088. CLE Hours: 2.0 (2.0 Ethics). Approved By: State Bar of Westfalia MCLE Committee. Delivery Method: In-Person Seminar. Date Completed: February 25, 2026.',
    issuer: 'Clearwater Ethics Institute', date: '2026-02-25', jurisdiction: 'Westfalia',
    hours: 2, activity: 'CEI-ETH-2026-088', delivery: 'In-Person Seminar', ethics: 2,
    approvedBy: 'State Bar of Westfalia MCLE Committee',
    creditType: 'CLE Ethics',
  }),
  cle({
    n: 3, slug: 'cle-clean-trial-skills',
    description: 'Clean CLE certificate — trial skills, no ethics component',
    text: 'Meridian Bar Review Institute certifies that [NAME_REDACTED], Esq. completed "Cross-Examination Strategy for Expert Witnesses" on January 21, 2026. Course ID: MBRI-LIT-2026-014. CLE Credits: 3.0 General. Ethics Credits: 0.0. Accredited by the Ohio Commission on CLE. Format: Live Webcast.',
    issuer: 'Meridian Bar Review Institute', date: '2026-01-21', jurisdiction: 'Ohio',
    hours: 3, activity: 'MBRI-LIT-2026-014', delivery: 'Live Webcast', ethics: 0,
    approvedBy: 'Ohio Commission on CLE',
  }),
  cle({
    n: 4, slug: 'cle-clean-ip-ondemand',
    description: 'Clean CLE certificate — on-demand IP law course',
    text: 'Oakhollow CLE Partners — Certificate of Completion. Attorney: [NAME_REDACTED]. Course: Patent Claim Construction after Recent Federal Circuit Decisions. Activity Code: OCP-IPL-2025-201. CLE Credit: 1.5 General Hours. Approved Provider, California MCLE. Delivery Method: On-Demand Video. Completed: December 2, 2025.',
    issuer: 'Oakhollow CLE Partners', date: '2025-12-02', jurisdiction: 'California',
    hours: 1.5, activity: 'OCP-IPL-2025-201', delivery: 'On-Demand Video', ethics: 0,
    approvedBy: 'California MCLE',
  }),
  cle({
    n: 5, slug: 'cle-clean-employment',
    description: 'Clean CLE certificate — employment law full-day seminar',
    text: 'Pinnacle Legal Studies Certificate of Attendance. This certifies that [NAME_REDACTED] attended the full-day seminar "Non-Compete Agreements and Trade Secret Litigation" held April 3, 2026. Course Number: PLS-EMP-2026-119. Total CLE Hours: 7.0, including 1.0 Ethics and 6.0 General. Approved by the Minnesota State Board of CLE. Format: In-Person Seminar. Location: Minneapolis, Minnesota.',
    issuer: 'Pinnacle Legal Studies', date: '2026-04-03', jurisdiction: 'Minnesota',
    hours: 7, activity: 'PLS-EMP-2026-119', delivery: 'In-Person Seminar', ethics: 1,
    approvedBy: 'Minnesota State Board of CLE',
  }),
  cle({
    n: 6, slug: 'cle-clean-bar-lunch',
    description: 'Clean CLE certificate — bar association lunch program',
    text: 'Bar Association of New Caldonia — CLE Lunch Series Certificate. Member: [NAME_REDACTED]. Program: E-Discovery Sanctions Update. Program ID: BANC-LIT-2026-042. CLE Credit: 1.0 General Hour. Approved by the New Caldonia State Bar CLE Board. Delivery: In-Person Seminar. Date: February 11, 2026.',
    issuer: 'Bar Association of New Caldonia', date: '2026-02-11', jurisdiction: 'New Caldonia',
    hours: 1, activity: 'BANC-LIT-2026-042', delivery: 'In-Person Seminar', ethics: 0,
    approvedBy: 'New Caldonia State Bar CLE Board',
  }),
  cle({
    n: 7, slug: 'cle-clean-expired-provider',
    description: 'Clean CLE certificate — expired provider accreditation flag',
    text: 'Fairport Law Seminars — CLE Completion Record. Attorney: [NAME_REDACTED]. Course: Landlord-Tenant Practice Update. Course ID: FLS-RE-2026-077. CLE Hours: 2.5 General. Provider accreditation with the Westfalia MCLE Committee expired 2025-11-30; credits pending provider reinstatement. Delivery: On-Demand Video. Completed: January 12, 2026.',
    issuer: 'Fairport Law Seminars', date: '2026-01-12', jurisdiction: 'Westfalia',
    hours: 2.5, activity: 'FLS-RE-2026-077', delivery: 'On-Demand Video', ethics: 0,
    approvedBy: 'Westfalia MCLE Committee',
    manualReviewExpected: true, fraudSignals: ['EXPIRED_ACCREDITATION'],
  }),
  cle({
    n: 8, slug: 'cle-clean-tech-competence',
    description: 'Clean CLE certificate — technology competence credit',
    text: 'Redwood Legal Learning Certificate. Attorney: [NAME_REDACTED]. Course: AI-Assisted Drafting and the Duty of Technology Competence. Activity Number: RLL-TEC-2026-023. CLE Credits: 1.0 Technology, counted toward the general requirement. Approved by the Florida Bar CLE Department. Delivery Method: Live Webcast. Completion Date: March 30, 2026.',
    issuer: 'Redwood Legal Learning', date: '2026-03-30', jurisdiction: 'Florida',
    hours: 1, activity: 'RLL-TEC-2026-023', delivery: 'Live Webcast', ethics: 0,
    approvedBy: 'Florida Bar CLE Department',
    creditType: 'CLE Technology',
  }),
  cle({
    n: 9, slug: 'cle-clean-multi-jurisdiction',
    description: 'Clean CLE certificate — multi-jurisdiction approval list',
    text: 'Stonegate Legal Institute — Uniform Certificate of Attendance. Attorney: [NAME_REDACTED]. Course: Cross-Border Data Transfers for Litigators. Course ID: SLI-PRV-2025-164. CLE Hours: 4.0 General, 0.5 Ethics (total 4.5). Primary approval: New York CLE Board (transitional and non-transitional). Reciprocity claimed: New Jersey, Connecticut. Delivery: Live Webcast. Date Completed: October 28, 2025.',
    issuer: 'Stonegate Legal Institute', date: '2025-10-28', jurisdiction: 'New York',
    hours: 4.5, activity: 'SLI-PRV-2025-164', delivery: 'Live Webcast', ethics: 0.5,
    approvedBy: 'New York CLE Board',
  }),
  cle({
    n: 10, slug: 'cle-heldout-clean-family', heldOut: true,
    description: 'HELD-OUT clean CLE certificate — family law webinar',
    text: 'Willowbrook Attorney Education — CLE Certificate of Completion. Attorney: [NAME_REDACTED]. Course: Equitable Distribution of Closely-Held Business Interests. Activity Number: WAE-FAM-2026-101. CLE Credit Hours: 2.0 General. Approved by the Georgia Commission on Continuing Lawyer Competency. Delivery Method: Live Webcast. Completion Date: May 6, 2026.',
    issuer: 'Willowbrook Attorney Education', date: '2026-05-06', jurisdiction: 'Georgia',
    hours: 2, activity: 'WAE-FAM-2026-101', delivery: 'Live Webcast', ethics: 0,
    approvedBy: 'Georgia Commission on Continuing Lawyer Competency',
  }),
  cle({
    n: 11, slug: 'cle-degraded-litigation', quality: 'degraded-scan',
    description: 'Degraded-scan CLE — litigation course, pipe noise',
    text: 'CERTIFICATE 0F ATTENDANCE | C0NTINUING LEGAL EDUCATI0N || Att0rney : [NAME_REDACTED] | C0urse : Rem0val and Remand Strategy | Activity Number : MBRI-LIT-2025-289 | T0tal CLE Credit H0urs : 5.0 , including 1.0 Ethics | Pr0vider : Meridian Bar Review Institute | Appr0ved by the 0hi0 C0mmissi0n 0n CLE | Delivery : Live Webcast | C0mpleti0n Date : N0vember 13 , 2025',
    issuer: 'Meridian Bar Review Institute', date: '2025-11-13', jurisdiction: 'Ohio',
    hours: 5, activity: 'MBRI-LIT-2025-289', delivery: 'Live Webcast', ethics: 1,
    approvedBy: 'Ohio Commission on CLE',
  }),
  cle({
    n: 12, slug: 'cle-degraded-ethics', quality: 'degraded-scan',
    description: 'Degraded-scan CLE — ethics program, split tokens',
    text: 'Clear water Eth ics Insti tute\nCLE Comple tion Certi ficate\nAttor ney: [NAME_REDACTED]\nPro gram: Candor to ward the Tribu nal in Set tlement Nego tiations\nPro gram Num ber: CEI-ETH-2025-141\nCLE Hours: 1.0 (1.0 Eth ics)\nApproved By: State Bar of West falia MCLE Commit tee\nDeli very Method: On-Demand Video\nDate Comple ted: Septem ber 9, 2025',
    issuer: 'Clearwater Ethics Institute', date: '2025-09-09', jurisdiction: 'Westfalia',
    hours: 1, activity: 'CEI-ETH-2025-141', delivery: 'On-Demand Video', ethics: 1,
    approvedBy: 'State Bar of Westfalia MCLE Committee',
    creditType: 'CLE Ethics',
  }),
  cle({
    n: 13, slug: 'cle-degraded-realestate', quality: 'degraded-scan',
    description: 'Degraded-scan CLE — real estate course, spacing noise in numbers',
    text: 'Fairport Law Seminars * CLE Record * Attorney [NAME_REDACTED] * Course : Commercial Lease Workouts and Receiverships * Course ID FLS - RE - 2026 - 118 * CLE Hours : 3 . 0 General * Approved by Westfalia MCLE Committee * Delivery : In - Person Seminar * Completed : March 4 , 2026',
    issuer: 'Fairport Law Seminars', date: '2026-03-04', jurisdiction: 'Westfalia',
    hours: 3, activity: 'FLS-RE-2026-118', delivery: 'In-Person Seminar', ethics: 0,
    approvedBy: 'Westfalia MCLE Committee',
  }),
  cle({
    n: 14, slug: 'cle-degraded-immigration', quality: 'degraded-scan',
    description: 'Degraded-scan CLE — immigration law, table remnants',
    text: '~~ ST0NEGATE LEGAL INSTITUTE ~~ ||| CLE TRANSCRIPT R0W ||| [NAME_REDACTED] | Asylum Practice After Recent BIA Precedent | SLI-IMM-2026-036 | 4.0 General | 0.0 Ethics | New Y0rk CLE B0ard | Live Webcast | 2026-01-27 |',
    issuer: 'Stonegate Legal Institute', date: '2026-01-27', jurisdiction: 'New York',
    hours: 4, activity: 'SLI-IMM-2026-036', delivery: 'Live Webcast', ethics: 0,
    approvedBy: 'New York CLE Board',
  }),
  cle({
    n: 15, slug: 'cle-degraded-edgecut', quality: 'degraded-scan',
    description: 'Degraded-scan CLE — edge-cut header, stamp noise',
    text: 'Pinnacle Legal Stu... (edge cut) / Certificate of Atten dance. Attor ney: [NAME_REDACTED]. Course: Wage and Hour Class Certi fication Defense. Course Num ber: PLS-EMP-2025-244. Total CLE Hours: 6.5 inclu ding 0.5 Eth ics. Appro ved by the Minne sota State Board of CLE. For mat: In-Per son Semi nar. Date: Octo ber 9, 2025. [seal illegible]',
    issuer: 'Pinnacle Legal Studies', date: '2025-10-09', jurisdiction: 'Minnesota',
    hours: 6.5, activity: 'PLS-EMP-2025-244', delivery: 'In-Person Seminar', ethics: 0.5,
    approvedBy: 'Minnesota State Board of CLE',
  }),
  cle({
    n: 16, slug: 'cle-degraded-criminal', quality: 'degraded-scan',
    description: 'Degraded-scan CLE — duplicated header words, criminal law',
    text: 'CLE CLE CERTIFICATE CERTIFICATE — Redwood Legal Learning. Attorney: [NAME_REDACTED]. Course Course: Sentencing Guidelines Departures Workshop. Activity Number: RLL-CRM-2025-310. CLE Credits: 2.0 General. Approved by the Florida Bar CLE Department. Delivery Method: On-Demand Video. Completion Date: December 18, 2025.',
    issuer: 'Redwood Legal Learning', date: '2025-12-18', jurisdiction: 'Florida',
    hours: 2, activity: 'RLL-CRM-2025-310', delivery: 'On-Demand Video', ethics: 0,
    approvedBy: 'Florida Bar CLE Department',
  }),
  cle({
    n: 17, slug: 'cle-degraded-bankruptcy', quality: 'degraded-scan',
    description: 'Degraded-scan CLE — zero/O substitution, bankruptcy course',
    text: '0akh0ll0w CLE Partners -- CLE C0mpleti0n Rec0rd. Att0rney: [NAME_REDACTED]. C0urse: Subchapter V Practice P0inters. Activity C0de: 0CP-BKR-2026-054. CLE Credit: 1.5 General H0urs. Appr0ved Pr0vider, Calif0rnia MCLE. Delivery Meth0d: Live Webcast. C0mpleted: February 19, 2026.',
    issuer: 'Oakhollow CLE Partners', date: '2026-02-19', jurisdiction: 'California',
    hours: 1.5, activity: 'OCP-BKR-2026-054', delivery: 'Live Webcast', ethics: 0,
    approvedBy: 'California MCLE',
  }),
  cle({
    n: 18, slug: 'cle-heldout-degraded-health', quality: 'degraded-scan', heldOut: true,
    description: 'HELD-OUT degraded-scan CLE — health law, mixed noise',
    text: 'LAKESH0RE LEGAL EDUCATI0N GR0UP || C L E  CERT | Att0rney : [NAME_REDACTED] | C0urse : Telehealth Licensing and the C0rp0rate Practice D0ctrine | Activity Number : LLEG-HEA-2026-149 | T0tal CLE Credit H0urs : 3.5 , including 0.5 Ethics | Appr0ved by the New Cald0nia State Bar CLE B0ard | Delivery : 0n-Demand Vide0 | C0mpleti0n Date : April 16 , 2026',
    issuer: 'Lakeshore Legal Education Group', date: '2026-04-16', jurisdiction: 'New Caldonia',
    hours: 3.5, activity: 'LLEG-HEA-2026-149', delivery: 'On-Demand Video', ethics: 0.5,
    approvedBy: 'New Caldonia State Bar CLE Board',
  }),
  cle({
    n: 19, slug: 'cle-adv-ambiguous-provider-firm', adversarial: 'ambiguous-provider',
    description: 'Adversarial CLE — law firm host vs accredited provider',
    text: 'CLE Certificate of Attendance. Attorney: [NAME_REDACTED]. Course: Privilege Logs in the Era of Generative Drafting Tools. Hosted at the offices of [COMPANY_REDACTED] LLP. Registration handled by EventWorks Co. Accredited CLE Provider of Record: Stonegate Legal Institute, approved by the New York CLE Board. Activity Number: SLI-PRV-2026-071. CLE Hours: 2.0 General. Delivery: In-Person Seminar. Date: March 25, 2026.',
    issuer: 'Stonegate Legal Institute', date: '2026-03-25', jurisdiction: 'New York',
    hours: 2, activity: 'SLI-PRV-2026-071', delivery: 'In-Person Seminar', ethics: 0,
    approvedBy: 'New York CLE Board',
  }),
  cle({
    n: 20, slug: 'cle-adv-ambiguous-provider-stream', adversarial: 'ambiguous-provider',
    description: 'Adversarial CLE — streaming platform brand dominates certificate',
    text: 'JurisCast Streaming Network — Viewing Confirmation. Viewer: [NAME_REDACTED], Esq. Title: Appellate Standards of Review Refresher. For CLE credit purposes, this program is produced and accredited by Meridian Bar Review Institute (Ohio Commission on CLE approved provider); JurisCast provides distribution only and is not a CLE provider. Activity Number: MBRI-APP-2026-063. CLE Credits: 1.0 General. Delivery: On-Demand Video. Completed: February 5, 2026.',
    issuer: 'Meridian Bar Review Institute', date: '2026-02-05', jurisdiction: 'Ohio',
    hours: 1, activity: 'MBRI-APP-2026-063', delivery: 'On-Demand Video', ethics: 0,
    approvedBy: 'Ohio Commission on CLE',
  }),
  cle({
    n: 21, slug: 'cle-heldout-adv-ambiguous-provider', quality: 'degraded-scan', adversarial: 'ambiguous-provider', heldOut: true,
    description: 'HELD-OUT adversarial CLE — degraded scan, sponsor vs co-sponsor vs venue',
    text: 'C L E   C E R T I F I C A T E || Venue : Harb0r P0int H0tel || C0-Sp0ns0r ( n0n-accredited ) : C0astal Paralegal All iance || Accredited Pr0vider 0f Rec0rd : Willowbr00k Att0rney Educati0n , appr0ved by the Ge0rgia C0mmissi0n 0n C0ntinuing Lawyer C0mpetency || Att0rney : [NAME_REDACTED] || C0urse : Guardianship Litigati0n W0rksh0p || Activity Number : WAE-PRO-2026-133 || CLE Credit H0urs : 4.0 General , 1.0 Ethics ( t0tal 5.0 ) || Delivery : In-Pers0n Seminar || Date : May 21 , 2026',
    issuer: 'Willowbrook Attorney Education', date: '2026-05-21', jurisdiction: 'Georgia',
    hours: 5, activity: 'WAE-PRO-2026-133', delivery: 'In-Person Seminar', ethics: 1,
    approvedBy: 'Georgia Commission on Continuing Lawyer Competency',
  }),
  cle({
    n: 22, slug: 'cle-adv-neardup-requested', adversarial: 'near-duplicate-credits',
    description: 'Adversarial CLE — requested vs approved vs earned hours',
    text: 'Lakeshore Legal Education Group — CLE Certificate. Attorney: [NAME_REDACTED]. Course: Construction Defect Coverage Disputes. Activity Number: LLEG-INS-2026-058. Hours requested from the CLE Board: 6.0. Hours approved by the New Caldonia State Bar CLE Board: 5.0. Hours earned by this attendee: 5.0 General. Delivery: In-Person Seminar. Completion Date: January 29, 2026.',
    issuer: 'Lakeshore Legal Education Group', date: '2026-01-29', jurisdiction: 'New Caldonia',
    hours: 5, activity: 'LLEG-INS-2026-058', delivery: 'In-Person Seminar', ethics: 0,
    approvedBy: 'New Caldonia State Bar CLE Board',
  }),
  cle({
    n: 23, slug: 'cle-adv-neardup-conversion', adversarial: 'near-duplicate-credits',
    description: 'Adversarial CLE — 50-minute vs 60-minute hour conversion',
    text: 'Oakhollow CLE Partners Uniform Certificate. Attorney: [NAME_REDACTED]. Course: Mediation Advocacy Intensive. Activity Code: OCP-ADR-2025-277. Instruction: 300 minutes. Credit in 60-minute-hour jurisdictions: 5.0 hours. Credit in 50-minute-hour jurisdictions: 6.0 hours. This certificate is issued for California (60-minute hour): 5.0 General Hours. Approved Provider, California MCLE. Delivery: In-Person Seminar. Completed: November 6, 2025.',
    issuer: 'Oakhollow CLE Partners', date: '2025-11-06', jurisdiction: 'California',
    hours: 5, activity: 'OCP-ADR-2025-277', delivery: 'In-Person Seminar', ethics: 0,
    approvedBy: 'California MCLE',
  }),
  cle({
    n: 24, slug: 'cle-heldout-adv-neardup', quality: 'degraded-scan', adversarial: 'near-duplicate-credits', heldOut: true,
    description: 'HELD-OUT adversarial CLE — degraded scan, repeated near-identical credit rows',
    text: 'PINNACLE LEGAL STUDIES | CLE REC0RD | Att0rney : [NAME_REDACTED] | C0urse : ERISA Litigati0n Update | Activity : PLS-ERI-2026-190 | CLE H0urs ( certificate ) : 3.0 General | CLE H0urs ( rescan 0f same r0w ) : 3.0 General | Sister c0urse PLS-ERI-2026-191 ( N0T attended ) : 3.5 General | Appr0ved by the Minnes0ta State B0ard 0f CLE | Delivery : Live Webcast | Date : March 11 , 2026',
    issuer: 'Pinnacle Legal Studies', date: '2026-03-11', jurisdiction: 'Minnesota',
    hours: 3, activity: 'PLS-ERI-2026-190', delivery: 'Live Webcast', ethics: 0,
    approvedBy: 'Minnesota State Board of CLE',
  }),
  cle({
    n: 25, slug: 'cle-adv-fractional-075', adversarial: 'fractional-hours',
    description: 'Adversarial CLE — fractional 0.75 ethics hours',
    text: 'Clearwater Ethics Institute — CLE Certificate. Attorney: [NAME_REDACTED]. Program: Fee Agreements and Trust Accounting Pitfalls. Program Number: CEI-ETH-2026-119. CLE Hours: 0.75 (0.75 Ethics). Approved By: State Bar of Westfalia MCLE Committee. Delivery Method: Live Webcast. Date Completed: April 21, 2026.',
    issuer: 'Clearwater Ethics Institute', date: '2026-04-21', jurisdiction: 'Westfalia',
    hours: 0.75, activity: 'CEI-ETH-2026-119', delivery: 'Live Webcast', ethics: 0.75,
    approvedBy: 'State Bar of Westfalia MCLE Committee',
    creditType: 'CLE Ethics',
  }),
  cle({
    n: 26, slug: 'cle-adv-fractional-325', adversarial: 'fractional-hours',
    description: 'Adversarial CLE — fractional 3.25 total, mixed general/ethics fractions',
    text: 'Redwood Legal Learning Certificate of Completion. Attorney: [NAME_REDACTED]. Course: Cyber Incident Response for Outside Counsel. Activity Number: RLL-PRV-2025-198. Total CLE Credits: 3.25, allocated 2.75 General and 0.5 Ethics. Approved by the Florida Bar CLE Department. Delivery Method: On-Demand Video. Completion Date: August 14, 2025.',
    issuer: 'Redwood Legal Learning', date: '2025-08-14', jurisdiction: 'Florida',
    hours: 3.25, activity: 'RLL-PRV-2025-198', delivery: 'On-Demand Video', ethics: 0.5,
    approvedBy: 'Florida Bar CLE Department',
  }),
  cle({
    n: 27, slug: 'cle-heldout-adv-fractional', quality: 'degraded-scan', adversarial: 'fractional-hours', heldOut: true,
    description: 'HELD-OUT adversarial CLE — degraded scan, fractional 1.25 hours',
    text: 'BAR ASS0CIATI0N 0F NEW CALD0NIA || CLE LUNCH SERIES || Member : [NAME_REDACTED] || Pr0gram : Expert Discl0sure Deadlines Under the Amended Rules || Pr0gram ID : BANC-LIT-2026-095 || CLE Credit : 1 . 25 General H0urs || Appr0ved by the New Cald0nia State Bar CLE B0ard || Delivery : In-Pers0n Seminar || Date : June 10 , 2026',
    issuer: 'Bar Association of New Caldonia', date: '2026-06-10', jurisdiction: 'New Caldonia',
    hours: 1.25, activity: 'BANC-LIT-2026-095', delivery: 'In-Person Seminar', ethics: 0,
    approvedBy: 'New Caldonia State Bar CLE Board',
  }),
  cle({
    n: 28, slug: 'cle-adv-multicredit-three-buckets', adversarial: 'multi-credit',
    description: 'Adversarial CLE — multi-credit: general + ethics + competence',
    text: 'Willowbrook Attorney Education — Full-Day Program Certificate. Attorney: [NAME_REDACTED]. Program: Modern Law Practice Summit. Activity Number: WAE-SUM-2026-021. Total CLE Hours: 8.0, allocated as 6.0 General, 1.0 Ethics, and 1.0 Professionalism. Approved by the Georgia Commission on Continuing Lawyer Competency. Delivery: In-Person Seminar. Date: February 27, 2026.',
    issuer: 'Willowbrook Attorney Education', date: '2026-02-27', jurisdiction: 'Georgia',
    hours: 8, activity: 'WAE-SUM-2026-021', delivery: 'In-Person Seminar', ethics: 1,
    approvedBy: 'Georgia Commission on Continuing Lawyer Competency',
  }),
  cle({
    n: 29, slug: 'cle-adv-multicredit-two-day', adversarial: 'multi-credit',
    description: 'Adversarial CLE — multi-credit two-day conference with per-day totals',
    text: 'Stonegate Legal Institute Annual Privacy Conference — Certificate of Attendance. Attorney: [NAME_REDACTED]. Dates: May 14-15, 2026. Day 1 credits: 6.0 General. Day 2 credits: 5.0 General plus 1.0 Ethics. Total CLE Hours awarded: 12.0. Activity Number: SLI-CONF-2026-003. Primary approval: New York CLE Board. Delivery: In-Person Seminar.',
    issuer: 'Stonegate Legal Institute', date: '2026-05-15', jurisdiction: 'New York',
    hours: 12, activity: 'SLI-CONF-2026-003', delivery: 'In-Person Seminar', ethics: 1,
    approvedBy: 'New York CLE Board',
  }),
  cle({
    n: 30, slug: 'cle-heldout-adv-multicredit', quality: 'degraded-scan', adversarial: 'multi-credit', heldOut: true,
    description: 'HELD-OUT adversarial CLE — degraded multi-credit allocation table',
    text: 'FAIRP0RT LAW SEMINARS || C0MBINED CLE CERTIFICATE || Att0rney : [NAME_REDACTED] || Pr0gram : Landl0rd-Tenant + Ethics D0uble Sessi0n || Activity : FLS-CMB-2026-201 || All0cati0n : | General | 2.0 | | Ethics | 1.0 | | T0TAL | 3.0 | || Appr0ved by Westfalia MCLE C0mmittee || Delivery Meth0d : Live Webcast || C0mpleted : June 17 , 2026',
    issuer: 'Fairport Law Seminars', date: '2026-06-17', jurisdiction: 'Westfalia',
    hours: 3, activity: 'FLS-CMB-2026-201', delivery: 'Live Webcast', ethics: 1,
    approvedBy: 'Westfalia MCLE Committee',
  }),
];

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

const ALL_SPECS: S3FixtureSpec[] = [...CPE_SPECS, ...CLE_SPECS];

/** The full S3 CPE/CLE golden set (gate + held-out splits). */
export const GOLDEN_DATASET_CPE_CLE_S3: GoldenDatasetEntry[] = ALL_SPECS.map(toEntry);

/** Gate split — scored by the SCRUM-2382 merge gate. */
export const CPE_CLE_S3_GATE_ENTRIES: GoldenDatasetEntry[] = GOLDEN_DATASET_CPE_CLE_S3.filter(
  (entry) => !entry.tags.includes(S3_HELDOUT_TAG),
);

/**
 * Held-out split — NEVER scored by merge gates (eval-gates.ts excludes the
 * `held-out` tag) and NEVER allowed into any committed prompt/few-shot/tuning
 * corpus (heldout-leakage.ts fails the build on contamination).
 */
export const CPE_CLE_S3_HELDOUT_ENTRIES: GoldenDatasetEntry[] = GOLDEN_DATASET_CPE_CLE_S3.filter(
  (entry) => entry.tags.includes(S3_HELDOUT_TAG),
);
