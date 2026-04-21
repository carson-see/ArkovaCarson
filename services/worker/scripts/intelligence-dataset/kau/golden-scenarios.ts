/**
 * KAU-05 (SCRUM-753) — Kenya + Australia golden-dataset scenario generator.
 *
 * Produces ≥20 scenarios per jurisdiction from the canonical credential
 * registry in `credentials.ts`. Each registry entry seeds 3 wording
 * variants (formal issuer language, colloquial, partial OCR) so the
 * classifier sees more than one surface form per credential type.
 *
 * Pure function; no LLM calls, no network I/O. NVI gate does not apply
 * (no training executed here — this is the dataset-building primitive
 * that NPH-13 will consume when the gate closes).
 */

import { KAU_CREDENTIAL_TYPES, type KauCredentialType } from './credentials.js';

export interface KauGoldenScenario {
  /** Stable id — `<credential-id>-v<n>`. */
  id: string;
  /** Jurisdiction bucket for balancing. */
  jurisdiction: 'KE' | 'AU';
  /** Synthetic document text the classifier will see. */
  input: string;
  /** Expected classification. */
  expected: {
    type: KauCredentialType['canonicalType'];
    subType: string;
    jurisdiction: KauCredentialType['jurisdiction'];
    confidence: number;
  };
}

type CredentialRenderer = (c: KauCredentialType) => string;

/**
 * Confidence ladder matches the few-shot rhetoric in `credentials.ts`:
 * clean issuer text > keyword-only > loose colloquial > degraded OCR.
 */
const CONFIDENCE_FORMAL = 0.92;
const CONFIDENCE_KEYWORD = 0.85;
const CONFIDENCE_COLLOQUIAL = 0.78;
const CONFIDENCE_OCR = 0.72;

/** Four surface-form variants per credential, templated from the registry. */
const VARIANTS: ReadonlyArray<CredentialRenderer> = [
  (c) =>
    `Official ${c.label} issued by ${c.issuer}. Governing framework: ${c.governingFramework}. Keywords: ${c.documentKeywords.join(', ')}.`,
  (c) =>
    `Holder presents document stating "${c.documentKeywords[0]}". Issuing authority: ${c.issuer}.`,
  (c) => {
    const kws = c.documentKeywords.slice(0, 2).map((k) => k.toUpperCase()).join(' ');
    return `OCR fragment: ${kws} ... ${c.issuer.split(' ').slice(0, 3).join(' ').toUpperCase()}`;
  },
  (c) =>
    `User uploaded what appears to be a ${c.label.toLowerCase()}. Mentions ${c.issuer}.`,
];

function confidenceFor(variantIdx: number): number {
  switch (variantIdx) {
    case 0: return CONFIDENCE_FORMAL;
    case 1: return CONFIDENCE_KEYWORD;
    case 2: return CONFIDENCE_OCR;
    default: return CONFIDENCE_COLLOQUIAL;
  }
}

function bucket(j: KauCredentialType['jurisdiction']): 'KE' | 'AU' {
  return j.startsWith('AU') ? 'AU' : 'KE';
}

/**
 * Generate all KAU golden scenarios. Returns at least 3 per registry
 * entry (currently 12 entries × 3 = 36 scenarios, 18 KE + 18 AU).
 *
 * Caller can balance/truncate as needed. Nothing here talks to RunPod
 * or Vertex; this only materialises the training-data rows.
 */
export function kauGoldenScenarios(): KauGoldenScenario[] {
  const out: KauGoldenScenario[] = [];
  for (const c of KAU_CREDENTIAL_TYPES) {
    VARIANTS.forEach((render, idx) => {
      out.push({
        id: `${c.id}-v${idx + 1}`,
        jurisdiction: bucket(c.jurisdiction),
        input: render(c),
        expected: {
          type: c.canonicalType,
          subType: c.id,
          jurisdiction: c.jurisdiction,
          confidence: confidenceFor(idx),
        },
      });
    });
  }
  return out;
}

/**
 * Return scenarios balanced to exactly `perJurisdiction` from each of KE
 * and AU. Used by NPH-13 to assemble a fixed-count batch.
 */
export function balancedKauScenarios(perJurisdiction: number): KauGoldenScenario[] {
  const all = kauGoldenScenarios();
  const ke = all.filter((s) => s.jurisdiction === 'KE').slice(0, perJurisdiction);
  const au = all.filter((s) => s.jurisdiction === 'AU').slice(0, perJurisdiction);
  return [...ke, ...au];
}

/**
 * Acceptance-criteria guard: the AC for SCRUM-753 asks for ≥20 KE and
 * ≥20 AU examples. Returns any shortage reasons.
 */
export function validateKauGoldenCoverage(
  minPerJurisdiction = 20,
): string[] {
  const all = kauGoldenScenarios();
  const ke = all.filter((s) => s.jurisdiction === 'KE').length;
  const au = all.filter((s) => s.jurisdiction === 'AU').length;
  const errs: string[] = [];
  if (ke < minPerJurisdiction) {
    errs.push(`Kenya golden scenarios below minimum: ${ke} < ${minPerJurisdiction} — add more Kenya rows to KAU_ROWS in credentials.ts`);
  }
  if (au < minPerJurisdiction) {
    errs.push(`Australia golden scenarios below minimum: ${au} < ${minPerJurisdiction} — add more Australia rows to KAU_ROWS in credentials.ts`);
  }
  const ids = new Set<string>();
  for (const s of all) {
    if (ids.has(s.id)) errs.push(`duplicate scenario id: ${s.id}`);
    ids.add(s.id);
  }
  return errs;
}
