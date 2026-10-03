import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('checks the real manual publisher with a controlled registry executable', () => {
  const result = spawnSync('bash', [resolve(import.meta.dirname, '../release/publish-npm.test.sh')], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? '' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('publish-npm exact-version admission: PASS');
}, 35_000);
