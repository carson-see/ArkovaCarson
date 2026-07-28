/**
 * F4 (SCRUM founder 22-format KPI, 2026-07-28) — genuine, UNMOCKED decode
 * proof against real committed fixture files under `__fixtures__/ocr/`.
 *
 * `ocrWorker.test.ts` mocks `pdfjs-dist` entirely (existing repo policy) to
 * keep routing/cap/dominance tests fast and deterministic. That means the
 * single most safety-critical claim in this PR — "a PDF with a real text
 * layer never takes the slow scanned-PDF OCR path, and a PDF with NO text
 * layer genuinely has none" — is only proven against a MOCK of PDF.js there.
 * This file proves it against the REAL `pdfjs-dist` library parsing REAL PDF
 * bytes, with no mocking at all. It also independently confirms `utif2` /
 * `heic-decode` decode real pixel dimensions correctly (redundant with, but
 * independent of, the mocked-Tesseract assertions in `ocrWorker.test.ts`).
 *
 * Deliberately does NOT invoke Tesseract (real OCR execution needs a
 * browser-grade worker+wasm+CSP-pinned-asset harness that isn't practical
 * under vitest+jsdom) — it calls `pdfjs-dist` / `utif2` / `heic-decode`
 * directly, the same way `ocrWorker.ts` itself does, to prove the DECODE
 * layer is genuinely correct.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'ocr');

function fixtureBytes(filename: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, filename));
}

describe('F4 real decode — pdfjs-dist text-layer detection (UNMOCKED)', () => {
  it('a real PDF with an embedded text layer yields real, non-empty extracted text', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(fixtureBytes('text-layer.pdf'));
    const doc = await pdfjs.getDocument({ data }).promise;

    expect(doc.numPages).toBe(1);
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item) => 'str' in item)
      .map((item) => (item as { str: string }).str)
      .join(' ')
      .trim();

    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('ARKOVA REAL TEXT LAYER PDF');
  });

  it('a real scanned/image-only PDF (no text objects) yields genuinely EMPTY text — this is exactly the condition that must trigger the OCR fallback', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(fixtureBytes('scanned.pdf'));
    const doc = await pdfjs.getDocument({ data }).promise;

    let combined = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      combined += content.items
        .filter((item) => 'str' in item)
        .map((item) => (item as { str: string }).str)
        .join(' ');
    }

    expect(combined.trim()).toBe('');
  });

  it('a corrupt/truncated PDF fails cleanly (rejects) instead of hanging — production code must catch this, not crash the tab', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(fixtureBytes('corrupt.pdf'));

    const caught = await Promise.race([
      pdfjs.getDocument({ data }).promise.then(
        () => 'RESOLVED_UNEXPECTEDLY',
        (err: unknown) => err,
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMED OUT')), 10_000)),
    ]);

    expect(caught).not.toBe('RESOLVED_UNEXPECTEDLY');
    expect(caught).toBeInstanceOf(Error);
  });
});

describe('F4 real decode — utif2 TIFF (UNMOCKED)', () => {
  it('decodes the real single-page fixture with correct dimensions and full RGBA byte length', async () => {
    const UTIF = (await import('utif2')).default;
    const buffer = fixtureBytes('text.tiff');
    const ifds = UTIF.decode(buffer);

    expect(ifds.length).toBe(1);
    UTIF.decodeImage(buffer, ifds[0]);
    expect(ifds[0].width).toBe(500);
    expect(ifds[0].height).toBe(180);
    const rgba = UTIF.toRGBA8(ifds[0]);
    expect(rgba.length).toBe(500 * 180 * 4);
  });

  it('decodes the real multi-page fixture as exactly 3 pages', async () => {
    const UTIF = (await import('utif2')).default;
    const ifds = UTIF.decode(fixtureBytes('multipage.tiff'));
    expect(ifds.length).toBe(3);
  });

  it('decodes the real 22-page fixture as exactly 22 pages (production caps processing at 20, but decode() itself sees all of them)', async () => {
    const UTIF = (await import('utif2')).default;
    const ifds = UTIF.decode(fixtureBytes('overcap.tiff'));
    expect(ifds.length).toBe(22);
  });

  it('the truncated corrupt fixture decodes to an IFD with no usable width/height (does not throw, does not hang)', async () => {
    const UTIF = (await import('utif2')).default;
    const buffer = fixtureBytes('corrupt.tiff');

    const result = await Promise.race([
      (async () => {
        const ifds = UTIF.decode(buffer);
        UTIF.decodeImage(buffer, ifds[0]);
        return ifds[0];
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMED OUT')), 5000)),
    ]);

    // This is exactly the "no throw, but no usable dimensions" case ocrWorker.ts's
    // `hasValidDimensions()` guard exists to catch.
    expect(typeof (result as { width?: unknown }).width).not.toBe('number');
  });
});

describe('F4 real decode — heic-decode HEIC (UNMOCKED)', () => {
  it('decodes the real fixture with correct dimensions and full RGBA byte length', async () => {
    const decode = (await import('heic-decode')).default;
    const buffer = new Uint8Array(fixtureBytes('text.heic'));
    const { width, height, data } = await decode({ buffer });

    expect(width).toBe(500);
    expect(height).toBe(180);
    expect(data.length).toBe(500 * 180 * 4);
  });

  it('the truncated corrupt fixture throws cleanly (does not hang)', async () => {
    const decode = (await import('heic-decode')).default;
    const buffer = new Uint8Array(fixtureBytes('corrupt.heic'));

    const caught = await Promise.race([
      decode({ buffer }).then(() => 'RESOLVED_UNEXPECTEDLY', (err: unknown) => err),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMED OUT')), 5000)),
    ]);

    expect(caught).not.toBe('RESOLVED_UNEXPECTEDLY');
    expect(caught).toBeInstanceOf(Error);
  });

  it('a non-HEIC file (real PNG bytes) fed to the HEIC decoder throws cleanly instead of misinterpreting the bytes', async () => {
    const decode = (await import('heic-decode')).default;
    const buffer = new Uint8Array(fixtureBytes('text.png'));

    const caught = await decode({ buffer }).then(() => 'RESOLVED_UNEXPECTEDLY', (err: unknown) => err);
    expect(caught).not.toBe('RESOLVED_UNEXPECTEDLY');
  });
});

describe('F4 real decode — upng-js PNG round-trip (UNMOCKED)', () => {
  it('encodes a decoded TIFF RGBA buffer into real, valid PNG bytes', async () => {
    const UTIF = (await import('utif2')).default;
    const UPNG = (await import('upng-js')).default;
    const buffer = fixtureBytes('text.tiff');
    const ifds = UTIF.decode(buffer);
    UTIF.decodeImage(buffer, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);

    const png = UPNG.encode([rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer], ifds[0].width, ifds[0].height, 0);
    const pngBytes = new Uint8Array(png);

    // Real PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(Array.from(pngBytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngBytes.length).toBeGreaterThan(100);
  });
});
