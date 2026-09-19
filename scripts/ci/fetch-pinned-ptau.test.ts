import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, '../../services/worker/circuits/fetch-pinned-ptau.sh');

function fixture(): { dir: string; good: string; bad: string; sha: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ptau-fetch-'));
  const good = join(dir, 'good');
  const bad = join(dir, 'bad');
  const bin = join(dir, 'bin');
  writeFileSync(good, 'trusted exact ptau fixture');
  writeFileSync(bad, 'corrupt bytes');
  mkdirSync(bin);
  const curl = join(bin, 'curl');
  writeFileSync(curl, `#!/usr/bin/env bash\nset -euo pipefail\nout=''\nwhile (($#)); do if [[ $1 == -o ]]; then out=$2; shift 2; else url=$1; shift; fi; done\ncase $url in fail://*) exit 22;; file://*) cp "\${url#file://}" "$out";; *) exit 23;; esac\n`);
  chmodSync(curl, 0o755);
  return { dir, good, bad, bin, sha: createHash('sha256').update(readFileSync(good)).digest('hex') };
}

function run(f: ReturnType<typeof fixture>, mirror: string, upstream: string) {
  const destination = join(f.dir, 'artifacts', 'test.ptau');
  const result = spawnSync('bash', [script, destination], {
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, PTAU_NAME: 'test.ptau', PTAU_SHA256: f.sha, PTAU_MIRROR_URL: mirror, PTAU_UPSTREAM_URL: upstream },
    encoding: 'utf8',
  });
  return { destination, result };
}

describe('pinned ptau fetch', () => {
  it('uses the Arkova mirror when it returns the pinned bytes', () => {
    const f = fixture();
    const { destination, result } = run(f, `file://${f.good}`, 'fail://upstream');
    expect(result.status).toBe(0);
    expect(readFileSync(destination)).toEqual(readFileSync(f.good));
  });

  it('falls back after mirror failure without exposing a partial destination', () => {
    const f = fixture();
    const { destination, result } = run(f, 'fail://mirror', `file://${f.good}`);
    expect(result.status).toBe(0);
    expect(readFileSync(destination)).toEqual(readFileSync(f.good));
  });

  it('rejects corrupt mirror bytes and accepts only a hash-matching fallback', () => {
    const f = fixture();
    const { destination, result } = run(f, `file://${f.bad}`, `file://${f.good}`);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('SHA-256 mismatch');
    expect(readFileSync(destination)).toEqual(readFileSync(f.good));
  });

  it('fails closed and leaves no destination when every source is invalid', () => {
    const f = fixture();
    const { destination, result } = run(f, `file://${f.bad}`, 'fail://upstream');
    expect(result.status).toBe(1);
    expect(() => readFileSync(destination)).toThrow();
  });
});
