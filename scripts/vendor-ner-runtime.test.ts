/**
 * Tests for scripts/vendor-ner-runtime.ts — the WEBEXT-01 F-1/F-2 fix's
 * build-time vendoring + integrity gate for the on-device NER RUNTIME
 * (self-contained transformers.js browser bundle + same-origin ort WASM).
 *
 * §1.6: the runtime bundle and the ort WASM binaries are privacy-critical —
 * they are the code that decides what counts as PII before anything leaves
 * the browser. Same contract as scripts/fetch-ner-model.ts for the weights:
 * every vendored artifact is SHA-256 + byte-length verified against a
 * committed lockfile (scripts/ner-runtime.lock.json) and any mismatch fails
 * the build CLOSED (non-zero exit). Additionally the bundle is refused if it
 * contains bare/off-origin module specifiers (the F-1 dead-on-arrival class).
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RUNTIME_LOCKFILE_PATH,
  readRuntimeLock,
  validateRuntimeLock,
  verifyRuntimeBuffer,
  type RuntimeLock,
} from './vendor-ner-runtime';
import { sha256 } from './fetch-ner-model';
import {
  ORT_WASM_VENDOR_PATH,
  TRANSFORMERS_BROWSER_MODULE,
  TRANSFORMERS_JS_VERSION,
} from '../src/lib/nerPiiDetector';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function goodLock(): RuntimeLock {
  return {
    transformersJsVersion: '4.2.0',
    onnxruntimeWebVersion: '1.26.0-dev.20260416-b7804b056c',
    files: {
      'public/vendor/transformers.bundle.min.js': {
        sha256: 'a'.repeat(64),
        bytes: 10,
        source: '@huggingface/transformers/dist/transformers.min.js',
      },
    },
  };
}

describe('validateRuntimeLock (fail-closed lock parsing)', () => {
  it('accepts a well-formed lock', () => {
    expect(() => validateRuntimeLock(goodLock())).not.toThrow();
  });

  it('rejects a lock missing the pinned runtime versions', () => {
    const lock = goodLock() as unknown as Record<string, unknown>;
    delete lock.transformersJsVersion;
    expect(() => validateRuntimeLock(lock as unknown as RuntimeLock)).toThrow(/transformersJsVersion/);
    const lock2 = goodLock() as unknown as Record<string, unknown>;
    delete lock2.onnxruntimeWebVersion;
    expect(() => validateRuntimeLock(lock2 as unknown as RuntimeLock)).toThrow(/onnxruntimeWebVersion/);
  });

  it('rejects a destination outside public/vendor/ (no vendored artifact may escape the served dir)', () => {
    const lock = goodLock();
    lock.files['src/lib/evil.js'] = {
      sha256: 'b'.repeat(64),
      bytes: 5,
      source: '@huggingface/transformers/dist/transformers.min.js',
    };
    expect(() => validateRuntimeLock(lock)).toThrow(/public\/vendor/);
  });

  it('rejects path traversal in dest or source', () => {
    const lock = goodLock();
    lock.files['public/vendor/../../etc/passwd'] = {
      sha256: 'c'.repeat(64),
      bytes: 5,
      source: '@huggingface/transformers/dist/transformers.min.js',
    };
    expect(() => validateRuntimeLock(lock)).toThrow(/traversal|\.\./);

    const lock2 = goodLock();
    lock2.files['public/vendor/x.js'] = {
      sha256: 'd'.repeat(64),
      bytes: 5,
      source: '../outside/node_modules-escape.js',
    };
    expect(() => validateRuntimeLock(lock2)).toThrow(/traversal|\.\./);
  });

  it('rejects a malformed sha256 or non-positive byte length', () => {
    const lock = goodLock();
    lock.files['public/vendor/transformers.bundle.min.js'].sha256 = 'not-a-hash';
    expect(() => validateRuntimeLock(lock)).toThrow(/sha256/i);

    const lock2 = goodLock();
    lock2.files['public/vendor/transformers.bundle.min.js'].bytes = 0;
    expect(() => validateRuntimeLock(lock2)).toThrow(/bytes/i);
  });
});

describe('verifyRuntimeBuffer (integrity gate)', () => {
  const locked = { sha256: sha256(Buffer.from('hello')), bytes: 5, source: 's' };

  it('returns null when hash + byte length match', () => {
    expect(verifyRuntimeBuffer('f.js', locked, Buffer.from('hello'))).toBeNull();
  });

  it('reports a byte-length mismatch', () => {
    expect(verifyRuntimeBuffer('f.js', locked, Buffer.from('hello!'))).toMatch(/byte length/);
  });

  it('reports a SHA-256 mismatch (same length, different content)', () => {
    expect(verifyRuntimeBuffer('f.js', locked, Buffer.from('hellp'))).toMatch(/SHA-256/);
  });
});

describe('the committed ner-runtime.lock.json (integration)', () => {
  it('exists, parses, and pins the same transformers.js version as the loader + weights lock', async () => {
    const lock = await readRuntimeLock(RUNTIME_LOCKFILE_PATH);
    expect(lock.transformersJsVersion).toBe(TRANSFORMERS_JS_VERSION);

    const weightsLock = JSON.parse(
      readFileSync(join(__dirname, 'ner-weights.lock.json'), 'utf8'),
    ) as { transformersJsVersion?: string };
    expect(lock.transformersJsVersion).toBe(weightsLock.transformersJsVersion);
  });

  it('pins the exact onnxruntime-web version @huggingface/transformers depends on', async () => {
    const lock = await readRuntimeLock(RUNTIME_LOCKFILE_PATH);
    const transformersPkg = JSON.parse(
      readFileSync(
        join(REPO_ROOT, 'node_modules', '@huggingface', 'transformers', 'package.json'),
        'utf8',
      ),
    ) as { dependencies?: Record<string, string> };
    expect(lock.onnxruntimeWebVersion).toBe(transformersPkg.dependencies?.['onnxruntime-web']);
  });

  it('locks the runtime bundle at the path the loader imports', async () => {
    const lock = await readRuntimeLock(RUNTIME_LOCKFILE_PATH);
    const bundleDest = `public${TRANSFORMERS_BROWSER_MODULE}`;
    expect(Object.keys(lock.files)).toContain(bundleDest);
    // Source must be the package's SELF-CONTAINED browser build, not the
    // bare-specifier `.web.` build (F-1).
    expect(lock.files[bundleDest].source).toBe(
      '@huggingface/transformers/dist/transformers.min.js',
    );
  });

  it('locks ort WASM artifacts under the loader-pinned vendor path (F-2)', async () => {
    const lock = await readRuntimeLock(RUNTIME_LOCKFILE_PATH);
    const ortDests = Object.keys(lock.files).filter((d) =>
      d.startsWith(`public${ORT_WASM_VENDOR_PATH}`),
    );
    // The pinned 4.2.0 bundle requests the asyncify flavor: .wasm + .mjs.
    expect(ortDests.some((d) => d.endsWith('.wasm'))).toBe(true);
    expect(ortDests.some((d) => d.endsWith('.mjs'))).toBe(true);
    for (const d of ortDests) {
      expect(lock.files[d].source.startsWith('onnxruntime-web/dist/')).toBe(true);
    }
  });

  it('the COMMITTED runtime bundle is byte-exact against the lock (tamper gate)', async () => {
    const lock = await readRuntimeLock(RUNTIME_LOCKFILE_PATH);
    const bundleDest = `public${TRANSFORMERS_BROWSER_MODULE}`;
    const buf = readFileSync(join(REPO_ROOT, bundleDest));
    expect(verifyRuntimeBuffer(bundleDest, lock.files[bundleDest], buf)).toBeNull();
  });

  it('ort WASM artifacts on disk (when vendored) are byte-exact against the lock', async () => {
    // public/vendor/ort/ is git-ignored and populated by `npm run prebuild`
    // (this script). In a fresh checkout the files may be absent — the BUILD
    // fails closed in that case; here we assert integrity when present.
    const lock = await readRuntimeLock(RUNTIME_LOCKFILE_PATH);
    for (const [dest, locked] of Object.entries(lock.files)) {
      const abs = join(REPO_ROOT, dest);
      if (!existsSync(abs)) continue;
      expect(verifyRuntimeBuffer(dest, locked, readFileSync(abs))).toBeNull();
    }
  });
});
