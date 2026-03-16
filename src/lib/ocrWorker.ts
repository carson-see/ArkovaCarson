/**
 * OCR Worker Module (P8-S5)
 *
 * CLIENT-SIDE ONLY — runs OCR on documents entirely in the browser.
 * Uses PDF.js for PDF text extraction and Tesseract.js for image OCR.
 *
 * Constitution 1.6: Documents never leave the user's device.
 * Constitution 4A: Raw OCR text stays client-side; only PII-stripped
 * metadata may be sent to the server.
 */

export interface OCRResult {
  text: string;
  pageCount: number;
  method: 'pdfjs' | 'tesseract';
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
 */
export async function extractTextFromImage(
  file: File,
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  const start = Date.now();

  onProgress?.({ stage: 'loading', progress: 0 });

  const Tesseract = await import('tesseract.js');

  const worker = await Tesseract.createWorker('eng', undefined, {
    logger: (m: { progress: number }) => {
      onProgress?.({
        stage: 'processing',
        progress: Math.round(m.progress * 100),
      });
    },
  });

  try {
    const { data } = await worker.recognize(file);

    onProgress?.({ stage: 'complete', progress: 100 });

    return {
      text: data.text,
      pageCount: 1,
      method: 'tesseract',
      durationMs: Date.now() - start,
    };
  } finally {
    await worker.terminate();
  }
}

/**
 * Auto-detect file type and run appropriate OCR.
 */
export async function extractText(
  file: File,
  onProgress?: (progress: OCRProgress) => void,
): Promise<OCRResult> {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    return extractTextFromPDF(file, onProgress);
  }

  if (file.type.startsWith('image/')) {
    return extractTextFromImage(file, onProgress);
  }

  throw new Error(`Unsupported file type: ${file.type}. Supported: PDF, images (PNG, JPG, TIFF).`);
}
