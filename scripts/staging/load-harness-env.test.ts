import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { resolveStagingApiBase } from './load-harness-env';

describe('resolveStagingApiBase', () => {
  it('requires STAGING_API_BASE instead of defaulting to shared staging', () => {
    expect(() => resolveStagingApiBase({})).toThrow(/STAGING_API_BASE is required/);
  });

  it('rejects the shared staging host', () => {
    expect(() =>
      resolveStagingApiBase({
        STAGING_API_BASE: 'https://arkova-worker-staging-kvojbeutfa-uc.a.run.app',
      }),
    ).toThrow(/shared\/main staging/);
  });

  it('rejects untagged Cloud Run hosts', () => {
    expect(() =>
      resolveStagingApiBase({
        STAGING_API_BASE: 'https://arkova-worker-staging-abc123-uc.a.run.app',
      }),
    ).toThrow(/tag-routed per-PR/);
  });

  it('accepts and normalizes a per-PR tag URL', () => {
    expect(
      resolveStagingApiBase({
        STAGING_API_BASE: 'https://pr-1055---arkova-worker-pr-1055-staging-kvojbeutfa-uc.a.run.app/',
      }),
    ).toBe('https://pr-1055---arkova-worker-pr-1055-staging-kvojbeutfa-uc.a.run.app');
  });

  it('fails load-harness dry-run when STAGING_API_BASE is missing', () => {
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const result = spawnSync(process.execPath, [tsxCli, 'scripts/staging/load-harness.ts', '--dry-run'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        STAGING_API_BASE: '',
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain('STAGING_API_BASE is required');
  });
});
