import { describe, expect, it } from 'vitest';

import {
  planExportRequests,
  EXPORTS_PASS_INTERVAL_MS,
  EXPORTS_DRIVER,
} from './cpe-cle-exports-driver';

const BASE = 'https://pr-1415---arkova-worker-staging-x-uc.a.run.app';

const ARGS = {
  callerJwt: 'jwt-caller',
  callerUserId: 'user-self',
  otherUserId: 'user-other',
  orgAdminJwt: 'jwt-org-admin',
  period: { start: '2026-01-01', end: '2026-06-30' },
};

describe('cpe-cle-exports-driver: three POST endpoints, both formats', () => {
  const plan = planExportRequests(BASE, ARGS);

  it('POSTs /exports/cpe-log in both pdf and json format', () => {
    const cpe = plan.filter((p) => p.endpoint === '/api/v1/exports/cpe-log' && p.label.startsWith('cpe-log-ok'));
    const formats = cpe.map((p) => JSON.parse(p.body!).format).sort();
    expect(formats).toEqual(['json', 'pdf']);
    for (const p of cpe) {
      expect(p.method).toBe('POST');
      expect(p.headers?.Authorization).toBe('Bearer jwt-caller');
      expect(JSON.parse(p.body!).user_id).toBe('user-self');
      expect(p.allowedStatuses).toContain(200);
    }
  });

  it('POSTs /exports/cle-log with a jurisdiction and both formats', () => {
    const cle = plan.filter((p) => p.endpoint === '/api/v1/exports/cle-log' && p.label.startsWith('cle-log-ok'));
    expect(cle).toHaveLength(2);
    for (const p of cle) {
      const body = JSON.parse(p.body!);
      expect(body.jurisdiction).toBeTruthy();
      expect(body.user_id).toBe('user-self');
    }
  });

  it('POSTs /exports/org/cpe-log with the ORG_ADMIN JWT targeting a member', () => {
    const org = plan.filter((p) => p.endpoint === '/api/v1/exports/org/cpe-log' && p.label.startsWith('org-cpe-log-ok'));
    expect(org).toHaveLength(2);
    for (const p of org) {
      expect(p.headers?.Authorization).toBe('Bearer jwt-org-admin');
      // Org export targets a MEMBER user_id, not the caller.
      expect(JSON.parse(p.body!).user_id).toBe('user-other');
    }
  });
});

describe('cpe-cle-exports-driver: cross-org / cross-user 403 isolation', () => {
  const plan = planExportRequests(BASE, ARGS);

  it('drives a cross-user 403 on /exports/cpe-log (caller exports a foreign user_id)', () => {
    const iso = plan.find((p) => p.label === 'cpe-log-cross-user-403');
    expect(iso).toBeDefined();
    expect(iso!.endpoint).toBe('/api/v1/exports/cpe-log');
    expect(JSON.parse(iso!.body!).user_id).toBe('user-other');
    expect(iso!.headers?.Authorization).toBe('Bearer jwt-caller');
    expect(iso!.allowedStatuses).toContain(403);
    expect(iso!.allowedStatuses).not.toContain(200);
  });
});

describe('cpe-cle-exports-driver: Zod edge cases', () => {
  const plan = planExportRequests(BASE, ARGS);

  it('drives a 400 for an invalid format enum', () => {
    const bad = plan.find((p) => p.label === 'cpe-log-bad-format-400');
    expect(bad).toBeDefined();
    expect(JSON.parse(bad!.body!).format).toBe('xml');
    expect(bad!.allowedStatuses).toContain(400);
  });

  it('drives a 400 for a malformed date (period_start not YYYY-MM-DD)', () => {
    const bad = plan.find((p) => p.label === 'cpe-log-bad-date-400');
    expect(bad).toBeDefined();
    expect(JSON.parse(bad!.body!).period_start).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(bad!.allowedStatuses).toContain(400);
  });

  it('drives a 400 for period_end before period_start (refine)', () => {
    const bad = plan.find((p) => p.label === 'cpe-log-inverted-period-400');
    expect(bad).toBeDefined();
    const body = JSON.parse(bad!.body!);
    expect(body.period_end < body.period_start).toBe(true);
    expect(bad!.allowedStatuses).toContain(400);
  });

  it('drives a 401 unauthenticated case (no JWT)', () => {
    const noAuth = plan.find((p) => p.label === 'unauthenticated-401');
    expect(noAuth).toBeDefined();
    expect(noAuth!.headers?.Authorization).toBeUndefined();
    expect(noAuth!.allowedStatuses).toContain(401);
  });
});

describe('cpe-cle-exports-driver: metadata', () => {
  it('names PR #1415 and the driver', () => {
    expect(EXPORTS_DRIVER.pr).toBe('#1415');
    expect(EXPORTS_DRIVER.driver).toBe('cpe-cle-exports');
  });

  it('every request is a POST to an /exports/ path with capture on', () => {
    const plan = planExportRequests(BASE, ARGS);
    for (const p of plan) {
      expect(p.method).toBe('POST');
      expect(p.endpoint).toContain('/exports/');
      expect(p.capture).toBe(true);
    }
  });

  it('spaces repeated export passes below the hourly per-caller cap', () => {
    expect(EXPORTS_PASS_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60_000);
  });
});
