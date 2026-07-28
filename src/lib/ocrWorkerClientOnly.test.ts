/**
 * §1.6 client-side-only guard — `ocrWorker.ts` (and its F4 decode
 * dependencies `utif2` / `heic-decode` / `upng-js` / `pdfjs-dist` /
 * `tesseract.js`) MUST never be imported from `services/worker/`.
 *
 * Constitution 1.6: "Documents never leave the user's device." OCR/extraction
 * is a browser-only guarantee — `generateFingerprint` and the whole
 * `ocrWorker.ts` pipeline are explicitly barred from `services/worker/` per
 * the module header and `src/lib/agents.md`. F4 (2026-07-28) added three new
 * lazy-loaded decode dependencies (TIFF/HEIC/PNG-re-encode); this guard
 * covers them alongside the pre-existing PDF.js/Tesseract imports so a future
 * accidental server-side import of any client-only OCR dependency fails CI
 * instead of silently reintroducing a §1.6 violation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKER_SRC = join(REPO_ROOT, 'services', 'worker', 'src');

/** Import specifiers that must never appear in a `services/worker/src/**` file. */
const BANNED_SPECIFIERS = [
  'ocrWorker',
  'utif2',
  'heic-decode',
  'libheif-js',
  'upng-js',
  'pdfjs-dist',
  'tesseract.js',
] as const;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Does this line contain a real `import`/`require` of the specifier (not merely mentioning it in a comment/string unrelated to module resolution)? */
function importsSpecifier(content: string, specifier: string): boolean {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(from\\s+['"][^'"]*${escaped}[^'"]*['"]|require\\(\\s*['"][^'"]*${escaped}[^'"]*['"]\\s*\\)|import\\(\\s*['"][^'"]*${escaped}[^'"]*['"]\\s*\\))`,
  );
  return pattern.test(content);
}

describe('§1.6 guard: ocrWorker.ts + F4 decode deps never imported in services/worker/', () => {
  it('services/worker/src exists (sanity — a rename would silently no-op this guard)', () => {
    expect(() => statSync(WORKER_SRC)).not.toThrow();
    expect(statSync(WORKER_SRC).isDirectory()).toBe(true);
  });

  it('no services/worker/src file imports ocrWorker.ts or its client-only decode dependencies', () => {
    const files = walkTsFiles(WORKER_SRC);
    expect(files.length).toBeGreaterThan(0); // sanity — an empty scan would pass vacuously

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const specifier of BANNED_SPECIFIERS) {
        if (importsSpecifier(content, specifier)) {
          violations.push(`${file.slice(REPO_ROOT.length + 1)} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('services/worker/package.json declaring pdfjs-dist/tesseract.js as devDependencies has zero actual importers (orphaned, not a live violation)', () => {
    // Known pre-existing state (not introduced by F4): these two packages are
    // listed as devDependencies in services/worker/package.json but nothing
    // in services/worker/src imports them (verified by the test above). This
    // assertion documents that fact so a future importer trips the guard
    // above rather than this one silently going stale.
    const pkgRaw = readFileSync(join(REPO_ROOT, 'services', 'worker', 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { devDependencies?: Record<string, string> };
    const devDeps = pkg.devDependencies ?? {};
    expect(Object.keys(devDeps)).toEqual(expect.arrayContaining(['pdfjs-dist', 'tesseract.js']));
  });
});
