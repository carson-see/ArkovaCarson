/**
 * Per-regulation JSON Schema whitelists for vLLM constrained decoding (NVI-16).
 *
 * Canonical IDs are inlined from the training dataset registries (scripts/intelligence-dataset/sources/)
 * to avoid importing files outside the worker rootDir boundary.
 */

// Canonical IDs extracted from scripts/intelligence-dataset/sources/*-sources.ts
const FCRA_IDS = [
  'fcra-601','fcra-603-d','fcra-603-f','fcra-603-p','fcra-603-x','fcra-604-a','fcra-604-b-1','fcra-604-b-2','fcra-604-b-3','fcra-604-f','fcra-605-a','fcra-605-b','fcra-605-g','fcra-605A','fcra-606-a','fcra-607-b','fcra-607-d','fcra-609','fcra-609-g','fcra-611-a','fcra-611-a-5-b','fcra-613','fcra-615-a','fcra-615-b','fcra-615-h','fcra-616','fcra-617','fcra-618','fcra-621','fcra-623-a','fcra-623-b','fcra-625','cfpb-summary-of-rights','reg-v-1022-74','cfpb-bulletin-2012-09','cfpb-bulletin-2016-04','cfpb-advisory-2022-01','cfpb-compliance-bulletin-2023-01','spokeo-2016','safeco-2007','transunion-2021','long-trw-1995','syed-2017','gilberg-2019','henderson-2021','ftc-almeda-2003','ftc-belford-2012','ftc-instant-checkmate-2014','ftc-realpage-2018','ftc-sterling-2015','oregon-oda-list','eeoc-2012-guidance','eeoc-green-factors','cal-civ-1786','cal-civ-1786-18','cal-civ-1785','cal-fair-chance','cal-gov-12952-c','ny-article-23a','ny-exec-296-15','nyc-fair-chance','nyc-fair-chance-2021-amend','il-joqaa','il-hra-2103-1','il-rip-act','tx-bcc-411','tx-labor-21-115','ma-chap-93-50','ma-cori-reform','philadelphia-fair-chance','cook-county-fair-chance','nj-opportunity-act','mn-crim-record','wa-fair-chance','co-wpra','cms-npi-spec','oig-leie','sam-gov-exclusion','npdb-hipdb','e-verify-tnc','ssa-cbsv','dea-controlled-reg','nysed-op','medical-board-ca','ftc-red-flags','ssa-dmf','ofac-sdn','glba-safeguards','facta-disposal','ginetic-nondiscrim','hipaa-genetic',
] as const;

const HIPAA_IDS = [
  'hipaa-act-1996','hitech-2009','hipaa-160-103-phi','hipaa-160-103-ce','hipaa-160-103-ba','hipaa-160-103-ephi','hipaa-164-502','hipaa-164-502-minimum-necessary','hipaa-164-506-tpo','hipaa-164-508-authorization','hipaa-164-508-psychotherapy','hipaa-164-510-opportunity','hipaa-164-512-public-health','hipaa-164-512-e','hipaa-164-512-f','hipaa-164-514-deidentification','hipaa-164-520-npp','hipaa-164-522-restriction','hipaa-164-524-access','hipaa-164-526-amendment','hipaa-164-528-accounting','hipaa-164-308-admin','hipaa-164-308-a1','hipaa-164-308-a5','hipaa-164-310-physical','hipaa-164-312-technical','hipaa-164-312-a2-iv','hipaa-164-312-d','hipaa-164-402-breach','hipaa-164-404-individual','hipaa-164-406-media','hipaa-164-408-hhs','hipaa-164-410-ba','hipaa-164-504-baa','hipaa-164-314-ba-security','hipaa-160-402-tier','hipaa-160-410-safe-harbor','ocr-anthem-2018','ocr-memorial-2017','ocr-premera-2019','ocr-right-of-access-2019','ca-cmia','ca-cmia-1798-82','tx-hb300','ny-shield-2019','il-mhddcc','fl-phic','npdb-hipdb','oig-leie','medical-board-ca','nysed-op','part-2','hipaa-employment-records','fcra-hipaa-intersection','hipaa-telehealth-2020','hipaa-part-2-amendment-2024','hipaa-sanction-policy','hipaa-workforce-training-2023','hipaa-genetic','hipaa-reproductive-2024','hipaa-minor','hipaa-deceased','hipaa-access-fees','hipaa-api-access-2024','hipaa-workplace-wellness','ada-medical-exam','ginetic-nondiscrim','state-breach-matrix',
] as const;

const FERPA_IDS = [
  'ferpa-20-1232g','ferpa-1232g-a','ferpa-1232g-b','ferpa-1232g-b-1','ferpa-1232g-b-2','ferpa-1232g-d','ferpa-1232g-f','ferpa-99-3-education-record','ferpa-99-3-pii','ferpa-99-3-school-official','ferpa-99-3-directory','ferpa-99-10','ferpa-99-20','ferpa-99-30','ferpa-99-31','ferpa-99-31-a-11','ferpa-99-32','ferpa-99-34','ferpa-99-35','ferpa-99-37','ferpa-99-61','ferpa-99-62','ferpa-99-63','ferpa-vpic-2008','ferpa-online-tools','ferpa-pta-2023','ppra-20-1232h','gepa-20-1232f','ferpa-hipaa-boundary','ny-education-2d','ca-sopipa','ca-ab-1584','il-sopa','co-siea','owasso-falvo-2002','gonzaga-doe-2002','fpco-enforcement-examples','ferpa-sunshine-state-law','ferpa-disciplinary-records','ferpa-clery-act-intersection','ferpa-law-enforcement-unit','ferpa-treatment-records','ferpa-verification-employment','ferpa-opt-out-scope','ada-medical-exam','ferpa-ex-parte-order',
] as const;

export interface ConstrainedDecodingSchema {
  regulation: string;
  version: string;
  canonicalIds: string[];
  jsonSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

function buildSchema(regulation: string, version: string, ids: string[]): ConstrainedDecodingSchema {
  return {
    regulation,
    version,
    canonicalIds: ids,
    jsonSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string' },
        confidence: { type: 'number', minimum: 0.55, maximum: 0.99 },
        risks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
            },
            required: ['description'],
          },
        },
        recommendations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
            },
            required: ['description'],
          },
        },
        citations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              record_id: { type: 'string', enum: ids },
              relevance: { type: 'string' },
            },
            required: ['record_id'],
          },
        },
      },
      required: ['answer', 'confidence', 'risks', 'recommendations', 'citations'],
    },
  };
}

export const FCRA_SCHEMA = buildSchema(
  'FCRA',
  'v27.3',
  [...FCRA_IDS],
);

export const HIPAA_SCHEMA = buildSchema(
  'HIPAA',
  'v28.0',
  [...HIPAA_IDS],
);

export const FERPA_SCHEMA = buildSchema(
  'FERPA',
  'v29.0',
  [...FERPA_IDS],
);

const SCHEMA_MAP: Record<string, ConstrainedDecodingSchema> = {
  fcra: FCRA_SCHEMA,
  hipaa: HIPAA_SCHEMA,
  ferpa: FERPA_SCHEMA,
};

/**
 * Look up a constrained decoding schema by regulation name.
 * Returns null if no schema exists for the regulation.
 */
export function getConstrainedSchema(regulation: string): ConstrainedDecodingSchema | null {
  return SCHEMA_MAP[regulation.toLowerCase()] ?? null;
}

const REGULATION_PATTERNS: Array<{ regulation: string; patterns: RegExp[] }> = [
  {
    regulation: 'FCRA',
    patterns: [
      /\bfcra\b/i,
      /\bfair\s+credit\s+reporting\s+act\b/i,
      /\bconsumer\s+report(?:ing)?\b/i,
      /\badverse\s+action\s+notice\b/i,
      /\bbackground\s+(?:check|screen)/i,
    ],
  },
  {
    regulation: 'HIPAA',
    patterns: [
      /\bhipaa\b/i,
      /\bhealth\s+insurance\s+portability/i,
      /\bphi\b/i,
      /\bprotected\s+health\s+information\b/i,
      /\bprivacy\s+rule\b/i,
      /\bcovered\s+entit(?:y|ies)\b/i,
    ],
  },
  {
    regulation: 'FERPA',
    patterns: [
      /\bferpa\b/i,
      /\bfamily\s+educational\s+rights/i,
      /\beducation\s+records?\b/i,
      /\bstudent\s+(?:education|privacy|records?)\b/i,
    ],
  },
];

/**
 * Detect which regulation a query is about based on keyword matching.
 * Returns null if no regulation is detected.
 */
export function detectRegulation(query: string): string | null {
  for (const { regulation, patterns } of REGULATION_PATTERNS) {
    if (patterns.some((p) => p.test(query))) {
      return regulation;
    }
  }
  return null;
}
