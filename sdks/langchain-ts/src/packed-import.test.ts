/**
 * Packed-tarball ESM import regression test.
 *
 * `@arkova/langchain` is ESM-only (`"type": "module"`, `module`/
 * `moduleResolution: "nodenext"`, `exports` map with only an `import`
 * condition — no `require`). That is a deliberate decision (2026-09-21
 * review, no dual CJS+ESM build this wave — see `agents.md`), but a
 * deliberate decision is only as good as its enforcement: importing the
 * SOURCE under vitest (which runs everything through its own ESM-aware
 * transform) proves nothing about what a real consumer gets from the
 * PUBLISHED tarball. This test builds fresh, packs the real tarball exactly
 * as `npm publish` would ship it, installs it into an empty temp project
 * (so Node resolves it exactly the way a real installed dependency would —
 * no monorepo hoisting or symlink shortcuts), and runs a real `node`
 * process that `import`s it. If the `exports` map or `package.json` ever
 * regresses to something `node` cannot resolve, this fails; running vitest
 * alone would not have caught it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let installDir: string;

beforeAll(() => {
  // Build + pack fresh so this exercises the actual shipped dist/, not a
  // stale one from a prior run.
  execFileSync('npm', ['run', 'build'], { cwd: packageRoot, stdio: 'pipe' });
  const packOutput = execFileSync('npm', ['pack', '--silent'], { cwd: packageRoot, encoding: 'utf8' });
  const tarballName = packOutput.trim().split('\n').at(-1)!;
  const tarballPath = join(packageRoot, tarballName);

  installDir = mkdtempSync(join(tmpdir(), 'arkova-langchain-pack-test-'));
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'pack-test', private: true }));
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', tarballPath], {
    cwd: installDir,
    stdio: 'pipe',
  });
  rmSync(tarballPath, { force: true });
}, 60_000);

afterAll(() => {
  if (installDir) rmSync(installDir, { recursive: true, force: true });
});

describe('packed tarball, real node process (not vitest)', () => {
  it('resolves and imports via a plain ESM `import` exactly as a real consumer would', () => {
    const script = [
      "import { getArkovaTools, ArkovaVerifyTool } from '@arkova/langchain';",
      "if (typeof getArkovaTools !== 'function') throw new Error('getArkovaTools missing from ESM import');",
      "if (typeof ArkovaVerifyTool !== 'function') throw new Error('ArkovaVerifyTool missing from ESM import');",
      "const tools = getArkovaTools({ apiKey: 'ak_test' });",
      "if (!Array.isArray(tools) || tools.length !== 6) throw new Error('expected 6 tools, got ' + (tools && tools.length));",
      "console.log('IMPORT_OK');",
    ].join('\n');
    const scriptPath = join(installDir, 'import-check.mjs');
    writeFileSync(scriptPath, script);

    const output = execFileSync('node', [scriptPath], { cwd: installDir, encoding: 'utf8' });
    expect(output).toContain('IMPORT_OK');
  });

  it('the packed exports map exposes only ESM conditions — no `require` entry point was ever built or tested as CJS', () => {
    const packedManifestPath = join(installDir, 'node_modules', '@arkova', 'langchain', 'package.json');
    const packedManifest = JSON.parse(readFileSync(packedManifestPath, 'utf8')) as {
      exports?: Record<string, unknown>;
      type?: string;
    };
    expect(packedManifest.type).toBe('module');
    expect(packedManifest.exports).toBeDefined();
    const rootExport = packedManifest.exports!['.'] as Record<string, string>;
    expect(Object.keys(rootExport).sort()).toEqual(['import', 'types']);
    expect(rootExport.require).toBeUndefined();
  });

  // 2026-09-21 independent-review correction: an earlier version of this file
  // asserted nothing about a LIVE `require()` call, reasoning that Node
  // >=22.12's native `require(esm)` interop might make `require()` of this
  // pure-ESM package transparently succeed — a claim the README also made
  // ("may transparently succeed"). Empirically wrong on Node 25.6.1 (and by
  // the exports-conditions algorithm, on every Node version): with an
  // `exports` map present that declares no `require` condition, Node's
  // exports-conditions resolver refuses the "." subpath for a `require()`
  // caller BEFORE the require(esm) interop is ever considered — interop only
  // engages for a bare ESM file with NO exports map restricting it, which is
  // not this package's shape. So `require()` does not "maybe" succeed here;
  // it reliably throws. This test asserts that reality directly, from the
  // real published tarball, so the README's prose and this package's actual
  // behavior cannot drift apart again the way they did this pass.
  it('a bare `require()` of the ESM-only package reliably throws — not "may transparently succeed"', () => {
    const script = [
      "try {",
      "  require('@arkova/langchain');",
      "  console.log('REQUIRE_UNEXPECTEDLY_SUCCEEDED');",
      "} catch (err) {",
      "  console.log('REQUIRE_FAILED code=' + err.code);",
      "}",
    ].join('\n');
    const scriptPath = join(installDir, 'require-check.cjs');
    writeFileSync(scriptPath, script);

    const output = execFileSync('node', [scriptPath], { cwd: installDir, encoding: 'utf8' });
    expect(output).not.toContain('REQUIRE_UNEXPECTEDLY_SUCCEEDED');
    expect(output).toContain('REQUIRE_FAILED code=ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});
