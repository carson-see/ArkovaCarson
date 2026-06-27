/**
 * Tests for the WEBEXT-04 / SCRUM-2506 CSP↔runtime-deps drift guard.
 *
 * This is the config↔reality gate the 2026-06-16 regression lacked: a runtime
 * dependency (Tesseract / NER / PDF.js) silently needed an off-origin fetch the
 * deployed CSP forbade, so on-device PII stripping disabled and unstripped PII
 * left the browser. The guard parses the DEPLOYED CSP from `vercel.json` and
 * fails the build if any runtime dep would require a fetch / eval the CSP
 * forbids.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCspDirectives,
  cspAllowsSelfWasmEval,
  FORBIDDEN_CDN_PATTERNS,
  scanSourceForForbiddenOrigins,
  evaluateCspRuntimeDeps,
  type CspFinding,
} from './check-csp-runtime-deps';

const DEPLOYED_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.sentry.io https://*.stripe.com https://arkova-worker-270018525501.us-central1.run.app https://app.arkova.ai https://arkova.ai https://edge.arkova.ai https://search.arkova.ai; frame-src 'self' https://*.stripe.com https://accounts.google.com; frame-ancestors 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; upgrade-insecure-requests";

describe('parseCspDirectives', () => {
  it('splits a CSP string into a directive → sources map', () => {
    const d = parseCspDirectives(DEPLOYED_CSP);
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(d['worker-src']).toEqual(["'self'", 'blob:']);
    expect(d['connect-src']).toContain("'self'");
    expect(d['object-src']).toEqual(["'none'"]);
  });

  it('is whitespace tolerant', () => {
    const d = parseCspDirectives("  default-src   'self' ;  script-src 'self'  'wasm-unsafe-eval' ; ");
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  });
});

describe('cspAllowsSelfWasmEval', () => {
  it('passes when script-src has self + wasm-unsafe-eval', () => {
    const d = parseCspDirectives(DEPLOYED_CSP);
    expect(cspAllowsSelfWasmEval(d)).toEqual([]);
  });

  it('fails when wasm-unsafe-eval is missing (wasm models cannot run)', () => {
    const d = parseCspDirectives("default-src 'self'; script-src 'self'; worker-src 'self' blob:");
    const findings = cspAllowsSelfWasmEval(d);
    expect(findings.some((f) => /wasm-unsafe-eval/.test(f.message))).toBe(true);
  });

  it('fails when worker-src does not allow self (Tesseract worker blocked)', () => {
    const d = parseCspDirectives("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src https://cdn.example.com");
    const findings = cspAllowsSelfWasmEval(d);
    expect(findings.some((f) => /worker-src/.test(f.message))).toBe(true);
  });

  it("fails when connect-src does not allow 'self' (vendored assets unreachable)", () => {
    const d = parseCspDirectives("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src https://*.supabase.co; worker-src 'self' blob:");
    const findings = cspAllowsSelfWasmEval(d);
    expect(findings.some((f) => /connect-src/.test(f.message))).toBe(true);
  });
});

describe('scanSourceForForbiddenOrigins', () => {
  it('flags a jsdelivr reference in runtime source', () => {
    const findings = scanSourceForForbiddenOrigins([
      { path: 'src/lib/ocrWorker.ts', content: "const corePath = 'https://cdn.jsdelivr.net/npm/tesseract.js-core';" },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toMatch(/jsdelivr/);
  });

  it('flags unpkg, huggingface.co, and tessdata CDN hosts', () => {
    const findings = scanSourceForForbiddenOrigins([
      { path: 'a.ts', content: "fetch('https://unpkg.com/x')" },
      { path: 'b.ts', content: "import('https://huggingface.co/Xenova/model')" },
      { path: 'c.ts', content: "langPath: 'https://tessdata.projectnaptha.com/4.0.0'" },
    ]);
    expect(findings.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('passes clean, self-hosted /vendor references', () => {
    const findings = scanSourceForForbiddenOrigins([
      { path: 'src/lib/ocrWorker.ts', content: "workerPath: '/vendor/tesseract/worker.min.js', corePath: '/vendor/tesseract/core/'" },
      { path: 'src/lib/nerPiiDetector.ts', content: "const MOD = '/vendor/transformers.web.min.js';" },
    ]);
    expect(findings).toEqual([]);
  });

  it('ignores forbidden hosts that appear only in comments', () => {
    const findings = scanSourceForForbiddenOrigins([
      { path: 'src/lib/ocrWorker.ts', content: '// historically this loaded from cdn.jsdelivr.net — now vendored to /vendor' },
    ]);
    expect(findings).toEqual([]);
  });

  it('has a non-empty forbidden-CDN pattern list', () => {
    expect(FORBIDDEN_CDN_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('evaluateCspRuntimeDeps (integration over the real repo CSP + source)', () => {
  it('passes for the current deployed CSP + self-hosted runtime deps', () => {
    const findings: CspFinding[] = evaluateCspRuntimeDeps();
    if (findings.length > 0) {
      // Surface details if this ever regresses.
      console.error(findings.map((f) => `[${f.kind}] ${f.path ?? 'csp'}: ${f.message}`).join('\n'));
    }
    expect(findings).toEqual([]);
  });
});
