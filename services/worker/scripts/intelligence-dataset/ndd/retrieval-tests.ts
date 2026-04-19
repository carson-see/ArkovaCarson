/**
 * NDD — retrieval expectations per story.
 *
 * Each expectation is a question the RAG layer should answer, plus the
 * set of source ids that the model's citations must include at least
 * one of. When available, we also assert the expected `EnforcementTier`
 * so the risk-analysis output can be scored deterministically.
 */

import type { NddRetrievalExpectation, NddStoryId } from './types.js';

export const NDD_RETRIEVAL_TESTS: Record<NddStoryId, NddRetrievalExpectation[]> = {
  'ndd-01-ny': [
    {
      query: 'NY SHIELD Act reasonable safeguards',
      mustCiteAnyOf: ['ny-shield-act-899-bb'],
    },
    {
      query: '23 NYCRR 500 breach notification timeline',
      mustCiteAnyOf: ['ny-23-nycrr-500'],
      expectedTier: 'CIVIL_MAJOR',
    },
    {
      query: 'NYC biometric identifier sign requirement',
      mustCiteAnyOf: ['nyc-biometric-disclosure'],
    },
  ],
  'ndd-02-ca': [
    {
      query: 'CCPA right to know categories',
      mustCiteAnyOf: ['ca-ccpa-1798-100'],
    },
    {
      query: 'CPRA sensitive personal information right to limit',
      mustCiteAnyOf: ['ca-cpra-1798-121'],
    },
    {
      query: 'California medical information authorization requirement',
      mustCiteAnyOf: ['ca-cmia-56-10'],
    },
    {
      query: 'California Delete Act 45-day deletion cadence',
      mustCiteAnyOf: ['ca-delete-act-sb-362'],
    },
  ],
  'ndd-03-hipaa-ocr': [
    {
      query: 'HIPAA breach notification 60-day deadline',
      mustCiteAnyOf: ['hipaa-164-404-breach-notice'],
    },
    {
      query: 'HIPAA willful neglect uncorrected penalty tier',
      mustCiteAnyOf: ['hitech-13410-tier-structure'],
      expectedTier: 'CIVIL_MAX',
    },
    {
      query: 'Largest HIPAA OCR settlement Anthem',
      mustCiteAnyOf: ['anthem-2018-settlement'],
    },
  ],
  'ndd-04-sox-pcaob': [
    {
      query: 'SOX CEO CFO certification',
      mustCiteAnyOf: ['sox-section-302'],
    },
    {
      query: 'Material weakness definition PCAOB',
      mustCiteAnyOf: ['pcaob-as-2201'],
    },
    {
      query: 'SOX 404 internal control over financial reporting',
      mustCiteAnyOf: ['sox-section-404'],
    },
  ],
  'ndd-05-ferpa': [
    {
      query: 'FERPA disclosure exceptions without consent',
      mustCiteAnyOf: ['ferpa-99-31-disclosure'],
    },
    {
      query: 'FERPA disclosure log requirement',
      mustCiteAnyOf: ['ferpa-99-32-disclosure-log'],
    },
    {
      query: 'FERPA directory information opt-out',
      mustCiteAnyOf: ['ferpa-99-37-directory-info'],
    },
  ],
  'ndd-06-fcra-employment': [
    {
      query: 'FCRA pre-adverse-action notice employment',
      mustCiteAnyOf: ['fcra-604-b-pre-adverse'],
    },
    {
      query: 'California ICRAA pre-adverse waiting period',
      mustCiteAnyOf: ['ca-icraa-1786-40'],
    },
    {
      query: 'NYC Fair Chance Act conditional offer requirement',
      mustCiteAnyOf: ['nyc-fair-chance-act'],
    },
  ],
  'ndd-07-kenya-odpc': [
    {
      query: 'Kenya DPA cross-border transfer',
      mustCiteAnyOf: ['kdpa-48-transfer'],
    },
    {
      query: 'ODPC data controller registration',
      mustCiteAnyOf: ['kdpa-registration-schedule'],
    },
    {
      query: 'Kenya data protection administrative fine',
      mustCiteAnyOf: ['kdpa-62-enforcement'],
      expectedTier: 'CIVIL_MAJOR',
    },
  ],
  'ndd-08-australia-app': [
    {
      query: 'APP 1 privacy policy transparency',
      mustCiteAnyOf: ['au-app-1-open-mgmt'],
    },
    {
      query: 'APP 6 use and disclosure secondary purpose',
      mustCiteAnyOf: ['au-app-6-use-disclosure'],
    },
    {
      query: 'APP 11 security reasonable steps',
      mustCiteAnyOf: ['au-app-11-security'],
    },
    {
      query: 'OAIC Medibank 2022 enforcement',
      mustCiteAnyOf: ['au-oaic-medibank-2024'],
      expectedTier: 'CIVIL_MAX',
    },
  ],
  'ndd-09-gdpr-dpa': [
    {
      query: 'GDPR accountability principle Article 5',
      mustCiteAnyOf: ['gdpr-article-5-principles'],
    },
    {
      query: 'GDPR DPIA high risk processing',
      mustCiteAnyOf: ['gdpr-article-35-dpia'],
    },
    {
      query: 'GDPR Article 46 SCCs third country',
      mustCiteAnyOf: ['gdpr-article-46-transfers'],
    },
    {
      query: 'Schrems II supplementary measures',
      mustCiteAnyOf: ['schrems-ii-c-311-18'],
    },
  ],
  'ndd-10-nigeria-sa': [
    {
      query: 'Nigeria NDPA cross-border transfer',
      mustCiteAnyOf: ['ndpa-2023-section-26'],
    },
    {
      query: 'Nigeria NDPC data controller of major importance registration',
      mustCiteAnyOf: ['ndpa-2023-section-48'],
    },
    {
      query: 'South Africa POPIA lawful processing grounds',
      mustCiteAnyOf: ['popia-section-11'],
    },
    {
      query: 'POPIA transborder flow adequate protection',
      mustCiteAnyOf: ['popia-section-72-transfer'],
    },
  ],
};
