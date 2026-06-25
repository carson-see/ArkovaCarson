/**
 * Enhanced PII Stripper (Phase 4)
 *
 * CLIENT-SIDE ONLY — combines regex-based stripping with NER-based detection
 * for comprehensive PII removal.
 *
 * Constitution 4A: PII must be stripped client-side before data leaves browser.
 *
 * Strategy:
 * 1. Run regex stripping first (fast, handles structured patterns like SSN/email/phone)
 * 2. Run NER on the remaining text (catches names, locations, orgs the regex missed)
 * 3. Merge results into a unified stripping report
 *
 * §1.6 FAIL-CLOSED (WEBEXT-03 / SCRUM-2505): the NER step is opt-OUT, not
 * best-effort. When NER is requested (the default) and the model fails to load
 * or run, this function THROWS a fail-closed error — it does NOT silently
 * degrade to regex-only. Silent degrade is the exact 2026-06-16 fail-open
 * regression (a CSP-broken model dep → regex-only → unstripped PII left the
 * browser). The caller (`aiExtraction.runExtraction`) catches the fail-closed
 * error BEFORE any network call, so no metadata leaves the device. NER is only
 * skipped when the caller explicitly passes `enableNER: false`.
 */

import { stripPII, type StrippingOptions, type StrippingReport } from './piiStripper';
import { detectPIIWithNER, redactNEREntities, type NERPIIResult, type NERProgress } from './nerPiiDetector';
import { detectMLRuntime, type MLBackend } from './mlRuntime';
import { NerPiiFailClosedError, isPiiStripFailClosedError } from './ocrFailClosed';

export interface EnhancedStrippingOptions extends StrippingOptions {
  /** Enable NER-based detection (default: true) */
  enableNER?: boolean;
  /** Progress callback for NER model loading/inference */
  onNERProgress?: (progress: NERProgress) => void;
  /** Force a specific ML backend */
  forceBackend?: MLBackend;
}

export interface EnhancedStrippingReport extends StrippingReport {
  /** Whether NER was used */
  nerUsed: boolean;
  /** NER detection results (null if NER not used) */
  nerResult: NERPIIResult | null;
  /** Total PII categories found (regex + NER combined) */
  allPiiCategories: string[];
}

/**
 * Strip PII using regex patterns + NER model.
 *
 * §1.6 FAIL-CLOSED: throws {@link NerPiiFailClosedError} (or re-throws Lane 1's
 * `NERModelLoadError`) when NER is requested but cannot load/run. Returns a
 * regex-only report ONLY when the caller explicitly passes `enableNER: false`.
 *
 * @throws PiiStripFailClosedError when NER fails and was not opted out.
 */
export async function stripPIIEnhanced(
  text: string,
  options: EnhancedStrippingOptions = {},
): Promise<EnhancedStrippingReport> {
  const enableNER = options.enableNER !== false;

  // Step 1: Regex stripping (always runs, fast)
  const regexReport = stripPII(text, {
    recipientNames: options.recipientNames,
  });

  if (!enableNER) {
    return {
      ...regexReport,
      nerUsed: false,
      nerResult: null,
      allPiiCategories: regexReport.piiFound,
    };
  }

  // Step 2: NER-based detection on the regex-stripped text
  try {
    const runtime = await detectMLRuntime();
    const backend = options.forceBackend ?? runtime.backend;

    const nerResult = await detectPIIWithNER(
      regexReport.strippedText,
      backend,
      options.onNERProgress,
    );

    if (nerResult.entities.length === 0) {
      // NER found nothing additional — return regex results
      return {
        ...regexReport,
        nerUsed: true,
        nerResult,
        allPiiCategories: regexReport.piiFound,
      };
    }

    // Step 3: Apply NER redactions to the already-regex-stripped text
    const finalText = redactNEREntities(regexReport.strippedText, nerResult.entities);

    // Merge PII categories
    const allCategories = new Set([
      ...regexReport.piiFound,
      ...nerResult.piiCategories,
    ]);

    return {
      strippedText: finalText,
      piiFound: regexReport.piiFound, // Regex-found categories
      redactionCount: regexReport.redactionCount + nerResult.entityCount,
      originalLength: text.length,
      strippedLength: finalText.length,
      nerUsed: true,
      nerResult,
      allPiiCategories: Array.from(allCategories),
    };
  } catch (err) {
    // §1.6 FAIL-CLOSED: NER was requested but could not load/run. Do NOT degrade
    // to regex-only — that would let NER-detectable PII (names, locations, orgs)
    // leave the browser. Re-raise as a fail-closed error so the orchestrator
    // blocks egress before any network call. If it is already a fail-closed
    // error (e.g. Lane 1's NERModelLoadError, DEPENDS ON #1253), preserve it.
    // NOTE: `err` is intentionally NOT interpolated into the message — it may
    // reference document-derived text; we surface only a bounded, generic
    // reason and attach the original as `cause` for diagnostics.
    if (isPiiStripFailClosedError(err)) {
      throw err;
    }
    throw new NerPiiFailClosedError(
      'On-device privacy check could not run (NER model unavailable).',
      { cause: err },
    );
  }
}
