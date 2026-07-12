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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  parseCspDirectives,
  cspAllowsSelfWasmEval,
  FORBIDDEN_CDN_PATTERNS,
  scanSourceForForbiddenOrigins,
  extractModuleSpecifiers,
  scanVendoredEsmForBareSpecifiers,
  checkOrtWasmPathsPinned,
  VENDORED_RUNTIME_ESM,
  evaluateCspRuntimeDeps,
  type CspFinding,
} from './check-csp-runtime-deps';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

// WEBEXT-01 F-1: the vendored runtime ESM must be SELF-CONTAINED. A top-level
// bare specifier ('onnxruntime-web/webgpu') makes native browser module-linking
// throw before a single byte of model code runs — CSP-independent, weights-
// independent, dead on arrival. This is the failure class the 2026-07-06
// re-gate (PR #1409) proved live in prod; the gate below makes it build-fatal.
describe('extractModuleSpecifiers (WEBEXT-01 F-1)', () => {
  it('extracts minified static import forms', () => {
    const src =
      'import*as cA from"onnxruntime-web/webgpu";import{Tensor as Q0}from"onnxruntime-common";' +
      'import Zt,{a}from"./rel.js";import"side-effect-pkg";export{x}from"/abs/path.js";';
    expect(extractModuleSpecifiers(src).sort()).toEqual([
      './rel.js',
      '/abs/path.js',
      'onnxruntime-common',
      'onnxruntime-web/webgpu',
      'side-effect-pkg',
    ]);
  });

  it('extracts string-literal dynamic imports and ignores non-literal ones', () => {
    const src = 'const m=await import("bare-pkg");const n=await import(someVar);import(`/tpl/${x}`);';
    expect(extractModuleSpecifiers(src)).toEqual(['bare-pkg']);
  });

  it('ignores import.meta and export without from', () => {
    const src = 'const u=import.meta.url;export{a,b,c};export default x;';
    expect(extractModuleSpecifiers(src)).toEqual([]);
  });
});

describe('scanVendoredEsmForBareSpecifiers (WEBEXT-01 F-1)', () => {
  it('flags a bare specifier (browser cannot link it without an import map)', () => {
    const findings = scanVendoredEsmForBareSpecifiers([
      { path: 'public/vendor/x.min.js', content: 'import*as o from"onnxruntime-web/webgpu";' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe('public/vendor/x.min.js');
    expect(findings[0].message).toMatch(/bare specifier/i);
    expect(findings[0].message).toMatch(/onnxruntime-web\/webgpu/);
  });

  it('flags an absolute off-origin URL import', () => {
    const findings = scanVendoredEsmForBareSpecifiers([
      { path: 'public/vendor/x.min.js', content: 'import{a}from"https://cdn.jsdelivr.net/npm/x/dist/x.mjs";' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toMatch(/off-origin/i);
  });

  it('passes root-relative and relative specifiers', () => {
    const findings = scanVendoredEsmForBareSpecifiers([
      { path: 'public/vendor/x.min.js', content: 'import{a}from"/vendor/ort/f.mjs";import{b}from"./chunk.mjs";' },
    ]);
    expect(findings).toEqual([]);
  });

  it('allows guarded DYNAMIC Node-builtin imports (emscripten pattern in the ort factory)', () => {
    // The ort wasm .mjs factory dynamically imports "module"/"worker_threads"
    // behind `globalThis.process?.versions?.node` guards — browser-inert and,
    // being dynamic, never part of link-time resolution (the F-1 class).
    const findings = scanVendoredEsmForBareSpecifiers([
      {
        path: 'public/vendor/ort/f.mjs',
        content:
          'if(isNode){const{createRequire:a}=await import("module");const w=await import("worker_threads");const u=await import("node:url");}',
      },
    ]);
    expect(findings).toEqual([]);
  });

  it('still flags a STATIC Node-builtin import (link-fatal in a browser)', () => {
    const findings = scanVendoredEsmForBareSpecifiers([
      { path: 'public/vendor/x.min.js', content: 'import{cpus}from"os";' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toMatch(/static bare specifier "os"/);
  });

  it('still flags a DYNAMIC bare specifier that is not a Node builtin', () => {
    const findings = scanVendoredEsmForBareSpecifiers([
      { path: 'public/vendor/x.min.js', content: 'const m=await import("some-npm-pkg");' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toMatch(/dynamic bare specifier "some-npm-pkg"/);
  });

  it('FAILS on the historical broken .web. bundle shape (F-1 regression pin)', () => {
    // Byte-shape taken from the real transformers.web.min.js 4.2.0 build that
    // shipped to prod and hard-blocked NER for every user (PR #1409 §6 F-1).
    const findings = scanVendoredEsmForBareSpecifiers([
      {
        path: 'public/vendor/transformers.web.min.js',
        content: 'import*as cA from"onnxruntime-web/webgpu";import{Tensor as Q0}from"onnxruntime-common";var x=1;',
      },
    ]);
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  it('the committed vendored runtime bundle(s) are genuinely self-contained', () => {
    // Integration over the REAL committed artifact — the exact check that would
    // have caught F-1 before it shipped.
    for (const rel of VENDORED_RUNTIME_ESM) {
      const content = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(
        scanVendoredEsmForBareSpecifiers([{ path: rel, content }]),
        `${rel} must contain no bare/off-origin module specifiers`,
      ).toEqual([]);
    }
  });
});

// WEBEXT-01 F-2: onnxruntime-web defaults `wasmPaths` to a jsdelivr CDN URL
// when unset — blocked by the deployed CSP (connect-src 'self'). The loader
// must pin wasmPaths to the same-origin vendor path before session creation.
describe('checkOrtWasmPathsPinned (WEBEXT-01 F-2)', () => {
  const GOOD =
    "export const ORT_WASM_VENDOR_PATH = '/vendor/ort/';\n" +
    'ortWasmEnv.wasmPaths = ORT_WASM_VENDOR_PATH;\n';

  it('passes when the loader pins wasmPaths to a same-origin vendor path', () => {
    expect(checkOrtWasmPathsPinned(GOOD)).toEqual([]);
  });

  it('fails when the vendor-path constant is missing', () => {
    const findings = checkOrtWasmPathsPinned('ortWasmEnv.wasmPaths = someOtherThing;');
    expect(findings.some((f) => /ORT_WASM_VENDOR_PATH/.test(f.message))).toBe(true);
  });

  it('fails when wasmPaths is never assigned (CDN default would win)', () => {
    const findings = checkOrtWasmPathsPinned("export const ORT_WASM_VENDOR_PATH = '/vendor/ort/';");
    expect(findings.some((f) => /wasmPaths/.test(f.message))).toBe(true);
  });

  it('fails when the pinned path is an absolute URL / CDN host', () => {
    const cdn =
      "export const ORT_WASM_VENDOR_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';\n" +
      'ortWasmEnv.wasmPaths = ORT_WASM_VENDOR_PATH;\n';
    const findings = checkOrtWasmPathsPinned(cdn);
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  it('the real nerPiiDetector.ts satisfies the pin', () => {
    const content = readFileSync(join(REPO_ROOT, 'src', 'lib', 'nerPiiDetector.ts'), 'utf8');
    expect(checkOrtWasmPathsPinned(content)).toEqual([]);
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
