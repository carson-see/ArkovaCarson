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

// Mock supabase
vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
    },
  },
}));

import { runExtraction } from './aiExtraction';
import { extractText } from './ocrWorker';
import { stripPII } from './piiStripper';
import { supabase } from './supabase';

describe('aiExtraction orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated session
    (supabase.auth.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { session: { access_token: 'test-token' } },
    });
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
});
