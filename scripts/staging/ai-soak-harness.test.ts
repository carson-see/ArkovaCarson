import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AI_SOAK_ENDPOINTS,
  buildConfigFromArgv,
  buildExtractionFixture,
  buildRequestHeaders,
  isLiveExtractionProvider,
  resolveAiSoakAuth,
  summarizeRun,
} from './ai-soak-harness';

const VALID_TAG_BASE = 'https://pr-1413---arkova-worker-staging-kvojbeutfa-uc.a.run.app';
const FAKE_JWT = 'header.payload.signature';

describe('ai-soak-harness config', () => {
  it('requires a live user JWT or Supabase password-grant credentials', () => {
    expect(() =>
      resolveAiSoakAuth({
        STAGING_API_BASE: VALID_TAG_BASE,
      }),
    ).toThrow(/requires a live Supabase user JWT/);
  });

  it('accepts direct JWT aliases and keeps the source name for evidence', () => {
    expect(resolveAiSoakAuth({ STAGING_SUPABASE_JWT: FAKE_JWT })).toEqual({
      kind: 'direct-jwt',
      source: 'STAGING_SUPABASE_JWT',
      token: FAKE_JWT,
    });
  });

  it('accepts password-grant credentials for long soaks that need JWT refresh', () => {
    expect(
      resolveAiSoakAuth({
        AI_SOAK_SUPABASE_URL: 'https://example.supabase.co',
        AI_SOAK_SUPABASE_ANON_KEY: 'anon-key',
        AI_SOAK_USER_EMAIL: 'ai-soak@example.test',
        AI_SOAK_USER_PASSWORD: 'correct-horse-battery-staple',
      }),
    ).toEqual({
      kind: 'supabase-password',
      supabaseUrl: 'https://example.supabase.co',
      anonKey: 'anon-key',
      email: 'ai-soak@example.test',
      password: 'correct-horse-battery-staple',
    });
  });

  it('rejects a direct auth value that is not JWT shaped', () => {
    expect(() => resolveAiSoakAuth({ AI_SOAK_JWT: 'not-a-jwt' })).toThrow(/JWT-looking token/);
  });

  it('refuses shared staging URLs through the common staging base guard', () => {
    expect(() =>
      buildConfigFromArgv(['--dry-run'], {
        STAGING_API_BASE: 'https://arkova-worker-staging-kvojbeutfa-uc.a.run.app',
        AI_SOAK_JWT: FAKE_JWT,
      }),
    ).toThrow(/shared\/main staging/);
  });

  it('defaults to live-provider enforcement and allows an explicit mock override', () => {
    expect(
      buildConfigFromArgv(['--dry-run'], {
        STAGING_API_BASE: VALID_TAG_BASE,
        AI_SOAK_JWT: FAKE_JWT,
      }).requireLiveProvider,
    ).toBe(true);

    expect(
      buildConfigFromArgv(['--dry-run', '--allow-mock-provider'], {
        STAGING_API_BASE: VALID_TAG_BASE,
        AI_SOAK_JWT: FAKE_JWT,
      }).requireLiveProvider,
    ).toBe(false);
  });
});

describe('ai-soak-harness requests', () => {
  it('targets only the changed AI extract and template surfaces', () => {
    expect(AI_SOAK_ENDPOINTS).toEqual(['/api/v1/ai/extract', '/api/v1/ai/template']);
    expect(AI_SOAK_ENDPOINTS.some((endpoint) => endpoint.includes('health'))).toBe(false);
  });

  it('keeps the Supabase JWT in Authorization and Cloud Run IAM in X-Serverless-Authorization', () => {
    expect(
      buildRequestHeaders({
        supabaseJwt: 'supabase.jwt.signature',
        cloudRunIdentityToken: 'google.oidc.signature',
      }),
    ).toMatchObject({
      Authorization: 'Bearer supabase.jwt.signature',
      'X-Serverless-Authorization': 'Bearer google.oidc.signature',
      'Content-Type': 'application/json',
    });
  });

  it('builds PII-stripped synthetic extraction fixtures with cache-busting fingerprints', () => {
    const first = buildExtractionFixture(1, 'nonce-a');
    const second = buildExtractionFixture(1, 'nonce-b');

    expect(first.strippedText).toContain('[NAME_REDACTED]');
    expect(first.strippedText).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(first.strippedText).not.toContain('@');
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.fingerprint).not.toEqual(second.fingerprint);
  });

  it('treats mock, cache, fallback, degraded, and missing providers as not live', () => {
    expect(isLiveExtractionProvider('gemini-2.5-flash', false)).toBe(true);
    expect(isLiveExtractionProvider('mock-e2e', false)).toBe(false);
    expect(isLiveExtractionProvider('cache', false)).toBe(false);
    expect(isLiveExtractionProvider('fast-fallback', false)).toBe(false);
    expect(isLiveExtractionProvider('gemini-2.5-flash', true)).toBe(false);
    expect(isLiveExtractionProvider(undefined, false)).toBe(false);
  });
});

describe('ai-soak-harness evidence', () => {
  it('summarizes statuses/providers without leaking JWTs', () => {
    const config = buildConfigFromArgv(['--dry-run'], {
      STAGING_API_BASE: VALID_TAG_BASE,
      AI_SOAK_JWT: FAKE_JWT,
    });
    const evidence = summarizeRun(
      {
        startedAt: 1,
        endedAt: 2,
        outcomes: [
          {
            endpoint: '/api/v1/ai/extract',
            status: 200,
            latencyMs: 120,
            ok: true,
            provider: 'gemini-2.5-flash',
          },
          {
            endpoint: '/api/v1/ai/template',
            status: 500,
            latencyMs: 240,
            ok: false,
            failure: 'http_500',
          },
        ],
      },
      config,
    );

    expect(evidence.totals).toEqual({ ok: 1, fail: 1, requests: 2 });
    expect(evidence.providers).toEqual({ 'gemini-2.5-flash': 1 });
    expect(evidence.failures).toEqual({ http_500: 1 });
    expect(JSON.stringify(evidence)).not.toContain(FAKE_JWT);
  });

  it('supports dry-run validation without fetching tokens or making requests', () => {
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const result = spawnSync(
      process.execPath,
      [
        tsxCli,
        'scripts/staging/ai-soak-harness.ts',
        '--dry-run',
        '--duration',
        '1',
        '--rate',
        '1',
        '--max-iterations',
        '1',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          STAGING_API_BASE: VALID_TAG_BASE,
          AI_SOAK_JWT: FAKE_JWT,
          STAGING_GCP_IDENTITY: 'google.oidc.signature',
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"dryRun": true');
    expect(result.stdout).not.toContain(FAKE_JWT);
  });
});
