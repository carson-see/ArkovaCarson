#!/usr/bin/env tsx
/**
 * Gemini Golden v6 — Dataset Enrichment (SCRUM-772 / GME2)
 *
 * Transforms the existing 2,500+ entry golden dataset into Vertex SFT JSONL
 * with TWO NEW FIELDS in the target output:
 *   - subType: fine-grained taxonomy (e.g., "pmp", "nursing_rn", "master")
 *   - description: 1–2 sentence plain-English summary for customer reports
 *
 * Target format mirrors v4 (NOT v5-reasoning):
 *   { systemInstruction: {...}, contents: [ {role:"user"}, {role:"model"} ] }
 *
 * v6 explicitly STRIPS reasoning/concerns/confidenceReasoning from the model
 * target — those v5 reasoning fields slow inference by 200–500ms per request.
 * v6 trades reasoning output for (a) faster latency, (b) richer structure.
 *
 * subType source priority:
 *   1. SUBTYPE_BACKFILL map (curated for GD-001..~GD-290)
 *   2. entry.groundTruth.subType (if already labeled)
 *   3. Deterministic rule engine (deduces from credentialType + text + fields)
 *   4. If still undetermined → "other"
 *
 * description source:
 *   Deterministic template per credentialType (uses ground truth fields only
 *   — never invents content, never hallucinates beyond what's extracted).
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/enrich-gemini-golden-v6.ts                  # write + stats
 *   npx tsx scripts/enrich-gemini-golden-v6.ts --upload         # + upload to GCS
 *
 * Output:
 *   training-output/gemini-golden-v6-vertex.jsonl               (train)
 *   training-output/gemini-golden-v6-vertex-validation.jsonl    (val)
 *   docs/eval/enrich-gemini-golden-v6-<date>.md                 (stats report)
 *
 * After this script, submit Vertex tuning with:
 *   baseModel:         gemini-2.5-flash
 *   epochs:            6
 *   adapterSize:       ADAPTER_SIZE_FOUR
 *   trainingDatasetUri: gs://arkova-training-data/gemini-golden-v6-vertex.jsonl
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import { SUBTYPE_BACKFILL } from '../src/ai/eval/golden-dataset-subtype-backfill.js';
import { computeRealisticConfidence } from '../src/ai/training/nessie-v4-data.js';
import type { GoldenDatasetEntry, GroundTruthFields } from '../src/ai/eval/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenvConfig({ path: resolve(__dirname, '../.env') });

// --- CLI args ---
const args = process.argv.slice(2);
const UPLOAD = args.includes('--upload');
const LIMIT = args.includes('--limit')
  ? parseInt(args[args.indexOf('--limit') + 1], 10)
  : 0;

const GCS_BUCKET = 'arkova-training-data';
const GCS_PATH_TRAIN = 'gemini-golden-v6-vertex.jsonl';
const GCS_PATH_VAL = 'gemini-golden-v6-vertex-validation.jsonl';

const TRAINING_OUT = resolve(__dirname, '../training-output');
const DOCS_EVAL = resolve(__dirname, '../docs/eval');

// ============================================================
// v6 SYSTEM PROMPT — taught at training time, served at inference
// ============================================================
const V6_SYSTEM_PROMPT = `You are Arkova Gemini Golden v6, a credential metadata extraction engine.

Input: PII-stripped credential text (names, SSNs, emails, phone numbers are already replaced with [NAME_REDACTED] etc.). Never reconstruct PII.

Output: ONE valid JSON object. No markdown. No commentary. No reasoning trace.

REQUIRED FIELDS:
- credentialType: one of DEGREE, LICENSE, CERTIFICATE, CLE, TRANSCRIPT, PROFESSIONAL, PUBLICATION, SEC_FILING, REGULATION, LEGAL, PATENT, INSURANCE, ATTESTATION, ACCREDITATION, BADGE, MEDICAL, IDENTITY, RESUME, FINANCIAL, MILITARY, CHARITY, FINANCIAL_ADVISOR, BUSINESS_ENTITY, OTHER
- subType: fine-grained taxonomy under credentialType (see taxonomy below). ALWAYS emit when determinable.
- description: 1–2 sentence plain-English summary for a customer report. Use ONLY extracted fields — never hallucinate.
- confidence: 0.0–1.0 reflecting extraction certainty.

OPTIONAL FIELDS (omit entirely when unknown — never null, never ""):
issuerName, issuedDate (YYYY-MM-DD), expiryDate (YYYY-MM-DD), fieldOfStudy, degreeLevel, licenseNumber, accreditingBody, jurisdiction, creditHours, creditType, barNumber, activityNumber, providerName, approvedBy, einNumber, taxExemptStatus, governingBody, crdNumber, firmName, finraRegistration, seriesLicenses, entityType, stateOfFormation, registeredAgent, goodStandingStatus, fraudSignals (array of strings).

SUBTYPE TAXONOMY (use these exact values when applicable):
DEGREE: bachelor | master | doctorate | associate | professional_md | professional_jd | professional_edd | professional_dds | professional_dnp
LICENSE: medical_md | nursing_rn | nursing_lpn | dental | pharmacist | veterinary | law_bar_admission | engineering_pe | architect | cpa | real_estate | teaching | psychology | chiropractic | optometry | social_work | speech_language_pathology | notary | electrician | plumber | cosmetology | general
CERTIFICATE: it_certification | professional_certification | trade_certification | training_certificate | completion_certificate
CLE: ethics_cle | general_cle | specialized_cle | elimination_of_bias
TRANSCRIPT: official_undergraduate | official_graduate | unofficial
PROFESSIONAL: board_certification | fellowship | residency | membership
ACCREDITATION: institutional | programmatic | industry (e.g., ABET/AACSB → programmatic; HLC/Middle States → institutional; Bureau Veritas/ISO → industry)
SEC_FILING: form_10k | form_10q | form_8k | form_def14a | form_s1 | form_13f | form_20f | form_4
REGULATION: federal | state | local | agency
LEGAL: court_opinion | court_order | contract | affidavit
PATENT: utility | design | plant | provisional
INSURANCE: liability | auto | health | property | professional
ATTESTATION: employment_verification | education_verification | good_standing | reference
BADGE: vendor_skill | educational_microcredential
MEDICAL: prescription | medical_record | diagnosis
IDENTITY: passport | drivers_license | government_id
RESUME: resume | cv
FINANCIAL: tax_return | financial_statement | audit_report
MILITARY: dd214 | discharge | service_record
CHARITY: 501c3 | 501c4 | 501c6
FINANCIAL_ADVISOR: finra_registered | sec_registered | state_registered
BUSINESS_ENTITY: llc | corporation | partnership | sole_proprietor
Other → use "other" as subType and describe in description.

DESCRIPTION TEMPLATE:
Describe the credential in 1–2 sentences using only fields you extracted. Start with the subType human name, mention issuer, field/domain, and relevant dates. No marketing language, no hedging, no speculation.

Examples:
- DEGREE bachelor: "Bachelor of Science in Computer Science from University of Michigan, conferred 2025-05-03."
- LICENSE medical_md: "Medical license for the State of New York (license 298765), specialty Internal Medicine, issued 2025-10-15, expires 2027-10-14."
- CERTIFICATE it_certification: "AWS Solutions Architect Associate certification issued by Amazon Web Services on 2025-09-12."
- CLE ethics_cle: "California Lawyers Association CLE course in Professional Responsibility and Ethics, 3.0 Ethics credit hours, completed 2026-03-15."

CONFIDENCE CALIBRATION:
- 0.90–0.95: Clean, complete, recognizable issuer. Use this as default for typical clean credentials.
- 0.80–0.89: Most fields present, 1–2 minor ambiguities.
- 0.65–0.79: Several fields missing or OCR noisy but type/issuer clear.
- 0.45–0.64: Sparse, heavy inference required.
- 0.20–0.44: Minimal extractable content.

OUTPUT FORMAT:
{"credentialType":"DEGREE","subType":"bachelor","issuerName":"...","issuedDate":"YYYY-MM-DD","fieldOfStudy":"...","degreeLevel":"Bachelor","jurisdiction":"...","description":"...","fraudSignals":[],"confidence":0.92}

Return ONLY this JSON object.`;

// ============================================================
// CANONICAL CREDENTIAL TYPE NORMALIZER
// Some golden entries have non-canonical GT credentialTypes
// (lowercase, alternate names). Normalize to the 23-type enum so
// the model learns consistent vocabulary.
// ============================================================
// v7: ACCREDITATION promoted to canonical (24 types). Institutional / program /
// industry accreditations are semantically distinct from ATTESTATION (individual
// employment/education verification). v6 eval showed 42.9% F1 on ACCREDITATION
// entries because the prior canonicalizer folded them to ATTESTATION → scorer
// marked every correct emission as wrong.
const CANONICAL_TYPES = new Set([
  'DEGREE', 'LICENSE', 'CERTIFICATE', 'CLE', 'TRANSCRIPT', 'PROFESSIONAL',
  'PUBLICATION', 'SEC_FILING', 'REGULATION', 'LEGAL', 'PATENT', 'INSURANCE',
  'ATTESTATION', 'ACCREDITATION', 'BADGE', 'MEDICAL', 'IDENTITY', 'RESUME',
  'FINANCIAL', 'MILITARY', 'CHARITY', 'FINANCIAL_ADVISOR', 'BUSINESS_ENTITY',
  'OTHER',
]);

const TYPE_ALIASES: Record<string, string> = {
  // Lowercase canonical → uppercase
  degree: 'DEGREE',
  license: 'LICENSE',
  certificate: 'CERTIFICATE',
  cle: 'CLE',
  transcript: 'TRANSCRIPT',
  accreditation: 'ACCREDITATION',
  // Non-canonical → closest canonical
  medical_license: 'LICENSE',
  nursing_license: 'LICENSE',
  real_estate_license: 'LICENSE',
  teaching_license: 'LICENSE',
  cpa_license: 'LICENSE',
  professional_certification: 'CERTIFICATE',
  employment_screening: 'ATTESTATION',
  employment_verification: 'ATTESTATION',
  employment_authorization: 'ATTESTATION',
};

function canonicalizeCredentialType(raw: string | undefined): string {
  if (!raw) return 'OTHER';
  const trimmed = raw.trim();
  if (CANONICAL_TYPES.has(trimmed)) return trimmed;
  const aliased = TYPE_ALIASES[trimmed] ?? TYPE_ALIASES[trimmed.toLowerCase()];
  if (aliased) return aliased;
  const upper = trimmed.toUpperCase();
  if (CANONICAL_TYPES.has(upper)) return upper;
  return 'OTHER';
}

// ============================================================
// DETERMINISTIC SUBTYPE RULE ENGINE
// Used when SUBTYPE_BACKFILL doesn't cover an entry.
// Returns null if no confident match — caller falls back to "other".
// ============================================================

function deduceSubType(entry: GoldenDatasetEntry): string | null {
  const ct = canonicalizeCredentialType(
    entry.groundTruth.credentialType ?? entry.credentialTypeHint,
  );
  const text = entry.strippedText;
  const textLower = text.toLowerCase();
  const gt = entry.groundTruth;
  const degLevel = (gt.degreeLevel ?? '').toLowerCase();
  const field = (gt.fieldOfStudy ?? '').toLowerCase();
  const issuer = (gt.issuerName ?? '').toLowerCase();

  if (ct === 'DEGREE') {
    if (/\bbachelor|\bb\.?s\.?\b|\bb\.?a\.?\b|\bbba\b|\bbsn\b/i.test(text) || degLevel.startsWith('bachelor')) return 'bachelor';
    if (/\bmaster|\bm\.?s\.?\b|\bm\.?a\.?\b|\bmba\b|\bmsw\b|\bmfa\b|\bmeng\b/i.test(text) || degLevel.startsWith('master')) return 'master';
    if (/\bdoctor of medicine|\bm\.?d\.?\b|\bdo\b|\bmbbs\b/i.test(text) && field.includes('medicin')) return 'professional_md';
    if (/\bjuris doctor|\bj\.?d\.?\b/i.test(text) || field.includes('law')) return 'professional_jd';
    if (/\bed\.?d\.?\b|\bdoctor of education\b/i.test(text)) return 'professional_edd';
    if (/\bdoctor of dental surgery|\bdds\b|\bdmd\b/i.test(text)) return 'professional_dds';
    if (/\bdnp\b|\bdoctor of nursing practice\b/i.test(text)) return 'professional_dnp';
    if (/\bdoctorate|\bph\.?d\.?\b|\bdoctor of\b/i.test(text) || degLevel.startsWith('doctorate') || degLevel.startsWith('doctor')) return 'doctorate';
    if (/\bassociate|\baa\b|\bas\b|\baas\b/i.test(text) || degLevel.startsWith('associate')) return 'associate';
    return null;
  }

  if (ct === 'LICENSE') {
    // Match highest-specificity first
    if (/\bregistered nurse|\brn\b|board of (registered )?nursing/i.test(text) || field.includes('nursing')) return 'nursing_rn';
    if (/\blpn\b|licensed practical nurse|midwife|midwifery/i.test(text)) return 'nursing_lpn';
    if (/\bmedical (board|license|licence)|\bmd\b|doctor of medicine|physician.{0,30}licen/i.test(text) || field.includes('medicin')) return 'medical_md';
    if (/\bdental|\bdds\b|\bdentist|dental hygienist/i.test(text) || field.includes('dental')) return 'dental';
    if (/\bpharmacist|\bpharmacy license|board of pharmacy/i.test(text) || field.includes('pharmac')) return 'pharmacist';
    if (/\bveterinar/i.test(text) || field.includes('veterinar')) return 'veterinary';
    if (/\bbar (admission|exam)|attorney.{0,30}licen|admitted to.{0,20}bar|state bar of/i.test(text) || field.includes('law')) return 'law_bar_admission';
    if (/\bprofessional engineer|\bpe license|\bp\.?e\.?\b/i.test(text) || field.includes('engineering')) return 'engineering_pe';
    if (/\barchitect/i.test(text) || field.includes('architect')) return 'architect';
    if (/\bcertified public accountant|\bcpa\b|accountancy board/i.test(text) || field.includes('accounting')) return 'cpa';
    if (/\breal estate|\bbroker|\bsalesperson|real estate commission/i.test(text) || field.includes('real estate')) return 'real_estate';
    if (/\bteaching license|teacher certification|department of education/i.test(text) || field.includes('teach')) return 'teaching';
    if (/\bpsycholog/i.test(text) || field.includes('psycholog')) return 'psychology';
    if (/\bchiropract/i.test(text) || field.includes('chiropract')) return 'chiropractic';
    if (/\boptomet/i.test(text) || field.includes('optomet')) return 'optometry';
    if (/\bsocial work/i.test(text) || field.includes('social work')) return 'social_work';
    if (/\bspeech.{0,10}language|\bslp\b/i.test(text) || field.includes('speech')) return 'speech_language_pathology';
    if (/\bnotary|notarial/i.test(text) || field.includes('notary')) return 'notary';
    if (/\belectric/i.test(text) || field.includes('electric')) return 'electrician';
    if (/\bplumber|plumbing license/i.test(text) || field.includes('plumb')) return 'plumber';
    if (/\bcosmetolog/i.test(text) || field.includes('cosmetolog')) return 'cosmetology';
    return 'general';
  }

  if (ct === 'CERTIFICATE') {
    // IT / Cloud / Security certifications
    if (/\baws\b|amazon web services|\bazure\b|\bgcp\b|google cloud|\bkubernetes|\bckad\b|\bcka\b|\bcissp\b|\bcisa\b|\bcism\b|\bceh\b|\boscp\b|\bcomptia|\bcisco\b|\bccnp\b|\bccna\b|\boracle|terraform|docker|salesforce|tableau|itil|togaf/i.test(text)) return 'it_certification';
    // Professional certifications
    if (/\bpmp\b|\bpmi\b|project management|\bshrm\b|\bphr\b|\bcfa\b|\bcpa\b|\bcma\b|\bfrm\b|six sigma|scrum master|\bleed\b|actuarial|emt|\bcfe\b|clinical research/i.test(text)) return 'professional_certification';
    // Trade certifications
    if (/welding|inspector|trade certif/i.test(text)) return 'trade_certification';
    // Training (CPR, OSHA, food handler, etc.)
    if (/\bcpr\b|\bbls\b|\bacls\b|\bpals\b|first aid|osha|food handler|ged\b/i.test(text)) return 'training_certificate';
    // Completion certificates (online courses, bootcamps)
    if (/coursera|udacity|edx|bootcamp|completion|completed the course|online course/i.test(text)) return 'completion_certificate';
    return 'professional_certification';
  }

  if (ct === 'CLE') {
    if (/\bethics\b|professional responsibility/i.test(text)) return 'ethics_cle';
    if (/elimination of bias|bias|diversity/i.test(text)) return 'elimination_of_bias';
    if (/\bgeneral (cle|credit)/i.test(text) || /\b(substance abuse|technology|immigration|bankruptcy|tax|securities)\b/i.test(text)) return 'specialized_cle';
    return 'general_cle';
  }

  if (ct === 'TRANSCRIPT') {
    if (degLevel.startsWith('master') || degLevel.startsWith('doctor') || /\bmba\b|\bjd\b|\bmd\b|graduate school|law school|medical school/i.test(text)) return 'official_graduate';
    if (/\bunofficial/i.test(text)) return 'unofficial';
    return 'official_undergraduate';
  }

  if (ct === 'PROFESSIONAL') {
    if (/board.{0,20}certif/i.test(text) || /\babms\b|abim|abs\b/i.test(text)) return 'board_certification';
    if (/\bfellowship/i.test(text)) return 'fellowship';
    if (/\bresidency|internship/i.test(text)) return 'residency';
    return 'membership';
  }

  if (ct === 'SEC_FILING') {
    if (/\b10-?k\b/i.test(text)) return 'form_10k';
    if (/\b10-?q\b/i.test(text)) return 'form_10q';
    if (/\b8-?k\b/i.test(text)) return 'form_8k';
    if (/def 14a|proxy statement/i.test(text)) return 'form_def14a';
    if (/\bs-?1\b|registration statement/i.test(text)) return 'form_s1';
    if (/\b13-?f\b/i.test(text)) return 'form_13f';
    if (/\b20-?f\b/i.test(text)) return 'form_20f';
    if (/\bform 4\b|insider transaction/i.test(text)) return 'form_4';
    return null;
  }

  if (ct === 'REGULATION') {
    if (/federal register|cfr\b|code of federal/i.test(text)) return 'federal';
    if (/state of|state regulatory|state agency/i.test(textLower)) return 'state';
    if (/local|municipal|county|city ordinance/i.test(textLower)) return 'local';
    return 'agency';
  }

  if (ct === 'LEGAL') {
    if (/opinion|ruling|decision|court of appeals|supreme court/i.test(text)) return 'court_opinion';
    if (/order|injunction|judgment/i.test(textLower) && !/contract/i.test(textLower)) return 'court_order';
    if (/contract|agreement|nda|non-?disclosure/i.test(textLower)) return 'contract';
    if (/affidavit|sworn statement/i.test(textLower)) return 'affidavit';
    return null;
  }

  if (ct === 'PATENT') {
    if (/design patent/i.test(text)) return 'design';
    if (/plant patent/i.test(text)) return 'plant';
    if (/provisional/i.test(text)) return 'provisional';
    return 'utility';
  }

  if (ct === 'INSURANCE') {
    if (/liability|commercial general/i.test(textLower)) return 'liability';
    if (/auto|automobile|vehicle/i.test(textLower)) return 'auto';
    if (/health|medical insurance/i.test(textLower)) return 'health';
    if (/property|homeowners/i.test(textLower)) return 'property';
    if (/professional|e&o|errors and omissions|workers comp/i.test(textLower)) return 'professional';
    return null;
  }

  if (ct === 'ATTESTATION') {
    if (/employment verification|employed by|work verification/i.test(textLower)) return 'employment_verification';
    if (/education verification|enrolled|degree verification/i.test(textLower)) return 'education_verification';
    if (/good standing|certificate of good standing/i.test(textLower)) return 'good_standing';
    if (/reference|letter of recommendation/i.test(textLower)) return 'reference';
    return null;
  }

  if (ct === 'BADGE') {
    if (issuer.includes('aws') || issuer.includes('google') || issuer.includes('microsoft') || issuer.includes('linkedin')) return 'vendor_skill';
    return 'educational_microcredential';
  }

  if (ct === 'MEDICAL') {
    if (/prescription|rx\b/i.test(text)) return 'prescription';
    if (/diagnosis|icd-?10/i.test(textLower)) return 'diagnosis';
    return 'medical_record';
  }

  if (ct === 'IDENTITY') {
    if (/passport/i.test(textLower)) return 'passport';
    if (/driver/i.test(textLower)) return 'drivers_license';
    return 'government_id';
  }

  if (ct === 'RESUME') {
    if (/\bcv\b|curriculum vitae/i.test(textLower)) return 'cv';
    return 'resume';
  }

  if (ct === 'FINANCIAL') {
    if (/tax return|1040|w-?2/i.test(textLower)) return 'tax_return';
    if (/audit report|audited by/i.test(textLower)) return 'audit_report';
    return 'financial_statement';
  }

  if (ct === 'MILITARY') {
    if (/\bdd-?214\b/i.test(text)) return 'dd214';
    if (/discharge/i.test(textLower)) return 'discharge';
    return 'service_record';
  }

  if (ct === 'CHARITY') {
    if (/501\(c\)\(3\)/i.test(text)) return '501c3';
    if (/501\(c\)\(4\)/i.test(text)) return '501c4';
    if (/501\(c\)\(6\)/i.test(text)) return '501c6';
    return null;
  }

  if (ct === 'FINANCIAL_ADVISOR') {
    if (/finra/i.test(textLower)) return 'finra_registered';
    if (/\bsec\b/i.test(text)) return 'sec_registered';
    return 'state_registered';
  }

  if (ct === 'BUSINESS_ENTITY') {
    if (/\bllc\b|limited liability/i.test(textLower)) return 'llc';
    if (/\bcorp(oration)?\b|\binc\b/i.test(textLower)) return 'corporation';
    if (/partnership/i.test(textLower)) return 'partnership';
    if (/sole proprietor/i.test(textLower)) return 'sole_proprietor';
    return null;
  }

  if (ct === 'ACCREDITATION') {
    // Industry/ISO: Bureau Veritas, BSI, Joint Commission
    if (/bureau veritas|bsi group|joint commission|iso \d{4,5}|dnv gl|sgs|tüv|tuv /i.test(text)) return 'industry';
    // Programmatic (subject-specific program accreditors)
    if (/\babet\b|\baacsb\b|\blcme\b|\baacn\b|\bcaahep\b|\baba\b|\bnaeyc\b|\befmd\b|\bnaab\b|\bcommission on accreditation\b|\baccreditation commission for\b|national architectural accrediting/i.test(text)) return 'programmatic';
    // Institutional (regional + national university accreditors)
    if (/higher learning commission|middle states|southern association|northwest commission|new england commission|wasc|chea|council for higher education|quality assurance agency|tertiary education quality|universal accreditation council/i.test(text)) return 'institutional';
    return 'other';
  }

  return null;
}

// ============================================================
// DESCRIPTION TEMPLATE
// ============================================================

function buildDescription(
  entry: GoldenDatasetEntry,
  subType: string,
): string {
  const gt = entry.groundTruth;
  const ct = canonicalizeCredentialType(gt.credentialType ?? entry.credentialTypeHint);
  const issuer = gt.issuerName ?? 'an issuer';
  const issued = gt.issuedDate;
  const expiry = gt.expiryDate;
  const field = gt.fieldOfStudy;
  const juris = gt.jurisdiction;
  const lic = gt.licenseNumber;

  const dateClause = (suffix: boolean): string => {
    const parts: string[] = [];
    if (issued) parts.push(`issued ${issued}`);
    if (expiry) parts.push(`expires ${expiry}`);
    if (parts.length === 0) return '';
    return (suffix ? ', ' : '') + parts.join(', ') + '.';
  };

  switch (ct) {
    case 'DEGREE': {
      // Prefer taxonomy human name ("Bachelor's degree") over raw level ("Bachelor")
      const level = humanSubType(subType) || gt.degreeLevel || 'Degree';
      const fieldPart = field ? ` in ${field}` : '';
      const datePart = issued ? `, conferred ${issued}` : '';
      return `${level}${fieldPart} from ${issuer}${datePart}.`;
    }
    case 'LICENSE': {
      const kind = humanSubType(subType) || 'Professional license';
      const jurisPart = juris ? ` for ${juris}` : '';
      const licPart = lic ? ` (license ${lic})` : '';
      const specialtyPart = field ? `, specialty ${field}` : '';
      return `${kind}${jurisPart}${licPart}${specialtyPart}${issued || expiry ? ', ' : '.'}${dateClause(false)}`.replace(/\.\s*\.$/, '.').replace(/,\s*\./, '.');
    }
    case 'CERTIFICATE': {
      const topic = field ?? humanSubType(subType);
      const datePart = issued ? ` on ${issued}` : '';
      const expPart = expiry ? `, valid through ${expiry}` : '';
      return `${topic} certification issued by ${issuer}${datePart}${expPart}.`;
    }
    case 'CLE': {
      const credits = gt.creditHours ? `${gt.creditHours} ` : '';
      const ctype = gt.creditType ?? humanSubType(subType);
      const topic = field ? ` in ${field}` : '';
      const datePart = issued ? `, completed ${issued}` : '';
      // Avoid doubling "CLE" when issuer already ends in CLE
      const courseLabel = /\bCLE\b$/i.test(issuer) ? ' course' : ' CLE course';
      return `${issuer}${courseLabel}${topic}, ${credits}${ctype} credit hours${datePart}.`.replace(/,\s*,/, ',');
    }
    case 'TRANSCRIPT': {
      const level = gt.degreeLevel ?? humanSubType(subType) ?? 'Academic';
      const programPart = field ? ` in ${field}` : '';
      const datePart = issued ? `, issued ${issued}` : '';
      return `${level} transcript from ${issuer}${programPart}${datePart}.`;
    }
    case 'PROFESSIONAL': {
      const kind = humanSubType(subType) || 'Professional credential';
      const fieldPart = field ? ` in ${field}` : '';
      const datePart = issued ? `, issued ${issued}` : '';
      return `${kind} from ${issuer}${fieldPart}${datePart}.`;
    }
    case 'SEC_FILING': {
      const form = humanSubType(subType) || 'SEC filing';
      const datePart = issued ? ` filed ${issued}` : '';
      return `${form} by ${issuer}${datePart}.`;
    }
    case 'REGULATION': {
      const scope = humanSubType(subType) || 'regulation';
      const datePart = issued ? ` effective ${issued}` : '';
      return `${scope} regulatory document from ${issuer}${datePart}.`;
    }
    case 'LEGAL': {
      const kind = humanSubType(subType) || 'Legal document';
      const datePart = issued ? `, dated ${issued}` : '';
      return `${kind} from ${issuer}${datePart}.`;
    }
    case 'PATENT': {
      const kind = humanSubType(subType) || 'Patent';
      const datePart = issued ? `, granted ${issued}` : '';
      const topic = field ? `, technical field ${field}` : '';
      return `${kind} patent ${lic ?? ''} from ${issuer}${topic}${datePart}.`.replace(/\s+/g, ' ');
    }
    case 'INSURANCE': {
      const kind = humanSubType(subType) || 'Insurance policy';
      const effPart = issued ? ` effective ${issued}` : '';
      const expPart = expiry ? `, expires ${expiry}` : '';
      return `${kind} policy from ${issuer}${effPart}${expPart}.`;
    }
    case 'ATTESTATION': {
      const kind = humanSubType(subType) || 'Attestation';
      const datePart = issued ? `, dated ${issued}` : '';
      return `${kind} from ${issuer}${datePart}.`;
    }
    case 'BADGE': {
      const topic = field ?? humanSubType(subType);
      const datePart = issued ? ` on ${issued}` : '';
      return `${topic} digital badge issued by ${issuer}${datePart}.`;
    }
    case 'CHARITY': {
      // Extended fields live on GroundTruthFields-adjacent data — cast for access
      const ext = gt as Record<string, unknown>;
      const taxStatus = typeof ext.taxExemptStatus === 'string' ? ext.taxExemptStatus : humanSubType(subType);
      const ein = typeof ext.einNumber === 'string' ? ext.einNumber : undefined;
      return `${issuer} — ${taxStatus} nonprofit organization${ein ? ` (EIN ${ein})` : ''}.`;
    }
    case 'FINANCIAL_ADVISOR': {
      const ext = gt as Record<string, unknown>;
      const crd = typeof ext.crdNumber === 'string' ? ext.crdNumber : undefined;
      const firm = typeof ext.firmName === 'string' ? ext.firmName : undefined;
      const kind = humanSubType(subType) || 'Registered advisor';
      return `${kind} advisor${crd ? ` (CRD ${crd})` : ''}${firm ? ` at ${firm}` : ''}.`;
    }
    case 'BUSINESS_ENTITY': {
      const kind = humanSubType(subType) ?? gt.entityType ?? 'Business entity';
      const state = gt.stateOfFormation ? ` (${gt.stateOfFormation})` : '';
      return `${kind}${state} filed with ${issuer}.`;
    }
    case 'ACCREDITATION': {
      // Accreditations describe an ORG/PROGRAM being accredited, not a person.
      const kind = humanSubType(subType) || 'Accreditation';
      const fieldPart = field ? ` for ${field}` : '';
      const jurisPart = juris ? ` (${juris})` : '';
      const datePart = issued ? `, issued ${issued}` : '';
      const expPart = expiry ? `, expires ${expiry}` : '';
      return `${kind}${fieldPart} by ${issuer}${jurisPart}${datePart}${expPart}.`.replace(/\s+/g, ' ').replace(/\s+([.,])/g, '$1');
    }
    default: {
      const datePart = issued ? ` dated ${issued}` : '';
      const topicPart = field ? `, field ${field}` : '';
      return `${ct.toLowerCase().replace('_', ' ')} document from ${issuer}${topicPart}${datePart}.`;
    }
  }
}

function humanSubType(subType: string): string {
  const map: Record<string, string> = {
    bachelor: "Bachelor's degree",
    master: "Master's degree",
    doctorate: 'Doctorate',
    associate: "Associate's degree",
    professional_md: 'Doctor of Medicine (MD)',
    professional_jd: 'Juris Doctor (JD)',
    professional_edd: 'Doctor of Education (EdD)',
    professional_dds: 'Doctor of Dental Surgery (DDS)',
    professional_dnp: 'Doctor of Nursing Practice (DNP)',
    medical_md: 'Medical license',
    nursing_rn: 'Registered Nurse license',
    nursing_lpn: 'Licensed Practical Nurse license',
    dental: 'Dental license',
    pharmacist: 'Pharmacist license',
    veterinary: 'Veterinary license',
    law_bar_admission: 'Bar admission',
    engineering_pe: 'Professional Engineer license',
    architect: 'Architect license',
    cpa: 'CPA license',
    real_estate: 'Real estate license',
    teaching: 'Teaching license',
    psychology: 'Psychology license',
    chiropractic: 'Chiropractic license',
    optometry: 'Optometry license',
    social_work: 'Social work license',
    speech_language_pathology: 'Speech-language pathology license',
    notary: 'Notary public commission',
    electrician: 'Electrician license',
    plumber: 'Plumber license',
    cosmetology: 'Cosmetology license',
    general: 'Professional license',
    it_certification: 'IT',
    professional_certification: 'Professional',
    trade_certification: 'Trade',
    training_certificate: 'Training',
    completion_certificate: 'Course completion',
    ethics_cle: 'Ethics',
    general_cle: 'General',
    specialized_cle: 'Specialized',
    elimination_of_bias: 'Elimination of Bias',
    official_undergraduate: 'Undergraduate',
    official_graduate: 'Graduate',
    unofficial: 'Unofficial',
    board_certification: 'Board certification',
    fellowship: 'Fellowship',
    residency: 'Residency',
    membership: 'Professional membership',
    form_10k: 'Form 10-K',
    form_10q: 'Form 10-Q',
    form_8k: 'Form 8-K',
    form_def14a: 'Proxy statement (DEF 14A)',
    form_s1: 'Form S-1 registration statement',
    form_13f: 'Form 13F',
    form_20f: 'Form 20-F',
    form_4: 'Form 4 insider transaction',
    federal: 'Federal',
    state: 'State',
    local: 'Local',
    agency: 'Agency',
    court_opinion: 'Court opinion',
    court_order: 'Court order',
    contract: 'Contract',
    affidavit: 'Affidavit',
    utility: 'Utility',
    design: 'Design',
    plant: 'Plant',
    provisional: 'Provisional',
    liability: 'Liability insurance',
    auto: 'Auto insurance',
    health: 'Health insurance',
    property: 'Property insurance',
    professional: 'Professional liability insurance',
    employment_verification: 'Employment verification',
    education_verification: 'Education verification',
    good_standing: 'Certificate of good standing',
    reference: 'Reference letter',
    vendor_skill: 'Vendor skill',
    educational_microcredential: 'Educational micro-credential',
    prescription: 'Prescription',
    medical_record: 'Medical record',
    diagnosis: 'Diagnosis',
    passport: 'Passport',
    drivers_license: "Driver's license",
    government_id: 'Government ID',
    resume: 'Resume',
    cv: 'Curriculum vitae',
    tax_return: 'Tax return',
    financial_statement: 'Financial statement',
    audit_report: 'Audit report',
    dd214: 'DD-214',
    discharge: 'Military discharge document',
    service_record: 'Military service record',
    '501c3': '501(c)(3)',
    '501c4': '501(c)(4)',
    '501c6': '501(c)(6)',
    finra_registered: 'FINRA-registered',
    sec_registered: 'SEC-registered',
    state_registered: 'State-registered',
    llc: 'Limited Liability Company',
    corporation: 'Corporation',
    partnership: 'Partnership',
    sole_proprietor: 'Sole proprietorship',
    // ACCREDITATION subtypes (v7 taxonomy addition)
    institutional: 'Institutional accreditation',
    programmatic: 'Programmatic accreditation',
    industry: 'Industry accreditation',
    other: 'Other',
  };
  return map[subType] ?? subType.replace(/_/g, ' ');
}

// ============================================================
// ENRICHMENT
// ============================================================

interface EnrichedEntry {
  id: string;
  ct: string;
  subType: string;
  subTypeSource: 'backfill' | 'ground_truth' | 'deduced' | 'other';
  description: string;
  vertex: unknown;
}

function buildUserPrompt(entry: GoldenDatasetEntry): string {
  const ct = entry.credentialTypeHint;
  let prompt = `Extract credential metadata from the PII-stripped text below.\n`;
  prompt += `Credential type hint: ${ct}\n`;
  if (entry.issuerHint) prompt += `Issuer hint: ${entry.issuerHint}\n`;
  prompt += `\n--- BEGIN CREDENTIAL TEXT ---\n${JSON.stringify(entry.strippedText)}\n--- END CREDENTIAL TEXT ---\n`;
  prompt += `\nReturn a single JSON object matching the v6 schema. Always include "subType", "description", and "confidence". Omit fields you cannot determine. No markdown, no prose.`;
  return prompt;
}

function buildTargetOutput(
  entry: GoldenDatasetEntry,
  subType: string,
  description: string,
): string {
  const gt = entry.groundTruth;
  const confidence = computeRealisticConfidence(
    gt as Record<string, unknown>,
    entry.strippedText,
  );

  // v6 output: STRIP reasoning / concerns / confidenceReasoning.
  // ADD: subType, description.
  const output: Record<string, unknown> = {};

  // Preserve credentialType first for readability, normalized to canonical enum
  output.credentialType = canonicalizeCredentialType(gt.credentialType ?? entry.credentialTypeHint);
  output.subType = subType;

  const copy = (k: keyof GroundTruthFields) => {
    const v = gt[k];
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0 && k === 'fraudSignals')) {
      (output as Record<string, unknown>)[k as string] = v;
    }
  };

  // All fields allowed in v6 schema
  for (const k of [
    'issuerName', 'issuedDate', 'expiryDate', 'fieldOfStudy', 'degreeLevel',
    'licenseNumber', 'accreditingBody', 'jurisdiction',
    'creditHours', 'creditType', 'barNumber', 'activityNumber', 'providerName', 'approvedBy',
    'entityType', 'stateOfFormation', 'registeredAgent', 'goodStandingStatus',
  ] as const) {
    copy(k);
  }

  // Charity/advisor fields may live in ground truth via extended types — copy defensively
  for (const k of ['einNumber', 'taxExemptStatus', 'governingBody', 'crdNumber', 'firmName', 'finraRegistration', 'seriesLicenses']) {
    const v = (gt as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length > 0) output[k] = v;
  }

  output.description = description;
  // fraudSignals always emit (even empty) so model learns to output array
  output.fraudSignals = Array.isArray(gt.fraudSignals) ? gt.fraudSignals : [];
  output.confidence = confidence;

  return JSON.stringify(output);
}

function enrichEntry(entry: GoldenDatasetEntry): EnrichedEntry {
  // 1. subType source priority
  let subType: string | null = null;
  let subTypeSource: EnrichedEntry['subTypeSource'] = 'other';

  const backfill = SUBTYPE_BACKFILL[entry.id];
  if (backfill?.subType) {
    subType = backfill.subType;
    subTypeSource = 'backfill';
  } else if (entry.groundTruth.subType) {
    subType = entry.groundTruth.subType;
    subTypeSource = 'ground_truth';
  } else {
    const deduced = deduceSubType(entry);
    if (deduced) {
      subType = deduced;
      subTypeSource = 'deduced';
    } else {
      subType = 'other';
      subTypeSource = 'other';
    }
  }

  // 2. description from template
  const description = buildDescription(entry, subType);

  // 3. Build Vertex SFT record
  const userPrompt = buildUserPrompt(entry);
  const modelOutput = buildTargetOutput(entry, subType, description);

  const vertex = {
    systemInstruction: {
      role: 'system',
      parts: [{ text: V6_SYSTEM_PROMPT }],
    },
    contents: [
      { role: 'user', parts: [{ text: userPrompt }] },
      { role: 'model', parts: [{ text: modelOutput }] },
    ],
  };

  const ct = canonicalizeCredentialType(entry.groundTruth.credentialType ?? entry.credentialTypeHint);
  return { id: entry.id, ct, subType, subTypeSource, description, vertex };
}

// ============================================================
// MAIN
// ============================================================

async function getAccessToken(): Promise<string> {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error('Failed to get access token');
  return token.token;
}

async function uploadToGCS(localPath: string, gcsObjectPath: string): Promise<string> {
  const token = await getAccessToken();
  const bodyBuf = readFileSync(localPath);
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET}/o?uploadType=media&name=${encodeURIComponent(gcsObjectPath)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: bodyBuf,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GCS upload failed (${res.status}): ${err}`);
  }
  return `gs://${GCS_BUCKET}/${gcsObjectPath}`;
}

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Gemini Golden v6 — Dataset Enrichment           ║');
  console.log('║  SCRUM-772 / GME2                                ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const startTs = Date.now();

  // Step 1: Load full golden dataset
  console.log('--- Step 1: Load full golden dataset ---');
  const entries = LIMIT > 0 ? FULL_GOLDEN_DATASET.slice(0, LIMIT) : FULL_GOLDEN_DATASET;
  console.log(`Total entries: ${entries.length}`);

  // Deduplicate by id (defensive)
  const byId = new Map<string, GoldenDatasetEntry>();
  for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e);
  const unique = Array.from(byId.values());
  console.log(`Unique by id: ${unique.length}`);

  // Step 2: Enrich
  console.log('\n--- Step 2: Enrich with subType + description ---');
  const enriched = unique.map(enrichEntry);

  // Stats
  const ctDist: Record<string, number> = {};
  const subTypeDist: Record<string, number> = {};
  const sourceDist: Record<string, number> = { backfill: 0, ground_truth: 0, deduced: 0, other: 0 };
  let otherEmitted = 0;
  for (const e of enriched) {
    ctDist[e.ct] = (ctDist[e.ct] ?? 0) + 1;
    const key = `${e.ct}:${e.subType}`;
    subTypeDist[key] = (subTypeDist[key] ?? 0) + 1;
    sourceDist[e.subTypeSource]++;
    if (e.subType === 'other') otherEmitted++;
  }

  console.log('\nCredential type distribution:');
  for (const [ct, n] of Object.entries(ctDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ct.padEnd(18)} ${String(n).padStart(4)}`);
  }

  console.log('\nsubType source breakdown:');
  for (const [src, n] of Object.entries(sourceDist)) {
    const pct = ((n / enriched.length) * 100).toFixed(1);
    console.log(`  ${src.padEnd(14)} ${String(n).padStart(4)}  (${pct}%)`);
  }
  console.log(`  → "other" fallback: ${otherEmitted} (${((otherEmitted / enriched.length) * 100).toFixed(1)}%)`);
  console.log(`  → subType emission non-"other": ${((1 - otherEmitted / enriched.length) * 100).toFixed(1)}%`);

  console.log('\nTop 30 subType combinations:');
  const topSubTypes = Object.entries(subTypeDist).sort((a, b) => b[1] - a[1]).slice(0, 30);
  for (const [key, n] of topSubTypes) {
    console.log(`  ${key.padEnd(36)} ${String(n).padStart(4)}`);
  }

  // Step 3: 90/10 train/val split (seeded so reruns are deterministic)
  console.log('\n--- Step 3: Deterministic 90/10 split ---');
  const seed = 4216; // 2026-04-16
  let state = seed;
  const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x100000000; };
  const shuffled = [...enriched];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const valSize = Math.max(Math.floor(shuffled.length * 0.1), 10);
  const valRecs = shuffled.slice(0, valSize);
  const trainRecs = shuffled.slice(valSize);
  console.log(`Train: ${trainRecs.length}`);
  console.log(`Val:   ${valRecs.length}`);

  // Step 4: Write JSONL
  console.log('\n--- Step 4: Write Vertex JSONL ---');
  mkdirSync(TRAINING_OUT, { recursive: true });
  const trainPath = resolve(TRAINING_OUT, 'gemini-golden-v6-vertex.jsonl');
  const valPath = resolve(TRAINING_OUT, 'gemini-golden-v6-vertex-validation.jsonl');

  writeFileSync(trainPath, trainRecs.map(r => JSON.stringify(r.vertex)).join('\n') + '\n');
  writeFileSync(valPath, valRecs.map(r => JSON.stringify(r.vertex)).join('\n') + '\n');

  const trainSizeMB = (readFileSync(trainPath).byteLength / 1024 / 1024).toFixed(2);
  const valSizeMB = (readFileSync(valPath).byteLength / 1024 / 1024).toFixed(2);
  console.log(`Train: ${trainPath}  (${trainSizeMB} MB)`);
  console.log(`Val:   ${valPath}  (${valSizeMB} MB)`);

  // Step 5: Write stats report
  console.log('\n--- Step 5: Write stats report ---');
  mkdirSync(DOCS_EVAL, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = resolve(DOCS_EVAL, `enrich-gemini-golden-v6-${date}.md`);
  const report = buildReport({
    entries: enriched,
    trainSize: trainRecs.length,
    valSize: valRecs.length,
    ctDist,
    sourceDist,
    topSubTypes,
  });
  writeFileSync(reportPath, report);
  console.log(`Report: ${reportPath}`);

  // Sample outputs
  console.log('\n--- Sample v6 outputs (first 3) ---');
  for (const r of enriched.slice(0, 3)) {
    const rec = r.vertex as { contents: Array<{ parts: Array<{ text: string }> }> };
    const target = rec.contents[1].parts[0].text;
    console.log(`\n[${r.id}] ${r.ct} → subType="${r.subType}" (${r.subTypeSource})`);
    console.log(`  description: ${r.description}`);
    console.log(`  target: ${target.slice(0, 250)}${target.length > 250 ? '…' : ''}`);
  }

  // Step 6: Upload if requested
  if (UPLOAD) {
    console.log('\n--- Step 6: Upload to GCS ---');
    const trainGCS = await uploadToGCS(trainPath, GCS_PATH_TRAIN);
    const valGCS = await uploadToGCS(valPath, GCS_PATH_VAL);
    console.log(`Train: ${trainGCS}`);
    console.log(`Val:   ${valGCS}`);
  } else {
    console.log('\n(Skipping GCS upload — pass --upload to upload)');
  }

  const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
  console.log(`\n✓ Enrichment complete in ${elapsed}s`);
  console.log(`\nNext: submit Vertex tuning with baseModel=gemini-2.5-flash, epochs=6.`);
}

function buildReport(ctx: {
  entries: EnrichedEntry[];
  trainSize: number;
  valSize: number;
  ctDist: Record<string, number>;
  sourceDist: Record<string, number>;
  topSubTypes: Array<[string, number]>;
}): string {
  const lines: string[] = [];
  lines.push(`# Gemini Golden v6 — Dataset Enrichment Report`);
  lines.push('');
  lines.push(`**Date:** ${new Date().toISOString()}`);
  lines.push(`**SCRUM:** [SCRUM-772](https://arkova.atlassian.net/browse/SCRUM-772)`);
  lines.push(`**Total entries:** ${ctx.entries.length}`);
  lines.push(`**Train:** ${ctx.trainSize}`);
  lines.push(`**Validation:** ${ctx.valSize}`);
  lines.push('');
  lines.push(`## What's new in v6`);
  lines.push('');
  lines.push(`- **subType** field — fine-grained taxonomy under credentialType (e.g., \`bachelor\`, \`nursing_rn\`, \`pmp\`).`);
  lines.push(`- **description** field — 1–2 sentence plain-English summary for customer reports.`);
  lines.push(`- Removed reasoning/concerns/confidenceReasoning fields to cut inference latency.`);
  lines.push(`- Target format: Vertex SFT JSONL for \`gemini-2.5-flash\` supervised tuning.`);
  lines.push('');
  lines.push(`## subType source breakdown`);
  lines.push('');
  lines.push(`| Source | Count | % |`);
  lines.push(`|---|---:|---:|`);
  for (const [src, n] of Object.entries(ctx.sourceDist)) {
    lines.push(`| ${src} | ${n} | ${((n / ctx.entries.length) * 100).toFixed(1)}% |`);
  }
  lines.push('');
  lines.push(`## Credential type distribution`);
  lines.push('');
  lines.push(`| Type | Count |`);
  lines.push(`|---|---:|`);
  for (const [ct, n] of Object.entries(ctx.ctDist).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${ct} | ${n} |`);
  }
  lines.push('');
  lines.push(`## Top 30 subType combinations`);
  lines.push('');
  lines.push(`| credentialType:subType | Count |`);
  lines.push(`|---|---:|`);
  for (const [key, n] of ctx.topSubTypes) {
    lines.push(`| \`${key}\` | ${n} |`);
  }
  lines.push('');
  lines.push(`## Definition of Done (v6)`);
  lines.push('');
  lines.push(`| Metric | Target | How verified |`);
  lines.push(`|---|---|---|`);
  lines.push(`| Macro F1 | ≥75% | 50-sample extraction eval (run-eval.ts) |`);
  lines.push(`| Weighted F1 | ≥80% | 50-sample extraction eval |`);
  lines.push(`| p50 latency | <2s | eval-latency-benchmark.ts on warm endpoint |`);
  lines.push(`| p95 latency | <3s | eval-latency-benchmark.ts |`);
  lines.push(`| subType emission rate (non-"other") | >80% | eval output analysis |`);
  lines.push(`| description emission rate | 100% | eval output analysis |`);
  lines.push(`| JSON parse success | 100% | eval output |`);
  lines.push('');
  lines.push(`## Next steps`);
  lines.push('');
  lines.push(`1. \`gsutil cp training-output/gemini-golden-v6-vertex.jsonl gs://arkova-training-data/\` (or use \`--upload\` flag)`);
  lines.push(`2. Submit Vertex tuning job: \`baseModel=gemini-2.5-flash\`, \`epochs=6\`, \`adapterSize=ADAPTER_SIZE_FOUR\``);
  lines.push(`3. Eval with \`run-eval.ts --provider gemini --sample 50\` against the v6 endpoint`);
  lines.push(`4. If DoD met: update Cloud Run \`GEMINI_TUNED_MODEL\` env var`);
  lines.push(`5. Update Jira SCRUM-772 + Confluence page 11894785`);
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  console.error('\n✗ Enrichment failed:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
