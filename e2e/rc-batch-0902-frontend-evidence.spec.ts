/**
 * rc/soak-batch-2026-09-02 — targeted frontend evidence for PR #2528
 * (`fix/published-verification-pointers`, T1, head 7781bf0e).
 *
 * #2528 is frontend-only (`src/lib/copy.ts`, `src/lib/generateAuditReport.ts`,
 * `src/lib/certificateQr.ts`, `src/pages/IndependentVerifyPage.tsx`) and has no
 * worker surface, so the batched worker driver does not touch it. This spec is
 * the T1's targeted evidence, per the frontend evidence path in
 * `scripts/ci/check-staging-evidence.ts` (`T2_FRONTEND_FIELDS`: "RM-approved
 * targeted evidence:", "Async-cycle floor:", "E2E result:"). It proves, against
 * a SERVED build in a real browser:
 *
 *   1. `/verify/independent` no longer publishes a pointer a reader cannot
 *      follow: no link or text names `verify.sh`, and no link or text names an
 *      `arkova.ai/verify` host without the `app.` prefix. The regexes are the
 *      ones `src/lib/publishedVerificationPointers.test.ts` pins at unit level,
 *      applied here to what the page actually renders.
 *   2. The certificate PDF a SECURED record's owner downloads from the real
 *      record page paints a QR whose rectangle runs are EXACTLY the runs of the
 *      QR for `canonicalVerifyUrl(publicId)` (`https://app.arkova.ai/verify/<id>`),
 *      reading the `re` operators out of the PDF content stream the way
 *      `src/lib/generateAuditReport.test.ts` does — so a transposed, missing, or
 *      differently-encoded QR fails, not just a missing `<canvas>`.
 *
 * Evidence: each test writes a JSON file under `RC0902_EVIDENCE_DIR` (default
 * `test-results/rc-batch-0902/`, gitignored) and attaches it to the Playwright
 * report. `servedBuild` records whether the origin served a Vite dev bundle
 * (`/@vite/client` present) or a built one — cite it honestly in the PR body.
 *
 * Run (served build):
 *   npm run build && npx vite preview --port 5173 --strictPort &
 *   npx playwright test e2e/rc-batch-0902-frontend-evidence.spec.ts --project=chromium
 * The certificate half needs the usual E2E stack (`.env.test` with
 * E2E_SUPABASE_SERVICE_KEY + E2E_SEED_PASSWORD against a local Supabase); the
 * page half needs only the served origin.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';
import { buildQrMatrix, type QrMatrix } from '../src/lib/certificateQr';
import { canonicalVerifyUrl } from '../src/lib/routes';

const PR_NUMBER = 2528;
const PR_HEAD_SHA = '7781bf0eb67df38d576e28f038003d7e3210dbd3';
const RC_HEAD_SHA = '78621249595e37398170da9b298ae13cd753a801';
const EVIDENCE_DIR = process.env.RC0902_EVIDENCE_DIR ?? resolve(process.cwd(), 'test-results', 'rc-batch-0902');

/** Same regexes as src/lib/publishedVerificationPointers.test.ts. */
const NON_APP_ARKOVA_URL = /https?:\/\/(?!app\.)(?:[\w-]+\.)*arkova\.(?:ai|io)(?![\w.-])/i;
const NON_APP_VERIFY_URL = /https?:\/\/(?!app\.)(?:[\w-]+\.)*arkova\.(?:ai|io)\/verify/i;
const VERIFY_SH = /verify\.sh/i;

/** jsPDF's mm -> pt scale factor (72 dpi over 25.4 mm/inch). */
const PT_PER_MM = 72 / 25.4;
/** Mirrors the module-scope constants in src/lib/generateAuditReport.ts. */
const QR_SIDE_MM = 26;

function writeEvidence(name: string, payload: Record<string, unknown>): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = resolve(EVIDENCE_DIR, `${name}.json`);
  writeFileSync(path, `${JSON.stringify({ utc: new Date().toISOString(), pr: PR_NUMBER, prHead: PR_HEAD_SHA, rcHead: RC_HEAD_SHA, ...payload }, null, 2)}\n`);
  return path;
}

/** Is the origin serving a Vite DEV bundle (not a built one)? Recorded, never asserted. */
async function detectServedBuild(baseURL: string): Promise<{ servedBuild: boolean; marker: string }> {
  const res = await fetch(baseURL);
  const html = await res.text();
  const dev = html.includes('/@vite/client');
  return { servedBuild: !dev, marker: dev ? 'vite dev bundle (/@vite/client present)' : 'built bundle (no /@vite/client)' };
}

/**
 * Every `x y w h re` rectangle in the PDF content stream, converted back to mm
 * with a top-left origin — reads what is actually PAINTED, exactly as the unit
 * test does. jsPDF emits `re` in points against a bottom-left origin and, in
 * its default COMPAT mode, negates the height.
 */
function paintedRects(pdf: string): Array<{ x: number; y: number; w: number; h: number }> {
  const mediaBox = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf);
  if (!mediaBox) throw new Error('no /MediaBox in the PDF — cannot convert coordinates');
  const pageHeightMm = Number(mediaBox[2]) / PT_PER_MM;
  return [...pdf.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g)].map((m) => {
    const [xPt, yPt, wPt, hPt] = m.slice(1, 5).map(Number);
    return { x: xPt / PT_PER_MM, y: pageHeightMm - yPt / PT_PER_MM, w: wPt / PT_PER_MM, h: Math.abs(hPt) / PT_PER_MM };
  });
}

/** Every `(…) Tj` text run in the content stream. */
function paintedText(pdf: string): string[] {
  return [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1]);
}

test.describe('#2528 — /verify/independent publishes only pointers a reader can follow', () => {
  // Public page: no session needed, and no dependency on the auth setup's storageState.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('no link or text names verify.sh or a non-app. arkova.ai/verify host', async ({ page, baseURL }) => {
    const origin = baseURL ?? 'http://localhost:5173';
    const served = await detectServedBuild(origin);

    await page.goto('/verify/independent');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Guard the guard: the page must actually have rendered its instructions,
    // or an empty shell would pass every negative assertion below.
    const codeBlocks = await page.locator('code').allInnerTexts();
    expect(codeBlocks.length, 'the step commands rendered').toBeGreaterThanOrEqual(4);

    const links = await page.locator('a[href]').evaluateAll((as) =>
      as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a as HTMLAnchorElement).innerText, download: a.hasAttribute('download') })),
    );
    const bodyText = await page.locator('body').innerText();

    const offenders: string[] = [];
    for (const l of links) {
      if (VERIFY_SH.test(l.href) || VERIFY_SH.test(l.text)) offenders.push(`link names verify.sh: ${l.href}`);
      if (NON_APP_VERIFY_URL.test(l.href)) offenders.push(`link to non-app verify host: ${l.href}`);
      if (l.download) offenders.push(`download link present: ${l.href}`);
    }
    if (VERIFY_SH.test(bodyText)) offenders.push('page text names verify.sh');
    if (NON_APP_VERIFY_URL.test(bodyText)) offenders.push('page text names a non-app arkova.ai/verify host');
    for (const code of codeBlocks) {
      if (NON_APP_ARKOVA_URL.test(code)) offenders.push(`command names a non-app arkova origin: ${code}`);
    }

    // Positive half: the pointer that replaced verify.sh is the in-repo verifier, invoked by a path that exists after the build.
    const step3 = codeBlocks.find((c) => c.includes('packages/verifier-cli/dist/cli.js'));
    const buildCmd = codeBlocks.find((c) => c.includes('packages/verifier ') && c.includes('packages/verifier-cli '));

    const evidencePath = writeEvidence('fe-published-pointers', {
      surface: '/verify/independent',
      origin,
      ...served,
      linksChecked: links.length,
      codeBlocksChecked: codeBlocks.length,
      offenders,
      step3Command: step3 ?? null,
      verifierBuildCommand: buildCmd ?? null,
      links: links.map((l) => l.href),
    });
    await test.info().attach('fe-published-pointers.json', { path: evidencePath, contentType: 'application/json' });

    expect(offenders).toEqual([]);
    expect(step3, 'step 3 invokes the in-repo verifier via dist/cli.js').toBeTruthy();
    expect(step3).toMatch(/^node\s/);
    expect(buildCmd, 'the build instruction compiles the library before the CLI').toBeTruthy();
    expect(bodyText).toContain('Get the Reference Verifier');
  });
});

test.describe('#2528 — the certificate PDF carries a scannable QR for the canonical verification URL', () => {
  const serviceClient = getServiceClient();
  let secured: { id: string; public_id: string };

  test.beforeAll(async () => {
    const anchor = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'SECURED',
      filename: 'rc0902_certificate_qr_evidence.pdf',
    });
    if (!anchor?.id || !anchor?.public_id) throw new Error('beforeAll: failed to create the SECURED test anchor');
    secured = { id: anchor.id, public_id: anchor.public_id };
  });

  test.afterAll(async () => {
    if (secured?.id) await deleteTestAnchor(serviceClient, secured.id);
  });

  test('the downloaded PDF paints exactly the QR runs of canonicalVerifyUrl(publicId) and prints that URL', async ({ individualPage, baseURL }) => {
    const origin = baseURL ?? 'http://localhost:5173';
    const served = await detectServedBuild(origin);

    await individualPage.goto(`/records/${secured.id}`);
    await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 15_000 });
    await expect(individualPage.getByText(/Download Proof Package/i)).toBeVisible();

    const downloadPromise = individualPage.waitForEvent('download', { timeout: 20_000 });
    await individualPage.getByRole('button', { name: /PDF/i }).click();
    const download = await downloadPromise;
    const path = await download.path();
    if (!path) throw new Error('download produced no file');
    const pdf = readFileSync(path).toString('latin1');

    const expectedUrl = canonicalVerifyUrl(secured.public_id);
    expect(expectedUrl).toBe(`https://app.arkova.ai/verify/${secured.public_id}`);
    const qr = buildQrMatrix(expectedUrl) as QrMatrix | null;
    if (!qr) throw new Error('buildQrMatrix returned null for the canonical URL');

    const rects = paintedRects(pdf);
    const moduleMm = QR_SIDE_MM / qr.moduleCount;
    const originX = Math.min(...rects.map((v) => v.x));
    const originY = Math.min(...rects.map((v) => v.y));
    const key = (v: { x: number; y: number; w: number; h: number }) => [v.x, v.y, v.w, v.h].map((n) => n.toFixed(3)).join(',');
    const painted = rects.map(key).sort();
    const expected = qr.runs
      .map((run) => key({ x: originX + run.col * moduleMm, y: originY + run.row * moduleMm, w: run.width * moduleMm, h: moduleMm }))
      .sort();

    const text = paintedText(pdf);
    const urlPrinted = text.includes(expectedUrl);
    const textOffenders = text.filter((t) => VERIFY_SH.test(t) || NON_APP_VERIFY_URL.test(t));

    const evidencePath = writeEvidence('fe-certificate-qr', {
      surface: `/records/${secured.id} -> certificate PDF`,
      origin,
      ...served,
      publicId: secured.public_id,
      canonicalUrl: expectedUrl,
      qrModuleCount: qr.moduleCount,
      qrRuns: qr.runs.length,
      paintedRects: rects.length,
      geometryMatches: painted.length === expected.length && painted.every((p, i) => p === expected[i]),
      urlPrinted,
      textOffenders,
      pdfBytes: pdf.length,
      downloadFilename: download.suggestedFilename(),
    });
    await test.info().attach('fe-certificate-qr.json', { path: evidencePath, contentType: 'application/json' });

    expect(rects.length, 'one painted rectangle per QR run and nothing else').toBe(qr.runs.length);
    expect(painted).toEqual(expected);
    expect(urlPrinted, 'the canonical URL is printed under the QR').toBe(true);
    expect(textOffenders).toEqual([]);
  });
});
