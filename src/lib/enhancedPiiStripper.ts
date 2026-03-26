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
 * The NER step is optional — if the model fails to load or is disabled,
 * falls back gracefully to regex-only stripping (existing behavior).
 */

import { stripPII, type StrippingOptions, type StrippingReport } from './piiStripper';
import { detectPIIWithNER, redactNEREntities, type NERPIIResult, type NERProgress } from './nerPiiDetector';
import { detectMLRuntime, type MLBackend } from './mlRuntime';

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
 * Falls back to regex-only if NER fails or is disabled.
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
    // NER failed — fall back to regex-only results
    console.warn('NER PII detection failed, using regex-only:', err);
    return {
      ...regexReport,
      nerUsed: false,
      nerResult: null,
      allPiiCategories: regexReport.piiFound,
    };
  }
}
