/**
 * §1.6 Fail-Closed Contract (WEBEXT-03 / SCRUM-2505)
 *
 * CLIENT-SIDE ONLY. This module defines the typed error surface that makes the
 * on-device extraction pipeline FAIL-CLOSED: if the on-device PII model (NER)
 * or the OCR engine (Tesseract) fails to load or run, the pipeline MUST throw
 * one of these errors so that NO metadata — stripped or not — leaves the
 * browser. There is no silent degrade to regex-only / no-strip.
 *
 * Background: on 2026-06-16 a CSP-breaking dependency silently disabled
 * on-device PII stripping; the pipeline fell back to a weaker path and
 * unstripped PII left the browser (FAIL-OPEN). Constitution §1.6 requires the
 * opposite posture: when the privacy guarantee cannot be honored, egress is
 * hard-blocked and the user sees a loud, explicit failure.
 *
 * ─── Cross-lane dependency (DEPENDS ON #1253) ─────────────────────────────
 * Lane 1 (SCRUM-2504) self-hosts the NER model and exports a typed
 * `NERModelLoadError` from `src/lib/nerPiiDetector.ts` on branch
 * `lane1/s1-webext-csp-selfhost` (PR #1253). That class is NOT yet on `main`.
 *
 * To keep Lane 2 compiling on `main` without importing Lane 1's not-yet-landed
 * symbol, we recognize a NER model-load failure structurally — by error name —
 * via {@link isNerModelLoadError}. Lane 1's `NERModelLoadError` sets
 * `Object.setPrototypeOf` AND `this.name = 'NERModelLoadError'`, so this guard
 * matches it regardless of transpilation / cross-bundle `instanceof` issues.
 * When #1253 lands, the guard keeps working unchanged; no edit to
 * `nerPiiDetector.ts` is required (that file is Lane 1-owned).
 */

/** Which on-device stage failed. */
export type FailClosedStage = 'ocr' | 'ner' | 'pipeline';

/**
 * Base class for any failure that must HARD-BLOCK on-device egress.
 *
 * `instanceof PiiStripFailClosedError` is the primary check the orchestrator
 * uses to decide "the privacy guarantee could not be honored → block the
 * network call." Uses `Object.setPrototypeOf` so the prototype chain survives
 * TypeScript's `extends Error` down-level transpilation, and carries a
 * `failClosed` discriminator so cross-bundle checks still work.
 */
export class PiiStripFailClosedError extends Error {
  /** Stable discriminator that survives bundling/transpilation. */
  readonly failClosed = true as const;
  /** Which on-device stage failed. */
  readonly stage: FailClosedStage;

  constructor(message: string, stage: FailClosedStage = 'pipeline', options?: { cause?: unknown }) {
    super(message);
    this.name = 'PiiStripFailClosedError';
    this.stage = stage;
    if (options?.cause !== undefined) {
      // `cause` is standard but typed loosely for older lib targets.
      (this as { cause?: unknown }).cause = options.cause;
    }
    Object.setPrototypeOf(this, PiiStripFailClosedError.prototype);
  }
}

/**
 * The OCR engine (Tesseract core / worker / language data) failed to load or
 * run on-device. Raised by `ocrWorker.ts`. A subclass of
 * {@link PiiStripFailClosedError} so the orchestrator's single fail-closed
 * check catches it.
 */
export class OcrEngineLoadError extends PiiStripFailClosedError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'ocr', options);
    this.name = 'OcrEngineLoadError';
    Object.setPrototypeOf(this, OcrEngineLoadError.prototype);
  }
}

/**
 * The on-device NER PII model failed to load or run while NER stripping was
 * requested. Raised by `enhancedPiiStripper.ts`. A subclass of
 * {@link PiiStripFailClosedError}.
 *
 * NOTE: this is distinct from Lane 1's `NERModelLoadError` (in
 * `nerPiiDetector.ts`). The model loader (Lane 1) throws `NERModelLoadError`;
 * the stripper (Lane 2) re-raises as this fail-closed error. Both are matched
 * by {@link isPiiStripFailClosedError} via name/prototype.
 */
export class NerPiiFailClosedError extends PiiStripFailClosedError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'ner', options);
    this.name = 'NerPiiFailClosedError';
    Object.setPrototypeOf(this, NerPiiFailClosedError.prototype);
  }
}

/**
 * A BENIGN, recoverable failure: the OCR engine is available, but the browser
 * cannot decode this particular image format (e.g. `.heic` / `.tiff`), so no
 * text can be extracted (SCRUM-2911).
 *
 * This is deliberately NOT a subclass of {@link PiiStripFailClosedError}: the
 * on-device privacy guarantee was never in play — nothing was read and nothing
 * left the device, because we detect the format BEFORE loading the OCR engine
 * or making any network call. Routing it through the §1.6 fail-closed path
 * would surface the FALSE "privacy failure" screen for a document that was
 * never at risk. Callers must map it to the ordinary "unsupported format"
 * soft-fail (skip AI extraction / anchor without extracted metadata), never to
 * the loud privacy-breach UI.
 *
 * Carries a stable `unsupportedFormat` discriminator + `name` so cross-bundle
 * checks work even when `instanceof` is unreliable, mirroring the fail-closed
 * error design above.
 */
export class UnsupportedImageFormatError extends Error {
  /** Stable discriminator that survives bundling/transpilation. */
  readonly unsupportedFormat = true as const;
  /** The MIME type or extension that could not be decoded (NOT document content). */
  readonly formatLabel: string;

  constructor(message: string, formatLabel: string) {
    super(message);
    this.name = 'UnsupportedImageFormatError';
    this.formatLabel = formatLabel;
    Object.setPrototypeOf(this, UnsupportedImageFormatError.prototype);
  }
}

/**
 * Guard for {@link UnsupportedImageFormatError}. Matches by prototype OR by the
 * `unsupportedFormat` discriminator / `name` (cross-bundle safe).
 *
 * PRIVACY BOUNDARY (fail-closed dominates): if the SAME error object also
 * carries a fail-closed marker (a real {@link PiiStripFailClosedError} or a
 * duck-typed `failClosed === true` / `NERModelLoadError`), this returns FALSE.
 * A benign "unsupported format" downgrade must never win over a §1.6 privacy
 * fail-closed signal — when in doubt, egress stays hard-blocked and the user
 * sees the loud privacy screen. Callers should still check
 * {@link isPiiStripFailClosedError} first as belt-and-suspenders.
 */
export function isUnsupportedImageFormatError(err: unknown): boolean {
  // Fail-closed always dominates: an error that is also a privacy fail-closed
  // signal is NOT a benign unsupported-format case.
  if (isPiiStripFailClosedError(err)) return false;
  if (err instanceof UnsupportedImageFormatError) return true;
  if (typeof err === 'object' && err !== null) {
    if ((err as { unsupportedFormat?: unknown }).unsupportedFormat === true) return true;
    if ((err as { name?: unknown }).name === 'UnsupportedImageFormatError') return true;
  }
  return false;
}

/**
 * Structural guard for Lane 1's `NERModelLoadError` (DEPENDS ON #1253).
 *
 * Matches by `name === 'NERModelLoadError'` (set in Lane 1's constructor) so it
 * works even before #1253 lands and even across bundle boundaries where
 * `instanceof` is unreliable. Also matches anything whose constructor name is
 * that class, defensively.
 */
export function isNerModelLoadError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'NERModelLoadError') return true;
  // Defensive: some bundlers rename `name`; fall back to constructor name.
  const ctorName = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return ctorName === 'NERModelLoadError';
}

/**
 * The single check the orchestrator uses: did an on-device step fail in a way
 * that MUST block egress? Returns true for:
 *   - any {@link PiiStripFailClosedError} (OCR / NER / pipeline), by prototype
 *     OR by the `failClosed` discriminator (cross-bundle safe), and
 *   - Lane 1's `NERModelLoadError` (DEPENDS ON #1253), by name.
 */
export function isPiiStripFailClosedError(err: unknown): boolean {
  if (err instanceof PiiStripFailClosedError) return true;
  if (typeof err === 'object' && err !== null) {
    if ((err as { failClosed?: unknown }).failClosed === true) return true;
  }
  return isNerModelLoadError(err);
}
