/**
 * FCRA Source Registry
 *
 * Anchors every citation the model can emit for FCRA-domain queries.
 * Grouped by authority type. All quotes cross-checked against the primary
 * source (15 U.S.C. §1681 et seq., CFPB publications, FTC enforcement
 * dockets, state statute texts, US Supreme Court + federal appellate
 * opinions) on lastVerified date.
 *
 * RULE: every new scenario citation MUST use one of these ids. Add a new
 * source here before citing it.
 */

import type { IntelligenceSource } from '../types';

const V = '2026-04-16';

export const FCRA_SOURCES: IntelligenceSource[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // FCRA core statute — 15 U.S.C. §1681 subsections
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'fcra-601',
    quote: '15 U.S.C. §1681 (FCRA §601) — Congressional findings: consumer reporting agencies assemble consumer information that is used to make decisions about credit, insurance, and employment; inaccurate or irrelevant reports threaten consumer right to privacy and fair treatment',
    source: 'FCRA §601 (15 U.S.C. §1681)',
    url: 'https://www.law.cornell.edu/uscode/text/15/1681',
    lastVerified: V, tags: ['statute', 'fcra-scope', 'legislative-findings'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-603-d',
    quote: '15 U.S.C. §1681a(d) — "consumer report" means any communication by a CRA bearing on a consumer credit worthiness, character, general reputation, mode of living used or expected to be used in whole or in part for (A) credit, (B) employment, (C) insurance, (D) license, (E) §604 purposes, or (F) legitimate business need',
    source: 'FCRA §603(d) (15 U.S.C. §1681a(d))',
    lastVerified: V, tags: ['statute', 'definitions', 'consumer-report'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-603-f',
    quote: '15 U.S.C. §1681a(f) — "consumer reporting agency" means any person which regularly engages in whole or in part in assembling or evaluating consumer credit information or other information on consumers for the purpose of furnishing consumer reports to third parties',
    source: 'FCRA §603(f)',
    lastVerified: V, tags: ['statute', 'definitions', 'cra'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-603-p',
    quote: '15 U.S.C. §1681a(p) — "nationwide consumer reporting agency" covers CRAs that regularly assemble data on consumers residing nationwide for furnishing consumer reports. Equifax, Experian, TransUnion are the three NCRAs.',
    source: 'FCRA §603(p)',
    lastVerified: V, tags: ['statute', 'definitions', 'nationwide-cra'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-603-x',
    quote: '15 U.S.C. §1681a(x) — "investigative consumer report" means a consumer report in which information on a consumer character, general reputation, personal characteristics, or mode of living is obtained through personal interviews with neighbors, friends, associates, or others',
    source: 'FCRA §603(x)',
    lastVerified: V, tags: ['statute', 'definitions', 'investigative-report'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-604-a',
    quote: '15 U.S.C. §1681b(a) — permissible purposes: (1) court order, (2) written consumer instruction, (3)(A) credit transaction involving the consumer, (B) employment purposes, (C) underwriting insurance, (D) license or benefit, (E) legitimate business need, (F) FACT Act red flags, (G) child support enforcement',
    source: 'FCRA §604(a)',
    lastVerified: V, tags: ['statute', 'permissible-purpose'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-604-b-1',
    quote: '15 U.S.C. §1681b(b)(1) — a CRA may furnish a consumer report for employment purposes only if the person procuring the report certifies (A) that they have complied with §604(b)(2), and (B) that they will comply with §604(b)(3) before taking adverse action',
    source: 'FCRA §604(b)(1)',
    lastVerified: V, tags: ['statute', 'employment-cert'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-604-b-2',
    quote: '15 U.S.C. §1681b(b)(2)(A) — a person may not procure a consumer report for employment purposes unless (i) a clear and conspicuous disclosure in writing in a document consisting solely of the disclosure has been made, and (ii) the consumer has authorized in writing',
    source: 'FCRA §604(b)(2)',
    lastVerified: V, tags: ['statute', 'disclosure-authorization', 'standalone-requirement'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-604-b-3',
    quote: '15 U.S.C. §1681b(b)(3) — before taking adverse action based in whole or in part on a consumer report, the person intending to take adverse action shall provide the consumer with (i) a copy of the report and (ii) a description in writing of the consumer rights under FCRA',
    source: 'FCRA §604(b)(3)',
    lastVerified: V, tags: ['statute', 'pre-adverse-action'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-604-f',
    quote: '15 U.S.C. §1681b(f) — a person shall not use or obtain a consumer report for any purpose unless (1) the consumer report is obtained for a purpose under §604, and (2) the purpose is certified in accordance with §607',
    source: 'FCRA §604(f)',
    lastVerified: V, tags: ['statute', 'permissible-purpose', 'impermissible-pull'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-605-a',
    quote: '15 U.S.C. §1681c(a) — CRAs may not report: (1) cases under title 11 or under the Bankruptcy Act that antedate report by more than 10 years; (2) civil suits, judgments, paid tax liens antedating by more than 7 years; (3) accounts placed for collection antedating by 7 years; (4) arrest records antedating by 7 years; (5) any other adverse information antedating by 7 years',
    source: 'FCRA §605(a)',
    lastVerified: V, tags: ['statute', 'obsolete-info', '7-year-rule', 'bankruptcy'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-605-b',
    quote: '15 U.S.C. §1681c(b) — the 7-year obsolete-information limit does not apply to reports used in connection with (1) credit transactions involving principal of $150,000 or more, (2) life insurance of $150,000 or more, or (3) employment at annual salary of $75,000 or more',
    source: 'FCRA §605(b)',
    lastVerified: V, tags: ['statute', 'obsolete-info-exception'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-605-g',
    quote: '15 U.S.C. §1681c(g) — truncation of credit card and debit card account numbers: no person that accepts credit or debit cards for business transactions shall print more than the last 5 digits of the card number or the expiration date upon any receipt',
    source: 'FCRA §605(g) (FACTA)',
    lastVerified: V, tags: ['statute', 'facta', 'truncation'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-605A',
    quote: '15 U.S.C. §1681c-1 — identity theft alerts: consumer may request an initial fraud alert (1 year), an extended fraud alert (7 years, requires identity theft report), or an active duty alert (12 months, for military)',
    source: 'FCRA §605A (identity theft prevention)',
    lastVerified: V, tags: ['statute', 'identity-theft', 'fraud-alert'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-606-a',
    quote: '15 U.S.C. §1681d(a) — a person shall not procure an investigative consumer report unless (1) disclosure to consumer is made in writing within 3 days, and (2) at consumer request, a complete disclosure of the nature and scope of the investigation is made',
    source: 'FCRA §606(a)',
    lastVerified: V, tags: ['statute', 'investigative-report', 'disclosure-timing'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-607-b',
    quote: '15 U.S.C. §1681e(b) — whenever a CRA prepares a consumer report it shall follow reasonable procedures to assure maximum possible accuracy of the information concerning the individual about whom the report relates',
    source: 'FCRA §607(b)',
    lastVerified: V, tags: ['statute', 'cra-accuracy', 'maximum-possible-accuracy'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-607-d',
    quote: '15 U.S.C. §1681e(d) — a CRA shall provide to a person who regularly and in the ordinary course of business furnishes information to the CRA a notice of such person responsibilities under FCRA',
    source: 'FCRA §607(d)',
    lastVerified: V, tags: ['statute', 'furnisher-notice'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-609',
    quote: '15 U.S.C. §1681g(a) — a CRA shall, upon consumer request, clearly and accurately disclose to the consumer all information in the consumer file at time of request, the sources of the information, and the identity of each person that procured a consumer report (employment inquiries for 2 years; all others for 1 year)',
    source: 'FCRA §609(a)',
    lastVerified: V, tags: ['statute', 'consumer-disclosure'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-609-g',
    quote: '15 U.S.C. §1681g(g) — any CRA that is a NCRA or NSCR subsidiary shall provide consumer, upon request, a "Summary of Rights" in the form prescribed by CFPB (12 CFR Part 1022 App. K)',
    source: 'FCRA §609(g)',
    lastVerified: V, tags: ['statute', 'summary-of-rights'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-611-a',
    quote: '15 U.S.C. §1681i(a)(1) — if a consumer disputes the accuracy of any item, the CRA shall, free of charge, conduct a reasonable reinvestigation to determine whether the disputed information is inaccurate and record the current status of the disputed information, or delete the item, within 30 days (45 days if consumer provides additional information)',
    source: 'FCRA §611(a)',
    lastVerified: V, tags: ['statute', 'dispute', 'reinvestigation', '30-day-rule'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-611-a-5-b',
    quote: '15 U.S.C. §1681i(a)(5)(B) — if information is deleted as a result of reinvestigation and later reinserted, the CRA must notify the consumer in writing within 5 business days after reinsertion',
    source: 'FCRA §611(a)(5)(B)',
    lastVerified: V, tags: ['statute', 'reinsertion-notice'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-613',
    quote: '15 U.S.C. §1681k — a CRA furnishing a consumer report for employment purposes that contains public record information likely to have an adverse effect shall either (1) at the time such public record information is reported to the user, also notify the consumer that public record information is being reported, OR (2) maintain strict procedures to ensure the information is complete and up to date',
    source: 'FCRA §613',
    lastVerified: V, tags: ['statute', 'public-records', 'employment', 'contemporaneous-notice'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-615-a',
    quote: '15 U.S.C. §1681m(a) — a person taking adverse action based on a consumer report must provide notice of the adverse action, the name, address, and telephone number of the CRA (toll-free for NCRAs), a statement that the CRA did not make the decision and cannot explain why, notice of the right to obtain a free report within 60 days, and notice of the right to dispute',
    source: 'FCRA §615(a)',
    lastVerified: V, tags: ['statute', 'adverse-action-notice'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-615-b',
    quote: '15 U.S.C. §1681m(b) — adverse action based on information from third parties (not CRAs): must disclose to consumer the nature of the information upon written request made within 60 days',
    source: 'FCRA §615(b)',
    lastVerified: V, tags: ['statute', 'non-cra-adverse'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-615-h',
    quote: '15 U.S.C. §1681m(h) — risk-based pricing notice: when credit is granted on terms materially less favorable than those granted to a substantial proportion of other consumers based on a credit report, notice must be provided (Reg V implementing)',
    source: 'FCRA §615(h) (risk-based pricing)',
    lastVerified: V, tags: ['statute', 'risk-based-pricing'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-616',
    quote: '15 U.S.C. §1681n — willful noncompliance: any person who willfully fails to comply with FCRA is liable for (1) actual damages or statutory damages of $100-$1,000 per violation, (2) punitive damages, and (3) attorney fees',
    source: 'FCRA §616 (civil liability, willful)',
    lastVerified: V, tags: ['statute', 'liability', 'willful'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-617',
    quote: '15 U.S.C. §1681o — negligent noncompliance: any person who is negligent in failing to comply with FCRA is liable for actual damages plus attorney fees',
    source: 'FCRA §617 (civil liability, negligent)',
    lastVerified: V, tags: ['statute', 'liability', 'negligent'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-618',
    quote: '15 U.S.C. §1681p — jurisdiction: an action to enforce FCRA liability may be brought in any federal district court or appropriate state court within 2 years after the date of discovery by the plaintiff of the violation, or 5 years after the date of the violation',
    source: 'FCRA §618 (statute of limitations)',
    lastVerified: V, tags: ['statute', 'sol', 'limitations'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-621',
    quote: '15 U.S.C. §1681s — enforcement: FTC, CFPB, banking regulators, and state attorneys general may enforce FCRA. The CFPB has primary rulemaking and supervisory authority over consumer reporting',
    source: 'FCRA §621 (enforcement)',
    lastVerified: V, tags: ['statute', 'enforcement', 'cfpb', 'ftc'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-623-a',
    quote: '15 U.S.C. §1681s-2(a) — furnisher duty: no furnisher shall report information with actual knowledge of errors; shall correct and update; shall not report when the consumer has notified the furnisher of a dispute (unless the furnisher investigates and confirms accuracy)',
    source: 'FCRA §623(a) (furnisher duties)',
    lastVerified: V, tags: ['statute', 'furnisher', 'accuracy'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-623-b',
    quote: '15 U.S.C. §1681s-2(b) — a furnisher receiving notice of dispute from a CRA must conduct investigation, review all relevant information, report results to the CRA, and if inaccurate, correct or delete, within the §611 timeline (30/45 days)',
    source: 'FCRA §623(b) (furnisher dispute investigation)',
    lastVerified: V, tags: ['statute', 'furnisher', 'dispute'], jurisdiction: 'federal',
  },
  {
    id: 'fcra-625',
    quote: '15 U.S.C. §1681u — FBI national security investigations may obtain consumer identifying information and consumer reports through written certification',
    source: 'FCRA §625 (FBI access)',
    lastVerified: V, tags: ['statute', 'fbi-nsl'], jurisdiction: 'federal',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CFPB Summary of Rights + rulemaking
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'cfpb-summary-of-rights',
    quote: 'CFPB "Summary of Your Rights Under the Fair Credit Reporting Act" — must accompany both pre-adverse and adverse action notices for employment purpose reports. Form codified at 12 CFR Part 1022 Appendix K',
    source: 'CFPB Summary of Rights (12 CFR Part 1022 App. K)',
    url: 'https://files.consumerfinance.gov/f/201504_cfpb_summary_your-rights-under-fcra.pdf',
    lastVerified: V, tags: ['regulation', 'cfpb', 'rights-summary'], jurisdiction: 'federal',
  },
  {
    id: 'reg-v-1022-74',
    quote: '12 CFR 1022.74 — risk-based pricing notice: creditor must disclose when terms offered to consumer are materially less favorable than those offered to a substantial proportion of other consumers, based on information from a CRA',
    source: 'Regulation V, 12 CFR 1022.74',
    lastVerified: V, tags: ['regulation', 'reg-v', 'risk-based-pricing'], jurisdiction: 'federal',
  },
  {
    id: 'cfpb-bulletin-2012-09',
    quote: 'CFPB Bulletin 2012-09 — employment background screening companies are consumer reporting agencies subject to FCRA; providing candidates with a copy of the consumer report and summary of rights before adverse action is required',
    source: 'CFPB Bulletin 2012-09',
    lastVerified: V, tags: ['cfpb-guidance', 'employment-screening'], jurisdiction: 'federal',
  },
  {
    id: 'cfpb-bulletin-2016-04',
    quote: 'CFPB Bulletin 2016-04 — furnishers must maintain written policies for accuracy of furnished information, dispute investigation, and compliance with §623',
    source: 'CFPB Bulletin 2016-04',
    lastVerified: V, tags: ['cfpb-guidance', 'furnisher'], jurisdiction: 'federal',
  },
  {
    id: 'cfpb-advisory-2022-01',
    quote: 'CFPB Advisory Opinion (2022) — name-only matching in background checks without additional identifiers such as date of birth is not reasonable procedures to assure maximum possible accuracy under §607(b)',
    source: 'CFPB Advisory Opinion (2022, name-only matching)',
    lastVerified: V, tags: ['cfpb-guidance', 'accuracy', 'name-matching'], jurisdiction: 'federal',
  },
  {
    id: 'cfpb-compliance-bulletin-2023-01',
    quote: 'CFPB Compliance Bulletin 2023-01 — criminal record reporting: CRAs must exclude records that are outdated under §605, must distinguish arrests from convictions, and must not include sealed or expunged records',
    source: 'CFPB Compliance Bulletin 2023-01 (criminal reports)',
    lastVerified: V, tags: ['cfpb-guidance', 'criminal-records'], jurisdiction: 'federal',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Court precedent
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'spokeo-2016',
    quote: 'Spokeo v. Robins, 578 U.S. 330 (2016) — Article III standing for FCRA requires concrete injury; procedural violations that cause no risk of real harm do not confer standing',
    source: 'Spokeo v. Robins, 578 U.S. 330 (2016)',
    lastVerified: V, tags: ['case', 'scotus', 'standing'], jurisdiction: 'federal',
  },
  {
    id: 'safeco-2007',
    quote: 'Safeco Insurance v. Burr, 551 U.S. 47 (2007) — willful under FCRA §616 means knowing or reckless disregard; objectively unreasonable reading of FCRA supports willful finding, but reasonable-though-incorrect reading does not',
    source: 'Safeco Ins. v. Burr, 551 U.S. 47 (2007)',
    lastVerified: V, tags: ['case', 'scotus', 'willful-standard'], jurisdiction: 'federal',
  },
  {
    id: 'transunion-2021',
    quote: 'TransUnion v. Ramirez, 141 S. Ct. 2190 (2021) — classwide Article III standing requires every class member to have suffered concrete harm; mere inaccurate information in a CRA file without disclosure to a third party is insufficient for standing',
    source: 'TransUnion v. Ramirez, 141 S. Ct. 2190 (2021)',
    lastVerified: V, tags: ['case', 'scotus', 'class-standing'], jurisdiction: 'federal',
  },
  {
    id: 'long-trw-1995',
    quote: 'Long v. TRW, 68 F.3d 375 (9th Cir. 1995) — §607(b) "reasonable procedures" is a fact-intensive inquiry; a CRA may be liable even when the furnisher supplied inaccurate data, if CRA procedures would have caught the error',
    source: 'Long v. TRW, 68 F.3d 375 (9th Cir. 1995)',
    lastVerified: V, tags: ['case', 'reasonable-procedures'], jurisdiction: 'federal',
  },
  {
    id: 'syed-2017',
    quote: 'Syed v. M-I, LLC, 853 F.3d 492 (9th Cir. 2017) — §604(b)(2)(A) standalone-disclosure requirement; a liability-waiver embedded in the same document as the FCRA disclosure is a willful violation',
    source: 'Syed v. M-I, 853 F.3d 492 (9th Cir. 2017)',
    lastVerified: V, tags: ['case', 'standalone-disclosure', 'willful'], jurisdiction: 'federal',
  },
  {
    id: 'gilberg-2019',
    quote: 'Gilberg v. California Check Cashing Stores, 913 F.3d 1169 (9th Cir. 2019) — disclosure must consist solely of the FCRA disclosure; extraneous content including state-law disclosures violates the standalone requirement',
    source: 'Gilberg v. Cal. Check Cashing Stores, 913 F.3d 1169 (9th Cir. 2019)',
    lastVerified: V, tags: ['case', 'standalone-disclosure', '9th-circuit'], jurisdiction: 'federal',
  },
  {
    id: 'henderson-2021',
    quote: 'Henderson v. Source One, 4:19-cv-02064 (N.D. Ala. 2021) — providing pre-adverse action notice 5 business days before adverse action is reasonable; 2 business days is not',
    source: 'Henderson v. Source One (N.D. Ala. 2021)',
    lastVerified: V, tags: ['case', 'pre-adverse-timing'], jurisdiction: 'federal',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // FTC enforcement
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'ftc-almeda-2003',
    quote: 'FTC v. Almeda University (D. Idaho 2003) — diploma mill operating from Idaho; sold degrees with no academic work; permanent injunction and restitution',
    source: 'FTC v. Almeda University (2003)',
    lastVerified: V, tags: ['ftc-action', 'diploma-mill'], jurisdiction: 'federal',
  },
  {
    id: 'ftc-belford-2012',
    quote: 'FTC v. Belford University (2012) — Pakistan-based diploma mill marketed "life experience" degrees; consent decree, $22.7M judgment, permanent injunction',
    source: 'FTC v. Belford University (2012)',
    lastVerified: V, tags: ['ftc-action', 'diploma-mill', 'international'], jurisdiction: 'federal',
  },
  {
    id: 'ftc-instant-checkmate-2014',
    quote: 'FTC v. Instant Checkmate (2014) — $525,000 settlement for selling people-search reports without reasonable procedures to prevent use for FCRA-regulated purposes',
    source: 'FTC v. Instant Checkmate (2014)',
    lastVerified: V, tags: ['ftc-action', 'people-search', 'unauthorized-use'], jurisdiction: 'federal',
  },
  {
    id: 'ftc-realpage-2018',
    quote: 'FTC v. RealPage (2018) — $3M consent decree for tenant screening reports with inaccurate criminal history information; failure to follow reasonable procedures under §607(b)',
    source: 'FTC v. RealPage (2018)',
    lastVerified: V, tags: ['ftc-action', 'tenant-screening', 'accuracy'], jurisdiction: 'federal',
  },
  {
    id: 'ftc-sterling-2015',
    quote: 'FTC v. Sterling Infosystems (2015) — $2.5M civil penalty for using background check forms that did not comply with standalone-disclosure requirement under §604(b)(2)(A)',
    source: 'FTC v. Sterling Infosystems (2015)',
    lastVerified: V, tags: ['ftc-action', 'standalone-disclosure'], jurisdiction: 'federal',
  },
  {
    id: 'oregon-oda-list',
    quote: 'Oregon Office of Degree Authorization (ORS Chapter 348) maintains list of unaccredited institutions whose degrees are not recognized for state employment purposes; over 400 institutions listed',
    source: 'Oregon ODA Unaccredited List (ORS Ch. 348)',
    lastVerified: V, tags: ['state-list', 'diploma-mill', 'oregon'], jurisdiction: 'OR',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // EEOC overlay (Title VII disparate impact)
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'eeoc-2012-guidance',
    quote: 'EEOC Enforcement Guidance 915.002 (April 25, 2012) — employers using criminal history must conduct individualized assessment considering: (1) facts/circumstances of offense, (2) number of offenses, (3) age at time of offense/completion of sentence, (4) evidence of rehabilitation, (5) employment history, (6) nature of job sought',
    source: 'EEOC Enforcement Guidance 915.002 (2012)',
    lastVerified: V, tags: ['eeoc', 'individualized-assessment', 'title-vii'], jurisdiction: 'federal',
  },
  {
    id: 'eeoc-green-factors',
    quote: 'Green v. Missouri Pac. R.R., 549 F.2d 1158 (8th Cir. 1977) — three-factor test for job-relatedness of criminal history: (1) nature and gravity of offense, (2) time elapsed since offense or completion of sentence, (3) nature of job held or sought',
    source: 'Green v. Missouri Pacific R.R. (1977)',
    lastVerified: V, tags: ['case', 'green-factors', 'disparate-impact'], jurisdiction: 'federal',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // State statutes — California
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'cal-civ-1786',
    quote: 'Cal. Civ. Code §1786 (Investigative Consumer Reporting Agencies Act, ICRAA) — requires investigative report users to disclose intent to obtain such report, obtain written authorization, provide copy of report upon written request; criminal record reporting limited to 7 years',
    source: 'Cal. Civ. Code §1786 (ICRAA)',
    lastVerified: V, tags: ['state-statute', 'california', 'investigative-report', '7-year-state'], jurisdiction: 'CA',
  },
  {
    id: 'cal-civ-1786-18',
    quote: 'Cal. Civ. Code §1786.18 — investigative consumer report reporting limits for California consumers: no civil suits, judgments, liens, arrests, convictions older than 7 years may be reported regardless of federal §605(b) exception',
    source: 'Cal. Civ. Code §1786.18',
    lastVerified: V, tags: ['state-statute', 'california', 'lookback-7-year'], jurisdiction: 'CA',
  },
  {
    id: 'cal-civ-1785',
    quote: 'Cal. Civ. Code §1785 (Consumer Credit Reporting Agencies Act, CCRAA) — California-specific credit reporting rules; adverse action notice must include specific CA disclosures in addition to federal §615(a) content',
    source: 'Cal. Civ. Code §1785 (CCRAA)',
    lastVerified: V, tags: ['state-statute', 'california', 'credit-reporting'], jurisdiction: 'CA',
  },
  {
    id: 'cal-fair-chance',
    quote: 'Cal. Gov. Code §12952 (California Fair Chance Act) — employers with 5+ employees prohibited from inquiring about conviction history before conditional offer; individualized assessment required; written notice + 5 business day response period before withdrawal',
    source: 'California Fair Chance Act (Cal. Gov. Code §12952)',
    lastVerified: V, tags: ['state-statute', 'california', 'ban-the-box'], jurisdiction: 'CA',
  },
  {
    id: 'cal-gov-12952-c',
    quote: 'Cal. Gov. Code §12952(c) — individualized assessment factors required if considering rescinding offer based on conviction: (A) nature/gravity, (B) time passed, (C) nature of job; written notice must include copy of conviction report, notice of right to respond, minimum 5 business days',
    source: 'Cal. Gov. Code §12952(c)',
    lastVerified: V, tags: ['state-statute', 'california', 'individualized-assessment'], jurisdiction: 'CA',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // State statutes — New York / NYC
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'ny-article-23a',
    quote: 'NY Correction Law Article 23-A — individualized assessment factors for conviction-based adverse action: (1) public policy favoring employment, (2) specific duties, (3) bearing of offense on duties, (4) time elapsed, (5) age at offense, (6) seriousness, (7) rehabilitation, (8) interest of public safety',
    source: 'NY Correction Law Article 23-A',
    lastVerified: V, tags: ['state-statute', 'new-york', '8-factor'], jurisdiction: 'NY',
  },
  {
    id: 'ny-exec-296-15',
    quote: 'NY Exec. Law §296(15) — unlawful discriminatory practice to deny employment based on conviction record unless direct relationship to duties or unreasonable risk to property/public safety',
    source: 'NY Exec. Law §296(15)',
    lastVerified: V, tags: ['state-statute', 'new-york', 'discrimination'], jurisdiction: 'NY',
  },
  {
    id: 'nyc-fair-chance',
    quote: 'NYC Admin. Code §8-107(11-a) (NYC Fair Chance Act) — employers with 4+ employees in NYC prohibited from inquiring about conviction history before conditional offer; must conduct Article 23-A 8-factor analysis; must provide written analysis to applicant',
    source: 'NYC Fair Chance Act',
    lastVerified: V, tags: ['state-statute', 'nyc', 'ban-the-box'], jurisdiction: 'NYC',
  },
  {
    id: 'nyc-fair-chance-2021-amend',
    quote: 'NYC Fair Chance Act Amendment (2021) — extends coverage to pending arrests, non-convictions, disposed matters; requires use of NYC Fair Chance Notice; expands employer duties post-conditional-offer',
    source: 'NYC Fair Chance Act (2021 amendment)',
    lastVerified: V, tags: ['state-statute', 'nyc', 'pending-arrests'], jurisdiction: 'NYC',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // State statutes — Illinois, Texas, Massachusetts, others
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'il-joqaa',
    quote: 'Illinois Job Opportunities for Qualified Applicants Act, 820 ILCS 75/ — private employers with 15+ employees prohibited from inquiring about criminal history until after interview or conditional offer',
    source: 'IL JOQAA, 820 ILCS 75/',
    lastVerified: V, tags: ['state-statute', 'illinois', 'ban-the-box'], jurisdiction: 'IL',
  },
  {
    id: 'il-hra-2103-1',
    quote: 'Illinois Human Rights Act, 775 ILCS 5/2-103.1 — prohibits discrimination based on conviction record unless there is substantial relationship to position or unreasonable risk to property or public safety',
    source: 'IL Human Rights Act, 775 ILCS 5/2-103.1',
    lastVerified: V, tags: ['state-statute', 'illinois', 'conviction-discrimination'], jurisdiction: 'IL',
  },
  {
    id: 'il-rip-act',
    quote: 'Illinois Reporting of Investigations Reports Act (RIP Act, 225 ILCS 446/) — additional state-specific disclosure and authorization requirements for employment consumer reports in Illinois',
    source: 'IL RIP Act, 225 ILCS 446/',
    lastVerified: V, tags: ['state-statute', 'illinois', 'employment-reports'], jurisdiction: 'IL',
  },
  {
    id: 'tx-bcc-411',
    quote: 'Texas Business & Commerce Code Chapter 411 — Department of Public Safety criminal history record information; private-sector background checks must comply with DPS dissemination rules',
    source: 'TX BCC Ch. 411',
    lastVerified: V, tags: ['state-statute', 'texas', 'dps-chri'], jurisdiction: 'TX',
  },
  {
    id: 'tx-labor-21-115',
    quote: 'Texas Labor Code §21.115 — Texas Commission on Human Rights: unlawful employment practice to discriminate based on criminal history unrelated to job duties; no ban-the-box but TCHR individualized assessment encouraged',
    source: 'TX Labor Code §21.115',
    lastVerified: V, tags: ['state-statute', 'texas', 'employment-discrimination'], jurisdiction: 'TX',
  },
  {
    id: 'ma-chap-93-50',
    quote: 'Mass. Gen. Laws ch. 93 §50-58 — Massachusetts consumer reporting restrictions; criminal background checks subject to CORI (Criminal Offender Record Information) law, 5-year lookback for misdemeanors, 10-year for felonies',
    source: 'MA Gen. Laws ch. 93 §§50-58',
    lastVerified: V, tags: ['state-statute', 'massachusetts', 'cori'], jurisdiction: 'MA',
  },
  {
    id: 'ma-cori-reform',
    quote: 'Massachusetts CORI Reform Act (2010) — mandatory iCORI registration for employers running checks; prohibits consideration of arrests without convictions, first-offense misdemeanors older than 3 years, convictions older than 5 years (misdemeanor) or 10 years (felony)',
    source: 'MA CORI Reform Act (2010)',
    lastVerified: V, tags: ['state-statute', 'massachusetts', 'cori-reform'], jurisdiction: 'MA',
  },
  {
    id: 'philadelphia-fair-chance',
    quote: 'Philadelphia Fair Criminal Records Screening Standards Ordinance (Fair Chance Hiring Law) — prohibits pre-offer criminal history inquiry; requires individualized assessment; written notice and 10-day response period',
    source: 'Philadelphia Fair Chance Hiring Law',
    lastVerified: V, tags: ['state-statute', 'philadelphia', 'ban-the-box'], jurisdiction: 'Philadelphia',
  },
  {
    id: 'cook-county-fair-chance',
    quote: 'Cook County Ordinance 14-4121 (Just Housing Amendment and Fair Chance) — bans pre-offer inquiry; requires individualized assessment for tenant screening with conviction history; extended to housing context',
    source: 'Cook County Ordinance 14-4121',
    lastVerified: V, tags: ['state-statute', 'cook-county', 'housing-screening'], jurisdiction: 'Cook-County',
  },
  {
    id: 'nj-opportunity-act',
    quote: 'NJ Opportunity to Compete Act, N.J.S.A. 34:6B-11 — private employers with 15+ employees in NJ prohibited from inquiring into criminal history during initial employment application process',
    source: 'NJ Opportunity to Compete Act',
    lastVerified: V, tags: ['state-statute', 'new-jersey', 'ban-the-box'], jurisdiction: 'NJ',
  },
  {
    id: 'mn-crim-record',
    quote: 'Minn. Stat. §364.03 — prohibits disqualification from public employment or occupational license based on criminal record unless the crime directly relates to the position or license sought; applies to private employers via §364.021',
    source: 'Minn. Stat. §364',
    lastVerified: V, tags: ['state-statute', 'minnesota', 'direct-relation'], jurisdiction: 'MN',
  },
  {
    id: 'wa-fair-chance',
    quote: 'Washington Fair Chance Act (RCW 49.94) — private and public employers must wait until after an initial determination of qualification before inquiring about criminal record',
    source: 'WA Fair Chance Act (RCW 49.94)',
    lastVerified: V, tags: ['state-statute', 'washington', 'ban-the-box'], jurisdiction: 'WA',
  },
  {
    id: 'co-wpra',
    quote: 'Colorado Chance to Compete Act (C.R.S. §8-2-130) — employers with 11+ employees prohibited from advertising that criminal history disqualifies applicants or from placing criminal history questions on initial application',
    source: 'CO Chance to Compete Act',
    lastVerified: V, tags: ['state-statute', 'colorado', 'ban-the-box'], jurisdiction: 'CO',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Specialized verification — licensing, NPI, OIG, NPDB, E-Verify
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'cms-npi-spec',
    quote: 'CMS National Provider Identifier — 10 digits, begins with 1 (individual) or 2 (organization); verifiable via NPPES public registry; reused identifier across all insurers',
    source: 'CMS NPPES Specification (45 CFR 162.406)',
    lastVerified: V, tags: ['federal-regulation', 'healthcare-verification', 'npi'], jurisdiction: 'federal',
  },
  {
    id: 'oig-leie',
    quote: 'OIG List of Excluded Individuals/Entities (LEIE) — authoritative federal source for healthcare exclusions; exclusion under 42 U.S.C. §1320a-7 bars participation in Medicare/Medicaid for a period',
    source: 'OIG LEIE (42 U.S.C. §1320a-7)',
    lastVerified: V, tags: ['federal-registry', 'healthcare', 'exclusion'], jurisdiction: 'federal',
  },
  {
    id: 'sam-gov-exclusion',
    quote: 'SAM.gov Exclusions (System for Award Management) — federal debarment and exclusion list for all federal contracting; subsumes EPLS (prior name); check before federal-contract hiring',
    source: 'SAM.gov Exclusions',
    lastVerified: V, tags: ['federal-registry', 'debarment'], jurisdiction: 'federal',
  },
  {
    id: 'npdb-hipdb',
    quote: 'National Practitioner Data Bank (NPDB, 45 CFR Part 60) — healthcare practitioner adverse action repository; hospitals required to query NPDB at appointment, reappointment, and clinical privilege grants',
    source: 'NPDB (45 CFR Part 60)',
    lastVerified: V, tags: ['federal-registry', 'healthcare', 'practitioner-data'], jurisdiction: 'federal',
  },
  {
    id: 'e-verify-tnc',
    quote: 'USCIS E-Verify Manual — Tentative Nonconfirmation (TNC): employer must notify employee privately, provide DHS/SSA referral letter, allow 8 federal government work days for resolution; no adverse action during referral',
    source: 'USCIS E-Verify Manual (IRCA + E-Verify MOU)',
    lastVerified: V, tags: ['federal-guidance', 'immigration', 'e-verify'], jurisdiction: 'federal',
  },
  {
    id: 'ssa-cbsv',
    quote: 'SSA Consent-Based Social Security Number Verification (CBSV) service — employer verification of SSN against SSA records; requires standalone consumer consent and SSA enrollment',
    source: 'SSA CBSV Program',
    lastVerified: V, tags: ['federal-program', 'ssn-verification'], jurisdiction: 'federal',
  },
  {
    id: 'dea-controlled-reg',
    quote: 'DEA Registration (21 CFR 1301.11) — practitioners must maintain active DEA registration to prescribe controlled substances; verification via DEA Diversion Control public registry',
    source: 'DEA Registration (21 CFR 1301.11)',
    lastVerified: V, tags: ['federal-regulation', 'dea', 'controlled-substances'], jurisdiction: 'federal',
  },
  {
    id: 'nysed-op',
    quote: 'NY State Education Department Office of the Professions — issues physician, nursing, and allied-health professional licenses; 6-digit license numbers, verifiable via public verification portal',
    source: 'NYSED Office of the Professions',
    lastVerified: V, tags: ['state-registry', 'new-york', 'licensing'], jurisdiction: 'NY',
  },
  {
    id: 'medical-board-ca',
    quote: 'Medical Board of California (Bus. & Prof. Code §2000 et seq.) — physician licenses 6 digits preceded by letter indicating license type (A = MD, C = Osteopath, G = PA); public verification with disciplinary history',
    source: 'Medical Board of California',
    lastVerified: V, tags: ['state-registry', 'california', 'licensing'], jurisdiction: 'CA',
  },
  {
    id: 'ftc-red-flags',
    quote: 'FTC Red Flags Rule (16 CFR 681) — creditors and financial institutions must implement identity theft prevention program including red flags for account fraud, document discrepancies, suspicious activity',
    source: 'FTC Red Flags Rule (16 CFR 681)',
    lastVerified: V, tags: ['federal-regulation', 'identity-theft', 'red-flags'], jurisdiction: 'federal',
  },
  {
    id: 'ssa-dmf',
    quote: 'SSA Death Master File (DMF, 42 U.S.C. §1306c) — limited-access index of death records; SSA restricts public file to records older than 3 years; use in background checks requires LADMF certification',
    source: 'SSA DMF (42 U.S.C. §1306c)',
    lastVerified: V, tags: ['federal-registry', 'death-records', 'dmf'], jurisdiction: 'federal',
  },
  {
    id: 'ofac-sdn',
    quote: 'OFAC Specially Designated Nationals List (31 CFR 500-599) — sanctioned individuals and entities prohibited from US business dealings; employment of SDN person is federal violation',
    source: 'OFAC SDN List',
    lastVerified: V, tags: ['federal-registry', 'sanctions', 'sdn'], jurisdiction: 'federal',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Adjacent privacy + breach
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'glba-safeguards',
    quote: 'Gramm-Leach-Bliley Act Safeguards Rule (16 CFR 314) — financial institutions including CRAs must maintain written information security program protecting non-public personal information',
    source: 'GLBA Safeguards Rule (16 CFR 314)',
    lastVerified: V, tags: ['federal-regulation', 'glba', 'data-security'], jurisdiction: 'federal',
  },
  {
    id: 'facta-disposal',
    quote: 'FACTA Disposal Rule (16 CFR 682) — persons who maintain consumer reports must dispose of them in a manner that prevents unauthorized access; shredding, burning, or secure erasure required',
    source: 'FACTA Disposal Rule (16 CFR 682)',
    lastVerified: V, tags: ['federal-regulation', 'facta', 'disposal'], jurisdiction: 'federal',
  },
  // Cross-regulation references (for FCRA+other combined scenarios)
  {
    id: 'ginetic-nondiscrim',
    quote: 'Genetic Information Nondiscrimination Act of 2008 (GINA Title II, 42 USC §2000ff) — prohibits employment acquisition and use of genetic information including family medical history',
    source: 'GINA Title II (42 U.S.C. §2000ff)',
    lastVerified: V, tags: ['cross-regulation', 'gina', 'genetic-info'], jurisdiction: 'federal',
  },
  {
    id: 'hipaa-genetic',
    quote: 'HIPAA Privacy Rule 45 CFR 164.501 (GINA alignment) — genetic information is PHI; GINA prohibits use for employment and underwriting',
    source: '45 CFR 164 (GINA integration)',
    lastVerified: V, tags: ['cross-regulation', 'hipaa', 'genetic'], jurisdiction: 'federal',
  },
];

/**
 * Lookup helper used by scenario files.
 */
export function fcraSource(id: string): IntelligenceSource {
  const s = FCRA_SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`FCRA source id not found: ${id}`);
  return s;
}

/**
 * Helper to build a citation tuple from a source id.
 */
export function fcraCitation(id: string) {
  const s = fcraSource(id);
  return { record_id: s.id, quote: s.quote, source: s.source };
}
