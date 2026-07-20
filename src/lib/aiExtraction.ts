/**
 * AI Extraction Orchestrator (P8-S5)
 *
 * CLIENT-SIDE orchestrator that chains:
 *   1. OCR (extractText) → raw text (stays client-side)
 *   2. PII Stripping (stripPII) → stripped text (client-side)
 *   3. Server API call (POST /api/v1/ai/extract) → structured fields
 *
 * Constitution 4A: Only PII-stripped metadata + fingerprint sent to server.
 * Constitution 1.6: Document bytes and raw OCR text never leave the client.
 */

import { extractText, type OCRResult, type OCRProgress } from './ocrWorker';
import { stripPII, type StrippingReport } from './piiStripper';
import { stripPIIEnhanced, type EnhancedStrippingReport } from './enhancedPiiStripper';
import { supabase } from './supabase';
import { WORKER_URL } from './workerClient';
import { isPiiStripFailClosedError, isUnsupportedImageFormatError } from './ocrFailClosed';
import { AI_EXTRACTION_LABELS } from './copy';

export const AI_EXTRACTION_REQUEST_TIMEOUT_MS = 15_000;

export interface ExtractionField {
  key: string;
  value: string;
  confidence: number;
  status: 'suggested' | 'accepted' | 'rejected' | 'edited';
}

export interface ExtractionProgress {
  stage: 'ocr' | 'stripping' | 'extracting' | 'complete' | 'error';
  progress: number; // 0-100
  ocrProgress?: OCRProgress;
  message?: string;
  /**
   * §1.6 FAIL-CLOSED (WEBEXT-03): true only when the on-device privacy
   * guarantee could NOT be honored (NER PII model or OCR engine failed to
   * load/run). In that case NO metadata left the browser and the UI must show
   * a LOUD, explicit failure — never the soft "secured without metadata" path.
   * Soft, recoverable failures (no text found, AI timeout, server 5xx) leave
   * this unset.
   */
  failClosed?: boolean;
}

export interface ExtractionOutput {
  fields: ExtractionField[];
  overallConfidence: number;
  provider: string;
  creditsRemaining: number;
  ocrResult: OCRResult;
  strippingReport: StrippingReport;
  /** VAI-01: Extraction manifest hash — cryptographic binding of AI output to source. */
  manifestHash?: string;
}

/**
 * Run the full extraction pipeline:
 * OCR → PII Strip → API → structured fields.
 *
 * If any step fails, returns null with the error propagated via onProgress.
 */
export async function runExtraction(
  file: File,
  fingerprint: string,
  credentialType: string,
  onProgress?: (progress: ExtractionProgress) => void,
  options?: {
    recipientNames?: string[];
    issuerHint?: string;
    /** Use NER-based PII detection (default: true) */
    enableNER?: boolean;
  },
): Promise<ExtractionOutput | null> {
  try {
    // Step 1: OCR (client-side)
    onProgress?.({ stage: 'ocr', progress: 0, message: 'Reading document...' });
    const ocrResult = await extractText(file, (ocrProgress) => {
      onProgress?.({
        stage: 'ocr',
        progress: Math.round(ocrProgress.progress * 0.4), // 0-40%
        ocrProgress,
        message: ocrProgress.stage === 'loading'
          ? 'Loading OCR engine...'
          : `Processing page ${ocrProgress.currentPage ?? ''}...`,
      });
    });

    if (!ocrResult.text.trim()) {
      onProgress?.({
        stage: 'error',
        progress: 0,
        message: 'No text found in document. Try a clearer scan.',
      });
      return null;
    }

    // Step 2: PII Stripping (client-side)
    // Use NER-enhanced stripping when enabled (default), fall back to regex-only
    onProgress?.({ stage: 'stripping', progress: 45, message: 'Removing personal information...' });
    let strippingReport: StrippingReport | EnhancedStrippingReport;
    const useNER = options?.enableNER !== false;
    if (useNER) {
      strippingReport = await stripPIIEnhanced(ocrResult.text, {
        recipientNames: options?.recipientNames,
        enableNER: true,
        onNERProgress: (nerProgress) => {
          const pct = nerProgress.stage === 'loading'
            ? 45 + Math.round(nerProgress.progress * 0.05) // 45-50%
            : 50 + Math.round((nerProgress.progress / 100) * 5); // 50-55%
          onProgress?.({ stage: 'stripping', progress: pct, message: nerProgress.message });
        },
      });
    } else {
      strippingReport = stripPII(ocrResult.text, {
        recipientNames: options?.recipientNames,
      });
    }

    // Step 3: Call extraction API (server-side, PII-stripped only)
    onProgress?.({ stage: 'extracting', progress: 55, message: 'Analyzing credential...' });

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      onProgress?.({ stage: 'error', progress: 0, message: 'Authentication required' });
      return null;
    }

    // Constitution 4A: Only PII-stripped metadata summary sent to server.
    // Truncate to reasonable limit to prevent excessive payloads.
    const truncatedText = strippingReport.strippedText.length > 10_000
      ? strippingReport.strippedText.slice(0, 10_000) + '\n[TRUNCATED]'
      : strippingReport.strippedText;

    const workerUrl = WORKER_URL;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_EXTRACTION_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${workerUrl}/api/v1/ai/extract`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          strippedText: truncatedText,
          credentialType,
          fingerprint,
          issuerHint: options?.issuerHint,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const message = (errorBody as Record<string, string>).message ?? `Extraction failed (${response.status})`;
      onProgress?.({ stage: 'error', progress: 0, message });
      return null;
    }

    const result = await response.json() as {
      fields: Record<string, string>;
      confidence: number;
      provider: string;
      creditsRemaining: number;
      manifestHash?: string;
    };

    // Convert to ExtractionField array
    const fields: ExtractionField[] = Object.entries(result.fields)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([key, value]) => ({
        key,
        value: String(value),
        // KNOWN LIMITATION (AI-03 / round-1 review): per-field confidence is
        // NOT real. /ai/extract returns ONE overall confidence for the whole
        // extraction, and it is stamped onto every field here. Downstream
        // review gating (TemplateReviewPanel low-confidence flags) is
        // therefore overall-confidence-driven: either ALL fields flag as
        // low-confidence or NONE do, until the extraction API returns true
        // per-field scores (follow-up story).
        confidence: result.confidence,
        status: 'suggested' as const,
      }));

    onProgress?.({ stage: 'complete', progress: 100, message: 'Extraction complete' });

    return {
      fields,
      overallConfidence: result.confidence,
      provider: result.provider,
      creditsRemaining: result.creditsRemaining,
      ocrResult,
      strippingReport,
      manifestHash: result.manifestHash,
    };
  } catch (err) {
    // §1.6 FAIL-CLOSED (WEBEXT-03 / SCRUM-2505): if the on-device PII model or
    // the OCR engine failed, we reach here BEFORE the network call — no metadata
    // left the browser. Surface a LOUD, explicit failure so the UI never falls
    // through to the soft "secured without metadata" recovery path.
    //
    // We deliberately do NOT interpolate `err.message` for the fail-closed case:
    // the OCR-stage error may wrap document-derived text in its `cause`, so we
    // surface only the fixed §1.6 copy string (defense-in-depth per §1.6).
    // PRIVACY BOUNDARY (fail-closed DOMINATES): the §1.6 fail-closed check runs
    // FIRST. If an on-device privacy stage failed we hard-block egress and show
    // the LOUD privacy screen — even if the same error also happens to carry an
    // unsupported-format marker. A benign downgrade must never win over a
    // privacy signal. `isUnsupportedImageFormatError` also yields to fail-closed
    // internally, so this is belt-and-suspenders.
    if (isPiiStripFailClosedError(err)) {
      onProgress?.({
        stage: 'error',
        progress: 0,
        failClosed: true,
        message: AI_EXTRACTION_LABELS.PRIVACY_GUARANTEE_FAILED,
      });
      return null;
    }

    // SCRUM-2911: an unsupported image format (.heic / .tiff) is a BENIGN
    // "we can't read this format" case — the document was never at risk and
    // nothing left the device (the format is rejected before OCR/strip/network).
    // It must NOT set `failClosed` (which would surface the FALSE privacy-failure
    // screen); route it to the ordinary soft-fail recovery path instead.
    // The message carries only the file format (never document-derived text).
    if (isUnsupportedImageFormatError(err)) {
      onProgress?.({
        stage: 'error',
        progress: 0,
        message: err instanceof Error ? err.message : 'This document format could not be read on your device.',
      });
      return null;
    }

    let message = 'Extraction failed';
    if (isAbortError(err)) {
      message = 'AI analysis timed out. The document can still be secured without metadata.';
    } else if (err instanceof TypeError && err.message.includes('fetch')) {
      message = 'Unable to connect to the server. Please check your connection and try again.';
    } else if (err instanceof Error) {
      message = err.message;
    }
    onProgress?.({ stage: 'error', progress: 0, message });
    return null;
  }
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && 'name' in err
    && (err as { name: unknown }).name === 'AbortError';
}

// ─── Template Reconstruction ───

export interface TemplateSection {
  heading: string;
  fields: Array<{
    label: string;
    value: string;
    displayType: 'text' | 'date' | 'badge' | 'status';
  }>;
}

export interface TemplateReconstructionResult {
  templateType: 'formal' | 'compact' | 'table';
  documentTitle: string;
  sections: TemplateSection[];
  tags: string[];
  documentType: string;
  summary: string;
  verificationNotes: string | null;
}

/**
 * Fetch template reconstruction from the worker.
 * Runs AFTER extraction — takes extracted fields as input.
 * Non-blocking: caller should fire-and-forget or await separately.
 */
export async function fetchTemplateReconstruction(
  fields: Record<string, unknown>,
  confidence: number,
): Promise<TemplateReconstructionResult | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;

    const response = await fetch(`${WORKER_URL}/api/v1/ai/template`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ fields, confidence }),
    });

    if (!response.ok) return null;

    const result = await response.json() as TemplateReconstructionResult;
    return result;
  } catch {
    return null;
  }
}
