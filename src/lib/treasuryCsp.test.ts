/**
 * CSP ↔ treasury-enrichment-origin guard (SCRUM-2901 / CSP mempool.space fix).
 *
 * The admin treasury dashboard (`useTreasuryBalance`) fetches display-only
 * receipts / price / fee enrichment DIRECTLY from `https://mempool.space/api/*`
 * in the browser (worker-owned data stays worker-side; this is the public
 * enrichment path). If `mempool.space` is absent from the deployed
 * `connect-src`, every one of those fetches is CSP-blocked and the treasury
 * page floods the console with violations.
 *
 * This test asserts the enrichment origin is allow-listed in BOTH CSP sources:
 *   - `vercel.json` (production response header), and
 *   - `index.html` (dev/build-time meta fallback).
 *
 * NOTE: `mempool.space` is a FRONTEND-only enrichment origin, NOT a worker/edge
 * runtime. It deliberately does NOT belong in the config-drift gate's
 * `cspConnectSrc` (that array is the cross-runtime worker+edge subset).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Parse a CSP header string into a `{ directive: sources[] }` map. */
function parseCspDirectives(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(';')) {
    const trimmed = part.trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    const tokens = trimmed.split(' ');
    out[tokens[0]] = tokens.slice(1);
  }
  return out;
}

function vercelConnectSrc(): string[] {
  const vercel = JSON.parse(readFileSync(resolve(REPO_ROOT, 'vercel.json'), 'utf8'));
  const cspHeader = vercel.headers
    ?.flatMap((h: { headers?: Array<{ key: string; value: string }> }) => h.headers ?? [])
    .find((kv: { key: string }) => kv.key === 'Content-Security-Policy');
  expect(cspHeader, 'vercel.json must define a Content-Security-Policy header').toBeTruthy();
  return parseCspDirectives(cspHeader.value)['connect-src'] ?? [];
}

function indexHtmlConnectSrc(): string[] {
  const html = readFileSync(resolve(REPO_ROOT, 'index.html'), 'utf8');
  const match = html.match(
    /http-equiv="Content-Security-Policy"\s*content="([\s\S]*?)"/,
  );
  expect(match, 'index.html must define a CSP meta tag').toBeTruthy();
  return parseCspDirectives(match![1])['connect-src'] ?? [];
}

const MEMPOOL_ORIGIN = 'https://mempool.space';

function vercelDirectives(): Record<string, string[]> {
  const vercel = JSON.parse(readFileSync(resolve(REPO_ROOT, 'vercel.json'), 'utf8'));
  const cspHeader = vercel.headers
    ?.flatMap((h: { headers?: Array<{ key: string; value: string }> }) => h.headers ?? [])
    .find((kv: { key: string }) => kv.key === 'Content-Security-Policy');
  expect(cspHeader, 'vercel.json must define a Content-Security-Policy header').toBeTruthy();
  return parseCspDirectives(cspHeader.value);
}

function indexHtmlDirectives(): Record<string, string[]> {
  const html = readFileSync(resolve(REPO_ROOT, 'index.html'), 'utf8');
  const match = html.match(/http-equiv="Content-Security-Policy"\s*content="([\s\S]*?)"/);
  expect(match, 'index.html must define a CSP meta tag').toBeTruthy();
  return parseCspDirectives(match![1]);
}

describe('treasury CSP enrichment origins (SCRUM-2901)', () => {
  it('vercel.json connect-src allows mempool.space (prod header)', () => {
    expect(vercelConnectSrc()).toContain(MEMPOOL_ORIGIN);
  });

  it('index.html connect-src allows mempool.space (dev/build fallback)', () => {
    // The dev fallback uses a wildcard *.arkova.ai but must still explicitly
    // permit the third-party mempool origin.
    const sources = indexHtmlConnectSrc();
    const allowed =
      sources.includes(MEMPOOL_ORIGIN) || sources.includes('https://*.mempool.space');
    expect(allowed, `index.html connect-src must allow ${MEMPOOL_ORIGIN}`).toBe(true);
  });

  it("both CSP sources still include 'self' (regression guard)", () => {
    expect(vercelConnectSrc()).toContain("'self'");
    expect(indexHtmlConnectSrc()).toContain("'self'");
  });

  // PI-0.5 24h-slice AC: the enrichment origin is allowed for FETCHES only.
  // mempool.space must never widen into script-src / default-src / img-src /
  // frame-src / any other directive — connect-src is the entire grant.
  it('mempool.space is scoped to connect-src ONLY in both CSP sources', () => {
    for (const [sourceName, directives] of [
      ['vercel.json', vercelDirectives()],
      ['index.html', indexHtmlDirectives()],
    ] as const) {
      for (const [directive, sources] of Object.entries(directives)) {
        if (directive === 'connect-src') continue;
        const hit = sources.find((s) => s.includes('mempool.space'));
        expect(
          hit,
          `${sourceName}: mempool.space must not appear in ${directive} (found "${hit}")`,
        ).toBeUndefined();
      }
    }
  });
});
