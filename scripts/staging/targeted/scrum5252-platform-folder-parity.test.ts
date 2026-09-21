import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAal2Token,
  assertWorkerIamToken,
  validateTargets,
  workerRequest,
} from './scrum5252-platform-folder-parity';

function token(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
}

describe('SCRUM-5252 hosted parity target and token guards', () => {
  it('keeps setup data-only and refuses an occupied fixture identity', () => {
    const sql = readFileSync(resolve(
      process.cwd(), 'docs/staging/uat24-2026-09-14/scrum5252-hosted-fixture.sql',
    ), 'utf8');
    expect(sql).toContain('fixture id ownership mismatch');
    expect(sql).toContain("admin_set_platform_admin('52520000-0000-4000-8000-00000000a001',true)");
    expect(sql).not.toMatch(/supabase_migrations|switchboard_flags|DELETE FROM auth\./i);
  });

  it('accepts only the authorized retired B4 pair', () => {
    expect(() => validateTargets(
      'https://dlfcwhljvkomeouykcwk.supabase.co',
      'https://arkova-worker-cto-train-b4-0913-staging-270018525501.us-central1.run.app',
    )).not.toThrow();
    expect(() => validateTargets('https://vzwyaatejekddvltxyye.supabase.co',
      'https://arkova-worker-cto-train-b4-0913-staging-270018525501.us-central1.run.app')).toThrow();
    expect(() => validateTargets('https://dlfcwhljvkomeouykcwk.supabase.co',
      'https://api.arkova.ai')).toThrow();
    expect(() => validateTargets('https://dlfcwhljvkomeouykcwk.supabase.co',
      'https://arkova-worker-cto-train-b4-0913-staging-270018525501.us-central1.run.app/other'))
      .toThrow();
    expect(() => validateTargets('https://dlfcwhljvkomeouykcwk.supabase.co',
      'https://user:pass@arkova-worker-cto-train-b4-0913-staging-270018525501.us-central1.run.app'))
      .toThrow();
  });

  it('requires the exact actor and aal2 claim', () => {
    expect(() => assertAal2Token(token({ sub: 'user-a', aal: 'aal2' }), 'user-a')).not.toThrow();
    expect(() => assertAal2Token(token({ sub: 'user-b', aal: 'aal2' }), 'user-a')).toThrow();
    expect(() => assertAal2Token(token({ sub: 'user-a', aal: 'aal1' }), 'user-a')).toThrow();
  });

  it('requires a live IAM token for the exact private worker audience', () => {
    const worker = 'https://arkova-worker-cto-train-b4-0913-staging-270018525501.us-central1.run.app';
    const live = Math.floor(Date.now() / 1000) + 600;
    expect(() => assertWorkerIamToken(token({ iss: 'https://accounts.google.com', aud: worker, exp: live }), worker))
      .not.toThrow();
    expect(() => assertWorkerIamToken(token({
      iss: 'https://accounts.google.com', aud: '32555940559.apps.googleusercontent.com', exp: live,
    }), worker)).not.toThrow();
    expect(() => assertWorkerIamToken(token({
      iss: 'https://accounts.google.com', aud: 'https://api.arkova.ai', exp: 4_000_000_000,
    }), worker))
      .toThrow();
    expect(() => assertWorkerIamToken(token({ iss: 'attacker', aud: worker, exp: live }), worker)).toThrow();
    expect(() => assertWorkerIamToken(token({
      iss: 'https://accounts.google.com', aud: worker, exp: 1,
    }), worker)).toThrow();
  });

  it('keeps Cloud Run IAM authorization separate from the application JWT', async () => {
    let captured: Headers | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return new Response(JSON.stringify({ git_sha: 'candidate' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await workerRequest(
        'https://arkova-worker-cto-train-b4-0913-staging-270018525501.us-central1.run.app',
        'iam-secret', '/health', { jwt: 'app-secret' },
      );
      expect(captured?.get('x-serverless-authorization')).toBe('Bearer iam-secret');
      expect(captured?.get('authorization')).toBe('Bearer app-secret');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses a request target that did not pass the fixed B4 binding', async () => {
    await expect(workerRequest('https://api.arkova.ai', 'iam-secret', '/health', {}))
      .rejects.toThrow('refusing unverified worker request target');
  });
});
