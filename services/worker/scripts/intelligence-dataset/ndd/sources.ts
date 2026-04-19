/**
 * NDD (Nessie Domain Depth) — anchored source registries per story.
 *
 * Compact per-jurisdiction registries seeded with the statutes,
 * regulations, and enforcement bulletins Nessie must cite. Seed sizes
 * are intentional (3–5 per story) — full coverage lands through the
 * NVI review pipeline once the gate closes and counsel approves each
 * regulation's source set.
 *
 * Everything here is hand-verified on 2026-04-18. Every entry must have
 * both a quote and a source label; urls are optional but preferred.
 */

import type { IntelligenceSource } from '../types.js';
import type { NddJurisdictionPack } from './types.js';

const V = '2026-04-18';

// ─────────────────────────────────────────────────────────────────────────
// NDD-01 — New York (SHIELD Act, 23 NYCRR 500, NYC biometric law)
// ─────────────────────────────────────────────────────────────────────────
const NY_SOURCES: IntelligenceSource[] = [
  {
    id: 'ny-shield-act-899-bb',
    quote: 'NY GBL §899-bb — any person or business that owns or licenses computerized data that includes private information of a NY resident shall develop, implement and maintain reasonable safeguards to protect the security, confidentiality and integrity of the private information',
    source: 'NY SHIELD Act (GBL §899-bb)',
    url: 'https://ag.ny.gov/resources/organizations/data-breach-reporting',
    lastVerified: V,
    tags: ['ny', 'shield-act', 'statute', 'safeguards'],
    jurisdiction: 'NY',
  },
  {
    id: 'ny-23-nycrr-500',
    quote: '23 NYCRR Part 500 — covered financial institutions must implement a cybersecurity program based on a risk assessment, designate a CISO, maintain audit trails, encrypt nonpublic information, and report cybersecurity events to the DFS Superintendent within 72 hours',
    source: '23 NYCRR Part 500 (DFS Cybersecurity Regulation)',
    url: 'https://www.dfs.ny.gov/industry_guidance/cybersecurity',
    lastVerified: V,
    tags: ['ny', 'dfs', 'regulation', 'cybersecurity', '72-hour'],
    jurisdiction: 'NY',
  },
  {
    id: 'nyc-biometric-disclosure',
    quote: 'NYC Admin Code §22-1202 — commercial establishments collecting biometric identifier information must disclose such collection by placing a clear and conspicuous sign near customer entrances; sale or exchange of biometric identifiers is prohibited',
    source: 'NYC Admin Code §22-1202 (Biometric Identifier Information Law)',
    lastVerified: V,
    tags: ['nyc', 'biometric', 'statute', 'commercial-establishment'],
    jurisdiction: 'NYC',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// NDD-02 — California (CCPA/CPRA, CalOPPA, CMIA, Delete Act)
// ─────────────────────────────────────────────────────────────────────────
const CA_SOURCES: IntelligenceSource[] = [
  {
    id: 'ca-ccpa-1798-100',
    quote: 'Cal. Civ. Code §1798.100 — a consumer has the right to request that a business disclose the categories and specific pieces of personal information the business has collected about the consumer',
    source: 'CCPA §1798.100 (as amended by CPRA)',
    url: 'https://oag.ca.gov/privacy/ccpa',
    lastVerified: V,
    tags: ['ca', 'ccpa', 'statute', 'right-to-know'],
    jurisdiction: 'CA',
  },
  {
    id: 'ca-cpra-1798-121',
    quote: 'Cal. Civ. Code §1798.121 — a consumer has the right to limit the use and disclosure of sensitive personal information to that which is necessary to perform the services reasonably expected',
    source: 'CPRA §1798.121 (Sensitive PI)',
    lastVerified: V,
    tags: ['ca', 'cpra', 'statute', 'sensitive-pi'],
    jurisdiction: 'CA',
  },
  {
    id: 'ca-cmia-56-10',
    quote: 'Cal. Civ. Code §56.10 — a health care provider, health care service plan, or contractor shall not disclose medical information regarding a patient without first obtaining an authorization, except as otherwise permitted',
    source: 'California CMIA §56.10',
    lastVerified: V,
    tags: ['ca', 'cmia', 'statute', 'medical-info'],
    jurisdiction: 'CA',
  },
  {
    id: 'ca-delete-act-sb-362',
    quote: 'California Delete Act (SB 362) — creates an accessible deletion mechanism whereby a consumer can request every registered data broker delete their personal information; brokers must honor requests every 45 days starting 2026',
    source: 'CA Delete Act (SB 362, 2023)',
    lastVerified: V,
    tags: ['ca', 'delete-act', 'statute', 'data-broker'],
    jurisdiction: 'CA',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// NDD-03 — HIPAA at OCR enforcement level
// ─────────────────────────────────────────────────────────────────────────
const HIPAA_OCR_SOURCES: IntelligenceSource[] = [
  {
    id: 'hipaa-164-404-breach-notice',
    quote: '45 CFR 164.404 — following a breach of unsecured protected health information a covered entity shall notify each individual whose PHI has been breached, no later than 60 calendar days after discovery',
    source: 'HIPAA Breach Notification Rule §164.404',
    url: 'https://www.hhs.gov/hipaa/for-professionals/breach-notification/',
    lastVerified: V,
    tags: ['hipaa', 'breach-rule', 'statute', '60-day'],
    jurisdiction: 'federal',
  },
  {
    id: 'hitech-13410-tier-structure',
    quote: 'HITECH §13410(d) — civil monetary penalty tiers for HIPAA violations: (1) unknowing, (2) reasonable cause, (3) willful neglect corrected, (4) willful neglect uncorrected; annual cap $2,067,813 per violation category (2024 inflation adjustment)',
    source: 'HITECH §13410(d) + 45 CFR 160.404 (CMP tiers)',
    lastVerified: V,
    tags: ['hipaa', 'hitech', 'statute', 'penalty-tiers'],
    jurisdiction: 'federal',
  },
  {
    id: 'ocr-corrective-action-framework',
    quote: 'HHS OCR Corrective Action Framework — typical CAP includes risk assessment, workforce training, incident response update, monitoring period (2–3 years), and reporting to OCR. Resolution Agreements are published publicly and carry reputational impact in addition to monetary settlement.',
    source: 'HHS OCR Resolution Agreements (administrative practice)',
    lastVerified: V,
    tags: ['hipaa', 'ocr', 'guidance', 'cap'],
    jurisdiction: 'federal',
  },
  {
    id: 'anthem-2018-settlement',
    quote: 'Anthem Inc. 2018 HIPAA settlement — $16M, the largest HIPAA OCR settlement at the time of resolution (October 2018). Findings: failure to conduct enterprise-wide risk analysis, insufficient procedures to review system activity, failure to identify and respond to a known cyberattack. CAP: 2-year monitoring.',
    source: 'HHS OCR v. Anthem Inc. 2018 Resolution Agreement',
    lastVerified: V,
    tags: ['hipaa', 'ocr', 'case', 'largest-settlement-2018'],
    jurisdiction: 'federal',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// NDD-04 — SOX materiality + PCAOB
// ─────────────────────────────────────────────────────────────────────────
const SOX_SOURCES: IntelligenceSource[] = [
  {
    id: 'sox-section-302',
    quote: 'SOX §302 — the CEO and CFO of each filer must certify, in each quarterly and annual report, that they have reviewed the report, that it does not contain material misstatements, and that the financial statements fairly present the financial condition',
    source: 'Sarbanes-Oxley Act §302 (15 U.S.C. §7241)',
    lastVerified: V,
    tags: ['sox', 'statute', 'certification', 'ceo-cfo'],
    jurisdiction: 'federal',
  },
  {
    id: 'sox-section-404',
    quote: 'SOX §404 — management assessment and auditor attestation on the effectiveness of internal control over financial reporting; accelerated filers must report material weaknesses identified by the audit',
    source: 'Sarbanes-Oxley Act §404 (15 U.S.C. §7262)',
    lastVerified: V,
    tags: ['sox', 'statute', 'icfr', 'material-weakness'],
    jurisdiction: 'federal',
  },
  {
    id: 'pcaob-as-2201',
    quote: 'PCAOB AS 2201 — an integrated audit of internal control over financial reporting integrated with an audit of financial statements. Material weakness is a deficiency, or a combination of deficiencies, in ICFR such that there is a reasonable possibility that a material misstatement will not be prevented or detected on a timely basis.',
    source: 'PCAOB AS 2201 (paragraphs A3, A7)',
    url: 'https://pcaobus.org/oversight/standards/auditing-standards/details/AS2201',
    lastVerified: V,
    tags: ['sox', 'pcaob', 'auditing-standard', 'material-weakness'],
    jurisdiction: 'federal',
  },
  {
    id: 'sox-section-906',
    quote: 'SOX §906 (18 U.S.C. §1350) — criminal penalties for knowing or willful certification of a periodic report that does not comport with all the requirements of §13(a) or §15(d) of the Exchange Act: knowing = up to $1M fine and/or 10 years imprisonment; willful = up to $5M and/or 20 years',
    source: 'Sarbanes-Oxley Act §906 (18 U.S.C. §1350)',
    lastVerified: V,
    tags: ['sox', 'statute', 'criminal', 'certification'],
    jurisdiction: 'federal',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// NDD-05 — FERPA (university registrar / FPCO enforcement)
// ─────────────────────────────────────────────────────────────────────────
const FERPA_SOURCES: IntelligenceSource[] = [
  {
    id: 'ferpa-99-31-disclosure',
    quote: '34 CFR 99.31 — a school may disclose PII from an education record without consent to school officials with legitimate educational interest, for health/safety emergencies, to comply with a judicial order or lawfully issued subpoena, and other enumerated exceptions',
    source: 'FERPA §99.31 disclosure exceptions',
    url: 'https://studentprivacy.ed.gov/',
    lastVerified: V,
    tags: ['ferpa', 'statute', 'disclosure'],
    jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-32-disclosure-log',
    quote: '34 CFR 99.32 — each educational agency or institution shall maintain a record of each request for access to and each disclosure of personally identifiable information from the education records of each student',
    source: 'FERPA §99.32 disclosure log requirement',
    lastVerified: V,
    tags: ['ferpa', 'statute', 'disclosure-log'],
    jurisdiction: 'federal',
  },
  {
    id: 'ferpa-99-37-directory-info',
    quote: '34 CFR 99.37 — before an educational agency or institution may disclose directory information, it must provide public notice and allow a reasonable time for parents or eligible students to opt out',
    source: 'FERPA §99.37 directory information',
    lastVerified: V,
    tags: ['ferpa', 'statute', 'directory-info'],
    jurisdiction: 'federal',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// NDD-06 — FCRA employment screening + state overlays
// ─────────────────────────────────────────────────────────────────────────
const FCRA_EMPLOYMENT_SOURCES: IntelligenceSource[] = [
  {
    id: 'fcra-604-b-pre-adverse',
    quote: 'FCRA §604(b)(3) — before taking adverse action based on a consumer report, the employer must provide the consumer with a copy of the report and a description of the consumer\'s rights under the FCRA',
    source: 'FCRA §604(b)(3) (15 U.S.C. §1681b(b)(3))',
    lastVerified: V,
    tags: ['fcra', 'employment', 'statute', 'pre-adverse'],
    jurisdiction: 'federal',
  },
  {
    id: 'fcra-615-adverse-action',
    quote: 'FCRA §615(a) — any user of a consumer report who takes adverse action based in whole or in part on that report shall provide the consumer with notice, the CRA\'s name/address/phone, and notice of the right to dispute',
    source: 'FCRA §615(a) (15 U.S.C. §1681m)',
    lastVerified: V,
    tags: ['fcra', 'employment', 'statute', 'adverse-action'],
    jurisdiction: 'federal',
  },
  {
    id: 'ca-icraa-1786-40',
    quote: 'California ICRAA §1786.40 — pre-adverse-action requirement plus 5-day waiting period before adverse action may be taken; investigative consumer report definition is broader than FCRA',
    source: 'California ICRAA §1786.40',
    lastVerified: V,
    tags: ['ca', 'icraa', 'statute', 'state-overlay'],
    jurisdiction: 'CA',
  },
  {
    id: 'nyc-fair-chance-act',
    quote: 'NYC Fair Chance Act — employers must (a) extend conditional offer before asking about criminal history, (b) conduct individualized Article 23-A analysis, (c) provide Fair Chance Notice with copy of the report and reasoning',
    source: 'NYC Admin Code §8-107(11-a) (Fair Chance Act)',
    lastVerified: V,
    tags: ['nyc', 'fair-chance', 'statute', 'ban-the-box'],
    jurisdiction: 'NYC',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// NDD-07 — Kenya DPA 2019 + ODPC cross-border
// ─────────────────────────────────────────────────────────────────────────
const KENYA_SOURCES: IntelligenceSource[] = [
  {
    id: 'kdpa-48-transfer',
    quote: 'KDPA §48 — a data controller or processor may transfer personal data outside Kenya where the Data Commissioner is satisfied that the recipient provides adequate level of protection, or where the data subject has given explicit consent',
    source: 'Kenya Data Protection Act 2019 §48',
    url: 'https://www.odpc.go.ke/',
    lastVerified: V,
    tags: ['kenya', 'kdpa', 'statute', 'cross-border'],
    jurisdiction: 'KE',
  },
  {
    id: 'kdpa-registration-schedule',
    quote: 'Data Protection (Registration of Data Controllers and Processors) Regulations 2021 — mandatory registration with the ODPC for entities with annual turnover above KES 5M or processing sensitive personal data, renewable every 24 months',
    source: 'Kenya Data Protection Regulations 2021 (registration)',
    lastVerified: V,
    tags: ['kenya', 'kdpa', 'regulation', 'odpc-registration'],
    jurisdiction: 'KE',
  },
  {
    id: 'kdpa-62-enforcement',
    quote: 'KDPA §62 — administrative fine of up to KES 5 million or 1% of annual turnover (whichever is lower) for breach of the Act; the Data Commissioner may issue enforcement notices and impose progressive sanctions',
    source: 'Kenya Data Protection Act 2019 §62',
    lastVerified: V,
    tags: ['kenya', 'kdpa', 'statute', 'enforcement'],
    jurisdiction: 'KE',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// NDD-08 — Australia APP 13 principles + NDB
// ─────────────────────────────────────────────────────────────────────────
const AU_SOURCES: IntelligenceSource[] = [
  {
    id: 'au-app-1-open-mgmt',
    quote: 'APP 1 — an APP entity must manage personal information in an open and transparent way; must have a clearly expressed and up-to-date privacy policy describing the kinds of PI collected, purposes, and access mechanism',
    source: 'Privacy Act 1988 (Cth) Schedule 1 APP 1',
    lastVerified: V,
    tags: ['australia', 'app', 'statute', 'transparency'],
    jurisdiction: 'AU',
  },
  {
    id: 'au-app-6-use-disclosure',
    quote: 'APP 6 — an APP entity that holds PI collected for a particular purpose must not use or disclose the information for another purpose unless the individual consented, the secondary use is related and within reasonable expectation, or an enumerated exception applies',
    source: 'Privacy Act 1988 (Cth) Schedule 1 APP 6',
    lastVerified: V,
    tags: ['australia', 'app', 'statute', 'use-disclosure'],
    jurisdiction: 'AU',
  },
  {
    id: 'au-app-11-security',
    quote: 'APP 11 — an APP entity must take such steps as are reasonable in the circumstances to protect PI from misuse, interference and loss; and from unauthorised access, modification or disclosure',
    source: 'Privacy Act 1988 (Cth) Schedule 1 APP 11',
    lastVerified: V,
    tags: ['australia', 'app', 'statute', 'security'],
    jurisdiction: 'AU',
  },
  {
    id: 'au-oaic-medibank-2024',
    quote: 'OAIC v Medibank (2024) — civil penalty proceedings alleging APP 11.1 contravention following the 2022 cyber incident affecting 9.7M customers; illustrates OAIC willingness to pursue maximum civil penalties (up to AUD 50M per contravention)',
    source: 'OAIC v Medibank Private Ltd (Federal Court, 2024)',
    lastVerified: V,
    tags: ['australia', 'enforcement', 'case', 'max-penalty'],
    jurisdiction: 'AU',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// NDD-09 — GDPR DPA enforcement + Schrems II
// ─────────────────────────────────────────────────────────────────────────
const GDPR_SOURCES: IntelligenceSource[] = [
  {
    id: 'gdpr-article-5-principles',
    quote: 'GDPR Article 5 — personal data shall be: (a) processed lawfully, fairly and transparently; (b) collected for specified purposes; (c) adequate and limited; (d) accurate; (e) kept no longer than necessary; (f) processed securely; (2) controller shall be responsible for demonstrating compliance ("accountability")',
    source: 'Regulation (EU) 2016/679 Article 5',
    lastVerified: V,
    tags: ['gdpr', 'statute', 'principles'],
    jurisdiction: 'EU',
  },
  {
    id: 'gdpr-article-35-dpia',
    quote: 'GDPR Article 35 — a DPIA is mandatory where processing is likely to result in a high risk to the rights and freedoms of natural persons, particularly systematic and extensive profiling, large-scale special category data, or systematic monitoring of a publicly accessible area',
    source: 'Regulation (EU) 2016/679 Article 35 (DPIA)',
    lastVerified: V,
    tags: ['gdpr', 'statute', 'dpia'],
    jurisdiction: 'EU',
  },
  {
    id: 'gdpr-article-46-transfers',
    quote: 'GDPR Article 46 — transfers to third countries are permitted if the controller provides appropriate safeguards: binding corporate rules, standard contractual clauses adopted by the Commission, approved code of conduct, or approved certification mechanism',
    source: 'Regulation (EU) 2016/679 Article 46 (SCCs)',
    lastVerified: V,
    tags: ['gdpr', 'statute', 'cross-border', 'sccs'],
    jurisdiction: 'EU',
  },
  {
    id: 'schrems-ii-c-311-18',
    quote: 'Schrems II (C-311/18) — the CJEU invalidated the EU-US Privacy Shield and held that controllers relying on SCCs must verify, on a case-by-case basis, whether the laws of the third country ensure adequate protection and adopt supplementary measures where necessary',
    source: 'CJEU Case C-311/18 Schrems II (16 July 2020)',
    lastVerified: V,
    tags: ['gdpr', 'case', 'cross-border', 'schrems-ii'],
    jurisdiction: 'EU',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// NDD-10 — Nigeria NDPA + South Africa POPIA
// ─────────────────────────────────────────────────────────────────────────
const NIGERIA_SA_SOURCES: IntelligenceSource[] = [
  {
    id: 'ndpa-2023-section-26',
    quote: 'Nigeria Data Protection Act 2023 §26 — a data controller must comply with all requirements of the Act regarding cross-border transfer of personal data; the Nigeria Data Protection Commission (NDPC) may prohibit transfers where the destination country lacks adequate protection',
    source: 'Nigeria Data Protection Act 2023 §26 (cross-border)',
    url: 'https://ndpc.gov.ng/',
    lastVerified: V,
    tags: ['nigeria', 'ndpa', 'statute', 'cross-border'],
    jurisdiction: 'NG',
  },
  {
    id: 'ndpa-2023-section-48',
    quote: 'Nigeria NDPA 2023 §48 — data controllers of major importance (processing data of more than 5,000 data subjects in a 12-month period) must register with the NDPC and appoint a Data Protection Officer',
    source: 'Nigeria Data Protection Act 2023 §48 (registration)',
    lastVerified: V,
    tags: ['nigeria', 'ndpa', 'statute', 'registration'],
    jurisdiction: 'NG',
  },
  {
    id: 'ndpa-2023-section-52-penalty',
    quote: 'Nigeria NDPA 2023 §52 — NDPC may impose administrative sanctions on a data controller of major importance up to the greater of NGN 10 million or 2% of annual gross revenue in the preceding year',
    source: 'Nigeria Data Protection Act 2023 §52 (administrative sanctions)',
    lastVerified: V,
    tags: ['nigeria', 'ndpa', 'statute', 'penalty'],
    jurisdiction: 'NG',
  },
  {
    id: 'popia-section-11',
    quote: 'POPIA §11 — personal information may only be processed if the data subject consents, processing is necessary for a contract, compliance with a legal obligation, protecting a legitimate interest, or a public law obligation',
    source: 'South Africa POPIA §11 (lawful processing)',
    url: 'https://inforegulator.org.za/',
    lastVerified: V,
    tags: ['south-africa', 'popia', 'statute', 'lawful-processing'],
    jurisdiction: 'ZA',
  },
  {
    id: 'popia-section-72-transfer',
    quote: 'POPIA §72 — transborder flows of personal information are permitted to a third party in a foreign country only if the recipient is subject to a law, binding corporate rules, or binding agreement providing adequate protection',
    source: 'South Africa POPIA §72 (cross-border)',
    lastVerified: V,
    tags: ['south-africa', 'popia', 'statute', 'cross-border'],
    jurisdiction: 'ZA',
  },
  {
    id: 'popia-section-109-penalties',
    quote: 'POPIA §109 — the Information Regulator may issue administrative fines up to ZAR 10 million; criminal offences under POPIA carry imprisonment up to 10 years for offences under §§100–106 + §103(1), and up to 12 months or ZAR 10M fine for other offences',
    source: 'South Africa POPIA §109 (administrative fines + criminal penalties)',
    lastVerified: V,
    tags: ['south-africa', 'popia', 'statute', 'penalties'],
    jurisdiction: 'ZA',
  },
];

// ---------------------------------------------------------------------------
// Jurisdiction-to-sources export
// ---------------------------------------------------------------------------

export const NDD_SOURCES_BY_STORY = {
  'ndd-01-ny': NY_SOURCES,
  'ndd-02-ca': CA_SOURCES,
  'ndd-03-hipaa-ocr': HIPAA_OCR_SOURCES,
  'ndd-04-sox-pcaob': SOX_SOURCES,
  'ndd-05-ferpa': FERPA_SOURCES,
  'ndd-06-fcra-employment': FCRA_EMPLOYMENT_SOURCES,
  'ndd-07-kenya-odpc': KENYA_SOURCES,
  'ndd-08-australia-app': AU_SOURCES,
  'ndd-09-gdpr-dpa': GDPR_SOURCES,
  'ndd-10-nigeria-sa': NIGERIA_SA_SOURCES,
} as const satisfies Record<NddJurisdictionPack['storyId'], IntelligenceSource[]>;

/** Flat list of every NDD source across every story. */
export const ALL_NDD_SOURCES: IntelligenceSource[] = Object.values(NDD_SOURCES_BY_STORY).flat();
