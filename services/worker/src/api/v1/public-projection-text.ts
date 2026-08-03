/**
 * The VALUE LAYER shared by every public, unauthenticated projection of an
 * anchor row that is written in TypeScript.
 *
 * Extracted from `verify.ts` when `provenance.ts` needed the same rule: two
 * copies of this wrapper is precisely the drift
 * `scripts/ci/public-pii-projection-contract.json` exists to prevent, and the
 * contract's whole premise is that ONE rule has N implementations, not N rules.
 *
 * The DETECTORS live in `ctdl/ctdl-pii-guard.ts` and are imported, never
 * re-implemented. This module adds only the POLICY that the detectors are used
 * with on a verification surface: OMIT the field, never throw.
 *
 * ── OMISSION, NOT FAIL-CLOSED ──────────────────────────────────────────────
 *
 * The CTDL path 404s on a PII hit because its body is a PUBLICATION to an
 * external registry, so refusing to publish is the right answer. Every caller
 * of THIS module is answering a VERIFICATION question, where refusing would
 * tell an anonymous verifier that a genuinely anchored document does not
 * exist — breaking the core product guarantee in exchange for nothing, since
 * the verification-bearing fields (fingerprint, chain receipt, status, block
 * height, timestamps) carry no free text and therefore no PII. Dropping the
 * offending FIELD contains the leak while the answer survives.
 *
 * Mirrors `private.public_free_text_or_null` in migration 0385, which makes
 * the same choice in SQL for the same reason.
 */

import {
  containsHighConfidencePii,
  normalizePublicText,
  MAX_SCAN_CHARS,
} from '../../ctdl/ctdl-pii-guard.js';

/**
 * The public-safe form of an issuer- or extraction-authored string, or `null`
 * to OMIT the field. Runs on EVERY credential type.
 *
 * Takes `unknown` rather than `string | null` so a caller reading an untyped
 * row (`sig.signer_name`, a `jsonb ->> 'x'`) cannot accidentally pass a
 * non-string past the gate.
 */
export function publicFreeTextOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Never emit text we did not scan. `normalizePublicText` bounds its scan at
  // MAX_SCAN_CHARS so a public, unauthenticated caller cannot drive an
  // unbounded regex pass; a longer raw value would therefore be published with
  // an UNSCANNED tail. Omit instead — the same fail-to-omission the CTDL guard
  // applies to a body too deep to scan.
  if (value.length > MAX_SCAN_CHARS) return null;
  // Scan AND emit the NORMALIZED form: emitting the raw value would ship a
  // control-character-split payload (`jane.doe\0@example.edu`) that the
  // detectors only see once normalized.
  const text = normalizePublicText(value);
  if (!text) return null;
  if (containsHighConfidencePii(text)) return null;
  return text;
}

/**
 * True when a stored free-text value is present in substance — i.e. it is a
 * non-empty string once hygiene is applied.
 *
 * Callers need this to tell "the issuer wrote nothing" apart from "the issuer
 * wrote something we refuse to publish". Those are DIFFERENT FACTS, and a
 * public projection must not assert the first when the second is true
 * (CLAUDE.md §1.5, §1.13 R-7: state what is measured vs asserted vs NOT
 * asserted). `provenance.ts` uses it to avoid printing "no reason provided"
 * over a revocation reason that exists and was suppressed.
 */
export function hasStoredFreeText(value: unknown): boolean {
  return typeof value === 'string' && normalizePublicText(value) !== '';
}
