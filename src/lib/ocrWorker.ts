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
 *
 * F2/F3 (SCRUM sprint amendment A3, founder 22-LOI-format KPI) — the ZIP-XML
 * family (.odt/.odp/.pptx/.epub, via `extractors/zipXmlExtract.ts` + JSZip),
 * RTF (`extractors/rtfExtract.ts`, a real control-word stripper), and SVG
 * (`extractors/svgExtract.ts`) all extract for real now instead of soft-
 * failing to manual entry. Each parser is dynamically imported on first use,
 * same lazy-load pattern as pdfjs-dist/mammoth/tesseract.js above.
 *
 * F4 (founder 22-LOI-format KPI, 2026-07-28) — image family completion:
 *   - TIFF (incl. multi-page): decoded client-side via `utif2` (MIT, pure JS,
 *     no wasm) into raw RGBA, then re-encoded to a real PNG via `upng-js`
 *     (MIT, pure JS) and handed to Tesseract. No canvas round-trip needed.
 *   - HEIC/HEIF: decoded client-side via `heic-decode` (ISC wrapper around
 *     `libheif-js`'s self-contained wasm bundle — the underlying compiled
 *     `libheif` C library is LGPL-3.0; loaded via a lazy `import()` that is
 *     never statically linked into the app bundle, which is the standard
 *     "dynamic linking" posture LGPL-3.0 §4 treats as separate from the
 *     combined work — flagged for a one-time legal sanity check, not a
 *     technical blocker) into raw RGBA, then the same `upng-js` PNG path.
 *   - Scanned/image-only PDFs: when PDF.js's text layer is empty across every
 *     page, pages are rendered to a canvas (inherent to the PDF.js render API)
 *     and OCR'd via the same Tesseract path, bounded by
 *     {@link SCANNED_PDF_OCR_MAX_PAGES} and
 *     {@link SCANNED_PDF_OCR_MAX_DURATION_MS} so a huge scan degrades
 *     gracefully instead of hanging the tab.
 * All three decoders are dynamically imported ONLY when a file of that format
 * is encountered — never part of the initial bundle (matches the existing
 * Tesseract/PDF.js/mammoth lazy-load pattern; see `vite.config.ts`
 * `manualChunks` for `vendor-tiff` / `vendor-heic` / `vendor-png-encode`).
 */

import { OCR_LABELS } from './copy';
import { OcrEngineLoadError, UnsupportedImageFormatError } from './ocrFailClosed';

/** Lower-cased file extension including the leading dot (e.g. `.heic`). */
function fileExtension(name: string): string {
  return '.' + (name.split('.').pop()?.toLowerCase() ?? '');
}

/**
 * Build the typed BENIGN error for an image file whose bytes could not be
 * decoded (SCRUM-2911 lineage). Pre-F4 this fired for the entire TIFF/HEIC
 * *format category* (browsers couldn't decode them at all); post-F4 it fires
 * only for a genuinely corrupt/malformed file WITHIN a now-supported format
 * (decode library throws, or reports no/invalid pages) — the "undecodable"
 * bar moved from format-level to file-level, but the soft-fail contract for
 * callers (`isUnsupportedImageFormatError`, never `failClosed`) is unchanged.
 */
function unsupportedImageError(file: File): UnsupportedImageFormatError {
  const formatLabel = file.type || fileExtension(file.name);
  return new UnsupportedImageFormatError(
    OCR_LABELS.UNSUPPORTED_IMAGE_FORMAT(formatLabel),
    formatLabel,
  );
}

// ---------------------------------------------------------------------------
// F4 format detection + bounds
// ---------------------------------------------------------------------------

const TIFF_MIME_TYPES = new Set(['image/tiff', 'image/tif']);
const TIFF_EXTENSIONS = new Set(['.tiff', '.tif']);
const HEIC_MIME_TYPES = new Set([
  'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence',
]);
const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);

/** Detects TIFF by MIME OR extension — real browser file metadata is often empty/generic for this format. */
function isTiffFile(file: File): boolean {
  return TIFF_MIME_TYPES.has(file.type.toLowerCase()) || TIFF_EXTENSIONS.has(fileExtension(file.name));
}

/** Detects HEIC/HEIF by MIME OR extension, same rationale as {@link isTiffFile}. */
function isHeicFile(file: File): boolean {
  return HEIC_MIME_TYPES.has(file.type.toLowerCase()) || HEIC_EXTENSIONS.has(fileExtension(file.name));
}

/**
 * Multi-page TIFF cap. Chosen to comfortably cover scanned legal documents
 * (LOIs, contracts) that run to a few dozen pages, while bounding worst-case
 * client-side OCR time on a hostile/oversized file. Excess pages are simply
 * not processed (not an error) — `OCRResult.pageCount` reports the number
 * actually processed.
 */
export const TIFF_MAX_PAGES = 20;

/** Same rationale as {@link TIFF_MAX_PAGES}, for the scanned-PDF OCR fallback. */
export const SCANNED_PDF_OCR_MAX_PAGES = 20;

/**
 * Wall-clock budget for the scanned-PDF OCR fallback loop. Each page can take
 * several seconds to render + OCR on a modest client device; this caps total
 * time so a huge scanned document degrades gracefully (returns whatever text
 * was recovered before the deadline) instead of hanging the tab.
 */
export const SCANNED_PDF_OCR_MAX_DURATION_MS = 180_000;

/**
 * Safety cap on decoded pixel count (width * height) for TIFF/HEIC pages.
 * Guards against a hostile/malformed file whose header claims an enormous
 * (or garbage) width/height, which would otherwise attempt a huge allocation
 * during RGBA→PNG re-encoding.
 */
const MAX_DECODE_PIXELS = 40_000_000; // ~40 megapixels

/** Loads `utif2`'s CJS export regardless of bundler/Node ESM interop shape. */
async function loadUtif(): Promise<typeof import('utif2')> {
  const mod = await import('utif2');
  return (mod as unknown as { default?: typeof import('utif2') }).default ?? (mod as unknown as typeof import('utif2'));
}

/** Loads `heic-decode`'s default export regardless of bundler/Node ESM interop shape. */
async function loadHeicDecode(): Promise<typeof import('heic-decode').default> {
  const mod = await import('heic-decode');
  return (mod as { default?: typeof import('heic-decode').default }).default ?? (mod as unknown as typeof import('heic-decode').default);
}

/** Loads `upng-js`'s default export regardless of bundler/Node ESM interop shape. */
async function loadUpng(): Promise<typeof import('upng-js').default> {
  const mod = await import('upng-js');
  return (mod as { default?: typeof import('upng-js').default }).default ?? (mod as unknown as typeof import('upng-js').default);
}

/**
 * Re-encodes a decoded RGBA8 pixel buffer as a real PNG, entirely in pure JS
 * (no canvas). Shared by the TIFF and HEIC decode paths so Tesseract always
 * receives a normal image file it already knows how to read.
 */
async function encodeRgbaToPngBlob(rgba: Uint8Array, width: number, height: number): Promise<Blob> {
  const UPNG = await loadUpng();
  const arrayBuffer = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer;
  const png = UPNG.encode([arrayBuffer], width, height, 0); // 0 = lossless truecolor, no palette quantization
  return new Blob([png], { type: 'image/png' });
}

/** A decoded page's dimensions are sane (positive, finite, within the hostile-input pixel cap). */
function hasValidDimensions(width: unknown, height: unknown): boolean {
  return (
    typeof width === 'number' && typeof height === 'number' &&
    Number.isFinite(width) && Number.isFinite(height) &&
    width > 0 && height > 0 &&
    width * height <= MAX_DECODE_PIXELS
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
  /**
   * `'pdfjs-ocr'` (F4): a scanned/image-only PDF whose text layer was empty —
   * pages were rendered to a canvas and OCR'd via Tesseract as a fallback.
   * Distinct from `'pdfjs'` (real text layer, no OCR) purely so
   * `noTextSourceKind()` in `aiExtraction.ts` can still label a no-text
   * outcome as `'pdf'` rather than the generic `'document'`.
   */
  method: 'pdfjs' | 'pdfjs-ocr' | 'tesseract' | 'mammoth' | 'text' | 'zip-xml' | 'rtf' | 'svg' | 'spreadsheet';
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
 *
 * F4 (SCRUM founder 22-format KPI, scanned-PDF gap): when the real text layer
 * is EMPTY across every page — the classic scanned/image-only PDF, common in
 * the Kenyan legal-docs pilot — falls back to rendering each page to a canvas
 * and running the same Tesseract path as {@link extractTextFromImage}. A PDF
 * that already has a text layer NEVER takes this slow path (checked BEFORE
 * any render/OCR call). The fallback is bounded by
 * {@link SCANNED_PDF_OCR_MAX_PAGES} and {@link SCANNED_PDF_OCR_MAX_DURATION_MS}
 * so a huge scan degrades gracefully (returns whatever was recovered) instead
 * of hanging the tab. `OcrEngineLoadError` from the shared Tesseract runner
 * propagates uncaught here — the §1.6 fail-closed dominance rule (a real
 * OCR-engine failure always wins) applies identically to the scanned-PDF path.
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

    // Text-layer pass gets 10-50%; the scanned-PDF OCR fallback (if it fires)
    // gets 50-100%. A normal text PDF never touches the OCR half.
    const progress = 10 + Math.round((i / totalPages) * 40);
    onProgress?.({ stage: 'processing', progress, currentPage: i, totalPages });
  }

  const combinedText = pageTexts.join('\n\n');
  if (combinedText.trim()) {
    onProgress?.({ stage: 'complete', progress: 100 });
    return {
      text: combinedText,
      pageCount: totalPages,
      method: 'pdfjs',
      durationMs: Date.now() - start,
    };
  }

  // Scanned/image-only PDF: no extractable text on ANY page. Render pages to
  // a canvas and OCR them, bounded by page count + wall-clock time.
  const pagesToOcr = Math.min(totalPages, SCANNED_PDF_OCR_MAX_PAGES);
  const ocrDeadline = Date.now() + SCANNED_PDF_OCR_MAX_DURATION_MS;
  const ocrPageTexts: string[] = [];
  let pagesProcessed = 0;

  for (let i = 1; i <= pagesToOcr; i++) {
    if (Date.now() >= ocrDeadline) break; // time budget exhausted — degrade gracefully

    const page = await pdf.getPage(i);
    // Upscale beyond the PDF's native 72dpi viewport for OCR accuracy on
    // typical scan resolutions.
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) break; // no canvas support — stop the fallback, keep whatever text we have

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) continue; // this page failed to rasterize — skip, try the next

    const base = 50 + Math.round(((i - 1) / pagesToOcr) * 45);
    const span = Math.max(1, Math.round((1 / pagesToOcr) * 45));
    onProgress?.({ stage: 'processing', progress: base, currentPage: i, totalPages: pagesToOcr });

    const pageText = await recognizeWithTesseract(blob, (p) => {
      onProgress?.({
        stage: 'processing',
        progress: Math.min(99, base + Math.round((p.progress / 100) * span)),
        currentPage: i,
        totalPages: pagesToOcr,
      });
    });
    ocrPageTexts.push(pageText);
    pagesProcessed = i;
  }

  onProgress?.({ stage: 'complete', progress: 100 });

  return {
    text: ocrPageTexts.join('\n\n'),
    pageCount: pagesProcessed || totalPages,
    method: 'pdfjs-ocr',
    durationMs: Date.now() - start,
  };
}

/**
 * Runs Tesseract OCR against a single image input (File or Blob) and returns
 * the recognized text. This is the SOLE place `Tesseract.createWorker` /
 * `.recognize` is called — reused by direct image OCR, each decoded TIFF
 * page, the decoded HEIC image, and each rendered scanned-PDF page — so the
 * WEBEXT-02 self-host pinning and the WEBEXT-03 fail-closed contract live in
 * exactly one place regardless of which caller triggered OCR.
 *
 * WEBEXT-02: the Tesseract core/worker/lang are loaded from the vendored,
 * same-origin {@link TESSERACT_VENDOR_PATHS} (CSP 'self'), never from a CDN.
 * WEBEXT-03: FAILS CLOSED — any load/init/recognition failure throws an
 * {@link OcrEngineLoadError} so the caller blocks egress. The underlying error
 * is attached as `cause` (for diagnostics) but is NEVER interpolated into the
 * surfaced message, since it could reference document-derived text (§1.6).
 */
async function recognizeWithTesseract(
  input: File | Blob,
  onProgress?: (progress: OCRProgress) => void,
): Promise<string> {
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
    const { data } = await worker.recognize(input);
    return data.text;
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
 * Extract text from an image file. Runs entirely in the browser — no network
 * calls. Dispatches to the TIFF/HEIC decode paths (F4) for those formats;
 * every other browser-decodable raster format (png/jpg/jpeg/gif/webp/bmp/...)
 * goes straight to {@link recognizeWithTesseract}, which Tesseract already
 * reads natively via `File`.
 */
export async function extractTextFromImage(
  file: File,
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  const start = Date.now();

  onProgress?.({ stage: 'loading', progress: 0 });

  if (isTiffFile(file)) {
    return extractTextFromTiff(file, start, onProgress);
  }
  if (isHeicFile(file)) {
    return extractTextFromHeic(file, start, onProgress);
  }

  const text = await recognizeWithTesseract(file, onProgress);
  onProgress?.({ stage: 'complete', progress: 100 });
  return {
    text,
    pageCount: 1,
    method: 'tesseract',
    durationMs: Date.now() - start,
  };
}

/**
 * F4 — TIFF (incl. multi-page) decode + OCR. Decodes via `utif2` (pure JS, no
 * wasm), skipping any page whose dimensions are missing/invalid/hostile
 * (SCRUM-2911 lineage — `utif2` does not always throw on malformed input; it
 * can silently return an IFD with no `width`/`height`, so we validate rather
 * than rely on a thrown error). If EVERY page fails to decode, the whole file
 * is a benign "undecodable" soft-fail. A real `OcrEngineLoadError` from
 * {@link recognizeWithTesseract} propagates uncaught — fail-closed dominance.
 *
 * Pages beyond {@link TIFF_MAX_PAGES} are not processed; `pageCount` reports
 * the number actually processed, not the file's total page count.
 */
async function extractTextFromTiff(
  file: File,
  start: number,
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  let UTIF: typeof import('utif2');
  let buffer: ArrayBuffer;
  let ifds: import('utif2').IFD[];
  try {
    UTIF = await loadUtif();
    buffer = await file.arrayBuffer();
    ifds = UTIF.decode(buffer);
  } catch {
    throw unsupportedImageError(file);
  }

  if (!Array.isArray(ifds) || ifds.length === 0) {
    throw unsupportedImageError(file);
  }

  const totalPages = ifds.length;
  const pagesToProcess = Math.min(totalPages, TIFF_MAX_PAGES);
  const pageTexts: string[] = [];
  let decodedAny = false;

  for (let i = 0; i < pagesToProcess; i++) {
    const ifd = ifds[i];
    let blob: Blob | undefined;
    try {
      // Note: `utif2`'s runtime `decodeImage` accepts an optional 3rd `ifds`
      // arg (used for rare multi-strip continuation cases); the published
      // `.d.ts` only declares 2. Standard single-strip TIFFs — the common
      // case for phone/scanner output — decode fully without it.
      UTIF.decodeImage(buffer, ifd);
      if (!hasValidDimensions(ifd.width, ifd.height)) continue; // corrupt/hostile page — skip, keep going
      const rgba = UTIF.toRGBA8(ifd);
      if (!rgba || rgba.length !== ifd.width * ifd.height * 4) continue; // truncated page data — skip
      blob = await encodeRgbaToPngBlob(rgba, ifd.width, ifd.height);
    } catch {
      continue; // this page is corrupt — degrade gracefully, try the next one
    }
    if (!blob) continue;

    decodedAny = true;
    const base = Math.round((i / pagesToProcess) * 90);
    const span = Math.max(1, Math.round((1 / pagesToProcess) * 90));
    onProgress?.({ stage: 'processing', progress: base, currentPage: i + 1, totalPages: pagesToProcess });

    const pageText = await recognizeWithTesseract(blob, (p) => {
      onProgress?.({
        stage: 'processing',
        progress: Math.min(99, base + Math.round((p.progress / 100) * span)),
        currentPage: i + 1,
        totalPages: pagesToProcess,
      });
    });
    pageTexts.push(pageText);
  }

  if (!decodedAny) {
    // Every page was corrupt/undecodable — this whole file is a benign
    // soft-fail, and the OCR engine was never invoked (no privacy guarantee
    // was ever at risk for the pages that never made it to Tesseract).
    throw unsupportedImageError(file);
  }

  onProgress?.({ stage: 'complete', progress: 100 });
  return {
    text: pageTexts.join('\n\n'),
    pageCount: pagesToProcess,
    method: 'tesseract',
    durationMs: Date.now() - start,
  };
}

/**
 * F4 — HEIC/HEIF decode + OCR. Decodes the PRIMARY image only via
 * `heic-decode` (a HEIC/HEIF "sequence" — e.g. a burst photo — has multiple
 * images; we deliberately process just the first/primary one, mirroring how
 * a single photographed document page is the common case here — a documented
 * choice, not full multi-image support). A real `OcrEngineLoadError` from
 * {@link recognizeWithTesseract} propagates uncaught — fail-closed dominance.
 */
async function extractTextFromHeic(
  file: File,
  start: number,
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  let blob: Blob;
  try {
    const decode = await loadHeicDecode();
    const arrayBuffer = await file.arrayBuffer();
    // Wrap as a same-realm Uint8Array: the wasm binding's internal type
    // checks need a real typed array (a raw ArrayBuffer, or a typed array
    // from a different global realm — e.g. Node's Buffer under jsdom's
    // separate window realm in tests — can fail the binding's instanceof
    // check with an opaque wasm-level error).
    const { width, height, data } = await decode({ buffer: new Uint8Array(arrayBuffer) });
    if (!hasValidDimensions(width, height) || !data || data.length !== width * height * 4) {
      throw new Error('invalid HEIC decode output');
    }
    blob = await encodeRgbaToPngBlob(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width, height);
  } catch {
    // The decoder library validates the HEIC brand box up front and throws
    // cleanly for non-HEIC/corrupt/truncated input — a benign soft-fail, and
    // the OCR engine is never invoked.
    throw unsupportedImageError(file);
  }

  const text = await recognizeWithTesseract(blob, onProgress);
  onProgress?.({ stage: 'complete', progress: 100 });
  return {
    text,
    pageCount: 1,
    method: 'tesseract',
    durationMs: Date.now() - start,
  };
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
 * Extract text from a ZIP-XML family document — .odt / .odp (OpenDocument),
 * .pptx (Office Open XML presentation), or .epub (zipped XHTML ebook).
 *
 * F2 (SCRUM sprint amendment A3). Runs entirely in the browser via
 * `extractors/zipXmlExtract.ts` (JSZip + DOMParser). `.ods` is intentionally
 * NOT routed here — it's covered by the F1 spreadsheet dual-mode SheetJS
 * path, which needs cell/row structure a flat text walk would lose.
 */
async function extractTextFromZipXml(
  file: File,
  kind: 'odt' | 'odp' | 'pptx' | 'epub',
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  const start = Date.now();
  onProgress?.({ stage: 'loading', progress: 10 });
  const { extractTextFromOpenDocument, extractTextFromPptx, extractTextFromEpub } =
    await import('./extractors/zipXmlExtract');
  onProgress?.({ stage: 'processing', progress: 40 });

  let text: string;
  if (kind === 'odt' || kind === 'odp') {
    text = await extractTextFromOpenDocument(file);
  } else if (kind === 'pptx') {
    text = await extractTextFromPptx(file);
  } else {
    text = await extractTextFromEpub(file);
  }

  onProgress?.({ stage: 'complete', progress: 100 });
  return {
    text,
    pageCount: 1,
    method: 'zip-xml',
    durationMs: Date.now() - start,
  };
}

/**
 * Extract text from an RTF file via the real control-word stripper (F3 /
 * SCRUM sprint amendment A3) — replaces the old plain-text fallback that
 * dumped raw RTF markup as garbage output.
 */
async function extractTextFromRtfFile(
  file: File,
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  const start = Date.now();
  onProgress?.({ stage: 'loading', progress: 10 });
  const { extractTextFromRtf } = await import('./extractors/rtfExtract');
  onProgress?.({ stage: 'processing', progress: 50 });
  const raw = await file.text();
  const text = extractTextFromRtf(raw);
  onProgress?.({ stage: 'complete', progress: 100 });
  return {
    text,
    pageCount: 1,
    method: 'rtf',
    durationMs: Date.now() - start,
  };
}

/**
 * Extract text from an SVG file — strips markup, keeps `<title>`/`<desc>`/
 * `<text>` content (F3 / SCRUM sprint amendment A3).
 */
async function extractTextFromSvgFile(
  file: File,
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  const start = Date.now();
  onProgress?.({ stage: 'loading', progress: 10 });
  const { extractTextFromSvg } = await import('./extractors/svgExtract');
  onProgress?.({ stage: 'processing', progress: 50 });
  const raw = await file.text();
  const text = extractTextFromSvg(raw);
  onProgress?.({ stage: 'complete', progress: 100 });
  return {
    text,
    pageCount: 1,
    method: 'svg',
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
  '.txt', '.csv', '.md', '.json', '.xml', '.html', '.htm', '.log',
]);

/** Word document MIME types (mammoth.js supports .docx only, not legacy .doc) */
const DOCX_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const DOCX_EXTENSIONS = new Set(['.docx']);

/**
 * F3 — RTF gets its own real control-word stripper (extractors/rtfExtract.ts)
 * instead of falling through to the plain-text reader, which used to dump
 * raw control words as garbage output.
 */
const RTF_TYPES = new Set(['application/rtf', 'text/rtf']);
const RTF_EXTENSIONS = new Set(['.rtf']);

/**
 * F3 — SVG text-node extraction (extractors/svgExtract.ts). Checked BEFORE
 * the generic `image/*` MIME branch below, since SVG's MIME type
 * (`image/svg+xml`) would otherwise route into Tesseract OCR on a
 * non-raster image.
 */
const SVG_TYPES = new Set(['image/svg+xml']);
const SVG_EXTENSIONS = new Set(['.svg']);

/**
 * F2 — ZIP-XML family (extractors/zipXmlExtract.ts). `.ods` is deliberately
 * excluded: it's covered by the F1 spreadsheet dual-mode SheetJS path
 * (row-mode / anchor-as-document), which needs cell/row structure a flat
 * text-node walk would destroy — coordinate with that workstream before
 * adding `.ods` here.
 */
const ZIP_XML_KIND_BY_EXTENSION: Record<string, 'odt' | 'odp' | 'pptx' | 'epub'> = {
  '.odt': 'odt',
  '.odp': 'odp',
  '.pptx': 'pptx',
  '.epub': 'epub',
};
const ZIP_XML_KIND_BY_MIME: Record<string, 'odt' | 'odp' | 'pptx' | 'epub'> = {
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/epub+zip': 'epub',
};

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

  // F3 — RTF: real control-word stripper (checked before the generic text
  // fallback, which used to dump raw RTF markup as garbage output).
  if (RTF_TYPES.has(file.type) || RTF_EXTENSIONS.has(ext)) {
    return extractTextFromRtfFile(file, onProgress);
  }

  // F3 — SVG: XML text-node extraction. Checked before the generic `image/*`
  // MIME branch below, since SVG's MIME type is `image/svg+xml`.
  if (SVG_TYPES.has(file.type) || SVG_EXTENSIONS.has(ext)) {
    return extractTextFromSvgFile(file, onProgress);
  }

  // F2 — ZIP-XML family: .odt / .odp / .pptx / .epub. Checked before the
  // generic fallback throw; `.ods` is intentionally excluded (see
  // ZIP_XML_KIND_BY_EXTENSION doc comment — F1 SheetJS path owns it).
  const zipXmlKind = ZIP_XML_KIND_BY_EXTENSION[ext] ?? ZIP_XML_KIND_BY_MIME[file.type];
  if (zipXmlKind) {
    return extractTextFromZipXml(file, zipXmlKind, onProgress);
  }

  // F4: TIFF/HEIC — checked by MIME OR extension, BEFORE the generic `image/*`
  // MIME branch, so a `.heic`/`.tiff` carrying an empty or generic browser
  // MIME (e.g. `application/octet-stream`) still routes to OCR instead of
  // falling through to the generic UNSUPPORTED_FILE_TYPE error. These formats
  // decode+OCR successfully now (SCRUM-2911 previously blanket-rejected the
  // whole category here; `extractTextFromImage` still soft-fails a genuinely
  // corrupt individual file via the same typed benign error).
  if (isTiffFile(file) || isHeicFile(file)) {
    return extractTextFromImage(file, onProgress);
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
