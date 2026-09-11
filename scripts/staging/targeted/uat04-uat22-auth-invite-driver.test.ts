import { describe, expect, it } from 'vitest';

import {
  APPROVED_RECIPIENTS,
  EXPECTED_CATALOG_SHA256,
  buildLongProbePlan,
  catalogSql,
  isDirectRun,
  parseUatArgs,
  redactEvidence,
  validateManifest,
} from './uat04-uat22-auth-invite-driver.js';

const HEAD = 'a'.repeat(40);
const CREATED = '2026-09-11T12:00:00.000Z';
const DESTROY = '2026-09-14T12:00:00.000Z';

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    rigId: 'uat04-22-0911',
    sourceHead: HEAD,
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
    cloudRunService: 'arkova-worker-uat04-22-0911-staging',
    workerUrl: 'https://arkova-worker-uat04-22-0911-staging-abc-uc.a.run.app',
    createdAt: CREATED,
    destroyBy: DESTROY,
    bootstrapCatalogSha256: EXPECTED_CATALOG_SHA256,
    ...overrides,
  };
}

describe('UAT04/UAT22 driver admission manifest', () => {
  it('accepts the exact isolated identity and 72-hour lease', () => {
    expect(validateManifest(manifest(), Date.parse('2026-09-12T12:00:00Z'))).toMatchObject({
      sourceHead: HEAD,
      cloudRunService: 'arkova-worker-uat04-22-0911-staging',
    });
  });

  it.each(['vzwyaatejekddvltxyye', 'fizyjojbebyalirtjjht', 'ujtlwnoqfhtitcmsnrpq'])(
    'refuses protected project ref %s',
    (ref) => expect(() => validateManifest(manifest({
      supabaseProjectRef: ref,
      supabaseUrl: `https://${ref}.supabase.co`,
    }), Date.parse('2026-09-12T12:00:00Z'))).toThrow(/protected Supabase/i),
  );

  it('refuses a service, URL, or source that is not bound to the manifest', () => {
    const now = Date.parse('2026-09-12T12:00:00Z');
    expect(() => validateManifest(manifest({ cloudRunService: 'arkova-worker-staging' }), now)).toThrow(/service/i);
    expect(() => validateManifest(manifest({ workerUrl: 'https://arkova-worker-270018525501.us-central1.run.app' }), now)).toThrow(/worker URL/i);
    expect(() => validateManifest(manifest({ workerUrl: 'https://arkova-worker-uat04-22-0911-staging-abc-uc.a.run.app/api' }), now)).toThrow(/worker URL/i);
    expect(() => validateManifest(manifest({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co?key=value' }), now)).toThrow(/supabaseProjectRef/i);
    expect(() => validateManifest(manifest({ sourceHead: 'short' }), now)).toThrow(/sourceHead/i);
    expect(() => validateManifest(manifest({ bootstrapCatalogSha256: '0'.repeat(64) }), now)).toThrow(/catalog identity/i);
  });

  it('requires an exact 72-hour lease that is still active', () => {
    expect(() => validateManifest(manifest({ destroyBy: '2026-09-14T11:59:59.000Z' }), Date.parse('2026-09-12T12:00:00Z'))).toThrow(/72 hours/i);
    expect(() => validateManifest(manifest(), Date.parse(DESTROY))).toThrow(/expired/i);
    expect(() => validateManifest(manifest(), Date.parse('2026-09-11T11:58:59Z'))).toThrow(/future/i);
  });

  it('rejects credentials embedded in either bound URL', () => {
    const now = Date.parse('2026-09-12T12:00:00Z');
    expect(() => validateManifest(manifest({
      supabaseUrl: 'https://user:password@abcdefghijklmnopqrst.supabase.co',
    }), now)).toThrow(/credentials/i);
    expect(() => validateManifest(manifest({
      workerUrl: 'https://token@arkova-worker-uat04-22-0911-staging-abc-uc.a.run.app',
    }), now)).toThrow(/credentials/i);
  });
});

describe('UAT04/UAT22 driver execution contract', () => {
  it('defaults to dry-run and requires explicit email opt-in for execution', () => {
    expect(parseUatArgs(['--manifest', 'docs/staging/uat04-22-0911/admission.json'])).toMatchObject({
      execute: false,
      liveEmail: false,
      durationMin: 2880,
      intervalSec: 900,
    });
    expect(() => parseUatArgs(['--manifest', 'x', '--execute'])).toThrow(/live-email/i);
  });

  it('pins every outbound address to Resend provider-owned test addresses', () => {
    expect(APPROVED_RECIPIENTS).toEqual({
      existing: 'delivered+uat04-22-0911-existing@resend.dev',
      fresh: 'delivered+uat04-22-0911-new@resend.dev',
      already: 'delivered+uat04-22-0911-already@resend.dev',
      provision: 'delivered+uat04-22-0911-provision@resend.dev',
    });
    expect(Object.values(APPROVED_RECIPIENTS).every((email) => /^delivered\+.+@resend\.dev$/.test(email))).toBe(true);
  });

  it('queries real trigger definitions and full Storage policy expressions', () => {
    const query = catalogSql();
    expect(query).toContain('pg_get_triggerdef(t.oid)');
    expect(query).toContain('p.polcmd');
    expect(query).toContain('p.polroles');
    expect(query).toContain('pg_get_expr(p.polqual,p.polrelid)');
    expect(query).toContain('pg_get_expr(p.polwithcheck,p.polrelid)');
    expect(query).toContain("role_oid=0 THEN 'public'");
    expect(query).not.toContain('t.tgname IN');
    expect(query).not.toContain('p.polname IN');
  });

  it('keeps the repeated soak phase read-only and email-free', () => {
    const plan = buildLongProbePlan('00000000-0000-4000-8000-000000000001');
    expect(plan.map((item) => `${item.method} ${item.path}`)).toEqual([
      'GET /api/admin/system-health',
      'GET /api/admin/organizations/00000000-0000-4000-8000-000000000001',
      'GET /api/admin/organizations/00000000-0000-4000-8000-000000000001/members',
    ]);
    expect(plan.every((item) => item.method === 'GET')).toBe(true);
  });

  it('redacts sensitive keys and registered secret values before evidence serialization', () => {
    const secret = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
    const redacted = redactEvidence({
      authorization: `Bearer ${secret}`,
      nested: { access_token: secret, status: 201, message: `upstream echoed ${secret}` },
    }, [secret]);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted).toEqual({
      authorization: '[REDACTED]',
      nested: { access_token: '[REDACTED]', status: 201, message: 'upstream echoed [REDACTED]' },
    });
  });
});

describe('UAT04/UAT22 driver entry guard', () => {
  it('recognizes absolute and relative direct execution only', () => {
    const self = import.meta.url;
    const absolute = new URL(self).pathname;
    expect(isDirectRun(self, absolute)).toBe(true);
    expect(isDirectRun(self, absolute.slice(process.cwd().length + 1))).toBe(true);
    expect(isDirectRun(self, new URL('./ops-slo-driver.ts', self).pathname)).toBe(false);
    expect(isDirectRun(self, undefined)).toBe(false);
  });
});
