# public/vendor/agents.md

Vendored third-party libraries served as static assets from the frontend.

## Files
- **`transformers.web.min.js`** — Hugging Face Transformers.js **v4.2.0** (minified web/ESM browser build). Used for client-side ML inference (the on-device NER PII detector, `src/lib/nerPiiDetector.ts`). Loaded at runtime via dynamic import from the app origin (`/vendor/...`), not bundled by Vite.
  - **Source:** byte-for-byte copy of `node_modules/@huggingface/transformers/dist/transformers.web.min.js` from the pinned `@huggingface/transformers@4.2.0` dependency (the package's browser/`default` export). NOT pulled from a CDN / floating `latest`.
  - **License:** Apache-2.0 (`@huggingface/transformers`).
  - **Version pin (SCRUM-2503):** this version MUST match `transformersJsVersion` in `scripts/ner-weights.lock.json` and `TRANSFORMERS_JS_VERSION` in `src/lib/nerPiiDetector.ts` — the SHA-256 integrity lock was built for the exact model file set THIS version requests for `Xenova/bert-base-NER` q8. The regression test `scripts/vendor-transformers-version.test.ts` fails the build on any skew.
- **`tesseract/`** — Self-hosted Tesseract.js v7 OCR runtime (WEBEXT-02 / SCRUM-2504). Served under CSP `'self'`; the npm-default `cdn.jsdelivr.net` load is forbidden by the deployed CSP (`vercel.json`). Pinned via `TESSERACT_VENDOR_PATHS` in `src/lib/ocrWorker.ts`. Lazy-loaded on first image OCR; NOT in the JS bundle. Apache-2.0.
  - `tesseract/worker.min.js` — the Tesseract Web Worker (`worker-src 'self'`).
  - `tesseract/core/tesseract-core-{,simd-,relaxedsimd-}lstm.wasm.js` — LSTM core loaders with the wasm embedded as base64 (no separate `.wasm` fetch). Tesseract auto-selects the SIMD/relaxedSIMD/plain variant at runtime by feature detection (`script-src 'self' 'wasm-unsafe-eval'`).
  - `tesseract/lang/eng.traineddata.gz` — English LSTM model (`@tesseract.js-data/eng` `4.0.0_best_int`), fetched via `langPath` (`connect-src 'self'`).

## Conventions
- Vendor files are checked in as-is; do not modify.
- Updates require re-vendoring the EXACT pinned version (re-copy from `node_modules` after bumping the dependency pin in `package.json`) and verifying the license (Apache 2.0 for Transformers.js + Tesseract.js). For `transformers.web.min.js`, re-confirm the lock + `TRANSFORMERS_JS_VERSION` + the `ner-weights.lock.json` file set all agree (then re-soak — PII-detection behavior may change).
- Client-side processing boundary (Constitution 1.6): documents never leave the user's device.
- Off-origin runtime fetches are CI-gated: `scripts/ci/check-csp-runtime-deps.ts` (WEBEXT-04) fails the build if a runtime dep references a forbidden CDN host instead of `/vendor`. Keep new on-device runtimes self-hosted here.
