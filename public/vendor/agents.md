# public/vendor/agents.md

Vendored third-party libraries served as static assets from the frontend.

## Files
- **`transformers.web.min.js`** — Hugging Face Transformers.js v4.1.0 (minified). Used for client-side ML inference (e.g., on-device document processing). Loaded at runtime, not bundled by Vite.

## Conventions
- Vendor files are checked in as-is; do not modify.
- Updates require re-downloading the specific version and verifying the license (Apache 2.0 for Transformers.js).
- Client-side processing boundary (Constitution 1.6): documents never leave the user's device.
