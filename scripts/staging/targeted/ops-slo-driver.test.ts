import { describe, expect, it } from 'vitest';

import {
  missingOpsSloAdmissionInputs,
  planOpsSloRequests,
  summarizeSurfaceAvailability,
  OPS_SLO_DRIVER,
} from './ops-slo-driver.js';

const BASE = 'https://pr-1441---arkova-worker-staging-x-uc.a.run.app';

describe('ops-slo-driver: request plan', () => {
  it('drives the authenticated platform-admin 200 path when a JWT is supplied', () => {
    const plan = planOpsSloRequests(BASE, { adminJwt: 'jwt-admin', nonAdminJwt: 'jwt-user' });
    const ok = plan.find((p) => p.label === 'admin-ok');
    expect(ok).toBeDefined();
    expect(ok!.endpoint).toBe('/api/admin/ops-slo-stats');
    expect(ok!.headers?.Authorization).toBe('Bearer jwt-admin');
    expect(ok!.allowedStatuses).toContain(200);
  });

  it('drives the 401 unauthenticated branch (no bearer token)', () => {
    const plan = planOpsSloRequests(BASE, { adminJwt: 'jwt-admin', nonAdminJwt: 'jwt-user' });
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

  it('fails closed instead of producing hollow 401-only evidence when JWTs are absent', () => {
    expect(() => planOpsSloRequests(BASE, {})).toThrow(/platform-admin Supabase JWT/);
    expect(() => planOpsSloRequests(BASE, { adminJwt: 'jwt-admin' })).toThrow(/non-admin Supabase JWT/);
  });

  it('captures response bodies to prove per-surface available:false fields', () => {
    const plan = planOpsSloRequests(BASE, { adminJwt: 'jwt-admin', nonAdminJwt: 'jwt-user' });
    expect(plan.every((p) => p.capture === true)).toBe(true);
  });
});

describe('ops-slo-driver: admission inputs', () => {
  it('names the exact missing target/auth/ingress facts', () => {
    expect(missingOpsSloAdmissionInputs({})).toEqual([
      'STAGING_API_BASE or WORKER_URL for the deployed PR #1441 tag URL',
      'STAGING_ADMIN_JWT or OPS_SLO_ADMIN_JWT for a platform-admin Supabase JWT',
      'STAGING_NON_ADMIN_JWT or OPS_SLO_NON_ADMIN_JWT for an authenticated non-admin Supabase JWT',
      'STAGING_GCP_IDENTITY, WORKER_IAM_TOKEN, or CLOUD_RUN_IDENTITY_TOKEN for Cloud Run tag ingress',
    ]);
  });

  it('accepts the OPS_SLO alias names without requiring secret values on argv', () => {
    expect(missingOpsSloAdmissionInputs({
      WORKER_URL: BASE,
      OPS_SLO_ADMIN_JWT: 'admin.jwt',
      OPS_SLO_NON_ADMIN_JWT: 'user.jwt',
      WORKER_IAM_TOKEN: 'iam.jwt',
    })).toEqual([]);
  });
});

describe('ops-slo-driver: summarizeSurfaceAvailability', () => {
  it('collects per-surface available flags from the #1441 stats body', () => {
    const body = {
      anchorSecuredRate: { available: true, breach: false },
      connectorQueue: { available: false, breach: false },
      creditConservation: { available: true, breach: false },
      webhookDelivery: { available: true, breach: false },
      apiErrors: { available: false, breach: false },
      overallBreach: false,
      checkedAt: '2026-07-09T16:00:00.000Z',
    };
    const avail = summarizeSurfaceAvailability(body);
    expect(avail).toEqual({
      anchorSecuredRate: true,
      connectorQueue: false,
      creditConservation: true,
      webhookDelivery: true,
      apiErrors: false,
    });
    // The whole point of #1441: at least one surface can be unavailable.
    expect(Object.values(avail)).toContain(false);
  });

  it('returns an empty map when the body has none of the flat surface keys', () => {
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
