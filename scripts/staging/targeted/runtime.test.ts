import { describe, expect, it, afterEach, vi } from 'vitest';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { newDriverStats } from './driver-core';
import {
  writeEvidenceFile,
  bearerHeader,
  iamAuthHeaders,
  iamOnlyHeaders,
  resolveGcloudIdentityArgs,
  runDriver,
  requireEnv,
} from './runtime';

const scratch = join(process.cwd(), 'docs', 'staging', `.tmp-tsoak-runtime-${process.pid}`);

afterEach(() => {
  if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  delete process.env.STAGING_GCP_IDENTITY;
  delete process.env.STAGING_GCP_AUDIENCE;
  delete process.env.TSOAK_REQUIRED_TEST;
  vi.restoreAllMocks();
});

describe('runtime: writeEvidenceFile', () => {
  it('writes pretty JSON to the requested path and creates parent dirs', () => {
    const out = join(scratch, 'nested', 'evidence.json');
    const evidence = { driver: 'x', totalRequests: 3 };
    writeEvidenceFile(out, evidence);
    expect(existsSync(out)).toBe(true);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(parsed.driver).toBe('x');
    expect(parsed.totalRequests).toBe(3);
  });

  it('is a no-op when no path is given (stdout-only run)', () => {
    expect(() => writeEvidenceFile(undefined, { driver: 'x' })).not.toThrow();
  });

  it('rejects evidence paths outside docs/staging', () => {
    expect(() => writeEvidenceFile('../escape.json', { driver: 'x' })).toThrow(/docs\/staging/);
  });
});

describe('runtime: bearerHeader', () => {
  it('builds an Authorization: Bearer header from a token', () => {
    expect(bearerHeader('abc.def')).toEqual({ Authorization: 'Bearer abc.def' });
  });
});

describe('runtime: IAM/app auth header split', () => {
  it('uses Authorization for IAM when no app-layer bearer is present', () => {
    process.env.STAGING_GCP_IDENTITY = 'iam-token';
    expect(iamAuthHeaders({ 'X-API-Key': 'ak_admin' })).toEqual({
      Authorization: 'Bearer iam-token',
      'X-API-Key': 'ak_admin',
    });
  });

  it('moves IAM to X-Serverless-Authorization when app auth needs Authorization', () => {
    process.env.STAGING_GCP_IDENTITY = 'iam-token';
    expect(iamAuthHeaders({ Authorization: 'Bearer supabase-jwt' })).toEqual({
      'X-Serverless-Authorization': 'Bearer iam-token',
      Authorization: 'Bearer supabase-jwt',
    });
  });

  it('can carry only Cloud Run IAM without app Authorization for JWT-negative probes', () => {
    process.env.STAGING_GCP_IDENTITY = 'iam-token';
    expect(iamOnlyHeaders()).toEqual({
      'X-Serverless-Authorization': 'Bearer iam-token',
    });
  });

  it('requests an audience-bound identity token when STAGING_GCP_AUDIENCE is set', () => {
    process.env.STAGING_GCP_AUDIENCE = 'https://arkova-worker-staging.example.run.app';

    expect(resolveGcloudIdentityArgs()).toEqual([
      'auth',
      'print-identity-token',
      '--audiences=https://arkova-worker-staging.example.run.app',
    ]);
  });
});

describe('runtime: runDriver', () => {
  it('logs a thrown pass and continues to completion instead of rejecting', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(
      runDriver({
        apiBase: 'https://pr-1.example',
        args: { durationMin: 0.001, dryRun: false },
        label: 'test-driver',
        stats: newDriverStats(),
        plan: async () => ['one-pass'],
        fireOnce: async () => {
          throw new Error('network broke after prior evidence');
        },
      }),
    ).resolves.toBeUndefined();

    expect(consoleSpy.mock.calls.flat().join('\n')).toContain('pass 0 failed');
  });
});

describe('runtime: requireEnv', () => {
  it('returns the env value when present', () => {
    process.env.TSOAK_REQUIRED_TEST = 'ok';
    expect(requireEnv('TSOAK_REQUIRED_TEST', 'test driver')).toBe('ok');
  });

  it('labels the driver context when missing', () => {
    expect(() => requireEnv('TSOAK_REQUIRED_TEST', 'test driver')).toThrow(/test driver/);
  });
});
