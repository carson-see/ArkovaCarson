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
}

export interface ExtractionOutput {
  fields: ExtractionField[];
  overallConfidence: number;
  provider: string;
  creditsRemaining: number;
  ocrResult: OCRResult;
  strippingReport: StrippingReport;
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
    const response = await fetch(`${workerUrl}/api/v1/ai/extract`, {
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
    });

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
    };

    // Convert to ExtractionField array
    const fields: ExtractionField[] = Object.entries(result.fields)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([key, value]) => ({
        key,
        value: String(value),
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
    };
  } catch (err) {
    let message = 'Extraction failed';
    if (err instanceof TypeError && err.message.includes('fetch')) {
      message = 'Unable to connect to the server. Please check your connection and try again.';
    } else if (err instanceof Error) {
      message = err.message;
    }
    onProgress?.({ stage: 'error', progress: 0, message });
    return null;
  }
}
