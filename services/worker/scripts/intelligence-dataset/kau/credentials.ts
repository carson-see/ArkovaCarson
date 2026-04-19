/**
 * KAU-05 (SCRUM-753) — Kenya + Australia credential type taxonomy.
 *
 * Canonical registry for non-US credential types so the Gemini extraction
 * prompt and Nessie classifier both converge on the same strings. The
 * extractor emits the `id` verbatim; scenario authors reference the `id`
 * only. No free-text credential names.
 *
 * Sources (verified 2026-04-18):
 *   - Kenya National Examinations Council (KNEC) — KCPE, KCSE certificates
 *   - Teachers Service Commission (TSC) — teacher registration
 *   - Nursing Council of Kenya — nursing registration
 *   - Law Society of Kenya — advocates roll
 *   - Kenya Medical Practitioners and Dentists Council (KMPDC)
 *   - Australian Health Practitioner Regulation Agency (AHPRA) — 15 boards
 *   - Tertiary Education Quality and Standards Agency (TEQSA) register
 *   - Chartered Accountants Australia and New Zealand (CA ANZ)
 *   - CPA Australia
 *   - Law Society (per Australian state/territory)
 */

export type KauJurisdiction = 'KE' | 'AU' | 'AU-NSW' | 'AU-VIC' | 'AU-QLD' | 'AU-WA' | 'AU-SA' | 'AU-TAS' | 'AU-ACT' | 'AU-NT';

export type KauCredentialCategory =
  | 'education'
  | 'professional-license'
  | 'business-entity'
  | 'government-id';

export interface KauCredentialType {
  /** Stable kebab-case id emitted by the extractor. Never change after publish. */
  id: string;
  /** Canonical credential type from the base taxonomy (shared with US set). */
  canonicalType: 'DEGREE' | 'TRANSCRIPT' | 'LEGAL' | 'MEDICAL' | 'BUSINESS_ENTITY' | 'IDENTITY' | 'REGULATION' | 'ACCREDITATION';
  /** KE or AU (and state where applicable). */
  jurisdiction: KauJurisdiction;
  /** Broad category for downstream routing. */
  category: KauCredentialCategory;
  /** Display label for UI. */
  label: string;
  /** Issuing authority. */
  issuer: string;
  /** Regulatory statute or framework that controls the credential. */
  governingFramework: string;
  /** Phrases that commonly appear on the document (used as few-shot hints). */
  documentKeywords: string[];
  /** ISO date the entry was last verified against the issuer's public registry. */
  lastVerified: string;
}

const V = '2026-04-18';

export const KAU_CREDENTIAL_TYPES: KauCredentialType[] = [
  // Kenya — education
  {
    id: 'ke-knec-kcpe',
    canonicalType: 'DEGREE',
    jurisdiction: 'KE',
    category: 'education',
    label: 'Kenya Certificate of Primary Education (KCPE)',
    issuer: 'Kenya National Examinations Council',
    governingFramework: 'KNEC Act, 2012',
    documentKeywords: ['KNEC', 'KCPE', 'Kenya Certificate of Primary Education'],
    lastVerified: V,
  },
  {
    id: 'ke-knec-kcse',
    canonicalType: 'DEGREE',
    jurisdiction: 'KE',
    category: 'education',
    label: 'Kenya Certificate of Secondary Education (KCSE)',
    issuer: 'Kenya National Examinations Council',
    governingFramework: 'KNEC Act, 2012',
    documentKeywords: ['KNEC', 'KCSE', 'Kenya Certificate of Secondary Education'],
    lastVerified: V,
  },
  // Kenya — professional licenses
  {
    id: 'ke-tsc-registration',
    canonicalType: 'LEGAL',
    jurisdiction: 'KE',
    category: 'professional-license',
    label: 'Teachers Service Commission registration',
    issuer: 'Teachers Service Commission (TSC)',
    governingFramework: 'Teachers Service Commission Act, 2012',
    documentKeywords: ['TSC', 'Teachers Service Commission', 'TSC number'],
    lastVerified: V,
  },
  {
    id: 'ke-nck-nursing',
    canonicalType: 'MEDICAL',
    jurisdiction: 'KE',
    category: 'professional-license',
    label: 'Nursing Council of Kenya registration',
    issuer: 'Nursing Council of Kenya',
    governingFramework: 'Nurses Act, Cap 257',
    documentKeywords: ['Nursing Council of Kenya', 'NCK', 'registered nurse'],
    lastVerified: V,
  },
  {
    id: 'ke-lsk-advocate',
    canonicalType: 'LEGAL',
    jurisdiction: 'KE',
    category: 'professional-license',
    label: 'Law Society of Kenya advocate',
    issuer: 'Law Society of Kenya',
    governingFramework: 'Advocates Act, Cap 16',
    documentKeywords: ['Law Society of Kenya', 'LSK', 'Advocate of the High Court'],
    lastVerified: V,
  },
  {
    id: 'ke-kmpdc-doctor',
    canonicalType: 'MEDICAL',
    jurisdiction: 'KE',
    category: 'professional-license',
    label: 'Kenya Medical Practitioners and Dentists Council registration',
    issuer: 'Kenya Medical Practitioners and Dentists Council',
    governingFramework: 'Medical Practitioners and Dentists Act, Cap 253',
    documentKeywords: ['KMPDC', 'Medical Practitioners and Dentists Council'],
    lastVerified: V,
  },

  // Australia — health (14 AHPRA boards, represented via a single AHPRA id;
  // specific board is carried via sub-type metadata on extraction)
  {
    id: 'au-ahpra-registration',
    canonicalType: 'MEDICAL',
    jurisdiction: 'AU',
    category: 'professional-license',
    label: 'AHPRA health practitioner registration',
    issuer: 'Australian Health Practitioner Regulation Agency',
    governingFramework: 'Health Practitioner Regulation National Law (each state)',
    documentKeywords: ['AHPRA', 'Australian Health Practitioner Regulation Agency', 'registration number'],
    lastVerified: V,
  },
  // Australia — education
  {
    id: 'au-teqsa-provider',
    canonicalType: 'ACCREDITATION',
    jurisdiction: 'AU',
    category: 'education',
    label: 'TEQSA-registered higher education provider qualification',
    issuer: 'Tertiary Education Quality and Standards Agency',
    governingFramework: 'Tertiary Education Quality and Standards Agency Act 2011',
    documentKeywords: ['TEQSA', 'Tertiary Education Quality and Standards Agency', 'PRV'],
    lastVerified: V,
  },
  // Australia — accounting
  {
    id: 'au-cpa-australia',
    canonicalType: 'ACCREDITATION',
    jurisdiction: 'AU',
    category: 'professional-license',
    label: 'CPA Australia membership',
    issuer: 'CPA Australia',
    governingFramework: 'CPA Australia By-Laws + ASIC registered tax agent framework',
    documentKeywords: ['CPA Australia', 'CPA'],
    lastVerified: V,
  },
  {
    id: 'au-ca-anz',
    canonicalType: 'ACCREDITATION',
    jurisdiction: 'AU',
    category: 'professional-license',
    label: 'Chartered Accountants ANZ membership',
    issuer: 'Chartered Accountants Australia and New Zealand',
    governingFramework: 'CA ANZ Royal Charter',
    documentKeywords: ['Chartered Accountants ANZ', 'CA ANZ', 'CA'],
    lastVerified: V,
  },
  // Australia — law (per state, two illustrative entries)
  {
    id: 'au-nsw-law-society',
    canonicalType: 'LEGAL',
    jurisdiction: 'AU-NSW',
    category: 'professional-license',
    label: 'Law Society of New South Wales practising certificate',
    issuer: 'Law Society of New South Wales',
    governingFramework: 'Legal Profession Uniform Law (NSW) 2014',
    documentKeywords: ['Law Society of New South Wales', 'practising certificate'],
    lastVerified: V,
  },
  {
    id: 'au-vic-law-institute',
    canonicalType: 'LEGAL',
    jurisdiction: 'AU-VIC',
    category: 'professional-license',
    label: 'Law Institute of Victoria practising certificate',
    issuer: 'Law Institute of Victoria',
    governingFramework: 'Legal Profession Uniform Law Application Act 2014 (Vic)',
    documentKeywords: ['Law Institute of Victoria', 'LIV', 'practising certificate'],
    lastVerified: V,
  },
];

export const JURISDICTION_UNCERTAIN = 'jurisdiction_uncertain' as const;

/**
 * Decide a KAU credential id from issuer-hint keywords on the document.
 * Returns null if no single match — caller should flag as
 * `jurisdiction_uncertain` for human review (KAU-05 acceptance criterion).
 */
export function matchKauCredential(textOrKeywords: string | string[]): KauCredentialType | null {
  const text = Array.isArray(textOrKeywords) ? textOrKeywords.join(' ').toLowerCase() : textOrKeywords.toLowerCase();
  const matches: KauCredentialType[] = [];
  for (const c of KAU_CREDENTIAL_TYPES) {
    if (c.documentKeywords.some((kw) => text.includes(kw.toLowerCase()))) {
      matches.push(c);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return null;
  // Prefer the most specific (longest-keyword) match when multiple hit.
  matches.sort((a, b) => maxKeywordLength(b) - maxKeywordLength(a));
  const top = matches[0];
  const runner = matches[1];
  if (maxKeywordLength(top) > maxKeywordLength(runner)) return top;
  return null; // ambiguous — escalate to human
}

function maxKeywordLength(c: KauCredentialType): number {
  return Math.max(...c.documentKeywords.map((k) => k.length));
}

/**
 * Minimum coverage guard. Acceptance criterion: ≥5 types per jurisdiction.
 */
export function validateKauCoverage(): string[] {
  const errs: string[] = [];
  const byJurisdiction = new Map<string, number>();
  for (const c of KAU_CREDENTIAL_TYPES) {
    const key = c.jurisdiction.startsWith('AU') ? 'AU' : c.jurisdiction;
    byJurisdiction.set(key, (byJurisdiction.get(key) ?? 0) + 1);
  }
  const keCount = byJurisdiction.get('KE') ?? 0;
  const auCount = byJurisdiction.get('AU') ?? 0;
  if (keCount < 5) errs.push(`Kenya coverage below minimum: ${keCount} < 5`);
  if (auCount < 5) errs.push(`Australia coverage below minimum: ${auCount} < 5`);
  const ids = new Set<string>();
  for (const c of KAU_CREDENTIAL_TYPES) {
    if (ids.has(c.id)) errs.push(`duplicate id: ${c.id}`);
    ids.add(c.id);
  }
  return errs;
}

/**
 * Build a Gemini few-shot block the extractor can splice into its system
 * prompt. Matches the few-shot format under `src/ai/prompts/extraction-v6.ts`.
 */
export function kauFewShotExamples(): Array<{ input: string; output: { type: string; subType: string; jurisdiction: string; confidence: number } }> {
  return KAU_CREDENTIAL_TYPES.slice(0, 5).map((c) => ({
    input: `Document keywords: ${c.documentKeywords.join(', ')}. Issuer: ${c.issuer}.`,
    output: {
      type: c.canonicalType,
      subType: c.id,
      jurisdiction: c.jurisdiction,
      confidence: 0.88,
    },
  }));
}
