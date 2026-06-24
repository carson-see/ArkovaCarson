/**
 * Vendored transformers.js ↔ integrity-lock VERSION-SKEW guard (SCRUM-2503 / WEBEXT-CSP).
 *
 * §1.6: the vendored browser bundle at `public/vendor/transformers.web.min.js`
 * is what actually resolves the on-device NER model files at runtime. The
 * SHA-256 integrity lockfile (scripts/ner-weights.lock.json `transformersJsVersion`)
 * was built for the EXACT file set THAT transformers.js version requests for
 * `Xenova/bert-base-NER` in q8. If the vendored bundle and the lock drift — e.g.
 * the bundle is 4.1.0 but the lock + loader are pinned to 4.2.0 — runtime model
 * loading can break (or resolve files the lock never covered) while CI stays
 * green. This test makes that skew a hard, build-time failure so it can NEVER
 * recur silently. It needs no network and never loads the model.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readLock, LOCKFILE_PATH } from './fetch-ner-model';
import { TRANSFORMERS_JS_VERSION } from '../src/lib/nerPiiDetector';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_BUNDLE = join(__dirname, '..', 'public', 'vendor', 'transformers.web.min.js');

/**
 * Resolve the SemVer version embedded in a minified transformers.js bundle.
 *
 * The bundle exposes its version on the public env API as `version:<ident>`,
 * where `<ident>` is a minified const assigned the version literal
 * (e.g. `$k="4.2.0"`). The const NAME is minifier-dependent and changes between
 * builds (4.1.0 → `Ck`, 4.2.0 → `$k`), so we follow the `version:` reference to
 * the literal rather than grepping a fixed identifier. Returns the version
 * string (e.g. `4.2.0`), or null if it can't be resolved.
 */
export function extractBundleVersion(src: string): string | null {
  const ref = src.match(/version:\s*([A-Za-z_$][\w$]*)/);
  if (!ref) return null;
  const ident = ref[1].replace(/[$]/g, '\\$&');
  const lit = src.match(new RegExp(`${ident}\\s*=\\s*"(\\d+\\.\\d+\\.\\d+)"`));
  return lit ? lit[1] : null;
}

describe('vendored transformers.js version ↔ integrity lock (SCRUM-2503)', () => {
  it('resolves a SemVer version from the vendored browser bundle', () => {
    const src = readFileSync(VENDOR_BUNDLE, 'utf8');
    const version = extractBundleVersion(src);
    expect(version, 'could not resolve a version string from the vendored bundle').not.toBeNull();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('vendored bundle version === the integrity lock transformersJsVersion', async () => {
    const src = readFileSync(VENDOR_BUNDLE, 'utf8');
    const bundleVersion = extractBundleVersion(src);
    const lock = await readLock(LOCKFILE_PATH);
    expect(lock.transformersJsVersion, 'lockfile must pin transformersJsVersion').toBeDefined();
    // THE skew guard: a vendored bundle whose version differs from the lock's
    // pinned version may request a different file set than the lock covers.
    expect(bundleVersion).toBe(lock.transformersJsVersion);
  });

  it('vendored bundle version === the loader-pinned TRANSFORMERS_JS_VERSION', () => {
    const src = readFileSync(VENDOR_BUNDLE, 'utf8');
    const bundleVersion = extractBundleVersion(src);
    expect(bundleVersion).toBe(TRANSFORMERS_JS_VERSION);
  });

  it('loader-pinned constant === the integrity lock transformersJsVersion', async () => {
    const lock = await readLock(LOCKFILE_PATH);
    expect(TRANSFORMERS_JS_VERSION).toBe(lock.transformersJsVersion);
  });
});
