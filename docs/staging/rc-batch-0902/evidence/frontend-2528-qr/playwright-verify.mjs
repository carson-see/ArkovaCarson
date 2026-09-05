/**
 * playwright-verify.mjs — PR #2528 evidence, step 3/4 (the decoded URL, in a browser).
 *
 * Takes the URL that jsQR DECODED (decode-matrix-results.json, scale 8) — not a
 * URL typed by hand — and loads it in headless Chromium via the worktree's
 * Playwright 1.62.1 at 1280x800 and 375x812, plus an iOS-Safari-UA mobile run
 * (what an iPhone camera scan opens) and the negative control. Records the
 * document response status + content-type, final URL, title, rendered body
 * text (innerText), keyword hits, console errors, failed requests, and full-page
 * + viewport screenshots.
 *
 * Run from the scratchpad dir:  node playwright-verify.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WT =
  '/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/.claude/worktrees/agent-a8730250c8406e20d';
const require = createRequire(join(WT, 'package.json'));
const { chromium } = require('playwright');
const OUT = dirname(fileURLToPath(import.meta.url));

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** Chain of custody: the URL under test is what the decoder read back. */
const decodeResults = JSON.parse(readFileSync(join(OUT, 'decode-matrix-results.json'), 'utf8'));
function decodedUrl(id) {
  const hit = decodeResults.ids[id].perScale.find(p => p.scale === 8);
  if (!hit || !hit.decoded) throw new Error(`no scale-8 decode for ${id}`);
  return hit.decoded;
}

const CASES = [
  { name: 'positive-desktop-1280x800', id: 'ARK-DOC-9G5HQZ', viewport: { width: 1280, height: 800 }, ua: null, mobile: false },
  { name: 'positive-mobile-375x812', id: 'ARK-DOC-9G5HQZ', viewport: { width: 375, height: 812 }, ua: null, mobile: true },
  { name: 'positive-ios-safari-ua-375x812', id: 'ARK-DOC-9G5HQZ', viewport: { width: 375, height: 812 }, ua: IOS_UA, mobile: true },
  { name: 'negative-desktop-1280x800', id: 'ARK-DOC-ZZZZZZ', viewport: { width: 1280, height: 800 }, ua: null, mobile: false },
  { name: 'negative-mobile-375x812', id: 'ARK-DOC-ZZZZZZ', viewport: { width: 375, height: 812 }, ua: null, mobile: true },
];

const KEYWORDS = ['verified', 'secured', 'anchored', 'valid', 'not found', 'no record', 'could not', 'unable', 'error', 'loading', 'sign in', 'log in', 'login'];

async function launch() {
  const attempts = [
    { label: 'playwright-bundled chromium (default)', opts: {} },
    { label: 'google chrome channel', opts: { channel: 'chrome' } },
    {
      label: 'cached chromium_headless_shell-1228',
      opts: {
        executablePath: join(
          homedir(),
          'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell',
        ),
      },
    },
  ];
  const errors = [];
  for (const a of attempts) {
    try {
      const browser = await chromium.launch({ headless: true, ...a.opts });
      return { browser, label: a.label, errors };
    } catch (e) {
      errors.push({ attempt: a.label, error: String(e).split('\n')[0] });
    }
  }
  throw new Error('no chromium could be launched: ' + JSON.stringify(errors));
}

function settled(text, id) {
  const t = text.toLowerCase();
  return t.includes(id.toLowerCase()) || /not found|no record|could not|unable|invalid|does not exist|error/.test(t);
}

const { browser, label, errors: launchErrors } = await launch();
const summary = {
  browser: label,
  browserVersion: browser.version(),
  playwrightVersion: require('playwright/package.json').version,
  launchFallbacks: launchErrors,
  ranAt: new Date().toISOString(),
  cases: [],
};

for (const c of CASES) {
  const url = decodedUrl(c.id);
  const context = await browser.newContext({
    viewport: c.viewport,
    deviceScaleFactor: c.mobile ? 3 : 1,
    isMobile: c.mobile,
    hasTouch: c.mobile,
    ...(c.ua ? { userAgent: c.ua } : {}),
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  const errorResponses = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('requestfailed', r => failedRequests.push({ url: r.url().slice(0, 200), error: r.failure() ? r.failure().errorText : null }));
  page.on('response', r => { if (r.status() >= 400) errorResponses.push({ url: r.url().slice(0, 200), status: r.status() }); });

  let resp = null;
  let navError = null;
  const t0 = Date.now();
  try {
    resp = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  } catch (e) {
    navError = String(e).split('\n')[0];
  }
  let networkIdle = true;
  try {
    await page.waitForLoadState('networkidle', { timeout: 30000 });
  } catch {
    networkIdle = false;
  }
  // Settle: wait (max 30 s) for the SPA to show the record or a terminal state.
  const deadline = Date.now() + 30000;
  let text = '';
  while (Date.now() < deadline) {
    text = await page.evaluate(() => document.body.innerText);
    if (settled(text, c.id)) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(2000);
  text = await page.evaluate(() => document.body.innerText);
  const title = await page.title();
  const ua = await page.evaluate(() => navigator.userAgent);

  const fullShot = join(OUT, `${c.name}.png`);
  const viewShot = join(OUT, `${c.name}-viewport.png`);
  await page.screenshot({ path: fullShot, fullPage: true });
  await page.screenshot({ path: viewShot, fullPage: false });
  writeFileSync(join(OUT, `${c.name}.txt`), text);

  const lower = text.toLowerCase();
  const keywordHits = {};
  for (const k of KEYWORDS) keywordHits[k] = lower.split(k).length - 1;

  const rec = {
    name: c.name,
    requestedUrl: url,
    viewport: c.viewport,
    userAgent: ua,
    documentStatus: resp ? resp.status() : null,
    documentContentType: resp ? resp.headers()['content-type'] || null : null,
    documentResponseUrl: resp ? resp.url() : null,
    finalUrl: page.url(),
    navigationError: navError,
    networkIdleReached: networkIdle,
    settleMs: Date.now() - t0,
    title,
    bodyTextChars: text.length,
    publicIdVisible: lower.includes(c.id.toLowerCase()),
    keywordHits,
    consoleErrors,
    failedRequests,
    errorResponses,
    screenshotFullPage: fullShot,
    screenshotViewport: viewShot,
    bodyTextFile: join(OUT, `${c.name}.txt`),
  };
  summary.cases.push(rec);
  console.log(`[pw] ${c.name}: status=${rec.documentStatus} ct=${rec.documentContentType} final=${rec.finalUrl} idVisible=${rec.publicIdVisible} title=${JSON.stringify(title)} hits=${JSON.stringify(keywordHits)} consoleErrors=${consoleErrors.length} failed=${failedRequests.length} nav=${navError}`);
  await context.close();
}

await browser.close();
writeFileSync(join(OUT, 'playwright-results.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ browser: summary.browser, version: summary.browserVersion, cases: summary.cases.length }, null, 2));
