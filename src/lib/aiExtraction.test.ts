/**
 * Tests for AI Extraction Orchestrator (P8-S5)
 *
 * Tests the orchestration logic without actual OCR/API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ocrWorker
vi.mock('./ocrWorker', () => ({
  extractText: vi.fn(),
}));

// Mock piiStripper
vi.mock('./piiStripper', () => ({
  stripPII: vi.fn(),
}));

// Mock enhancedPiiStripper
vi.mock('./enhancedPiiStripper', () => ({
  stripPIIEnhanced: vi.fn(),
}));

// Mock supabase
vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
    },
  },
}));

import { AI_EXTRACTION_REQUEST_TIMEOUT_MS, runExtraction } from './aiExtraction';
import { extractText } from './ocrWorker';
import { stripPII } from './piiStripper';
import { stripPIIEnhanced } from './enhancedPiiStripper';
import { supabase } from './supabase';
import { NerPiiFailClosedError, OcrEngineLoadError } from './ocrFailClosed';

describe('aiExtraction orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated session
    (supabase.auth.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { session: { access_token: 'test-token' } },
    });

    (stripPIIEnhanced as ReturnType<typeof vi.fn>).mockImplementation((text: string) => stripPII(text));
  });

  it('runs full pipeline: OCR → strip → API → fields', async () => {
    // Mock OCR
    (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'University of Michigan\nBachelor of Science\nJohn Doe',
      pageCount: 1,
      method: 'pdfjs',
      durationMs: 500,
    });

    // Mock PII stripping
    (stripPII as ReturnType<typeof vi.fn>).mockReturnValue({
      strippedText: 'University of Michigan\nBachelor of Science\n[NAME_REDACTED]',
      piiFound: ['name'],
      redactionCount: 1,
      originalLength: 52,
      strippedLength: 62,
    });

    // Mock fetch
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        fields: { credentialType: 'DEGREE', issuerName: 'University of Michigan' },
        confidence: 0.92,
        provider: 'gemini',
        creditsRemaining: 49,
      }),
    });
    global.fetch = mockFetch;

    const file = new File(['dummy'], 'diploma.pdf', { type: 'application/pdf' });
    const result = await runExtraction(file, 'a'.repeat(64), 'DEGREE');

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(2);
    expect(result!.fields[0].key).toBe('credentialType');
    expect(result!.fields[0].value).toBe('DEGREE');
    expect(result!.fields[0].status).toBe('suggested');
    expect(result!.overallConfidence).toBe(0.92);
    expect(result!.creditsRemaining).toBe(49);
    expect(result!.ocrResult.method).toBe('pdfjs');
    expect(result!.strippingReport.piiFound).toContain('name');
  });

  it('sends a clean PII-stripped document summary to the worker and returns suggestions', async () => {
    (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'University of Michigan\nBachelor of Science\nIssued May 2026',
      pageCount: 1,
      method: 'pdfjs',
      durationMs: 180,
    });

    (stripPII as ReturnType<typeof vi.fn>).mockReturnValue({
      strippedText: 'University of Michigan\nBachelor of Science\nIssued May 2026',
      piiFound: [],
      redactionCount: 0,
      originalLength: 60,
      strippedLength: 60,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        fields: { credentialType: 'DEGREE', issuerName: 'University of Michigan' },
        confidence: 0.94,
        provider: 'gemini',
        creditsRemaining: 48,
      }),
    });
    global.fetch = mockFetch;

    const file = new File(['local pdf bytes stay client-side'], 'clean-degree.pdf', { type: 'application/pdf' });
    const result = await runExtraction(file, 'f'.repeat(64), 'DEGREE');

    expect(stripPIIEnhanced).toHaveBeenCalledTimes(1);
    expect(stripPIIEnhanced).toHaveBeenCalledWith(
      'University of Michigan\nBachelor of Science\nIssued May 2026',
      expect.objectContaining({ enableNER: true }),
    );
    expect(result?.fields).toEqual([
      { key: 'credentialType', value: 'DEGREE', confidence: 0.94, status: 'suggested' },
      { key: 'issuerName', value: 'University of Michigan', confidence: 0.94, status: 'suggested' },
    ]);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/ai/extract'),
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );
  });

  it('never sends raw OCR text or document bytes in the Constitution 4A worker payload', async () => {
    const rawOcrText = 'Jane Doe\nSSN 123-45-6789\nUniversity of Michigan\nBachelor of Science';
    const strippedText = '[NAME_REDACTED]\n[SSN_REDACTED]\nUniversity of Michigan\nBachelor of Science';
    const localDocumentBytes = 'binary-pdf-containing-Jane-Doe-and-123-45-6789';

    (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: rawOcrText,
      pageCount: 1,
      method: 'pdfjs',
      durationMs: 160,
    });

    (stripPII as ReturnType<typeof vi.fn>).mockReturnValue({
      strippedText,
      piiFound: ['name', 'ssn'],
      redactionCount: 2,
      originalLength: rawOcrText.length,
      strippedLength: strippedText.length,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        fields: { credentialType: 'DEGREE' },
        confidence: 0.9,
        provider: 'gemini',
        creditsRemaining: 47,
      }),
    });
    global.fetch = mockFetch;

    const file = new File([localDocumentBytes], 'private-degree.pdf', { type: 'application/pdf' });
    await runExtraction(file, 'e'.repeat(64), 'DEGREE');

    const requestBody = JSON.parse(String(mockFetch.mock.calls[0][1].body)) as Record<string, unknown>;
    const serializedBody = JSON.stringify(requestBody);

    expect(requestBody).toEqual({
      strippedText,
      credentialType: 'DEGREE',
      fingerprint: 'e'.repeat(64),
    });
    expect(serializedBody).not.toContain('Jane Doe');
    expect(serializedBody).not.toContain('123-45-6789');
    expect(serializedBody).not.toContain(localDocumentBytes);
    expect(requestBody).not.toHaveProperty('rawText');
    expect(requestBody).not.toHaveProperty('ocrText');
    expect(requestBody).not.toHaveProperty('file');
    expect(requestBody).not.toHaveProperty('imageBase64');
  });

  it('returns null when OCR finds no text', async () => {
    (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: '',
      pageCount: 1,
      method: 'pdfjs',
      durationMs: 100,
    });

    const progressCb = vi.fn();
    const file = new File(['dummy'], 'blank.pdf', { type: 'application/pdf' });
    const result = await runExtraction(file, 'a'.repeat(64), 'DEGREE', progressCb);

    expect(result).toBeNull();
    expect(progressCb).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'error', message: expect.stringContaining('No text found') }),
    );
  });

  it('returns null when not authenticated', async () => {
    (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'Some text',
      pageCount: 1,
      method: 'pdfjs',
      durationMs: 100,
    });

    (stripPII as ReturnType<typeof vi.fn>).mockReturnValue({
      strippedText: 'Some text',
      piiFound: [],
      redactionCount: 0,
      originalLength: 9,
      strippedLength: 9,
    });

    (supabase.auth.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { session: null },
    });

    const file = new File(['dummy'], 'doc.pdf', { type: 'application/pdf' });
    const result = await runExtraction(file, 'a'.repeat(64), 'DEGREE');

    expect(result).toBeNull();
  });

  it('returns null on API error', async () => {
    (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'Some text',
      pageCount: 1,
      method: 'pdfjs',
      durationMs: 100,
    });

    (stripPII as ReturnType<typeof vi.fn>).mockReturnValue({
      strippedText: 'Some text',
      piiFound: [],
      redactionCount: 0,
      originalLength: 9,
      strippedLength: 9,
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ message: 'Server error' }),
    });

    const file = new File(['dummy'], 'doc.pdf', { type: 'application/pdf' });
    const result = await runExtraction(file, 'a'.repeat(64), 'DEGREE');

    expect(result).toBeNull();
  });

  it('reports error message via progress callback on API failure', async () => {
    (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'Some text',
      pageCount: 1,
      method: 'pdfjs',
      durationMs: 100,
    });

    (stripPII as ReturnType<typeof vi.fn>).mockReturnValue({
      strippedText: 'Some text',
      piiFound: [],
      redactionCount: 0,
      originalLength: 9,
      strippedLength: 9,
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ message: 'AI extraction disabled' }),
    });

    const progressCb = vi.fn();
    const file = new File(['dummy'], 'doc.pdf', { type: 'application/pdf' });
    const result = await runExtraction(file, 'a'.repeat(64), 'DEGREE', progressCb);

    expect(result).toBeNull();
    expect(progressCb).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'error',
        message: expect.stringContaining('AI extraction disabled'),
      }),
    );
  });

  it('reports network error via progress callback on fetch failure', async () => {
    (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'Some text',
      pageCount: 1,
      method: 'pdfjs',
      durationMs: 100,
    });

    (stripPII as ReturnType<typeof vi.fn>).mockReturnValue({
      strippedText: 'Some text',
      piiFound: [],
      redactionCount: 0,
      originalLength: 9,
      strippedLength: 9,
    });

    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const progressCb = vi.fn();
    const file = new File(['dummy'], 'doc.pdf', { type: 'application/pdf' });
    const result = await runExtraction(file, 'a'.repeat(64), 'DEGREE', progressCb);

    expect(result).toBeNull();
    expect(progressCb).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'error',
        message: expect.stringContaining('Unable to connect'),
      }),
    );
  });

  it('times out the worker request so Secure Document can continue', async () => {
    vi.useFakeTimers();
    try {
      (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'University of Michigan\nBachelor of Science',
        pageCount: 1,
        method: 'pdfjs',
        durationMs: 100,
      });

      (stripPII as ReturnType<typeof vi.fn>).mockReturnValue({
        strippedText: 'University of Michigan\nBachelor of Science',
        piiFound: [],
        redactionCount: 0,
        originalLength: 39,
        strippedLength: 39,
      });

      globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      })) as typeof fetch;

      const progressCb = vi.fn();
      const file = new File(['dummy'], 'degree.pdf', { type: 'application/pdf' });
      const pending = runExtraction(
        file,
        'a'.repeat(64),
        'DEGREE',
        progressCb,
        { enableNER: false },
      );

      await vi.advanceTimersByTimeAsync(AI_EXTRACTION_REQUEST_TIMEOUT_MS);
      const result = await pending;

      expect(result).toBeNull();
      expect(progressCb).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'error',
          message: expect.stringContaining('timed out'),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports progress through all stages', async () => {
    (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'Some credential text',
      pageCount: 1,
      method: 'pdfjs',
      durationMs: 100,
    });

    (stripPII as ReturnType<typeof vi.fn>).mockReturnValue({
      strippedText: 'Some credential text',
      piiFound: [],
      redactionCount: 0,
      originalLength: 20,
      strippedLength: 20,
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        fields: { credentialType: 'CERTIFICATE' },
        confidence: 0.8,
        provider: 'mock',
        creditsRemaining: 30,
      }),
    });

    const progressCb = vi.fn();
    const file = new File(['dummy'], 'cert.pdf', { type: 'application/pdf' });
    await runExtraction(file, 'a'.repeat(64), 'CERTIFICATE', progressCb);

    const stages = progressCb.mock.calls.map((c: unknown[]) => (c[0] as { stage: string }).stage);
    expect(stages).toContain('ocr');
    expect(stages).toContain('stripping');
    expect(stages).toContain('extracting');
    expect(stages).toContain('complete');
  });

  // ───────────────────────────────────────────────────────────────────────
  // §1.6 FAIL-CLOSED (WEBEXT-03 / SCRUM-2505)
  //
  // If the on-device PII model OR the OCR engine fails, the flow MUST
  // hard-block egress: NO metadata (stripped or not) leaves the browser, and
  // the user sees a LOUD, explicit failure (progress.failClosed === true).
  // These are the security-critical tests — they prove the 2026-06-16 fail-open
  // regression cannot recur.
  // ───────────────────────────────────────────────────────────────────────
  describe('§1.6 fail-closed', () => {
    it('blocks egress (NO fetch) when the NER PII model fails to run', async () => {
      (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Jane Doe\nUniversity of Michigan\nBachelor of Science',
        pageCount: 1,
        method: 'pdfjs',
        durationMs: 120,
      });
      // NER stripping fails closed (the new contract).
      (stripPIIEnhanced as ReturnType<typeof vi.fn>).mockRejectedValue(
        new NerPiiFailClosedError('On-device privacy check could not run (NER model unavailable).'),
      );

      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      const progressCb = vi.fn();
      const file = new File(['private-bytes'], 'degree.pdf', { type: 'application/pdf' });
      const result = await runExtraction(file, 'a'.repeat(64), 'DEGREE', progressCb);

      // The network call must NEVER happen on the fail-closed path.
      expect(mockFetch).not.toHaveBeenCalled();
      // No successful extraction output.
      expect(result).toBeNull();
      // The user sees a LOUD, fail-closed error (not a silent skip).
      expect(progressCb).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'error', failClosed: true }),
      );
    });

    it('blocks egress (NO fetch) when the OCR engine fails to load', async () => {
      // Tesseract/core/lang failed to load on-device → fail-closed.
      (extractText as ReturnType<typeof vi.fn>).mockRejectedValue(
        new OcrEngineLoadError('On-device document reader could not start.'),
      );

      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      const progressCb = vi.fn();
      const file = new File(['scan-bytes'], 'scan.png', { type: 'image/png' });
      const result = await runExtraction(file, 'b'.repeat(64), 'OTHER', progressCb);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toBeNull();
      expect(progressCb).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'error', failClosed: true }),
      );
    });

    it('re-raises a Lane 1 NERModelLoadError as fail-closed (DEPENDS ON #1253)', async () => {
      (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Some PII-bearing text with names',
        pageCount: 1,
        method: 'pdfjs',
        durationMs: 100,
      });
      // Simulate Lane 1's typed error escaping the stripper unchanged.
      const nerLoadErr = Object.assign(new Error('CSP blocked the model'), {
        name: 'NERModelLoadError',
        failClosed: true,
      });
      (stripPIIEnhanced as ReturnType<typeof vi.fn>).mockRejectedValue(nerLoadErr);

      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      const progressCb = vi.fn();
      const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
      const result = await runExtraction(file, 'c'.repeat(64), 'DEGREE', progressCb);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toBeNull();
      expect(progressCb).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'error', failClosed: true }),
      );
    });

    it('does NOT mark soft failures (no text found) as fail-closed', async () => {
      (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: '',
        pageCount: 1,
        method: 'pdfjs',
        durationMs: 80,
      });

      const progressCb = vi.fn();
      const file = new File(['blank'], 'blank.pdf', { type: 'application/pdf' });
      const result = await runExtraction(file, 'a'.repeat(64), 'DEGREE', progressCb);

      expect(result).toBeNull();
      // A blank document is a soft, recoverable failure — NOT a privacy breach.
      const failClosedCalls = progressCb.mock.calls.filter(
        (c: unknown[]) => (c[0] as { failClosed?: boolean }).failClosed === true,
      );
      expect(failClosedCalls).toHaveLength(0);
    });

    it('does NOT mark an API/timeout failure as fail-closed (egress already PII-safe)', async () => {
      (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'University of Michigan\nBachelor of Science',
        pageCount: 1,
        method: 'pdfjs',
        durationMs: 100,
      });
      (stripPII as ReturnType<typeof vi.fn>).mockReturnValue({
        strippedText: 'University of Michigan\nBachelor of Science',
        piiFound: [],
        redactionCount: 0,
        originalLength: 39,
        strippedLength: 39,
      });
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ message: 'AI extraction disabled' }),
      });

      const progressCb = vi.fn();
      const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
      const result = await runExtraction(file, 'a'.repeat(64), 'DEGREE', progressCb);

      expect(result).toBeNull();
      // The strip already succeeded; the failure is downstream of egress safety.
      const failClosedCalls = progressCb.mock.calls.filter(
        (c: unknown[]) => (c[0] as { failClosed?: boolean }).failClosed === true,
      );
      expect(failClosedCalls).toHaveLength(0);
    });
  });
});
