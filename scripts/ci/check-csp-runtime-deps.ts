#!/usr/bin/env -S npx tsx
/**
 * WEBEXT-04 / SCRUM-2506 — CSP ↔ runtime-deps drift guard.
 *
 * This is the config↔reality gate the 2026-06-16 §1.6 regression lacked. On
 * that date a CSP-breaking dependency silently needed an off-origin fetch the
 * deployed CSP forbade; on-device PII stripping disabled and unstripped PII
 * left the browser (FAIL-OPEN). This guard fails the build BEFORE deploy if any
 * runtime dependency (Tesseract OCR core/worker/lang, the NER model, PDF.js)
 * would require:
 *   1. an off-origin fetch / import / worker the deployed CSP forbids, or
 *   2. a wasm eval the CSP does not allow.
 *
 * It asserts against the DEPLOYED CSP — the exact `Content-Security-Policy`
 * header in `vercel.json` (NOT a dev-relaxed policy).
 *
 * Specifically it checks:
 *   - `script-src` includes `'self'` AND `'wasm-unsafe-eval'` (the on-device
 *     ML / OCR wasm runtimes need wasm eval),
 *   - `worker-src` allows `'self'` (the Tesseract Web Worker is vendored),
 *   - `connect-src` allows `'self'` (vendored wasm + traineddata are fetched),
 *   - NO runtime source file references a forbidden CDN host
 *     (jsdelivr / unpkg / huggingface.co / tessdata / etc.) — the vendored
 *     assets must load from `'self'` (`/vendor/...`).
 *
 * Override: PR labeled `csp-runtime-deps-intentional` (use only for a
 * deliberate, reviewed CSP/runtime-origin change).
 *
 * Companion gate: `check-config-drift.ts` (R-5) checks the `connect-src`
 * allowlist vs RUNNING prod. This guard is orthogonal — it checks that the
 * runtime CODE is consistent with whatever the CSP allows.
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OVERRIDE_LABEL = 'csp-runtime-deps-intentional';

/**
 * Forbidden runtime-fetch host substrings. If any appears in a runtime source
 * file (outside comments/strings-in-comments), the dependency would reach an
 * off-origin the CSP forbids → the 06-16 failure class. The vendored
 * equivalents all live under `/vendor/...` (`'self'`).
 */
export const FORBIDDEN_CDN_PATTERNS: readonly string[] = [
  'cdn.jsdelivr.net',
  'jsdelivr',
  'unpkg.com',
  'unpkg',
  'huggingface.co',
  'hf.co',
  'tessdata.projectnaptha.com',
  'tessdata',
  'cdnjs.cloudflare.com',
  'raw.githubusercontent.com',
];

/**
 * Runtime source files whose asset-loading must stay same-origin. These are the
 * files that load wasm / workers / model weights on-device. Kept explicit so a
 * new off-origin loader has to be added here deliberately.
 */
export const RUNTIME_DEP_SOURCES: readonly string[] = [
  'src/lib/ocrWorker.ts',
  'src/lib/nerPiiDetector.ts',
  'src/lib/enhancedPiiStripper.ts',
  'src/lib/mlRuntime.ts',
];

export interface CspFinding {
  kind: 'csp' | 'source';
  /** Source path for kind='source'; undefined for kind='csp'. */
  path?: string;
  message: string;
}

/** Parse a CSP header string into a `{ directive: sources[] }` map. */
export function parseCspDirectives(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const directive = tokens[0];
    out[directive] = tokens.slice(1);
  }
  return out;
}

/**
 * Assert the CSP permits the on-device runtimes:
 *   - script-src: 'self' + 'wasm-unsafe-eval'
 *   - worker-src (falls back to script-src then default-src): 'self'
 *   - connect-src (falls back to default-src): 'self'
 */
export function cspAllowsSelfWasmEval(directives: Record<string, string[]>): CspFinding[] {
  const findings: CspFinding[] = [];
  const scriptSrc = directives['script-src'] ?? directives['default-src'] ?? [];

  if (!scriptSrc.includes("'self'")) {
    findings.push({ kind: 'csp', message: "script-src must include 'self' (vendored runtimes load from the app origin)" });
  }
  if (!scriptSrc.includes("'wasm-unsafe-eval'")) {
    findings.push({
      kind: 'csp',
      message: "script-src must include 'wasm-unsafe-eval' (on-device OCR/NER wasm cannot instantiate without it)",
    });
  }

  // worker-src → script-src → default-src fallback chain (CSP spec).
  const workerSrc = directives['worker-src'] ?? directives['script-src'] ?? directives['default-src'] ?? [];
  if (!workerSrc.includes("'self'")) {
    findings.push({ kind: 'csp', message: "worker-src must allow 'self' (the Tesseract Web Worker is vendored to the app origin)" });
  }

  // connect-src → default-src fallback.
  const connectSrc = directives['connect-src'] ?? directives['default-src'] ?? [];
  if (!connectSrc.includes("'self'")) {
    findings.push({ kind: 'csp', message: "connect-src must allow 'self' (vendored wasm + language data are fetched from the app origin)" });
  }

  return findings;
}

/** Strip `//` line comments and `/* *​/` block comments so we don't flag historical notes. */
function stripComments(src: string): string {
  // Remove block comments first, then line comments.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:]|^)\/\/.*$/gm, '$1'); // trailing line comments (avoid eating `https://`)
}

/** Scan runtime source contents for any forbidden CDN host (outside comments). */
export function scanSourceForForbiddenOrigins(
  files: ReadonlyArray<{ path: string; content: string }>,
): CspFinding[] {
  const findings: CspFinding[] = [];
  for (const { path, content } of files) {
    const code = stripComments(content);
    for (const pattern of FORBIDDEN_CDN_PATTERNS) {
      if (code.includes(pattern)) {
        findings.push({
          kind: 'source',
          path,
          message: `runtime source references forbidden off-origin host "${pattern}" — vendor it to '/vendor' (CSP 'self')`,
        });
        break; // one finding per file is enough
      }
    }
  }
  return findings;
}

// ─── Repo wiring ──────────────────────────────────────────────────────────

/**
 * Resolve the repo root safely. Honors CSP_RUNTIME_REPO_ROOT but constrains it
 * (path-traversal hotspot pattern flagged elsewhere in this dir).
 */
function resolveRepoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  const def = resolve(here, '..', '..', '..'); // scripts/ci → repo root
  const override = process.env.CSP_RUNTIME_REPO_ROOT;
  if (!override) return def;
  const resolved = realpathSync(resolve(override));
  return resolved;
}

/** Extract the deployed CSP header value from vercel.json. */
export function loadDeployedCsp(repoRoot: string): string {
  const vercelPath = resolve(repoRoot, 'vercel.json');
  const json = JSON.parse(readFileSync(vercelPath, 'utf8')) as {
    headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  for (const block of json.headers ?? []) {
    for (const h of block.headers ?? []) {
      if (h.key.toLowerCase() === 'content-security-policy') {
        return h.value;
      }
    }
  }
  throw new Error('No Content-Security-Policy header found in vercel.json');
}

function readRuntimeSources(repoRoot: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  for (const rel of RUNTIME_DEP_SOURCES) {
    // Constrain to repo root (no traversal).
    const abs = resolve(repoRoot, rel);
    if (!abs.startsWith(repoRoot + sep)) continue;
    if (!existsSync(abs)) continue;
    files.push({ path: rel, content: readFileSync(abs, 'utf8') });
  }
  return files;
}

/** Full evaluation over the real repo: CSP checks + source scan. */
export function evaluateCspRuntimeDeps(repoRoot: string = resolveRepoRoot()): CspFinding[] {
  const csp = loadDeployedCsp(repoRoot);
  const directives = parseCspDirectives(csp);
  const cspFindings = cspAllowsSelfWasmEval(directives);
  const sourceFindings = scanSourceForForbiddenOrigins(readRuntimeSources(repoRoot));
  return [...cspFindings, ...sourceFindings];
}

function isMainModule(metaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && resolve(fileURLToPath(metaUrl)) === resolve(argvPath);
}

/** Whether the PR carries the deliberate-change override label. */
export function hasOverrideLabel(prLabelsEnv: string | undefined): boolean {
  if (!prLabelsEnv) return false;
  return prLabelsEnv
    .split(',')
    .map((l) => l.trim())
    .includes(OVERRIDE_LABEL);
}

function main(): void {
  if (hasOverrideLabel(process.env.PR_LABELS)) {
    console.log(`⏭️  CSP↔runtime-deps gate overridden by PR label \`${OVERRIDE_LABEL}\`.`);
    return;
  }
  const findings = evaluateCspRuntimeDeps();
  if (findings.length === 0) {
    console.log('✅ CSP↔runtime-deps: deployed CSP permits self-hosted OCR/NER/PDF runtimes; no off-origin runtime fetches.');
    return;
  }
  console.error(`::error::WEBEXT-04 CSP↔runtime-deps drift: ${findings.length} issue(s):`);
  for (const f of findings) {
    console.error(`  [${f.kind}] ${f.path ? f.path + ': ' : ''}${f.message}`);
  }
  console.error(`  (Override with PR label \`${OVERRIDE_LABEL}\` only for a deliberate, reviewed change.)`);
  process.exit(1);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error('::error::WEBEXT-04 CSP↔runtime-deps check failed to run.');
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
}
