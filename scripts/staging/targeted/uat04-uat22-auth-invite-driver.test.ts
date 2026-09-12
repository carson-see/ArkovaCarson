import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import {
  APPROVED_RECIPIENTS,
  EXPECTED_CATALOG_SHA256,
  buildLongProbePlan,
  boundedRateLimitWait,
  catalogSql,
  isDirectRun,
  parseUatArgs,
  redactEvidence,
  validateManifest,
  observeWorkerUptime,
  assertWorkerRequestLease,
  validateManifestDocument,
  verifyStandingObservation,
  standingStateSql,
  standingServiceConfigurationSha256,
  canonicalEvidenceSha256,
  type StandingObservation,
  type StandingAdmissionManifest,
} from './uat04-uat22-auth-invite-driver.js';

const HEAD = 'a'.repeat(40);
const CREATED = '2026-09-11T12:00:00.000Z';
const DESTROY = '2026-09-14T12:00:00.000Z';
const REAL_SHA = '0123456789abcdef0123456789abcdef01234567';
const HASH_A = '0123456789abcdef'.repeat(4);
const HASH_B = 'fedcba9876543210'.repeat(4);
const RUN_ID = '12345678-1234-4234-8234-123456789abc';

function standingManifest(overrides: Record<string, unknown> = {}): StandingAdmissionManifest {
  const leaseReason = (pr: number, head: string) =>
    `exclusive-standing-mirror run=${RUN_ID} starts=${CREATED} expires=${DESTROY} combined=${REAL_SHA} pr=${pr} head=${head}`;
  const members = [2825, 2831, 2832].map((pr, index) => ({
    prNumber: pr,
    sourceHead: `${index + 1}23456789abcdef0123456789abcdef012345678`,
    reason: leaseReason(pr, `${index + 1}23456789abcdef0123456789abcdef012345678`),
    acquiredBy: 'codex-standing-rc-release-owner',
    acquiredAt: CREATED,
  }));
  return {
    ...manifest({
      admissionMode: 'exclusive-standing-mirror',
      sourceHead: REAL_SHA,
      supabaseProjectRef: 'fizyjojbebyalirtjjht',
      supabaseUrl: 'https://fizyjojbebyalirtjjht.supabase.co',
      cloudRunService: 'arkova-worker-staging',
      workerUrl: 'https://arkova-worker-staging-kvojbeutfa-uc.a.run.app',
    }),
    runId: RUN_ID,
    baselineSourceHead: 'abcdef0123456789abcdef0123456789abcdef01',
    sourceMembership: members,
    acceptedBaseline149Sha256: HASH_A,
    expectedRcMigrationCount: 152,
    expectedRcLedgerSha256: HASH_B,
    historicalLeaseSha256: '13579bdf02468ace'.repeat(4),
    standingService: {
      projectId: 'arkova1',
      region: 'us-central1',
      uid: 'a8e256d2-a5f9-41be-b880-8b85c4382bd3',
      generation: 401,
      revision: 'arkova-worker-staging-00401-abc',
      imageDigest: `sha256:${HASH_A}`,
      configurationSha256: HASH_B,
    },
    ...overrides,
  } as StandingAdmissionManifest;
}

function standingObservation(value = standingManifest()): StandingObservation {
  return {
    ledgerCount: value.expectedRcMigrationCount,
    baselineCount: 149,
    leaseCount: 6,
    baseline149Sha256: value.acceptedBaseline149Sha256,
    ledgerSha256: value.expectedRcLedgerSha256,
    historicalLeaseSha256: value.historicalLeaseSha256,
    leaseRows: value.sourceMembership.map((row) => ({
      pr_number: row.prNumber,
      reason: row.reason,
      acquired_by: row.acquiredBy,
      acquired_at: row.acquiredAt,
    })),
    service: {
      uid: value.standingService.uid,
      generation: value.standingService.generation,
      revision: value.standingService.revision,
      imageDigest: value.standingService.imageDigest,
      configurationSha256: value.standingService.configurationSha256,
      trafficRevision: value.standingService.revision,
      trafficPercent: 100,
    },
  };
}

describe('target-bound existing-standing admission', () => {
  const now = Date.parse('2026-09-12T12:00:00Z');

  it('requires the explicit mode and the exact manifest bytes supplied', () => {
    const raw = JSON.stringify(standingManifest());
    const digest = createHash('sha256').update(raw).digest('hex');
    expect(validateManifestDocument(raw, digest, now)).toMatchObject({
      admissionMode: 'exclusive-standing-mirror',
      supabaseProjectRef: 'fizyjojbebyalirtjjht',
      expectedRcMigrationCount: 152,
    });
    expect(() => validateManifestDocument(raw, undefined, now)).toThrow(/manifest-sha256/i);
    expect(() => validateManifestDocument(`${raw}\n`, digest, now)).toThrow(/manifest SHA-256 mismatch/i);
    expect(() => validateManifestDocument('{invalid', digest, now)).toThrow(/manifest SHA-256 mismatch/i);
    const defaultMode = standingManifest({ admissionMode: undefined });
    expect(() => validateManifest(defaultMode, now)).toThrow(/protected Supabase/i);
  });

  it('rejects placeholders, wrong identities, and incomplete source membership', () => {
    expect(() => validateManifest(standingManifest({ acceptedBaseline149Sha256: '0'.repeat(64) }), now)).toThrow(/non-placeholder/i);
    expect(() => validateManifest(standingManifest({ expectedRcMigrationCount: 149 }), now)).toThrow(/greater than baseline/i);
    expect(() => validateManifest(standingManifest({ supabaseProjectRef: 'vzwyaatejekddvltxyye' }), now)).toThrow(/standing mode requires project/i);
    expect(() => validateManifest(standingManifest({ sourceMembership: standingManifest().sourceMembership.slice(0, 2) }), now)).toThrow(/exactly PRs/i);
    const wrongOrder = structuredClone(standingManifest().sourceMembership).reverse();
    expect(() => validateManifest(standingManifest({ sourceMembership: wrongOrder }), now)).toThrow(/ordered/i);
    const wrongReason = structuredClone(standingManifest().sourceMembership);
    wrongReason[0].reason = 'unbound lease';
    expect(() => validateManifest(standingManifest({ sourceMembership: wrongReason }), now)).toThrow(/target-bound/i);
    const fullImage = standingManifest();
    fullImage.standingService.imageDigest = `us-central1-docker.pkg.dev/arkova1/workers/worker@sha256:${HASH_A}`;
    expect(() => validateManifest(fullImage, now)).not.toThrow();
  });

  it('accepts only an exact live ledger, lease, traffic, and service observation', () => {
    const admitted = validateManifest(standingManifest(), now);
    if (admitted.admissionMode !== 'exclusive-standing-mirror') throw new Error('test manifest mode mismatch');
    expect(() => verifyStandingObservation(admitted, standingObservation(), now)).not.toThrow();
    const equivalentInstant = standingObservation();
    equivalentInstant.leaseRows[0].acquired_at = '2026-09-11T12:00:00+00:00';
    expect(() => verifyStandingObservation(admitted, equivalentInstant, now)).not.toThrow();
    for (const changed of [
      standingObservation({ ...standingManifest(), expectedRcMigrationCount: 153 }),
      { ...standingObservation(), ledgerSha256: HASH_A },
      { ...standingObservation(), baselineCount: 148 },
      { ...standingObservation(), historicalLeaseSha256: HASH_B },
      { ...standingObservation(), leaseCount: 7 },
      { ...standingObservation(), leaseRows: standingObservation().leaseRows.slice(1) },
      { ...standingObservation(), service: { ...standingObservation().service, trafficPercent: 99 } },
      { ...standingObservation(), service: { ...standingObservation().service, generation: 402 } },
    ]) expect(() => verifyStandingObservation(admitted, changed, now)).toThrow();
    expect(() => verifyStandingObservation(admitted, standingObservation(), Date.parse(DESTROY))).toThrow(/lease/i);
  });

  it('queries ordered baseline/RC ledger and exact historical/new rows without lease writes', () => {
    const sql = standingStateSql();
    expect(sql).toContain('supabase_migrations.schema_migrations');
    expect(sql).toContain("version NOT IN ('0443','0451','0452')");
    expect(sql).toContain('baseline_count');
    expect(sql).not.toContain('LIMIT 149');
    expect(sql).toContain('2571,2637,2668');
    expect(sql).toContain('2825,2831,2832');
    expect(sql).toContain('ORDER BY pr_number');
    expect(sql).not.toMatch(/\b(?:insert|update|delete)\b/i);
    expect(canonicalEvidenceSha256([
      { reason: 'SCRUM-3873: isolated owie qualification of credit and tenant fixes; shared database used only for scoped lease/deploy audit', pr_number: 2571, acquired_at: '2026-09-05T15:52:04.778253+00:00', acquired_by: 'codex-pr2571-release-review' },
      { reason: 'SCRUM-3167: T3 MFA security qualification on isolated existing nesu; shared database only for scoped lease and real deploy audit', pr_number: 2637, acquired_at: '2026-09-05T16:10:22.270592+00:00', acquired_by: 'codex-pr2637-security-release-review' },
      { reason: 'SCRUM-4499: ComputeID PR-A T2 soak on isolated rig computeid-pra (CTO session)', pr_number: 2668, acquired_at: '2026-09-07T15:06:45+00:00', acquired_by: 'carson@Arkovas-Mac-mini' },
    ])).toBe('ab4a7809975fbfbf98cdeaa3778d1da224675f8c785a4737da3eebcdc1e4664b');
  });

  it('hashes stable service identity/config while excluding controller timestamps', () => {
    const document = {
      apiVersion: 'serving.knative.dev/v1', kind: 'Service',
      metadata: { name: 'arkova-worker-staging', namespace: '270018525501', uid: 'u', generation: 401, labels: { lane: 'rc' }, annotations: { ingress: 'all', 'run.googleapis.com/operation-id': 'old' }, creationTimestamp: 'old', resourceVersion: '1' },
      spec: { template: { metadata: { name: 'rev' }, spec: { containers: [{ image: `image@sha256:${HASH_A}` }] } } },
      status: { conditions: [{ lastTransitionTime: 'old' }] },
    };
    const changedClocks = structuredClone(document);
    changedClocks.metadata.creationTimestamp = 'new';
    changedClocks.metadata.resourceVersion = '2';
    changedClocks.metadata.annotations['run.googleapis.com/operation-id'] = 'new';
    changedClocks.status.conditions[0].lastTransitionTime = 'new';
    expect(standingServiceConfigurationSha256(changedClocks)).toBe(standingServiceConfigurationSha256(document));
    changedClocks.spec.template.spec.containers[0].image = `image@sha256:${HASH_B}`;
    expect(standingServiceConfigurationSha256(changedClocks)).not.toBe(standingServiceConfigurationSha256(document));
  });
});

describe('worker uptime continuity', () => {
  it('retains a common process start across request latency and second rounding', () => {
    const first = observeWorkerUptime(null, 100, 200_000, 202_000);
    const next = observeWorkerUptime(first, 1000, 1_100_000, 1_104_000);
    expect(next).toMatchObject({ bootEarliestMs: 99_000, bootLatestMs: 102_000, firstUptimeSeconds: 100, lastUptimeSeconds: 1000, samples: 2 });
  });

  it('rejects a restart even when the new uptime exceeds the earlier sample', () => {
    const first = observeWorkerUptime(null, 100, 200_000, 201_000);
    expect(() => observeWorkerUptime(first, 500, 1_100_000, 1_101_000)).toThrow(/uptime_discontinuity/);
    expect(() => observeWorkerUptime(first, 5, 210_000, 211_000)).toThrow(/uptime_discontinuity/);
  });

  it.each([undefined, '100', -1, Infinity, NaN, 1.5])('fails closed for invalid uptime %s', (uptime) => {
    expect(() => observeWorkerUptime(null, uptime, 200_000, 201_000)).toThrow(/invalid_worker_uptime/);
  });
});

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
    expect(parseUatArgs(['--manifest', 'docs/staging/uat04-22-0911/admission.json', '--manifest-sha256', HASH_A])).toMatchObject({
      execute: false,
      liveEmail: false,
      manifestSha256: HASH_A,
      durationMin: 2910,
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

  it('bounds 429 pacing by the limiter window and remaining rig lease', () => {
    const now = Date.parse('2026-09-12T12:00:00Z');
    expect(boundedRateLimitWait('999999', now, '2026-09-14T12:00:00Z')).toBe(61_000);
    expect(boundedRateLimitWait('30', now, '2026-09-14T12:00:00Z')).toBe(30_250);
    expect(boundedRateLimitWait('invalid', now, new Date(now + 10_000).toISOString())).toBeNull();
    expect(boundedRateLimitWait('invalid', now, new Date(now + 30_000).toISOString())).toBe(9_999);
    expect(boundedRateLimitWait('1', now, new Date(now).toISOString())).toBeNull();
  });

  it('reserves a full request timeout before expiry, including the final sample', () => {
    const expiry = Date.parse(DESTROY);
    expect(() => assertWorkerRequestLease(expiry - 20_000, DESTROY)).toThrow(/lease/);
    expect(() => assertWorkerRequestLease(expiry, DESTROY)).toThrow(/lease/);
    expect(() => assertWorkerRequestLease(expiry - 20_001, DESTROY)).not.toThrow();
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
