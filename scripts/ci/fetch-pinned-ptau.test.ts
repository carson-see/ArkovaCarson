import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, '../../services/worker/circuits/fetch-pinned-ptau.sh');

function fixture(): { dir: string; good: string; bad: string; sha: string; bin: string; curlArgs: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ptau-fetch-'));
  const good = join(dir, 'good');
  const bad = join(dir, 'bad');
  const bin = join(dir, 'bin');
  const curlArgs = join(dir, 'curl-args');
  writeFileSync(good, 'trusted exact ptau fixture');
  writeFileSync(bad, 'corrupt bytes');
  mkdirSync(bin);
  const curl = join(bin, 'curl');
  writeFileSync(curl, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$@" > "$CURL_ARGS_LOG"\nout=''\nurl=''\nwhile (($#)); do if [[ $1 == -o ]]; then out=$2; shift 2; elif [[ $1 == -* ]]; then shift; if [[ \${1:-} != -* && \${1:-} != *://* ]]; then shift; fi; else url=$1; shift; fi; done\ncase $url in fail://*) exit 22;; partial://*) printf partial > "$out"; exit 18;; file://*) cp "\${url#file://}" "$out";; *) exit 23;; esac\n`);
  chmodSync(curl, 0o755);
  return { dir, good, bad, bin, curlArgs, sha: createHash('sha256').update(readFileSync(good)).digest('hex') };
}

function run(f: ReturnType<typeof fixture>, mirror: string) {
  const destination = join(f.dir, 'artifacts', 'test.ptau');
  const result = spawnSync('bash', [script, destination], {
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, CURL_ARGS_LOG: f.curlArgs, PTAU_NAME: 'test.ptau', PTAU_SHA256: f.sha, PTAU_MIRROR_URL: mirror },
    encoding: 'utf8',
  });
  return { destination, result };
}

describe('pinned ptau fetch', () => {
  it('keeps redirects on HTTPS and never invokes an install-on-demand package runner', () => {
    const fetchSource = readFileSync(script, 'utf8');
    const buildSource = readFileSync(join(import.meta.dirname, '../../services/worker/circuits/build.sh'), 'utf8');
    expect(fetchSource).toContain("--proto '=https' --proto-redir '=https'");
    expect(buildSource).toContain("--proto '=https' --proto-redir '=https'");
    expect(buildSource).toContain('node_modules/.bin/snarkjs');
    expect(buildSource).not.toMatch(/\bnpx\b/);
  });

  it('uses the Arkova mirror when it returns the pinned bytes', () => {
    const f = fixture();
    const { destination, result } = run(f, `file://${f.good}`);
    expect(result.status).toBe(0);
    expect(readFileSync(destination)).toEqual(readFileSync(f.good));
    const args = readFileSync(f.curlArgs, 'utf8');
    expect(args).toContain('--connect-timeout\n10');
    expect(args).toContain('--max-time\n120');
    expect(args).toContain('--retry\n2');
    expect(args).toContain('--retry-max-time\n180');
  });

  it('reuses a hash-valid cached destination without a network attempt', () => {
    const f = fixture();
    const destination = join(f.dir, 'artifacts', 'test.ptau');
    mkdirSync(join(f.dir, 'artifacts'));
    writeFileSync(destination, readFileSync(f.good));
    const result = spawnSync('bash', [script, destination], {
      env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, CURL_ARGS_LOG: f.curlArgs, PTAU_NAME: 'test.ptau', PTAU_SHA256: f.sha, PTAU_MIRROR_URL: 'fail://mirror' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(existsSync(f.curlArgs)).toBe(false);
    expect(readFileSync(destination)).toEqual(readFileSync(f.good));
  });

  it('replaces a corrupt cached destination only after the mirror passes its hash', () => {
    const f = fixture();
    const destination = join(f.dir, 'artifacts', 'test.ptau');
    mkdirSync(join(f.dir, 'artifacts'));
    writeFileSync(destination, readFileSync(f.bad));
    const result = spawnSync('bash', [script, destination], {
      env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, CURL_ARGS_LOG: f.curlArgs, PTAU_NAME: 'test.ptau', PTAU_SHA256: f.sha, PTAU_MIRROR_URL: `file://${f.good}` },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(readFileSync(destination)).toEqual(readFileSync(f.good));
  });

  it('fails closed after mirror failure without exposing a partial destination', () => {
    const f = fixture();
    const { destination, result } = run(f, 'fail://mirror');
    expect(result.status).toBe(1);
    expect(() => readFileSync(destination)).toThrow();
  });

  it('removes an interrupted partial download and leaves no destination', () => {
    const f = fixture();
    const { destination, result } = run(f, 'partial://mirror');
    expect(result.status).toBe(1);
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(join(f.dir, 'artifacts'))).toEqual([]);
  });

  it('rejects corrupt mirror bytes and leaves no destination', () => {
    const f = fixture();
    const { destination, result } = run(f, `file://${f.bad}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SHA-256 mismatch');
    expect(() => readFileSync(destination)).toThrow();
  });
});
