import { describe, expect, it } from 'vitest';

import {
  planOpsSloRequests,
  summarizeSurfaceAvailability,
  OPS_SLO_DRIVER,
} from './ops-slo-driver';

const BASE = 'https://pr-1441---arkova-worker-staging-x-uc.a.run.app';

describe('ops-slo-driver: request plan', () => {
  it('drives the authenticated platform-admin 200 path when a JWT is supplied', () => {
    const plan = planOpsSloRequests(BASE, { adminJwt: 'jwt-admin' });
    const ok = plan.find((p) => p.label === 'admin-ok');
    expect(ok).toBeDefined();
    expect(ok!.endpoint).toBe('/api/admin/ops-slo-stats');
    expect(ok!.headers?.Authorization).toBe('Bearer jwt-admin');
    expect(ok!.allowedStatuses).toContain(200);
  });

  it('drives the 401 unauthenticated branch (no bearer token)', () => {
    const plan = planOpsSloRequests(BASE, { adminJwt: 'jwt-admin' });
    const unauth = plan.find((p) => p.label === 'unauthenticated');
    expect(unauth).toBeDefined();
    expect(unauth!.headers?.Authorization).toBeUndefined();
    expect(unauth!.allowedStatuses).toContain(401);
  });

  it('drives the 403 non-admin branch when a non-admin JWT is supplied', () => {
    const plan = planOpsSloRequests(BASE, { adminJwt: 'jwt-admin', nonAdminJwt: 'jwt-user' });
    const forbidden = plan.find((p) => p.label === 'non-admin-forbidden');
    expect(forbidden).toBeDefined();
    expect(forbidden!.headers?.Authorization).toBe('Bearer jwt-user');
    expect(forbidden!.allowedStatuses).toContain(403);
  });

  it('omits the admin-ok + non-admin cases when their JWTs are absent (401 still runs)', () => {
    const plan = planOpsSloRequests(BASE, {});
    expect(plan.find((p) => p.label === 'admin-ok')).toBeUndefined();
    expect(plan.find((p) => p.label === 'non-admin-forbidden')).toBeUndefined();
    expect(plan.find((p) => p.label === 'unauthenticated')).toBeDefined();
  });

  it('captures response bodies to prove per-surface available:false fields', () => {
    const plan = planOpsSloRequests(BASE, { adminJwt: 'jwt-admin' });
    expect(plan.every((p) => p.capture === true)).toBe(true);
  });
});

describe('ops-slo-driver: summarizeSurfaceAvailability', () => {
  it('collects per-surface available flags from the #1441 stats body', () => {
    const body = {
      surfaces: {
        anchoring: { available: true, p95_ms: 120 },
        webhooks: { available: false, p95_ms: null },
        exports: { available: true, p95_ms: 340 },
      },
    };
    const avail = summarizeSurfaceAvailability(body);
    expect(avail).toEqual({ anchoring: true, webhooks: false, exports: true });
    // The whole point of #1441: at least one surface can be unavailable.
    expect(Object.values(avail)).toContain(false);
  });

  it('returns an empty map when the body has no surfaces key', () => {
    expect(summarizeSurfaceAvailability({ error: 'x' })).toEqual({});
    expect(summarizeSurfaceAvailability('not-json')).toEqual({});
  });
});

describe('ops-slo-driver: metadata', () => {
  it('names PR #1441 and the driver', () => {
    expect(OPS_SLO_DRIVER.pr).toBe('#1441');
    expect(OPS_SLO_DRIVER.driver).toBe('ops-slo');
  });
});
