#!/usr/bin/env node
/**
 * scripts/vendor-ner-runtime.ts — vendor + integrity-verify the on-device NER
 * RUNTIME: the self-contained transformers.js browser bundle and the
 * onnxruntime WASM artifacts it fetches at runtime.
 *
 * WEBEXT-01 F-1/F-2 fix (gate #13, §1.6). The 2026-07-06 re-gate (PR #1409)
 * proved two runtime breaks:
 *
 *   F-1: the previously vendored `transformers.web.min.js` (the package's
 *        `.web.` build) carries TOP-LEVEL BARE SPECIFIERS
 *        (`onnxruntime-web/webgpu`, `onnxruntime-common`). Production loads
 *        the bundle via NATIVE browser `import('/vendor/...')` — a browser
 *        cannot link bare specifiers without an import map, so module linking
 *        threw `TypeError: Failed to resolve module specifier` on EVERY load
 *        (weights present or not, CSP irrelevant). Fix: vendor the package's
 *        SELF-CONTAINED browser build (`dist/transformers.min.js`, ort inlined,
 *        zero bare specifiers) as `public/vendor/transformers.bundle.min.js`.
 *
 *   F-2: once the bundle links, onnxruntime-web defaults `wasmPaths` to a
 *        jsdelivr CDN URL when unset — blocked by the deployed CSP
 *        (`connect-src 'self'`). Fix: vendor the ort WASM artifacts the pinned
 *        bundle requests (the asyncify flavor: `.wasm` + `.mjs`) under
 *        `public/vendor/ort/` and pin `env.backends.onnx.wasm.wasmPaths`
 *        to `/vendor/ort/` in src/lib/nerPiiDetector.ts BEFORE any session
 *        creation.
 *
 * Integrity (same contract as scripts/fetch-ner-model.ts for the weights):
 * every artifact is copied from the EXACT npm-pinned package in node_modules
 * (build-time — no runtime CDN), SHA-256 + byte-length verified against the
 * committed lockfile scripts/ner-runtime.lock.json, and any mismatch exits
 * NON-ZERO (fail the build closed). The bundle is additionally refused if it
 * contains bare/off-origin module specifiers — the F-1 class can never be
 * re-vendored silently. CI enforces the same on the committed artifact via
 * scripts/ci/check-csp-runtime-deps.ts + scripts/vendor-ner-runtime.test.ts.
 *
 * The bundle (~0.5 MB) is COMMITTED under public/vendor/ (like the Tesseract
 * runtime); the ort WASM artifacts (~24 MB) are git-ignored
 * (`public/vendor/ort/`) and re-vendored at build time via `npm run prebuild`.
 *
 * Usage:
 *   npx tsx scripts/vendor-ner-runtime.ts                # vendor + verify (fail-closed)
 *   npx tsx scripts/vendor-ner-runtime.ts --check        # verify vendored files on disk only (no copy)
 *   npx tsx scripts/vendor-ner-runtime.ts --update-lock  # MAINTAINER: recompute + REWRITE the lockfile from node_modules
 *
 * Exit 0 on success, 1 on any failure (so CI/build can gate on it).
 */

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from './fetch-ner-model';
import { scanVendoredEsmForBareSpecifiers } from './ci/check-csp-runtime-deps';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
export const RUNTIME_LOCKFILE_PATH = join(__dirname, 'ner-runtime.lock.json');

export interface RuntimeLockedFile {
  sha256: string;
  bytes: number;
  /** Source path inside node_modules (package-relative, e.g. `onnxruntime-web/dist/x.wasm`). */
  source: string;
}

export interface RuntimeLock {
  /** Must equal TRANSFORMERS_JS_VERSION + ner-weights.lock.json transformersJsVersion. */
  transformersJsVersion: string;
  /** Must equal the exact onnxruntime-web version @huggingface/transformers pins. */
  onnxruntimeWebVersion: string;
  /** Keyed by repo-relative DESTINATION (must live under public/vendor/). */
  files: Record<string, RuntimeLockedFile>;
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const updateLock = args.includes('--update-lock');

/** Fail-closed structural validation of the lock. Throws on any problem. */
export function validateRuntimeLock(lock: RuntimeLock): void {
  if (!lock || typeof lock !== 'object') throw new Error('Malformed runtime lock: not an object');
  if (!lock.transformersJsVersion || typeof lock.transformersJsVersion !== 'string') {
    throw new Error('Malformed runtime lock: missing transformersJsVersion');
  }
  if (!lock.onnxruntimeWebVersion || typeof lock.onnxruntimeWebVersion !== 'string') {
    throw new Error('Malformed runtime lock: missing onnxruntimeWebVersion');
  }
  if (!lock.files || typeof lock.files !== 'object' || Object.keys(lock.files).length === 0) {
    throw new Error('Malformed runtime lock: missing/empty files map');
  }
  for (const [dest, f] of Object.entries(lock.files)) {
    if (dest.includes('..') || (f.source ?? '').includes('..')) {
      throw new Error(`Runtime lock entry '${dest}': path traversal ('..') is forbidden`);
    }
    if (!dest.startsWith('public/vendor/')) {
      throw new Error(`Runtime lock entry '${dest}': destination must live under public/vendor/`);
    }
    if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? '')) {
      throw new Error(`Runtime lock entry '${dest}': sha256 must be 64 lowercase hex chars`);
    }
    if (!Number.isInteger(f.bytes) || f.bytes <= 0) {
      throw new Error(`Runtime lock entry '${dest}': bytes must be a positive integer`);
    }
    if (!f.source || typeof f.source !== 'string') {
      throw new Error(`Runtime lock entry '${dest}': missing node_modules source path`);
    }
  }
}

export async function readRuntimeLock(lockPath: string = RUNTIME_LOCKFILE_PATH): Promise<RuntimeLock> {
  const raw = await readFile(lockPath, 'utf8');
  const lock = JSON.parse(raw) as RuntimeLock;
  validateRuntimeLock(lock);
  return lock;
}

/** Verify a buffer against the locked hash + byte length. Returns an error string or null. */
export function verifyRuntimeBuffer(dest: string, locked: RuntimeLockedFile, buf: Buffer): string | null {
  if (buf.byteLength !== locked.bytes) {
    return `${dest}: byte length ${buf.byteLength} != locked ${locked.bytes}`;
  }
  const got = sha256(buf);
  if (got !== locked.sha256) {
    return `${dest}: SHA-256 ${got} != locked ${locked.sha256}`;
  }
  return null;
}

function srcPath(locked: RuntimeLockedFile): string {
  return join(REPO_ROOT, 'node_modules', locked.source);
}

function destAbs(dest: string): string {
  return join(REPO_ROOT, dest);
}

async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size === 0) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * F-1 gate at vendoring time: refuse to vendor (or lock) an ESM bundle that a
 * browser cannot link same-origin. Returns error strings (empty = clean).
 */
export function bareSpecifierProblems(dest: string, buf: Buffer): string[] {
  if (!/\.(js|mjs)$/.test(dest)) return [];
  const findings = scanVendoredEsmForBareSpecifiers([{ path: dest, content: buf.toString('utf8') }]);
  return findings.map((f) => f.message);
}

async function readInstalledVersion(pkg: string): Promise<string | null> {
  try {
    const raw = await readFile(join(REPO_ROOT, 'node_modules', pkg, 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** Verify the installed package versions match the lock's pins. */
async function verifyPackageVersions(lock: RuntimeLock): Promise<string[]> {
  const problems: string[] = [];
  const tf = await readInstalledVersion('@huggingface/transformers');
  if (tf !== lock.transformersJsVersion) {
    problems.push(`@huggingface/transformers installed=${tf ?? 'MISSING'} != locked ${lock.transformersJsVersion}`);
  }
  const ort = await readInstalledVersion('onnxruntime-web');
  if (ort !== lock.onnxruntimeWebVersion) {
    problems.push(`onnxruntime-web installed=${ort ?? 'MISSING'} != locked ${lock.onnxruntimeWebVersion}`);
  }
  return problems;
}

/** --check: verify vendored files on disk against the lock; no copying. */
async function runCheck(lock: RuntimeLock): Promise<number> {
  let problems = 0;
  for (const [dest, locked] of Object.entries(lock.files)) {
    const buf = await readIfExists(destAbs(dest));
    if (!buf) {
      console.error(`✗ ${dest} (MISSING — run: npx tsx scripts/vendor-ner-runtime.ts)`);
      problems++;
      continue;
    }
    const err = verifyRuntimeBuffer(dest, locked, buf);
    if (err) {
      console.error(`✗ ${dest} (${err})`);
      problems++;
      continue;
    }
    const bare = bareSpecifierProblems(dest, buf);
    if (bare.length > 0) {
      for (const b of bare) console.error(`✗ ${dest}: ${b}`);
      problems += bare.length;
      continue;
    }
    console.log(`✓ ${dest} (hash verified)`);
  }
  if (problems > 0) {
    console.error(`\n${problems} runtime artifact problem(s).`);
    return 1;
  }
  console.log('\nAll NER runtime artifacts present + hash-verified + browser-linkable.');
  return 0;
}

/**
 * --update-lock: MAINTAINER flow. Recompute every entry's hash from the
 * installed node_modules source, copy into public/vendor/, and REWRITE the
 * lockfile. The bare-specifier gate still applies — a broken bundle can never
 * be locked. Use after bumping the @huggingface/transformers pin (then review
 * the diff + re-soak: PII-detection runtime changes).
 */
async function runUpdateLock(lock: RuntimeLock): Promise<number> {
  console.log('Updating ner-runtime.lock.json from node_modules …');
  const tf = await readInstalledVersion('@huggingface/transformers');
  const ort = await readInstalledVersion('onnxruntime-web');
  if (!tf || !ort) {
    console.error('✗ @huggingface/transformers / onnxruntime-web not installed — run npm ci first.');
    return 1;
  }
  const nextFiles: Record<string, RuntimeLockedFile> = {};
  for (const [dest, locked] of Object.entries(lock.files)) {
    const buf = await readIfExists(srcPath(locked));
    if (!buf) {
      console.error(`✗ ${dest} — source missing: node_modules/${locked.source}`);
      return 1;
    }
    const bare = bareSpecifierProblems(dest, buf);
    if (bare.length > 0) {
      for (const b of bare) console.error(`✗ REFUSING TO LOCK ${dest}: ${b}`);
      return 1;
    }
    const abs = destAbs(dest);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    nextFiles[dest] = { sha256: sha256(buf), bytes: buf.byteLength, source: locked.source };
    console.log(`✓ ${dest} → sha256 ${nextFiles[dest].sha256} (${buf.byteLength} bytes)`);
  }
  const raw = JSON.parse(await readFile(RUNTIME_LOCKFILE_PATH, 'utf8')) as Record<string, unknown>;
  raw.transformersJsVersion = tf;
  raw.onnxruntimeWebVersion = ort;
  raw.files = nextFiles;
  await writeFile(RUNTIME_LOCKFILE_PATH, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`\nLockfile rewritten: ${RUNTIME_LOCKFILE_PATH}. Review the diff + re-soak before merging.`);
  return 0;
}

/** Default: vendor every artifact from node_modules, verifying against the lock (fail-closed). */
async function runVendor(lock: RuntimeLock): Promise<number> {
  let failed = 0;

  for (const problem of await verifyPackageVersions(lock)) {
    console.error(`✗ ${problem}`);
    failed++;
  }
  if (failed > 0) {
    console.error('\nInstalled package versions do not match the lock — refusing to vendor.');
    return 1;
  }

  for (const [dest, locked] of Object.entries(lock.files)) {
    const abs = destAbs(dest);

    // Idempotent: already present AND matching → skip.
    const existing = await readIfExists(abs);
    if (existing && verifyRuntimeBuffer(dest, locked, existing) === null) {
      console.log(`✓ ${dest} (present, hash verified — skipping)`);
      continue;
    }

    const buf = await readIfExists(srcPath(locked));
    if (!buf) {
      console.error(`✗ ${dest} — source missing: node_modules/${locked.source} (run npm ci)`);
      failed++;
      continue;
    }
    const err = verifyRuntimeBuffer(dest, locked, buf);
    if (err) {
      // NEVER write an unverified artifact into the served dir.
      console.error(`✗ INTEGRITY FAILURE — ${err}\n  source: node_modules/${locked.source}`);
      failed++;
      continue;
    }
    const bare = bareSpecifierProblems(dest, buf);
    if (bare.length > 0) {
      for (const b of bare) console.error(`✗ REFUSING TO VENDOR ${dest}: ${b}`);
      failed++;
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    const mb = (buf.byteLength / (1024 * 1024)).toFixed(2);
    console.log(`✓ ${dest} (${mb} MB, hash verified)`);
  }

  if (failed > 0) {
    console.error(`\n${failed} runtime artifact(s) failed vendoring/verification — build must fail closed.`);
    return 1;
  }
  console.log(
    '\nDone. NER runtime vendored + hash-verified under public/vendor/ ' +
      '(bundle committed; ort WASM git-ignored, rebuilt each prebuild). ' +
      'Runtime loads module code + WASM from the app origin only.',
  );
  return 0;
}

export async function main(): Promise<number> {
  const lock = await readRuntimeLock();
  console.log(
    `NER runtime: transformers.js ${lock.transformersJsVersion} (self-contained browser bundle) ` +
      `+ onnxruntime-web ${lock.onnxruntimeWebVersion} WASM\n`,
  );
  if (updateLock) return runUpdateLock(lock);
  if (checkOnly) return runCheck(lock);
  return runVendor(lock);
}

// Run only when executed directly, NOT when imported by the test module.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Unexpected error:', err);
      process.exit(1);
    });
}
