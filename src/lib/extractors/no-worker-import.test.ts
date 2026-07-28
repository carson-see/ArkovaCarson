/**
 * Constitution §1.6 client-side processing boundary guard.
 *
 * `services/worker/` must NEVER import the client-side-only document
 * extraction modules (`ocrWorker.ts` and the F2/F3 extractors added under
 * `src/lib/extractors/`) — these run entirely in the browser, and the
 * whole point is that user-uploaded document bytes never reach the server.
 * This is a static, repo-wide source scan (not a mocked unit test) so it
 * catches a future accidental import, not just today's state.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const WORKER_SRC = path.join(REPO_ROOT, 'services/worker/src');

/** Base names of the client-side-only extraction modules — never importable from services/worker/. */
const GUARDED_MODULE_BASENAMES = [
  'ocrWorker',
  'zipXmlExtract',
  'rtfExtract',
  'svgExtract',
];

const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (CODE_FILE_RE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Matches `from '...basename...'` / `require('...basename...')` / `import('...basename...')` for a given module basename. */
function importsModule(content: string, basename: string): boolean {
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:from|require|import)\\s*\\(?\\s*['"][^'"]*${escaped}(?:\\.[jt]sx?)?['"]`);
  return re.test(content);
}

describe('§1.6 client-side boundary — services/worker never imports the client-side extraction modules', () => {
  it('finds services/worker/src to scan', () => {
    expect(statSync(WORKER_SRC).isDirectory()).toBe(true);
  });

  it('scans every worker source file for a forbidden import', () => {
    const files = walk(WORKER_SRC);
    expect(files.length).toBeGreaterThan(0); // sanity: the scan itself must find files

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      for (const basename of GUARDED_MODULE_BASENAMES) {
        if (importsModule(content, basename)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} imports "${basename}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('sanity check: the guard regex actually detects a forbidden import shape', () => {
    expect(importsModule(`import { extractText } from '../../../src/lib/ocrWorker';`, 'ocrWorker')).toBe(true);
    expect(importsModule(`const x = await import('../lib/extractors/zipXmlExtract');`, 'zipXmlExtract')).toBe(true);
    expect(importsModule(`import { something } from './unrelatedModule';`, 'ocrWorker')).toBe(false);
  });
});
