import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('built arkova binary', () => {
  it('prints machine-readable help through the package bin target', () => {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), '--help'], {
      cwd: resolve('.'), encoding: 'utf8', env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ command: 'arkova', output: 'json' });
  });
});
