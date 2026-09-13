/**
 * Founder-reported bug (2026-09-13): the Secure Document dialog's Continue
 * flow fell closed to the §1.6 privacy-blocked screen on every extraction
 * under `npm run dev` because `nerPiiDetector.ts`'s default transformers.js
 * loader used a plain `import('/vendor/...')`, which Vite's dev server
 * refuses to serve for a `/public` asset. See that file's
 * `defaultTransformersLoader` doc comment for the full mechanism.
 *
 * This fixture drives the REAL loader (`__loadRealTransformersModuleForE2E`,
 * never `__setTransformersLoaderForTesting`) against the real vendored
 * bundle, exactly as `SecureDocumentDialog` -> `aiExtraction.runExtraction`
 * -> `enhancedPiiStripper.stripPIIEnhanced` -> `detectPIIWithNER` does for
 * loading the runtime module. It stops at "module loaded", not full
 * inference (backend/WASM/WebGPU selection is a separate concern from the
 * bundle-loading regression this fixture pins) — it must be run against a
 * live `vite dev` (or `vite preview` / static prod) server, not vitest/jsdom,
 * because the defect is in HOW the dev server serves a module import, which
 * jsdom cannot reproduce.
 */
import { __loadRealTransformersModuleForE2E } from '../../src/lib/nerPiiDetector';

async function run() {
  const out = document.getElementById('out')!;
  try {
    const result = await __loadRealTransformersModuleForE2E();
    out.textContent = 'OK:' + JSON.stringify(result);
  } catch (err) {
    out.textContent = 'FAIL:' + (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}

void run();
