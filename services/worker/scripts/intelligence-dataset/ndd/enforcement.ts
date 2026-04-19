/**
 * NDD — enforcement ladder per story.
 *
 * Each story has a ladder of penalty/severity tiers backed by the
 * anchored source registry. The model is trained to emit the matching
 * `EnforcementTier` whenever it produces a risk analysis for the
 * regulation in question.
 *
 * Keeping the ladder data-driven (not embedded in scenarios) means new
 * scenarios pick up the correct tier automatically and unit tests can
 * assert tier assignment without running the model.
 */

import type { NddEnforcementRule, NddStoryId } from './types.js';

export const NDD_ENFORCEMENT_LADDERS: Record<NddStoryId, NddEnforcementRule[]> = {
  'ndd-01-ny': [
    {
      name: 'SHIELD Act civil penalty (per violation)',
      tier: 'CIVIL_MINOR',
      anchorSources: ['ny-shield-act-899-bb'],
      penalty: 'Up to $5,000 per violation (GBL §899-bb), injunctive relief',
      confidenceBand: 'clear-statute',
    },
    {
      name: '23 NYCRR 500 failure to report within 72h',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['ny-23-nycrr-500'],
      penalty: 'Per-day civil penalties by DFS; substantial enforcement actions against banks + insurers',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'NYC biometric law — sale prohibition',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['nyc-biometric-disclosure'],
      penalty: '$500–5,000 per violation; private right of action for sale violations',
      confidenceBand: 'common-interpretation',
    },
  ],
  'ndd-02-ca': [
    {
      name: 'CCPA/CPRA unintentional violation',
      tier: 'CIVIL_MINOR',
      anchorSources: ['ca-ccpa-1798-100', 'ca-cpra-1798-121'],
      penalty: '$2,500 per violation; 30-day cure for business-to-business',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'CCPA/CPRA intentional violation',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['ca-ccpa-1798-100'],
      penalty: '$7,500 per intentional violation or per violation involving minor\'s data',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'CMIA unauthorized disclosure',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['ca-cmia-56-10'],
      penalty: 'Actual damages, administrative fines up to $250K, criminal penalties for knowing disclosure',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'Delete Act non-compliance',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['ca-delete-act-sb-362'],
      penalty: '$200/day per deletion request (starting 2026); CPPA enforcement',
      confidenceBand: 'common-interpretation',
    },
  ],
  'ndd-03-hipaa-ocr': [
    {
      name: 'HIPAA Tier 1 — unknowing',
      tier: 'CIVIL_MINOR',
      anchorSources: ['hitech-13410-tier-structure'],
      penalty: '$100–$50,000 per violation, $2,067,813 annual cap (2024)',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'HIPAA Tier 4 — willful neglect, uncorrected',
      tier: 'CIVIL_MAX',
      anchorSources: ['hitech-13410-tier-structure'],
      penalty: '$68,928 per violation minimum; $2,067,813 annual cap (2024)',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'OCR Corrective Action Plan (multi-year monitoring)',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['ocr-corrective-action-framework', 'anthem-2018-settlement'],
      penalty: 'Resolution Agreement + 2–3 year CAP; public disclosure of findings',
      confidenceBand: 'common-interpretation',
    },
  ],
  'ndd-04-sox-pcaob': [
    {
      name: 'SOX §906 knowingly false certification',
      tier: 'CRIMINAL',
      anchorSources: ['sox-section-906'],
      penalty: 'Up to $1M fine and 10 years imprisonment; $5M and 20 years for willful (18 U.S.C. §1350)',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'SOX §404 material weakness disclosure',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['sox-section-404', 'pcaob-as-2201'],
      penalty: 'SEC enforcement, restated financials, loss of accelerated filer status; no automatic fine',
      confidenceBand: 'common-interpretation',
    },
  ],
  'ndd-05-ferpa': [
    {
      name: 'FERPA loss of federal funding (ultimate remedy)',
      tier: 'CIVIL_MAX',
      anchorSources: ['ferpa-99-31-disclosure'],
      penalty: 'Termination of ED funds — never actually imposed, but threat of administrative enforcement',
      confidenceBand: 'common-interpretation',
    },
    {
      name: 'FPCO administrative enforcement',
      tier: 'ADVISORY',
      anchorSources: ['ferpa-99-31-disclosure', 'ferpa-99-32-disclosure-log'],
      penalty: 'Complaint investigation, letter of finding, voluntary compliance agreement',
      confidenceBand: 'clear-statute',
    },
  ],
  'ndd-06-fcra-employment': [
    {
      name: 'FCRA statutory damages for willful noncompliance',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['fcra-604-b-pre-adverse', 'fcra-615-adverse-action'],
      penalty: '$100–$1,000 per violation plus actual damages, punitive damages, attorney\'s fees',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'California ICRAA — state statutory damages',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['ca-icraa-1786-40'],
      penalty: '$10,000 per violation plus actual damages; private right of action',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'NYC Fair Chance Act',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['nyc-fair-chance-act'],
      penalty: 'Compensatory damages, punitive damages, civil penalties up to $250K; NYCCHR enforcement',
      confidenceBand: 'common-interpretation',
    },
  ],
  'ndd-07-kenya-odpc': [
    {
      name: 'KDPA §62 administrative fine',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['kdpa-62-enforcement'],
      penalty: 'KES 5M or 1% of annual turnover (whichever is lower)',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'ODPC enforcement notice (pre-fine)',
      tier: 'CIVIL_MINOR',
      anchorSources: ['kdpa-registration-schedule'],
      penalty: 'Compliance order, remediation deadline; repeated failure escalates to §62',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'Cross-border transfer without §48 safeguards',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['kdpa-48-transfer'],
      penalty: 'Fines + prohibition notice; typical first step is ODPC cease-and-desist',
      confidenceBand: 'common-interpretation',
    },
  ],
  'ndd-08-australia-app': [
    {
      name: 'Privacy Act civil penalty (serious contravention)',
      tier: 'CIVIL_MAX',
      anchorSources: ['au-app-11-security', 'au-oaic-medibank-2024'],
      penalty: 'Up to AUD 50M per contravention, or 30% of adjusted turnover if larger (2022 amendments)',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'APP 1 transparency breach',
      tier: 'CIVIL_MINOR',
      anchorSources: ['au-app-1-open-mgmt'],
      penalty: 'OAIC determination, compensation order, apology requirement',
      confidenceBand: 'clear-statute',
    },
  ],
  'ndd-09-gdpr-dpa': [
    {
      name: 'GDPR Article 83(4) — procedural violation',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['gdpr-article-5-principles'],
      penalty: 'Up to EUR 10M or 2% of global annual turnover (whichever is higher)',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'GDPR Article 83(5) — substantive violation',
      tier: 'CIVIL_MAX',
      anchorSources: ['gdpr-article-5-principles', 'gdpr-article-46-transfers'],
      penalty: 'Up to EUR 20M or 4% of global annual turnover (whichever is higher)',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'Schrems II cross-border without supplementary measures',
      tier: 'CIVIL_MAX',
      anchorSources: ['schrems-ii-c-311-18', 'gdpr-article-46-transfers'],
      penalty: 'Falls under Article 83(5); recent Irish DPC Meta decision imposed EUR 1.2B',
      confidenceBand: 'common-interpretation',
    },
  ],
  'ndd-10-nigeria-sa': [
    {
      name: 'Nigeria NDPA §52 administrative sanction (major importance)',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['ndpa-2023-section-52-penalty', 'ndpa-2023-section-48'],
      penalty: 'Greater of NGN 10M or 2% of annual gross revenue (§52 sanctions for failures arising under §48 registration)',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'POPIA §72 unauthorized transborder flow',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['popia-section-72-transfer', 'popia-section-109-penalties'],
      penalty: 'Penalties under §109: admin fine up to ZAR 10M + criminal liability for §72 contravention',
      confidenceBand: 'clear-statute',
    },
    {
      name: 'POPIA §11 unlawful processing',
      tier: 'CIVIL_MAJOR',
      anchorSources: ['popia-section-11', 'popia-section-109-penalties'],
      penalty: 'Penalties under §109: admin fine up to ZAR 10M + compensation order via Information Regulator',
      confidenceBand: 'clear-statute',
    },
  ],
};
