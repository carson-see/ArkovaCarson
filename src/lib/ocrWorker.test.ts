/**
 * Tests for ocrWorker.ts — extractText routing logic.
 *
 * Validates that extractText dispatches to the correct handler based on
 * MIME type and file extension: mammoth for .docx, pdfjs for PDF,
 * text reader for plain text files, and throws for unsupported types.
 *
 * Heavy engines (Tesseract, real PDF.js, real mammoth) are mocked. F4
 * (2026-07-28, founder 22-format KPI) ADDS real, unmocked `utif2` /
 * `heic-decode` / `upng-js` decoding of real committed fixture files under
 * `src/lib/__fixtures__/ocr/` — these are the NEW decode logic this suite
 * proves, not just routing around a mock. Tesseract recognition output itself
 * stays mocked (deterministic, matches the file's pre-existing policy above);
 * genuine end-to-end Tesseract OCR of these fixtures is exercised manually /
 * in a real browser, not under jsdom (Tesseract's worker+wasm+CSP-pinned-path
 * machinery isn't practical to run for real inside vitest+jsdom).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'ocr');

/** Loads a real committed fixture file's bytes as a `File`. */
function fixtureFile(filename: string, type: string): File {
  const bytes = readFileSync(join(FIXTURES_DIR, filename));
  return new File([bytes], filename, { type });
}

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
import {
  extractText,
  extractTextFromImage,
  extractTextFromPDF,
  TESSERACT_VENDOR_PATHS,
  TIFF_MAX_PAGES,
  SCANNED_PDF_OCR_MAX_PAGES,
} from './ocrWorker';
import {
  OcrEngineLoadError,
  UnsupportedImageFormatError,
  isPiiStripFailClosedError,
} from './ocrFailClosed';

/** Helper: create a File with the given name, MIME type, and optional content */
function fakeFile(name: string, type: string, content = ''): File {
  return new File([content], name, { type });
}

/**
 * Loads one of the real, genuinely-generated spreadsheet fixtures under
 * src/lib/fixtures/spreadsheets/ (built with the actual `xlsx` (SheetJS)
 * writer — see src/lib/fixtures/spreadsheets/agents.md for regeneration) and
 * wraps it as a File. `xlsx` is NOT mocked in this test file, so these tests
 * exercise the real SheetJS reader against real binary bytes end-to-end.
 */
function spreadsheetFixtureFile(filename: string, type: string): File {
  const bytes = readFileSync(join(import.meta.dirname, 'fixtures', 'spreadsheets', filename));
  return new File([bytes], filename, { type });
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
// SCRUM-2911 lineage / F4 (2026-07-28, founder 22-format KPI) — TIFF/HEIC
// image-family completion.
//
// Pre-F4: browsers couldn't decode HEIC/TIFF at all, so the WHOLE FORMAT
// CATEGORY was soft-failed as UnsupportedImageFormatError before the OCR
// engine ever loaded. F4 adds real client-side decode (utif2 for TIFF,
// heic-decode for HEIC, both re-encoded to PNG via upng-js — no canvas), so
// these formats now decode+OCR successfully. The soft-fail contract MOVES
// from format-level to file-level: only a genuinely corrupt/malformed file
// within one of these formats still raises the typed benign error, and it
// must still do so WITHOUT ever loading the OCR engine.
//
// `utif2` / `heic-decode` / `upng-js` are REAL (not mocked) in this suite —
// they decode real committed fixture bytes from `__fixtures__/ocr/`. Only
// Tesseract recognition output is mocked (matches the file's stated policy).
// ───────────────────────────────────────────────────────────────────────────
describe('F4 — TIFF decode + OCR (real utif2, real fixtures)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateWorker.mockResolvedValue({
      recognize: mockTesseractRecognize,
      terminate: mockTesseractTerminate,
    });
    mockTesseractRecognize.mockResolvedValue({ data: { text: 'ocr text' } });
  });

  it('decodes a real single-page TIFF and OCRs it (method tesseract, pageCount 1)', async () => {
    const file = fixtureFile('text.tiff', 'image/tiff');

    const result = await extractTextFromImage(file);

    expect(result.method).toBe('tesseract');
    expect(result.pageCount).toBe(1);
    expect(result.text).toBe('ocr text');
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
  });

  it('decodes a real MULTI-PAGE TIFF and OCRs every page, joining distinct per-page text', async () => {
    let call = 0;
    mockTesseractRecognize.mockImplementation(async () => ({
      data: { text: `PAGE-${++call}` },
    }));

    const file = fixtureFile('multipage.tiff', 'image/tiff');
    const result = await extractTextFromImage(file);

    expect(result.pageCount).toBe(3); // multipage.tiff has 3 real pages
    expect(mockCreateWorker).toHaveBeenCalledTimes(3); // one worker per page, via the shared Tesseract runner
    expect(result.text).toBe('PAGE-1\n\nPAGE-2\n\nPAGE-3');
  });

  it('caps multi-page processing at TIFF_MAX_PAGES (real 22-page fixture, cap is 20)', async () => {
    const file = fixtureFile('overcap.tiff', 'image/tiff');
    const result = await extractTextFromImage(file);

    expect(TIFF_MAX_PAGES).toBe(20);
    expect(result.pageCount).toBe(20);
    expect(mockCreateWorker).toHaveBeenCalledTimes(20);
  });

  it('detects TIFF by extension even when MIME is empty (real browser metadata often omits it)', async () => {
    const file = fixtureFile('text.tiff', '');
    const result = await extractTextFromImage(file);
    expect(result.method).toBe('tesseract');
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
  });

  it('extractText: routes a real .tiff with GENERIC MIME (application/octet-stream) to OCR, not the unsupported-file-type error', async () => {
    const file = fixtureFile('text.tiff', 'application/octet-stream');
    const result = await extractText(file);
    expect(result.method).toBe('tesseract');
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
  });
});

describe('F4 — HEIC decode + OCR (real heic-decode, real fixtures)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateWorker.mockResolvedValue({
      recognize: mockTesseractRecognize,
      terminate: mockTesseractTerminate,
    });
    mockTesseractRecognize.mockResolvedValue({ data: { text: 'ocr text' } });
  });

  it('decodes a real HEIC file and OCRs it (method tesseract, pageCount 1)', async () => {
    const file = fixtureFile('text.heic', 'image/heic');

    const result = await extractTextFromImage(file);

    expect(result.method).toBe('tesseract');
    expect(result.pageCount).toBe(1);
    expect(result.text).toBe('ocr text');
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
  });

  it('detects HEIC by extension even when MIME is empty', async () => {
    const file = fixtureFile('text.heic', '');
    const result = await extractTextFromImage(file);
    expect(result.method).toBe('tesseract');
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
  });

  it('extractText: routes a real .heic with EMPTY MIME to OCR (not the generic unsupported-file-type error)', async () => {
    const file = fixtureFile('text.heic', '');
    const result = await extractText(file);
    expect(result.method).toBe('tesseract');
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
    expect(mockExtractRawText).not.toHaveBeenCalled();
    expect(mockGetDocument).not.toHaveBeenCalled();
  });
});

describe('F4 — genuinely corrupt/hostile TIFF and HEIC files still soft-fail benignly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateWorker.mockResolvedValue({
      recognize: mockTesseractRecognize,
      terminate: mockTesseractTerminate,
    });
    mockTesseractRecognize.mockResolvedValue({ data: { text: 'ocr text' } });
  });

  it('a truncated/corrupt TIFF raises the benign UnsupportedImageFormatError WITHOUT loading the OCR engine', async () => {
    // Real fixture: text.tiff truncated to 2000 bytes. utif2 does not always
    // THROW on malformed input (SCRUM-2911 lineage) — it can silently return
    // an IFD with no usable width/height, which the production code detects
    // and treats as an undecodable page.
    const file = fixtureFile('corrupt.tiff', 'image/tiff');

    const caught = await extractTextFromImage(file).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(UnsupportedImageFormatError);
    expect(isPiiStripFailClosedError(caught)).toBe(false);
    expect(caught).not.toBeInstanceOf(OcrEngineLoadError);
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it('a truncated/corrupt HEIC raises the benign UnsupportedImageFormatError WITHOUT loading the OCR engine', async () => {
    // Real fixture: text.heic truncated to 100 bytes — heic-decode validates
    // the HEIC brand box up front and throws cleanly.
    const file = fixtureFile('corrupt.heic', 'image/heic');

    const caught = await extractTextFromImage(file).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(UnsupportedImageFormatError);
    expect(isPiiStripFailClosedError(caught)).toBe(false);
    expect(caught).not.toBeInstanceOf(OcrEngineLoadError);
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it('does not hang on a non-TIFF/non-HEIC byte soup carrying a .tiff extension', async () => {
    const file = fakeFile('garbage.tiff', 'image/tiff', 'not actually a tiff file at all, just garbage bytes 12345');

    const caught = await Promise.race([
      extractTextFromImage(file).catch((e: unknown) => e),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMED OUT — hung on hostile input')), 5000)),
    ]);

    expect(caught).toBeInstanceOf(UnsupportedImageFormatError);
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it('does not hang on a non-HEIC byte soup carrying a .heic extension', async () => {
    const file = fakeFile('garbage.heic', 'image/heic', 'not actually a heic file at all, just garbage bytes 12345');

    const caught = await Promise.race([
      extractTextFromImage(file).catch((e: unknown) => e),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMED OUT — hung on hostile input')), 5000)),
    ]);

    expect(caught).toBeInstanceOf(UnsupportedImageFormatError);
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F1 (founder amendment 2026-07-28) — spreadsheet document-mode extraction.
//
// REGRESSION PIN: before this change, .xlsx/.xls/.ods fell all the way
// through extractText's dispatch chain (not PDF, not DOCX, not an image, not
// in TEXT_TYPES/TEXT_EXTENSIONS) and hit the generic
// `throw new Error(OCR_LABELS.UNSUPPORTED_FILE_TYPE(...))` at the bottom —
// a silent soft-fail, not a real extraction. These tests exercise the REAL
// `xlsx` (SheetJS) package (not mocked in this file) against genuinely
// generated binary fixture files, proving extraction actually works rather
// than merely not throwing.
// ─────────────────────────────────────────────────────────────────────────
describe('extractText — spreadsheet document-mode extraction (F1)', () => {
  const EXPECTED_ROWS = [
    'Name,Role,Notes',
    'Alice Rivera,Engineer,Backend team',
    'Bob Chen,Designer,Design system',
    'Cara Osei,PM,Roadmap owner',
  ];

  it.each([
    ['sample-roster.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['sample-roster.xls', 'application/vnd.ms-excel'],
    ['sample-roster.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ])('extracts real row/column text from a genuine %s fixture via SheetJS (method: "spreadsheet")', async (filename, type) => {
    const file = spreadsheetFixtureFile(filename, type);

    const result = await extractText(file);

    expect(result.method).toBe('spreadsheet');
    expect(result.pageCount).toBe(1); // one sheet ("Roster") in the fixture
    for (const row of EXPECTED_ROWS) {
      expect(result.text).toContain(row);
    }
    // The extraction must not have gone through any of the other engines.
    expect(mockExtractRawText).not.toHaveBeenCalled();
    expect(mockGetDocument).not.toHaveBeenCalled();
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it('routes .xlsx by extension alone even with an empty/generic MIME (real browser file metadata)', async () => {
    const bytes = readFileSync(join(import.meta.dirname, 'fixtures', 'spreadsheets', 'sample-roster.xlsx'));
    const file = new File([bytes], 'sample-roster.xlsx', { type: '' });

    const result = await extractText(file);

    expect(result.method).toBe('spreadsheet');
    expect(result.text).toContain('Alice Rivera,Engineer,Backend team');
  });

  it('a real, genuine .csv fixture extracts as plain text (unchanged TEXT_TYPES path — CSV was never broken)', async () => {
    const file = spreadsheetFixtureFile('sample-roster.csv', 'text/csv');

    const result = await extractText(file);

    expect(result.method).toBe('text');
    for (const row of EXPECTED_ROWS) {
      expect(result.text).toContain(row);
    }
  });

  it('an empty workbook (no sheets) does not throw — returns empty text instead of a soft-fail error', async () => {
    // Round-trip a File built from a workbook with a sheet but zero populated
    // rows, exercising the `sheet ? … : ''` guard without a real binary asset.
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([[]]);
    XLSX.utils.book_append_sheet(wb, ws, 'Empty');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const file = new File([buf], 'empty.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const result = await extractText(file);

    expect(result.method).toBe('spreadsheet');
    expect(result.pageCount).toBe(1);
    expect(result.text).toContain('# Empty');
  });
});

describe('F4 — fail-closed dominance: a REAL OCR-engine failure still wins over the format layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // This is the regression test for the dominance rule stated in the module
  // docs: "real PII/OCR-engine failures still fail closed; format-undecodable
  // stays benign." A well-formed TIFF/HEIC decodes FINE (format layer has
  // nothing to complain about) — but if Tesseract itself then fails to load
  // or run, that must surface as OcrEngineLoadError (§1.6 fail-closed), never
  // be misclassified as a benign UnsupportedImageFormatError.
  it('TIFF: decode succeeds, but Tesseract engine load fails → OcrEngineLoadError (fail-closed), not benign', async () => {
    mockCreateWorker.mockRejectedValue(new Error('Failed to fetch dynamically imported module'));
    const file = fixtureFile('text.tiff', 'image/tiff');

    const caught = await extractTextFromImage(file).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(OcrEngineLoadError);
    expect((caught as OcrEngineLoadError).failClosed).toBe(true);
    expect(isPiiStripFailClosedError(caught)).toBe(true);
    expect(caught).not.toBeInstanceOf(UnsupportedImageFormatError);
  });

  it('HEIC: decode succeeds, but Tesseract recognition throws → OcrEngineLoadError (fail-closed), not benign', async () => {
    mockCreateWorker.mockResolvedValue({
      recognize: mockTesseractRecognize,
      terminate: mockTesseractTerminate,
    });
    mockTesseractRecognize.mockRejectedValue(new Error('wasm OOM'));
    const file = fixtureFile('text.heic', 'image/heic');

    const caught = await extractTextFromImage(file).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(OcrEngineLoadError);
    expect(isPiiStripFailClosedError(caught)).toBe(true);
    expect(caught).not.toBeInstanceOf(UnsupportedImageFormatError);
    expect(mockTesseractTerminate).toHaveBeenCalled(); // worker still released on failure
  });

  it('still runs OCR for already-supported raster formats (png/jpg) — unaffected by F4', async () => {
    mockCreateWorker.mockResolvedValue({
      recognize: mockTesseractRecognize,
      terminate: mockTesseractTerminate,
    });
    mockTesseractRecognize.mockResolvedValue({ data: { text: 'ocr text' } });
    const file = fakeFile('scan.png', 'image/png', 'fake-image-bytes');
    const result = await extractTextFromImage(file);
    expect(result.method).toBe('tesseract');
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F4 — verify png/jpg/jpeg/gif/webp genuinely route through the Tesseract
// path with REAL fixture bytes (not the old placeholder `'fake-image-bytes'`
// strings). Real, unmocked pdfjs+utif2+heic-decode decoding is proven in the
// two describe blocks above and in `ocrWorker.realDecode.test.ts`; Tesseract
// execution itself stays mocked here per the file's stated policy.
// ───────────────────────────────────────────────────────────────────────────
describe('F4 — png/jpg/jpeg/gif/webp verification with real fixture bytes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateWorker.mockResolvedValue({
      recognize: mockTesseractRecognize,
      terminate: mockTesseractTerminate,
    });
    mockTesseractRecognize.mockResolvedValue({ data: { text: 'ARKOVA TEST' } });
  });

  it.each([
    ['text.png', 'image/png'],
    ['text.jpg', 'image/jpeg'],
    ['text.gif', 'image/gif'],
    ['text.webp', 'image/webp'],
  ])('extractTextFromImage(%s) routes to Tesseract and returns its text', async (filename, type) => {
    const file = fixtureFile(filename, type);
    const result = await extractTextFromImage(file);

    expect(result.method).toBe('tesseract');
    expect(result.text).toBe('ARKOVA TEST');
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
    // Tesseract receives the real File directly — no TIFF/HEIC decode/re-encode detour.
    expect(mockTesseractRecognize).toHaveBeenCalledWith(file);
  });

  it.each([
    ['text.png', 'image/png'],
    ['text.jpg', 'image/jpeg'],
    ['text.gif', 'image/gif'],
    ['text.webp', 'image/webp'],
  ])('extractText(%s) top-level dispatcher routes the same way', async (filename, type) => {
    const file = fixtureFile(filename, type);
    const result = await extractText(file);
    expect(result.method).toBe('tesseract');
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F4 — scanned/image-only PDF OCR fallback (the highest-value gap for the
// Kenyan legal-docs pilot per the sprint brief). PDF.js itself stays mocked
// (existing policy); this suite proves the ROUTING contract: a text-layer PDF
// never takes the slow OCR path, a scanned PDF does, and both page-count and
// wall-clock caps degrade gracefully instead of hanging.
//
// jsdom has no real `<canvas>` backend (the `canvas` npm package isn't
// installed — a deliberate scope call, see the PR body). `page.render()` is
// fully mocked below and never touches the canvas context, so a minimal
// non-null stub for `getContext('2d')` + `toBlob` is sufficient to exercise
// the fallback loop's OWN logic (page/time caps, Tesseract dispatch) without
// needing real pixel rendering.
// ───────────────────────────────────────────────────────────────────────────
describe('F4 — scanned/image-only PDF OCR fallback', () => {
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let toBlobSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateWorker.mockResolvedValue({
      recognize: mockTesseractRecognize,
      terminate: mockTesseractTerminate,
    });
    mockTesseractRecognize.mockResolvedValue({ data: { text: 'ocr text' } });

    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({} as unknown as CanvasRenderingContext2D);
    toBlobSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback) {
        callback(new Blob(['fake-page-render'], { type: 'image/png' }));
      });
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    toBlobSpy.mockRestore();
    vi.useRealTimers();
  });

  /** Wires the shared pdfjs mocks to a fake document with the given per-page text ('' = no text layer / scanned). */
  function mockPdfWithPages(pageTexts: string[]) {
    const mockRender = vi.fn().mockReturnValue({ promise: Promise.resolve() });
    mockGetPage.mockImplementation(async (pageNum: number) => {
      const text = pageTexts[pageNum - 1] ?? '';
      return {
        getTextContent: vi.fn().mockResolvedValue({ items: text ? [{ str: text }] : [] }),
        getViewport: vi.fn().mockReturnValue({ width: 100, height: 100 }),
        render: mockRender,
      };
    });
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: pageTexts.length, getPage: mockGetPage }),
    });
    return { mockRender };
  }

  it('a real text-layer PDF (non-empty text) does NOT take the OCR fallback path', async () => {
    const { mockRender } = mockPdfWithPages(['ARKOVA REAL TEXT LAYER PDF']);
    const file = fakeFile('text-layer.pdf', 'application/pdf', '%PDF-fake');

    const result = await extractTextFromPDF(file);

    expect(result.method).toBe('pdfjs');
    expect(result.text).toBe('ARKOVA REAL TEXT LAYER PDF');
    // The slow path must never fire for a text PDF.
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it('a scanned/image-only PDF (empty text layer on every page) triggers the OCR fallback', async () => {
    let call = 0;
    mockTesseractRecognize.mockImplementation(async () => ({ data: { text: `PAGE-${++call}` } }));
    const { mockRender } = mockPdfWithPages(['', '']); // 2 pages, no text layer at all

    const file = fakeFile('scanned.pdf', 'application/pdf', '%PDF-fake');
    const result = await extractTextFromPDF(file);

    expect(result.method).toBe('pdfjs-ocr');
    expect(result.pageCount).toBe(2);
    expect(mockRender).toHaveBeenCalledTimes(2);
    expect(mockCreateWorker).toHaveBeenCalledTimes(2); // one Tesseract worker per rendered page
    expect(result.text).toBe('PAGE-1\n\nPAGE-2');
  });

  it('a PDF with text on SOME pages but not others does not trigger OCR (any real text anywhere short-circuits it)', async () => {
    const { mockRender } = mockPdfWithPages(['', 'real text on page 2']);
    const file = fakeFile('mixed.pdf', 'application/pdf', '%PDF-fake');

    const result = await extractTextFromPDF(file);

    expect(result.method).toBe('pdfjs');
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it('caps the OCR fallback at SCANNED_PDF_OCR_MAX_PAGES for a huge scanned document', async () => {
    const pageTexts = new Array(25).fill(''); // 25 empty-text pages, cap is 20
    const { mockRender } = mockPdfWithPages(pageTexts);

    const file = fakeFile('huge-scan.pdf', 'application/pdf', '%PDF-fake');
    const result = await extractTextFromPDF(file);

    expect(SCANNED_PDF_OCR_MAX_PAGES).toBe(20);
    expect(result.pageCount).toBe(20);
    expect(mockRender).toHaveBeenCalledTimes(20);
    expect(mockCreateWorker).toHaveBeenCalledTimes(20);
  });

  it('bounds the OCR fallback by wall-clock time, degrading gracefully instead of hanging', async () => {
    vi.useFakeTimers();
    const { mockRender } = mockPdfWithPages(['', '', '', '']); // 4 pages
    // After the first page renders, jump the clock past the time budget so
    // the loop bails before processing the remaining pages.
    let renderCalls = 0;
    mockRender.mockImplementation(() => {
      renderCalls++;
      if (renderCalls === 1) {
        vi.setSystemTime(Date.now() + 181_000); // > SCANNED_PDF_OCR_MAX_DURATION_MS (180_000)
      }
      return { promise: Promise.resolve() };
    });

    const file = fakeFile('slow-scan.pdf', 'application/pdf', '%PDF-fake');
    const resultPromise = extractTextFromPDF(file);
    const result = await resultPromise;

    expect(result.method).toBe('pdfjs-ocr');
    // Only the first page was processed before the deadline check bailed.
    expect(result.pageCount).toBe(1);
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully (no throw, no hang) when canvas support is unavailable', async () => {
    getContextSpy.mockReturnValue(null);
    const { mockRender } = mockPdfWithPages(['', '']);

    const file = fakeFile('no-canvas.pdf', 'application/pdf', '%PDF-fake');
    const result = await Promise.race([
      extractTextFromPDF(file),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMED OUT')), 5000)),
    ]);

    expect(result.method).toBe('pdfjs-ocr');
    expect(result.text).toBe('');
    expect(mockRender).not.toHaveBeenCalled(); // bailed before ever rendering
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it('fail-closed dominance: a real OCR-engine failure in the scanned-PDF path still surfaces OcrEngineLoadError', async () => {
    mockCreateWorker.mockRejectedValue(new Error('Failed to fetch dynamically imported module'));
    mockPdfWithPages(['']);

    const file = fakeFile('scanned-engine-fail.pdf', 'application/pdf', '%PDF-fake');
    const caught = await extractTextFromPDF(file).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(OcrEngineLoadError);
    expect((caught as OcrEngineLoadError).failClosed).toBe(true);
  });
});
