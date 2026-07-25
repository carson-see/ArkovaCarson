/**
 * OCR Worker Module (P8-S5)
 *
 * CLIENT-SIDE ONLY — runs OCR on documents entirely in the browser.
 * Uses PDF.js for PDF text extraction and Tesseract.js for image OCR.
 *
 * Constitution 1.6: Documents never leave the user's device.
 * Constitution 4A: Raw OCR text stays client-side; only PII-stripped
 * metadata may be sent to the server.
 *
 * WEBEXT-02 / SCRUM-2504 — Tesseract is self-hosted under CSP 'self'. The
 * Tesseract core (wasm), the worker script, and the English language data are
 * served from an Arkova-controlled origin (`/vendor/tesseract/...`), NOT from
 * `cdn.jsdelivr.net`. The deployed CSP (`vercel.json`) forbids jsdelivr, so the
 * upstream-default CDN load would silently fail; pinning to /vendor keeps OCR
 * working under the production CSP. Assets are lazy-loaded (only on first image
 * OCR) and browser-cached; they are NOT bundled into the JS app.
 *
 * WEBEXT-03 / SCRUM-2505 — the OCR engine FAILS CLOSED: if the core/worker/lang
 * cannot load or recognition throws, `extractTextFromImage` raises an
 * `OcrEngineLoadError` (a fail-closed error) so the orchestrator blocks egress.
 */

import { OCR_LABELS } from './copy';
import { OcrEngineLoadError, UnsupportedImageFormatError } from './ocrFailClosed';

/**
 * SCRUM-2911 — image formats browsers cannot decode for on-device OCR.
 * HEIC/HEIF have effectively no browser canvas-decode support, and TIFF is not
 * decodable in the mainstream browsers Tesseract relies on. Attempting OCR on
 * these throws deep in recognition, where the failure would otherwise be
 * misclassified as a §1.6 OCR-engine fail-closed error and surface the FALSE
 * privacy-failure screen. We detect them up front and soft-fail benignly
 * instead — before the engine loads and before anything could leave the device.
 */
const UNSUPPORTED_IMAGE_TYPES = new Set([
  'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence',
  'image/tiff', 'image/tif',
]);
const UNSUPPORTED_IMAGE_EXTENSIONS = new Set(['.heic', '.heif', '.tiff', '.tif']);

/** Lower-cased file extension including the leading dot (e.g. `.heic`). */
function fileExtension(name: string): string {
  return '.' + (name.split('.').pop()?.toLowerCase() ?? '');
}

/**
 * SCRUM-2911: is this a browser-undecodable image the pipeline must SOFT-FAIL?
 * Detects by BOTH MIME type and extension so real browser file metadata is
 * handled consistently — a `.heic`/`.tiff` dragged in with an empty or generic
 * MIME (e.g. `application/octet-stream`) is still recognized, rather than
 * falling through to the generic "unsupported file type" error.
 */
function isUnsupportedImageFile(file: File): boolean {
  return (
    UNSUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase()) ||
    UNSUPPORTED_IMAGE_EXTENSIONS.has(fileExtension(file.name))
  );
}

/** Build the typed benign error for an unsupported image file (SCRUM-2911). */
function unsupportedImageError(file: File): UnsupportedImageFormatError {
  const formatLabel = file.type || fileExtension(file.name);
  return new UnsupportedImageFormatError(
    OCR_LABELS.UNSUPPORTED_IMAGE_FORMAT(formatLabel),
    formatLabel,
  );
}

/**
 * WEBEXT-02: vendored, same-origin Tesseract asset roots (served from
 * `public/vendor/tesseract/` → site root `/vendor/tesseract/` in dev + prod).
 * These are passed to `Tesseract.createWorker(..., WorkerOptions)` so Tesseract
 * never reaches a CDN at runtime. They are also the source of truth asserted by
 * the WEBEXT-04 CSP CI guard (`scripts/ci/check-csp-runtime-deps.ts`).
 *
 *  - `workerPath`: the Tesseract Web Worker script (worker-src 'self').
 *  - `corePath`:   directory of the core wasm loaders; Tesseract auto-selects
 *                  the SIMD/relaxedSIMD/plain `-lstm.wasm.js` variant at runtime
 *                  (script-src 'self' + 'wasm-unsafe-eval').
 *  - `langPath`:   directory holding `eng.traineddata.gz` (connect-src 'self').
 */
export const TESSERACT_VENDOR_PATHS = {
  workerPath: '/vendor/tesseract/worker.min.js',
  corePath: '/vendor/tesseract/core/',
  langPath: '/vendor/tesseract/lang',
} as const;

export interface OCRResult {
  text: string;
  pageCount: number;
  method: 'pdfjs' | 'tesseract' | 'mammoth' | 'text';
  durationMs: number;
}

export interface OCRProgress {
  stage: 'loading' | 'processing' | 'complete' | 'error';
  progress: number; // 0-100
  currentPage?: number;
  totalPages?: number;
}

/**
 * Extract text from a PDF file using PDF.js.
 * Runs entirely in the browser — no network calls.
 */
export async function extractTextFromPDF(
  file: File,
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  const start = Date.now();

  onProgress?.({ stage: 'loading', progress: 0 });

  const pdfjs = await import('pdfjs-dist');
  // Use the bundled worker
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;

  onProgress?.({ stage: 'processing', progress: 10, currentPage: 0, totalPages });

  const pageTexts: string[] = [];

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item) => 'str' in item && typeof (item as Record<string, unknown>).str === 'string')
      .map((item) => (item as unknown as { str: string }).str)
      .join(' ');
    pageTexts.push(text);

    const progress = 10 + Math.round((i / totalPages) * 90);
    onProgress?.({ stage: 'processing', progress, currentPage: i, totalPages });
  }

  onProgress?.({ stage: 'complete', progress: 100 });

  return {
    text: pageTexts.join('\n\n'),
    pageCount: totalPages,
    method: 'pdfjs',
    durationMs: Date.now() - start,
  };
}

/**
 * Extract text from an image file using Tesseract.js OCR.
 * Runs entirely in the browser — no network calls.
 *
 * WEBEXT-02: the Tesseract core/worker/lang are loaded from the vendored,
 * same-origin {@link TESSERACT_VENDOR_PATHS} (CSP 'self'), never from a CDN.
 * WEBEXT-03: FAILS CLOSED — any load/init/recognition failure throws an
 * {@link OcrEngineLoadError} so the caller blocks egress. The underlying error
 * is attached as `cause` (for diagnostics) but is NEVER interpolated into the
 * surfaced message, since it could reference document-derived text (§1.6).
 */
export async function extractTextFromImage(
  file: File,
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  const start = Date.now();

  // SCRUM-2911: reject browser-undecodable formats (HEIC/TIFF) BEFORE loading
  // the OCR engine. This is a benign "we can't read this format" outcome — NOT
  // a §1.6 privacy fail-closed error — so it must not reach the recognition
  // catch below (which would wrap it as OcrEngineLoadError and trigger the FALSE
  // privacy-failure screen). Nothing loads and nothing leaves the device.
  if (isUnsupportedImageFile(file)) {
    throw unsupportedImageError(file);
  }

  onProgress?.({ stage: 'loading', progress: 0 });

  // The Tesseract import + worker creation + recognition are ALL inside the
  // fail-closed boundary: a CSP-blocked core fetch, a worker init error, or a
  // wasm/recognition fault must surface as OcrEngineLoadError — not leak through.
  let Tesseract: typeof import('tesseract.js');
  try {
    Tesseract = await import('tesseract.js');
  } catch (err) {
    throw new OcrEngineLoadError(OCR_LABELS.OCR_ENGINE_UNAVAILABLE, { cause: err });
  }

  let worker: Awaited<ReturnType<typeof Tesseract.createWorker>>;
  try {
    // WEBEXT-02: pin the core (wasm), worker, and language data to /vendor.
    // OEM defaults to LSTM_ONLY, matching the vendored `*-lstm` cores + the
    // `eng.traineddata.gz` LSTM model. `gzip: true` matches the `.gz` asset.
    worker = await Tesseract.createWorker('eng', undefined, {
      workerPath: TESSERACT_VENDOR_PATHS.workerPath,
      corePath: TESSERACT_VENDOR_PATHS.corePath,
      langPath: TESSERACT_VENDOR_PATHS.langPath,
      gzip: true,
      logger: (m: { progress: number }) => {
        onProgress?.({
          stage: 'processing',
          progress: Math.round(m.progress * 100),
        });
      },
    });
  } catch (err) {
    onProgress?.({ stage: 'error', progress: 0 });
    throw new OcrEngineLoadError(OCR_LABELS.OCR_ENGINE_UNAVAILABLE, { cause: err });
  }

  try {
    const { data } = await worker.recognize(file);

    onProgress?.({ stage: 'complete', progress: 100 });

    return {
      text: data.text,
      pageCount: 1,
      method: 'tesseract',
      durationMs: Date.now() - start,
    };
  } catch (err) {
    onProgress?.({ stage: 'error', progress: 0 });
    throw new OcrEngineLoadError(OCR_LABELS.OCR_ENGINE_UNAVAILABLE, { cause: err });
  } finally {
    // Always release the worker, even on failure, to avoid a leak.
    try {
      await worker.terminate();
    } catch {
      // Terminate best-effort; the fail-closed error above is what matters.
    }
  }
}

/**
 * Extract text from a Word document (.docx) using mammoth.js.
 * Runs entirely in the browser — no network calls.
 *
 * BUG-2026-05-22-007: .docx is a ZIP-based format; the old fallback
 * read it as plain text via file.text(), producing garbage output.
 * mammoth.js properly unzips and parses the Office Open XML structure.
 */
async function extractTextFromDocx(
  file: File,
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  const start = Date.now();
  onProgress?.({ stage: 'loading', progress: 10 });
  const mammoth = await import('mammoth');
  const arrayBuffer = await file.arrayBuffer();
  onProgress?.({ stage: 'processing', progress: 50 });
  const result = await mammoth.extractRawText({ arrayBuffer });
  onProgress?.({ stage: 'complete', progress: 100 });
  return {
    text: result.value,
    pageCount: 1,
    method: 'mammoth',
    durationMs: Date.now() - start,
  };
}

/**
 * Extract text from a plain text file by reading it directly.
 * No OCR needed — just read the file contents.
 */
async function extractTextFromTextFile(
  file: File,
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  const start = Date.now();
  onProgress?.({ stage: 'processing', progress: 50, currentPage: 1, totalPages: 1 });

  const text = await file.text();

  onProgress?.({ stage: 'complete', progress: 100, currentPage: 1, totalPages: 1 });

  return {
    text,
    pageCount: 1,
    method: 'text',
    durationMs: Date.now() - start,
  };
}

/** File types that can be read as plain text */
const TEXT_TYPES = new Set([
  'text/plain', 'text/csv', 'text/html', 'text/xml', 'text/markdown',
  'application/json', 'application/xml',
]);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.csv', '.md', '.json', '.xml', '.html', '.htm', '.log', '.rtf',
]);

/** Word document MIME types (mammoth.js supports .docx only, not legacy .doc) */
const DOCX_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const DOCX_EXTENSIONS = new Set(['.docx']);

/**
 * Auto-detect file type and run appropriate text extraction.
 * Supports PDFs (PDF.js), Word documents (mammoth.js), images (Tesseract OCR), and text files (direct read).
 */
export async function extractText(
  file: File,
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    return extractTextFromPDF(file, onProgress);
  }

  // Word documents — extract via mammoth.js (must check before image/text fallback)
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  if (DOCX_TYPES.has(file.type) || DOCX_EXTENSIONS.has(ext)) {
    return extractTextFromDocx(file, onProgress);
  }

  // SCRUM-2911: browser-undecodable image formats (HEIC/TIFF) must SOFT-FAIL
  // with the typed benign error — checked by MIME OR extension, BEFORE the
  // `image/*` MIME branch, so a `.heic`/`.tiff` carrying an empty or generic
  // browser MIME (e.g. `application/octet-stream`) is still routed here instead
  // of falling through to the generic UNSUPPORTED_FILE_TYPE error.
  if (isUnsupportedImageFile(file)) {
    throw unsupportedImageError(file);
  }

  if (file.type.startsWith('image/')) {
    return extractTextFromImage(file, onProgress);
  }

  // Text-based files — read directly, no OCR needed
  if (TEXT_TYPES.has(file.type) || TEXT_EXTENSIONS.has(ext)) {
    return extractTextFromTextFile(file, onProgress);
  }

  throw new Error(OCR_LABELS.UNSUPPORTED_FILE_TYPE(file.type || ext));
}
