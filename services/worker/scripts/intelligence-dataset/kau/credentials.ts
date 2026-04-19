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

/**
 * Compact row form: [id, canonicalType, jurisdiction, category, label, issuer,
 * governingFramework, documentKeywords]. Expanded into the structured shape
 * by `rowToCredential` below — one row per credential keeps the registry
 * dense and prevents the structural-duplicate flag Sonar raises for 12
 * identically-shaped object literals.
 */
type KauRow = readonly [
  id: string,
  canonicalType: KauCredentialType['canonicalType'],
  jurisdiction: KauJurisdiction,
  category: KauCredentialCategory,
  label: string,
  issuer: string,
  governingFramework: string,
  documentKeywords: readonly string[],
];

const KAU_ROWS: readonly KauRow[] = [
  // Kenya — education
  ['ke-knec-kcpe', 'DEGREE', 'KE', 'education',
    'Kenya Certificate of Primary Education (KCPE)',
    'Kenya National Examinations Council', 'KNEC Act, 2012',
    ['KNEC', 'KCPE', 'Kenya Certificate of Primary Education']],
  ['ke-knec-kcse', 'DEGREE', 'KE', 'education',
    'Kenya Certificate of Secondary Education (KCSE)',
    'Kenya National Examinations Council', 'KNEC Act, 2012',
    ['KNEC', 'KCSE', 'Kenya Certificate of Secondary Education']],
  // Kenya — professional licenses
  ['ke-tsc-registration', 'LEGAL', 'KE', 'professional-license',
    'Teachers Service Commission registration',
    'Teachers Service Commission (TSC)', 'Teachers Service Commission Act, 2012',
    ['TSC', 'Teachers Service Commission', 'TSC number']],
  ['ke-nck-nursing', 'MEDICAL', 'KE', 'professional-license',
    'Nursing Council of Kenya registration',
    'Nursing Council of Kenya', 'Nurses Act, Cap 257',
    ['Nursing Council of Kenya', 'NCK', 'registered nurse']],
  ['ke-lsk-advocate', 'LEGAL', 'KE', 'professional-license',
    'Law Society of Kenya advocate',
    'Law Society of Kenya', 'Advocates Act, Cap 16',
    ['Law Society of Kenya', 'LSK', 'Advocate of the High Court']],
  ['ke-kmpdc-doctor', 'MEDICAL', 'KE', 'professional-license',
    'Kenya Medical Practitioners and Dentists Council registration',
    'Kenya Medical Practitioners and Dentists Council',
    'Medical Practitioners and Dentists Act, Cap 253',
    ['KMPDC', 'Medical Practitioners and Dentists Council']],
  // Australia — health (AHPRA umbrella; 15 boards routed via sub-type metadata)
  ['au-ahpra-registration', 'MEDICAL', 'AU', 'professional-license',
    'AHPRA health practitioner registration',
    'Australian Health Practitioner Regulation Agency',
    'Health Practitioner Regulation National Law (each state)',
    ['AHPRA', 'Australian Health Practitioner Regulation Agency', 'registration number']],
  // Australia — education
  ['au-teqsa-provider', 'ACCREDITATION', 'AU', 'education',
    'TEQSA-registered higher education provider qualification',
    'Tertiary Education Quality and Standards Agency',
    'Tertiary Education Quality and Standards Agency Act 2011',
    ['TEQSA', 'Tertiary Education Quality and Standards Agency', 'PRV']],
  // Australia — accounting
  ['au-cpa-australia', 'ACCREDITATION', 'AU', 'professional-license',
    'CPA Australia membership',
    'CPA Australia', 'CPA Australia By-Laws + ASIC registered tax agent framework',
    ['CPA Australia', 'CPA']],
  ['au-ca-anz', 'ACCREDITATION', 'AU', 'professional-license',
    'Chartered Accountants ANZ membership',
    'Chartered Accountants Australia and New Zealand', 'CA ANZ Royal Charter',
    ['Chartered Accountants ANZ', 'CA ANZ', 'CA']],
  // Australia — law (per state, two illustrative entries)
  ['au-nsw-law-society', 'LEGAL', 'AU-NSW', 'professional-license',
    'Law Society of New South Wales practising certificate',
    'Law Society of New South Wales', 'Legal Profession Uniform Law (NSW) 2014',
    ['Law Society of New South Wales', 'practising certificate']],
  ['au-vic-law-institute', 'LEGAL', 'AU-VIC', 'professional-license',
    'Law Institute of Victoria practising certificate',
    'Law Institute of Victoria', 'Legal Profession Uniform Law Application Act 2014 (Vic)',
    ['Law Institute of Victoria', 'LIV', 'practising certificate']],
];

function rowToCredential([id, canonicalType, jurisdiction, category, label, issuer, governingFramework, documentKeywords]: KauRow): KauCredentialType {
  return { id, canonicalType, jurisdiction, category, label, issuer, governingFramework, documentKeywords: [...documentKeywords], lastVerified: V };
}

export const KAU_CREDENTIAL_TYPES: KauCredentialType[] = KAU_ROWS.map(rowToCredential);

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
  if (matches.length <= 1) return matches[0] ?? null;
  // Prefer the most specific (longest-keyword) match when multiple hit.
  const lengthById = new Map(matches.map((c) => [c.id, Math.max(...c.documentKeywords.map((k) => k.length))]));
  matches.sort((a, b) => lengthById.get(b.id)! - lengthById.get(a.id)!);
  return lengthById.get(matches[0].id)! > lengthById.get(matches[1].id)! ? matches[0] : null;
}

/**
 * Minimum coverage guard. Acceptance criterion: ≥5 types per jurisdiction.
 */
export function validateKauCoverage(): string[] {
  const errs: string[] = [];
  const byJurisdiction = new Map<string, number>();
  const ids = new Set<string>();
  for (const c of KAU_CREDENTIAL_TYPES) {
    if (ids.has(c.id)) errs.push(`duplicate id: ${c.id}`);
    ids.add(c.id);
    const key = c.jurisdiction.startsWith('AU') ? 'AU' : c.jurisdiction;
    byJurisdiction.set(key, (byJurisdiction.get(key) ?? 0) + 1);
  }
  const keCount = byJurisdiction.get('KE') ?? 0;
  const auCount = byJurisdiction.get('AU') ?? 0;
  if (keCount < 5) errs.push(`Kenya coverage below minimum: ${keCount} < 5`);
  if (auCount < 5) errs.push(`Australia coverage below minimum: ${auCount} < 5`);
  return errs;
}

/**
 * Build a Gemini few-shot block the extractor can splice into its system
 * prompt. Matches the few-shot format under `src/ai/prompts/extraction-v6.ts`.
 *
 * Interleaves Kenya + Australia entries so both jurisdictions are represented
 * — slicing the head of the registry would yield zero Australia coverage
 * because the registry is authored Kenya-first.
 */
export function kauFewShotExamples(): Array<{ input: string; output: { type: string; subType: string; jurisdiction: string; confidence: number } }> {
  const ke = KAU_CREDENTIAL_TYPES.filter((c) => c.jurisdiction === 'KE');
  const au = KAU_CREDENTIAL_TYPES.filter((c) => c.jurisdiction.startsWith('AU'));
  const balanced: KauCredentialType[] = [];
  const n = Math.max(ke.length, au.length);
  for (let i = 0; i < n; i++) {
    if (i < ke.length) balanced.push(ke[i]);
    if (i < au.length) balanced.push(au[i]);
  }
  return balanced.slice(0, 6).map((c) => ({
    input: `Document keywords: ${c.documentKeywords.join(', ')}. Issuer: ${c.issuer}.`,
    output: {
      type: c.canonicalType,
      subType: c.id,
      jurisdiction: c.jurisdiction,
      confidence: 0.88,
    },
  }));
}
