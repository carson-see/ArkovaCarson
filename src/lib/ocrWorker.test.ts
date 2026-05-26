/**
 * Tests for ocrWorker.ts — extractText routing logic.
 *
 * Validates that extractText dispatches to the correct handler based on
 * MIME type and file extension: mammoth for .docx, pdfjs for PDF,
 * text reader for plain text files, and throws for unsupported types.
 *
 * Heavy engines (Tesseract, real PDF.js, real mammoth) are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock mammoth (dynamic import)
// ---------------------------------------------------------------------------
const mockExtractRawText = vi.fn().mockResolvedValue({ value: 'mammoth extracted text' });
vi.mock('mammoth', () => ({
  default: { extractRawText: (...args: unknown[]) => mockExtractRawText(...args) },
  extractRawText: (...args: unknown[]) => mockExtractRawText(...args),
}));

// ---------------------------------------------------------------------------
// Mock pdfjs-dist (dynamic import)
// ---------------------------------------------------------------------------
const mockGetTextContent = vi.fn().mockResolvedValue({
  items: [{ str: 'pdf page text' }],
});
const mockGetPage = vi.fn().mockResolvedValue({ getTextContent: mockGetTextContent });
const mockGetDocument = vi.fn().mockReturnValue({
  promise: Promise.resolve({ numPages: 1, getPage: mockGetPage }),
});
vi.mock('pdfjs-dist', () => ({
  default: {
    getDocument: (...args: unknown[]) => mockGetDocument(...args),
    GlobalWorkerOptions: { workerSrc: '' },
  },
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
  GlobalWorkerOptions: { workerSrc: '' },
}));

// ---------------------------------------------------------------------------
// Mock tesseract.js (dynamic import) — we won't exercise it but need it to
// exist so the module loads without error.
// ---------------------------------------------------------------------------
vi.mock('tesseract.js', () => ({
  default: {
    createWorker: vi.fn().mockResolvedValue({
      recognize: vi.fn().mockResolvedValue({ data: { text: 'ocr text' } }),
      terminate: vi.fn(),
    }),
  },
  createWorker: vi.fn().mockResolvedValue({
    recognize: vi.fn().mockResolvedValue({ data: { text: 'ocr text' } }),
    terminate: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import under test — AFTER mocks are declared
// ---------------------------------------------------------------------------
import { extractText } from './ocrWorker';

/** Helper: create a File with the given name, MIME type, and optional content */
function fakeFile(name: string, type: string, content = ''): File {
  return new File([content], name, { type });
}

describe('extractText routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // .docx via mammoth (.doc is unsupported — mammoth only handles .docx)
  // -------------------------------------------------------------------------

  it('routes .docx files by MIME type to mammoth handler and returns method "mammoth"', async () => {
    const file = fakeFile(
      'report.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'binary-content',
    );

    const result = await extractText(file);

    expect(result.method).toBe('mammoth');
    expect(result.text).toBe('mammoth extracted text');
    expect(result.pageCount).toBe(1);
    expect(mockExtractRawText).toHaveBeenCalledTimes(1);
    // Verify it was called with an object containing arrayBuffer
    const callArg = mockExtractRawText.mock.calls[0][0] as { arrayBuffer: ArrayBuffer };
    expect(callArg).toHaveProperty('arrayBuffer');
    expect(callArg.arrayBuffer).toBeInstanceOf(ArrayBuffer);
  });

  it('routes .docx files by extension to mammoth handler even with empty MIME type', async () => {
    const file = fakeFile('contract.docx', '', 'binary-content');

    const result = await extractText(file);

    expect(result.method).toBe('mammoth');
    expect(mockExtractRawText).toHaveBeenCalledTimes(1);
  });

  it('rejects legacy .doc files (mammoth only supports .docx)', async () => {
    const file = fakeFile('legacy.doc', 'application/msword', 'binary-content');

    await expect(extractText(file)).rejects.toThrow(/Unsupported file type/);
    expect(mockExtractRawText).not.toHaveBeenCalled();
  });

  it('rejects .doc files by extension alone', async () => {
    const file = fakeFile('old-file.doc', '', 'binary-content');

    await expect(extractText(file)).rejects.toThrow(/Unsupported file type/);
    expect(mockExtractRawText).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Unsupported file types
  // -------------------------------------------------------------------------

  it('throws for unsupported file types', async () => {
    const file = fakeFile('data.xyz', 'application/x-unknown');

    await expect(extractText(file)).rejects.toThrow(/Unsupported file type/);
    expect(mockExtractRawText).not.toHaveBeenCalled();
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  it('throws for unknown extension with empty MIME', async () => {
    const file = fakeFile('mystery.zzz', '');

    await expect(extractText(file)).rejects.toThrow(/Unsupported file type/);
  });

  // -------------------------------------------------------------------------
  // Plain text files
  // -------------------------------------------------------------------------

  it('routes plain text files by MIME type', async () => {
    const file = fakeFile('notes.txt', 'text/plain', 'Hello, world!');

    const result = await extractText(file);

    expect(result.method).toBe('text');
    expect(result.text).toBe('Hello, world!');
    expect(result.pageCount).toBe(1);
    // mammoth and pdfjs should NOT have been called
    expect(mockExtractRawText).not.toHaveBeenCalled();
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  it('routes .csv files by extension', async () => {
    const file = fakeFile('data.csv', '', 'a,b,c\n1,2,3');

    const result = await extractText(file);

    expect(result.text).toBe('a,b,c\n1,2,3');
    expect(mockExtractRawText).not.toHaveBeenCalled();
  });

  it('routes .json files by extension', async () => {
    const file = fakeFile('config.json', '', '{"key":"value"}');

    const result = await extractText(file);

    expect(result.text).toBe('{"key":"value"}');
  });

  // -------------------------------------------------------------------------
  // PDF files
  // -------------------------------------------------------------------------

  it('routes PDF files by MIME type to pdfjs handler', async () => {
    const file = fakeFile('document.pdf', 'application/pdf', '%PDF-fake');

    const result = await extractText(file);

    expect(result.method).toBe('pdfjs');
    expect(result.text).toBe('pdf page text');
    expect(result.pageCount).toBe(1);
    expect(mockGetDocument).toHaveBeenCalledTimes(1);
    expect(mockExtractRawText).not.toHaveBeenCalled();
  });

  it('routes PDF files by .pdf extension even with empty MIME', async () => {
    const file = fakeFile('scan.pdf', '', '%PDF-fake');

    const result = await extractText(file);

    expect(result.method).toBe('pdfjs');
    expect(mockGetDocument).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('routes .DOCX (uppercase extension) to mammoth handler', async () => {
    const file = fakeFile('SHOUTING.DOCX', '', 'binary');

    const result = await extractText(file);

    expect(result.method).toBe('mammoth');
    expect(mockExtractRawText).toHaveBeenCalledTimes(1);
  });

  it('includes durationMs as a non-negative number', async () => {
    const file = fakeFile('timing.docx', '', 'content');

    const result = await extractText(file);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe('number');
  });
});
