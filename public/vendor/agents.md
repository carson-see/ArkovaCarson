# public/vendor/agents.md

Vendored third-party libraries served as static assets from the frontend.

## Files
- **`transformers.web.min.js`** — Hugging Face Transformers.js **v4.2.0** (minified web/ESM browser build). Used for client-side ML inference (the on-device NER PII detector, `src/lib/nerPiiDetector.ts`). Loaded at runtime via dynamic import from the app origin (`/vendor/...`), not bundled by Vite.
  - **Source:** byte-for-byte copy of `node_modules/@huggingface/transformers/dist/transformers.web.min.js` from the pinned `@huggingface/transformers@4.2.0` dependency (the package's browser/`default` export). NOT pulled from a CDN / floating `latest`.
  - **License:** Apache-2.0 (`@huggingface/transformers`).
  - **Version pin (SCRUM-2503):** this version MUST match `transformersJsVersion` in `scripts/ner-weights.lock.json` and `TRANSFORMERS_JS_VERSION` in `src/lib/nerPiiDetector.ts` — the SHA-256 integrity lock was built for the exact model file set THIS version requests for `Xenova/bert-base-NER` q8. The regression test `scripts/vendor-transformers-version.test.ts` fails the build on any skew.

## Conventions
- Vendor files are checked in as-is; do not modify.
- Updates require re-vendoring the EXACT pinned version (re-copy from `node_modules` after bumping the `@huggingface/transformers` pin in `package.json`), verifying the license (Apache 2.0), and re-confirming the lock + `TRANSFORMERS_JS_VERSION` + the `ner-weights.lock.json` file set all agree (then re-soak — PII-detection behavior may change).
- Client-side processing boundary (Constitution 1.6): documents never leave the user's device.
