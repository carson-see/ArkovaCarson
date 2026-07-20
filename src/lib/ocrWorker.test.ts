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
// Mock tesseract.js (dynamic import). createWorker is a shared spy so tests can
// inspect the WEBEXT-02 self-host options and force load failures (WEBEXT-03).
// ---------------------------------------------------------------------------
const mockTesseractRecognize = vi.fn().mockResolvedValue({ data: { text: 'ocr text' } });
const mockTesseractTerminate = vi.fn();
const mockCreateWorker = vi.fn().mockResolvedValue({
  recognize: mockTesseractRecognize,
  terminate: mockTesseractTerminate,
});
vi.mock('tesseract.js', () => ({
  default: { createWorker: (...args: unknown[]) => mockCreateWorker(...args) },
  createWorker: (...args: unknown[]) => mockCreateWorker(...args),
}));

// ---------------------------------------------------------------------------
// Import under test — AFTER mocks are declared
// ---------------------------------------------------------------------------
import { extractText, extractTextFromImage, TESSERACT_VENDOR_PATHS } from './ocrWorker';
import {
  OcrEngineLoadError,
  UnsupportedImageFormatError,
  isPiiStripFailClosedError,
} from './ocrFailClosed';

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

// ---------------------------------------------------------------------------
// WEBEXT-02 / SCRUM-2504 — Tesseract self-host under CSP 'self'
// WEBEXT-03 / SCRUM-2505 — OCR engine fail-closed
// ---------------------------------------------------------------------------
describe('Tesseract self-host + fail-closed (WEBEXT-02/03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateWorker.mockResolvedValue({
      recognize: mockTesseractRecognize,
      terminate: mockTesseractTerminate,
    });
    mockTesseractRecognize.mockResolvedValue({ data: { text: 'ocr text' } });
  });

  it('exposes vendored, same-origin (/vendor) Tesseract asset paths — no CDN', () => {
    // The exported config is the single source of truth for the CI CSP guard.
    expect(TESSERACT_VENDOR_PATHS.workerPath).toMatch(/^\/vendor\/tesseract\//);
    expect(TESSERACT_VENDOR_PATHS.corePath).toMatch(/^\/vendor\/tesseract\//);
    expect(TESSERACT_VENDOR_PATHS.langPath).toMatch(/^\/vendor\/tesseract\//);
    for (const p of Object.values(TESSERACT_VENDOR_PATHS)) {
      expect(p).not.toMatch(/jsdelivr|unpkg|tessdata|cdn|https?:/i);
    }
  });

  it('passes the vendored self-host options to createWorker (no jsdelivr/CDN fetch)', async () => {
    const file = fakeFile('scan.png', 'image/png', 'fake-image-bytes');

    const result = await extractTextFromImage(file);

    expect(result.method).toBe('tesseract');
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
    const [lang, , workerOptions] = mockCreateWorker.mock.calls[0] as [
      string,
      unknown,
      { workerPath?: string; corePath?: string; langPath?: string },
    ];
    expect(lang).toBe('eng');
    // The 3rd arg (WorkerOptions) must pin all three asset roots to /vendor.
    expect(workerOptions.workerPath).toBe(TESSERACT_VENDOR_PATHS.workerPath);
    expect(workerOptions.corePath).toBe(TESSERACT_VENDOR_PATHS.corePath);
    expect(workerOptions.langPath).toBe(TESSERACT_VENDOR_PATHS.langPath);
  });

  it('FAILS CLOSED with OcrEngineLoadError when the OCR engine cannot load', async () => {
    // Simulate the CSP-blocked / network-failed core load.
    mockCreateWorker.mockRejectedValue(new Error('Failed to fetch dynamically imported module'));

    const file = fakeFile('scan.png', 'image/png', 'fake-image-bytes');

    const caught = await extractTextFromImage(file).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(OcrEngineLoadError);
    expect((caught as OcrEngineLoadError).failClosed).toBe(true);
    expect((caught as OcrEngineLoadError).stage).toBe('ocr');
  });

  it('FAILS CLOSED when recognition itself throws (engine ran but failed)', async () => {
    mockTesseractRecognize.mockRejectedValue(new Error('wasm OOM'));

    const file = fakeFile('scan.png', 'image/png', 'fake-image-bytes');

    const caught = await extractTextFromImage(file).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(OcrEngineLoadError);
    // The worker must still be terminated even on failure (no leak).
    expect(mockTesseractTerminate).toHaveBeenCalled();
  });

  it('does NOT leak document bytes into the fail-closed error message', async () => {
    mockCreateWorker.mockRejectedValue(new Error('boom containing secret-doc-bytes-ABC123'));

    const file = fakeFile('scan.png', 'image/png', 'secret-doc-bytes-ABC123');

    const caught = await extractTextFromImage(file).catch((e: unknown) => e) as Error;
    // The surfaced message must be the fixed copy, not the raw underlying error.
    expect(caught.message).not.toContain('secret-doc-bytes-ABC123');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SCRUM-2911 sub-item 1 — unsupported image formats (.heic / .tiff) SOFT-FAIL.
//
// Browsers can't decode HEIC/TIFF, so Tesseract recognition throws. Previously
// that failure was wrapped as OcrEngineLoadError (a §1.6 fail-closed error),
// which surfaced the FALSE "privacy failure" screen even though the document
// was never at risk. These must instead raise a BENIGN UnsupportedImageFormatError
// WITHOUT ever loading/running the OCR engine — nothing left the device.
// ───────────────────────────────────────────────────────────────────────────
describe('unsupported image formats soft-fail (SCRUM-2911)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateWorker.mockResolvedValue({
      recognize: mockTesseractRecognize,
      terminate: mockTesseractTerminate,
    });
    mockTesseractRecognize.mockResolvedValue({ data: { text: 'ocr text' } });
  });

  it.each([
    ['photo.heic', 'image/heic'],
    ['photo.heif', 'image/heif'],
    ['scan.tiff', 'image/tiff'],
    ['scan.tif', 'image/tif'],
  ])('raises a benign UnsupportedImageFormatError for %s (%s)', async (name, type) => {
    const file = fakeFile(name, type, 'binary-image-bytes');

    const caught = await extractTextFromImage(file).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(UnsupportedImageFormatError);
    // This is a benign case — it must NOT be a §1.6 privacy fail-closed error.
    expect(isPiiStripFailClosedError(caught)).toBe(false);
    expect(caught).not.toBeInstanceOf(OcrEngineLoadError);
    // The engine must never even be loaded — no privacy guarantee was in play.
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it('detects unsupported formats by extension even when MIME is empty', async () => {
    const file = fakeFile('IMG_0042.HEIC', '', 'binary-image-bytes');

    const caught = await extractTextFromImage(file).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(UnsupportedImageFormatError);
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it('still runs OCR for supported image formats (png/jpg)', async () => {
    const file = fakeFile('scan.png', 'image/png', 'fake-image-bytes');
    const result = await extractTextFromImage(file);
    expect(result.method).toBe('tesseract');
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
  });

  it('routes HEIC/TIFF through extractText to the benign error (not fail-closed)', async () => {
    const heic = fakeFile('photo.heic', 'image/heic', 'binary');
    const caught = await extractText(heic).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(UnsupportedImageFormatError);
    expect(isPiiStripFailClosedError(caught)).toBe(false);
  });
});
