# agents.md — lib/extractors

_Last updated: 2026-07-28_

## What This Folder Contains

Client-side document text extraction parsers consumed by `../ocrWorker.ts`'s
`extractText()` dispatcher. **CLIENT-SIDE ONLY per Constitution §1.6** —
every module here MUST NEVER be imported from `services/worker/`. The
automated guard is `no-worker-import.test.ts` (repo-wide static scan of
`services/worker/src/**` for a forbidden import of any module in this
folder or of `ocrWorker.ts` itself).

- `zipXmlExtract.ts` — F2: ZIP-XML family. `.odt`/`.odp` (OpenDocument —
  both read `content.xml`), `.pptx` (OOXML — one `ppt/slides/slideN.xml`
  per slide, numerically sorted), `.epub` (zipped XHTML — reads the OPF
  spine via `META-INF/container.xml` for reading order, falls back to a
  sorted `.xhtml`/`.html` file scan if the container/OPF structure is
  missing). Walks XML text nodes, inserting a line break at block-level
  element boundaries (`p`/`h`/`div`/`li`/... by local name, namespace-prefix
  stripped) so output reads as paragraphs, not one run-on string.
  **`.ods` is deliberately NOT handled here** — it belongs to the F1
  spreadsheet dual-mode SheetJS workstream (row-mode / anchor-as-document),
  which needs cell/row structure a flat text walk would destroy. Coordinate
  with that workstream before ever adding `.ods` support to this module.
  Dynamically imports `jszip` (new dependency, pinned `3.10.1` — already a
  transitive dep of `mammoth`, now also a direct dep) so it never bloats
  the initial bundle; gets its own `vendor-zip` chunk in `vite.config.ts`
  `manualChunks`, matching the `pdfjs-dist` → `vendor-pdf` pattern.
- `rtfExtract.ts` — F3: a real RTF control-word stripper (pure string
  state machine, no dependencies). Replaces the previous behavior of
  routing `.rtf` through the plain-text reader, which dumped raw control
  words (`\fonttbl`, `\par`, `\'92`, ...) into the "extracted" text as
  garbage. Handles group-scoped non-visible destinations (`\fonttbl`,
  `\colortbl`, `\stylesheet`, `\info`, `\pict`, `\object`, `\*`-marked
  ignorable extensions, ...), `\par`/`\line`/`\tab` whitespace, typographic
  control words (`\lquote`, `\emdash`, `\bullet`, ...), `\'hh` CP-1252 hex
  escapes, and `\uN` Unicode escapes with `\ucN`-declared ASCII-fallback
  swallowing. Single forward pass, no recursion — cannot hang, cannot throw
  on malformed/truncated/non-RTF input (worst case: near-passthrough of
  literal characters).
- `svgExtract.ts` — F3: SVG text extraction via `DOMParser`. Strips markup,
  keeps `<title>`/`<desc>`/`<text>` content (nested `<tspan>` runs fold in
  automatically via `textContent`). Throws a clear error on malformed XML
  (`<parsererror>` detection) — never hangs/crashes.
- `__fixtures__/` — **test-only** fixture builders, not imported by
  production code. `buildZipFixtures.ts` constructs genuinely real (if
  minimal) `.odt`/`.odp`/`.pptx`/`.epub` ZIP archives via JSZip — the
  fixture-building code is itself a readable spec of each format's real XML
  shape, and every test exercises the real unzip + real XML parse path.
  `textFixtures.ts` holds the RTF/SVG source-string fixtures.

## Wiring

`../ocrWorker.ts` `extractText()` dispatches by extension/MIME to
`extractTextFromZipXml` / `extractTextFromRtfFile` / `extractTextFromSvgFile`
wrapper functions (each dynamically imports its extractor module — same
lazy-load pattern as `mammoth`/`pdfjs-dist`/`tesseract.js`), producing an
`OCRResult` with `method: 'zip-xml' | 'rtf' | 'svg'`. Dispatch order matters:
RTF/SVG/zip-xml checks run BEFORE the generic `image/*` branch (SVG's MIME
is `image/svg+xml`, which would otherwise route into Tesseract OCR on a
non-raster image) and before the plain-text fallback (which used to
mis-handle `.rtf`).

## Do / Don't Rules

- DON'T import anything in this folder from `services/worker/` — ever. The
  guard test fails the build if this happens.
- DON'T add `.ods` handling to `zipXmlExtract.ts` without checking the F1
  spreadsheet dual-mode workstream first (SheetJS owns `.ods`/`.xls`/`.xlsx`).
- DO keep every new parser dynamically imported (`await import(...)`) —
  never a static top-level import — to protect the initial bundle size.
- DO add a real fixture (via `__fixtures__/`) + a corrupt/malformed-input
  test for any new format added here, per the founder KPI bar: every
  format must genuinely extract, not soft-fail to manual entry.
