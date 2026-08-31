/**
 * Certificate QR — module matrix for the audit-certificate PDF.
 *
 * The downloadable audit certificate (`generateAuditReport.ts`) is the artifact
 * people hand to an auditor. It needs a scannable pointer to the live
 * verification page, encoding EXACTLY the same URL the in-app QR encodes —
 * `verifyUrl(publicId)` (see `ShareSheet.tsx` / `AssetDetailView.tsx`) — so a
 * printed certificate and the screen can never send a reader to two different
 * places.
 *
 * ─── Why a second QR library, when `qrcode.react` is already a dependency ───
 *
 * `qrcode.react` exports ONLY React components (`QRCodeCanvas`, `QRCodeSVG`);
 * its bundled encoder is not exported, and both components call React hooks, so
 * neither can be invoked outside a renderer. The only way to reach that encoder
 * from a plain function is `react-dom/server`'s `renderToStaticMarkup` and then
 * parsing the emitted SVG path — and `vite.config.ts`'s `manualChunks` routes
 * EVERY `/react-dom/` module into the `vendor-react-dom` chunk, which ships in
 * the initial bundle. Importing `react-dom/server` would therefore add ~500 KB
 * of server renderer to first paint (or force an edit to that deliberately
 * commented chunking rule) to draw a QR code. jsPDF has no QR support of its
 * own, and `qrcode.react` cannot produce a matrix or a data URL without a DOM
 * canvas — which would also break `buildAuditReport`'s purity and its jsdom
 * tests.
 *
 * `qrcode-generator` (MIT, zero dependencies, ~52 KB) is a plain encoder with
 * no DOM and no React dependency. It is the smaller and more honest cost. This
 * module is the ONLY place it is imported.
 *
 * The output is run-length packed by row because jsPDF draws filled rectangles:
 * one `rect()` per horizontal run instead of one per dark module keeps the PDF
 * content stream small (~200 rects instead of ~450 for a 29×29 code).
 *
 * Failure is ALWAYS `null`, never a throw: an unscannable certificate is a
 * cosmetic loss, a certificate that fails to generate is a broken feature. The
 * caller falls back to rendering the URL as text.
 */
import qrcode from 'qrcode-generator';

/** One maximal horizontal run of dark modules in a single row. */
export interface QrRun {
  /** Zero-based module row. */
  row: number;
  /** Zero-based module column where the run starts. */
  col: number;
  /** Run length in modules; always ≥ 1. */
  width: number;
}

/** A QR code as its module grid, packed into per-row horizontal runs. */
export interface QrMatrix {
  /** Side length in modules (always `4 × version + 17`, i.e. 21…177). */
  moduleCount: number;
  /** Every dark run, in row-major order. Light modules are simply absent. */
  runs: QrRun[];
}

/**
 * Error-correction level. `M` (~15 % recovery) is the usual print default: it
 * survives the smudging and partial occlusion a paper certificate collects
 * without inflating the version — a ~45-character verification URL still fits
 * in a 29×29 (version 3) code.
 */
const ERROR_CORRECTION_LEVEL = 'M' as const;

/** `0` asks the encoder to pick the smallest version that fits the payload. */
const AUTO_VERSION = 0 as const;

/**
 * Build the QR module matrix for `value`.
 *
 * Returns `null` — never throws — when the value is empty, is not pure ASCII,
 * or does not fit in any QR version. The non-ASCII refusal is deliberate:
 * `qrcode-generator`'s default byte conversion is Latin-1 (`stringToBytes('é')`
 * → `[233]`, not the UTF-8 `[195, 169]`), so a non-ASCII value would silently
 * encode to a DIFFERENT string than the one printed beside it. A certificate
 * whose QR resolves somewhere other than its printed link is worse than one
 * with no QR at all (§1.5), so we decline to draw it.
 */
export function buildQrMatrix(value: string): QrMatrix | null {
  // Printable ASCII only (space through `~`) — see the doc comment above.
  if (!value || !/^[\x20-\x7E]+$/.test(value)) return null;

  try {
    const qr = qrcode(AUTO_VERSION, ERROR_CORRECTION_LEVEL);
    qr.addData(value); // Byte mode (the library default)
    qr.make();

    const moduleCount = qr.getModuleCount();
    const runs: QrRun[] = [];

    for (let row = 0; row < moduleCount; row++) {
      let col = 0;
      while (col < moduleCount) {
        if (!qr.isDark(row, col)) {
          col++;
          continue;
        }
        const start = col;
        while (col < moduleCount && qr.isDark(row, col)) col++;
        runs.push({ row, col: start, width: col - start });
      }
    }

    // A code with no dark modules is not a code. Treat it as a failure rather
    // than handing the renderer an empty box that looks like a scannable one.
    return runs.length > 0 ? { moduleCount, runs } : null;
  } catch {
    // qrcode-generator throws a bare value (no Error) when the payload exceeds
    // the largest version's capacity. Degrade to "no QR".
    return null;
  }
}
