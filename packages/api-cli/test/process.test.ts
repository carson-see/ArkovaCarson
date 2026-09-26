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
    const help = JSON.parse(result.stdout) as { command: string; output: string; usage: string[] };
    expect(help).toMatchObject({ command: 'arkova', output: 'json' });
    expect(help.usage).toContain('arkova status <public-id>');
    expect(help.usage).toContain('arkova agent computeid admit --request-json file');
  });

  it('rejects invalid lifecycle input in the built binary before network access', () => {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'agent', 'update', 'agent-1', '--status', 'revoked'], {
      cwd: resolve('.'), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ARKOVA_API_KEY: 'ak_test' },
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'usage_error' } });
    expect(result.stdout).toBe('');
  });
});
