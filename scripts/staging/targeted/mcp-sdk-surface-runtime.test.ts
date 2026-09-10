// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmPackAndInstall, runPySdkSmoke, resolveInstalledTool, selectPythonSdist } from './mcp-sdk-surface-driver';
import { newDriverStats, summarizeEvidence } from './driver-core';

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-runtime-test-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MCP SDK qualification runtime', () => {
  it('refuses to package stale dist after a failed build', () => {
    const root = tempRoot();
    const pkg = join(root, 'package');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
      name: 'stale-sdk-qualification-test', version: '1.0.0',
      scripts: { build: 'node -e "process.exit(17)"' },
    }));
    writeFileSync(join(pkg, 'index.js'), 'module.exports = "stale";');
    expect(() => npmPackAndInstall(pkg, join(root, 'installed'), () => {})).toThrow();
  }, 15_000);

  it('packs a fresh build without rerunning noisy prepack hooks inside JSON output', () => {
    const root = tempRoot();
    const pkg = join(root, 'package');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
      name: 'fresh-sdk-qualification-test', version: '1.0.0',
      scripts: { build: 'node -e "process.exit(0)"', prepack: 'node -e "console.log(123)"' },
    }));
    writeFileSync(join(pkg, 'index.js'), 'module.exports = "fresh";');
    expect(npmPackAndInstall(pkg, join(root, 'installed'), () => {}).pkgName).toBe('fresh-sdk-qualification-test');
  }, 15_000);

  it('requires absolute tool paths and refuses a broken explicit override without falling back', () => {
    expect(resolveInstalledTool(process.execPath, [], 'test')).toBe(process.execPath);
    expect(() => resolveInstalledTool('node', [process.execPath], 'test')).toThrow(/absolute path/);
    expect(() => resolveInstalledTool('/missing/mcp-runtime-tool', [process.execPath], 'test')).toThrow(/accessible file/);
    expect(() => resolveInstalledTool(undefined, [], 'test')).toThrow(/explicit absolute path/);
  });

  it('selects one actual Python artifact without interpreting shell metacharacters', () => {
    const root = tempRoot();
    const oddDir = join(root, 'space $(not-a-command) `literal`');
    mkdirSync(oddDir);
    expect(() => selectPythonSdist(oddDir)).toThrow(/exactly one sdist/);
    const sdist = join(oddDir, 'arkova-1.0.tar.gz');
    writeFileSync(sdist, 'synthetic');
    mkdirSync(join(oddDir, 'not-a-file.tar.gz'));
    expect(selectPythonSdist(oddDir)).toBe(sdist);
    writeFileSync(join(oddDir, 'stale-0.1.tar.gz'), 'stale');
    expect(() => selectPythonSdist(oddDir)).toThrow(/exactly one sdist/);
  });

  it('allows the Python child to reach its in-process IAM proxy without exposing credentials in argv', async () => {
    const root = tempRoot();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const apiKey = 'synthetic-sdk-test-key';
    const requests: string[] = [];
    const auth: unknown[] = [];
    const upstream = createServer((req, res) => {
      requests.push(req.url ?? '');
      auth.push({ app: req.headers.authorization, iam: req.headers['x-serverless-authorization'] });
      const body = gzipSync('{}');
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': body.length });
      res.end(body);
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('missing upstream address');
    // A real subprocess with the same command interface as Python; no Python SDK installation is needed.
    writeFileSync(join(bin, 'python3'), `#!${process.execPath}\n` + [
      'const script = process.argv[3];',
      'const url = process.env.ARKOVA_SMOKE_BASE_URL || /base_url="([^"]+)"/.exec(script)?.[1];',
      'fetch(url + "/api/v1/verify/ARK-FIXTURE", {headers: {authorization: "Bearer " + process.env.ARKOVA_SMOKE_API_KEY}}).then(async r => {',
      '  await r.json();',
      '  if (!r.ok || script.includes("synthetic-sdk-test-key")) process.exit(9);',
      '  console.log(JSON.stringify({ok: true}).replace(":true", ": true"));',
      '}).catch(() => process.exit(10));',
    ].join('\n'), { mode: 0o700 });
    vi.stubEnv('STAGING_GCP_IDENTITY', 'synthetic-identity');
    const stats = newDriverStats();
    try {
      await runPySdkSmoke({ stats, pyPkgDir: '', venvDir: root, apiKey,
        apiBase: `http://127.0.0.1:${address.port}`,
        fx: { publicId: 'ARK-FIXTURE', fingerprint: 'a'.repeat(64), searchTerm: 'synthetic' }, log: () => {},
      });
      expect(requests).toEqual(['/api/v1/verify/ARK-FIXTURE']);
      expect(auth).toEqual([{ app: `Bearer ${apiKey}`, iam: 'Bearer synthetic-identity' }]);
      expect(summarizeEvidence(stats, { driver: 'test', pr: '#2589', apiBase: 'synthetic' }).allExpected).toBe(true);
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
    }
  }, 40_000);
});
