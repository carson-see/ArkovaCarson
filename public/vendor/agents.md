# public/vendor/agents.md

Vendored third-party libraries served as static assets from the frontend.

## Files
- **`transformers.web.min.js`** — Hugging Face Transformers.js v4.1.0 (minified). Used for client-side ML inference (e.g., on-device document processing). Loaded at runtime, not bundled by Vite.
- **`tesseract/`** — Self-hosted Tesseract.js v7 OCR runtime (WEBEXT-02 / SCRUM-2504). Served under CSP `'self'`; the npm-default `cdn.jsdelivr.net` load is forbidden by the deployed CSP (`vercel.json`). Pinned via `TESSERACT_VENDOR_PATHS` in `src/lib/ocrWorker.ts`. Lazy-loaded on first image OCR; NOT in the JS bundle. Apache-2.0.
  - `tesseract/worker.min.js` — the Tesseract Web Worker (`worker-src 'self'`).
  - `tesseract/core/tesseract-core-{,simd-,relaxedsimd-}lstm.wasm.js` — LSTM core loaders with the wasm embedded as base64 (no separate `.wasm` fetch). Tesseract auto-selects the SIMD/relaxedSIMD/plain variant at runtime by feature detection (`script-src 'self' 'wasm-unsafe-eval'`).
  - `tesseract/lang/eng.traineddata.gz` — English LSTM model (`@tesseract.js-data/eng` `4.0.0_best_int`), fetched via `langPath` (`connect-src 'self'`).

## Conventions
- Vendor files are checked in as-is; do not modify.
- Updates require re-downloading the specific version and verifying the license (Apache 2.0 for Transformers.js + Tesseract.js).
- Client-side processing boundary (Constitution 1.6): documents never leave the user's device.
- Off-origin runtime fetches are CI-gated: `scripts/ci/check-csp-runtime-deps.ts` (WEBEXT-04) fails the build if a runtime dep references a forbidden CDN host instead of `/vendor`. Keep new on-device runtimes self-hosted here.
