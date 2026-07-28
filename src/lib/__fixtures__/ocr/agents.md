# agents.md — lib/__fixtures__/ocr

_Last updated: 2026-07-28_

## What This Folder Contains

Real, tiny (all files <25 KB, ~80 KB total) committed binary fixtures for `ocrWorker.test.ts` / `ocrWorker.realDecode.test.ts` (F4, 2026-07-28). All contain genuine rendered text or a real PDF text layer — none are placeholder/fake bytes — so decode + text-detection assertions exercise real library behavior, not mocks.

## Key Files

- `text.png` / `text.jpg` / `text.gif` / `text.webp` / `text.tiff` / `text.heic` — same "ARKOVA TEST" image re-encoded per format (generated via PIL / ImageMagick).
- `multipage.tiff` — 3-page TIFF ("PAGE ONE" / "PAGE TWO" / "PAGE THREE"), proves multi-page TIFF decode + per-page OCR joining.
- `overcap.tiff` — 22-page TIFF (pages "P1".."P22"), proves the `TIFF_MAX_PAGES=20` cap actually bounds processing.
- `text-layer.pdf` — real embedded text layer (via `reportlab`), proves a text PDF never takes the scanned-PDF OCR fallback.
- `scanned.pdf` — image-only PDF (a PNG embedded as an XObject via ImageMagick, zero text objects), proves the scanned-PDF OCR fallback trigger condition against a REAL file.
- `corrupt.tiff` / `corrupt.heic` / `corrupt.pdf` — truncated (not merely mislabeled) real files, for the malformed/hostile-input soft-fail tests. `corrupt.tiff` is `text.tiff` truncated to 2000 bytes (IFD parses but yields no usable width/height — `utif2` does not always throw on malformed input); `corrupt.heic` is `text.heic` truncated to 100 bytes (fails the HEIC brand-box check); `corrupt.pdf` is `scanned.pdf` truncated to 300 bytes (`pdfjs-dist` rejects with `InvalidPDFException`).

## Do / Don't Rules

- DO keep every fixture small and real (genuine rendered content, not placeholder bytes) — the whole point is proving real decode/OCR-routing behavior against real files.
- DO NOT regenerate `corrupt.*` fixtures without re-verifying they still exercise the SAME failure mode (a different truncation length can silently start throwing/succeeding differently — see `ocrWorker.realDecode.test.ts` for the exact expected behavior of each).
- DON'T add large fixtures here — this directory is committed to git; keep the total footprint small.
