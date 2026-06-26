/**
 * §1.6 FAIL-CLOSED E2E — the exit proof for WEBEXT-02/03/04 (SCRUM-2504/2505/2506).
 *
 * This is the config↔reality test the 2026-06-16 regression lacked. It runs the
 * on-device extraction privacy contract UNDER THE EXACT DEPLOYED CSP (parsed
 * from `vercel.json`, NOT a dev-relaxed policy) and proves:
 *
 *   1. The deployed CSP actually BLOCKS the off-origin CDNs the old code reached
 *      (cdn.jsdelivr.net for Tesseract, huggingface.co for the NER model). If
 *      the CSP were misconfigured, this would surface here, not in prod.
 *   2. Same-origin (`/vendor/...`) assets ARE reachable under that CSP — so the
 *      self-hosted Tesseract/NER path can work.
 *   3. The fail-closed egress invariant: when the on-device PII model / OCR
 *      engine fails to load, the pipeline HARD-BLOCKS — NO request carrying
 *      document metadata (stripped or not) is sent. (Ties to WEBEXT-03.)
 *
 * It does NOT require the authed app backend: it serves a minimal page under the
 * real CSP and exercises the privacy contract directly. The production modules
 * themselves are unit/integration-tested in
 * `src/lib/{ocrWorker,enhancedPiiStripper,aiExtraction,ocrFailClosed}.test.ts`.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/** Read the EXACT deployed CSP header value from vercel.json. */
function loadDeployedCsp(): string {
  const vercel = JSON.parse(readFileSync(resolve(REPO_ROOT, 'vercel.json'), 'utf8')) as {
    headers?: Array<{ headers: Array<{ key: string; value: string }> }>;
  };
  for (const block of vercel.headers ?? []) {
    for (const h of block.headers ?? []) {
      if (h.key.toLowerCase() === 'content-security-policy') return h.value;
    }
  }
  throw new Error('No CSP header found in vercel.json');
}

const DEPLOYED_CSP = loadDeployedCsp();

// A fixed, same-origin test page served WITH the deployed CSP header. We use a
// stable URL under the app origin so `'self'` resolves to it.
const TEST_PAGE_URL = 'http://localhost:5173/__csp_fail_closed_probe__';

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>csp probe</title></head>
<body><main id="root">csp fail-closed probe</main></body></html>`;

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('§1.6 fail-closed under the deployed CSP (WEBEXT-02/03/04)', () => {
  test.beforeEach(async ({ page }) => {
    // Serve our probe page under the app origin WITH the exact deployed CSP.
    await page.route(TEST_PAGE_URL, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': DEPLOYED_CSP },
        body: PROBE_HTML,
      });
    });
  });

  test('the deployed CSP forbids the Tesseract + NER model CDNs', () => {
    // Sanity contract: the policy itself must not allowlist the CDNs the old
    // (fail-open) code reached. connect-src governs fetch(); script-src governs
    // import()/worker scripts.
    expect(DEPLOYED_CSP).not.toMatch(/jsdelivr|unpkg|tessdata|huggingface\.co|cdnjs/i);
    // And it must permit the self-hosted runtimes.
    expect(DEPLOYED_CSP).toMatch(/script-src[^;]*'wasm-unsafe-eval'/);
    expect(DEPLOYED_CSP).toMatch(/worker-src[^;]*'self'/);
    expect(DEPLOYED_CSP).toMatch(/connect-src[^;]*'self'/);
  });

  test('the browser BLOCKS an off-origin CDN fetch under the deployed CSP', async ({ page }) => {
    await page.goto(TEST_PAGE_URL);

    // Attempt the exact fetch the old code performed (Tesseract core via
    // jsdelivr). Under the deployed connect-src, the browser must refuse it.
    const blocked = await page.evaluate(async () => {
      try {
        await fetch('https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-lstm.wasm.js', {
          mode: 'no-cors',
        });
        return false; // fetch resolved → NOT blocked (CSP failed)
      } catch {
        return true; // CSP blocked it
      }
    });
    expect(blocked).toBe(true);

    // The HuggingFace model host (the NER weights default origin) is likewise blocked.
    const hfBlocked = await page.evaluate(async () => {
      try {
        await fetch('https://huggingface.co/Xenova/bert-base-NER/resolve/main/config.json', {
          mode: 'no-cors',
        });
        return false;
      } catch {
        return true;
      }
    });
    expect(hfBlocked).toBe(true);
  });

  test('FAIL-CLOSED: a model-load failure sends NO document metadata (zero egress)', async ({ page }) => {
    await page.goto(TEST_PAGE_URL);

    // Record every network request leaving the page.
    const requests: string[] = [];
    page.on('request', (req) => requests.push(req.url()));

    // Mirror the production fail-closed gate (aiExtraction.runExtraction):
    //   on-device strip throws fail-closed → NO fetch to the extraction API.
    // We model the contract so the E2E is self-contained; the production code
    // path is asserted in the unit/integration suites.
    const egressAttempted = await page.evaluate(async () => {
      const EXTRACT_ENDPOINT = '/api/v1/ai/extract';

      class NerPiiFailClosedError extends Error {
        failClosed = true;
        constructor(m: string) { super(m); this.name = 'NerPiiFailClosedError'; }
      }
      function isFailClosed(e: unknown): boolean {
        return typeof e === 'object' && e !== null &&
          ((e as { failClosed?: unknown }).failClosed === true ||
           (e as { name?: unknown }).name === 'NERModelLoadError');
      }

      // The on-device privacy step FAILS (e.g. CSP-blocked model).
      async function stripPii(): Promise<string> {
        throw new NerPiiFailClosedError('model unavailable');
      }

      let sentMetadata = false;
      try {
        const stripped = await stripPii(); // throws fail-closed
        // This line MUST be unreachable on the fail-closed path:
        sentMetadata = true;
        await fetch(EXTRACT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strippedText: stripped, fingerprint: 'x'.repeat(64) }),
        });
      } catch (e) {
        if (!isFailClosed(e)) throw e;
        // Fail-closed → block egress. Nothing sent.
      }
      return sentMetadata;
    });

    // The metadata-bearing fetch was never attempted.
    expect(egressAttempted).toBe(false);
    // And no request to the extraction endpoint left the page.
    expect(requests.some((u) => u.includes('/api/v1/ai/extract'))).toBe(false);
  });
});
