import { describe, expect, it, vi } from 'vitest';

import {
  buildBlockedAdmission,
  hasOpsSloContract,
  missingAdmissionInputs,
  parseConfig,
  runOneCycle,
} from './ops-slo-driver.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const goodBody = {
  anchorSecuredRate: { available: true, breach: false },
  connectorQueue: { available: true, breach: false },
  creditConservation: { available: true, breach: false },
  webhookDelivery: { available: true, breach: false },
  apiErrors: { available: true, breach: false },
  overallBreach: false,
  checkedAt: '2026-07-09T16:00:00.000Z',
};

describe('ops-slo targeted driver admission', () => {
  it('names exact missing auth and target inputs', () => {
    expect(missingAdmissionInputs({})).toEqual([
      'WORKER_URL or STAGING_API_BASE for the deployed PR #1441 tag URL',
      'OPS_SLO_ADMIN_JWT or STAGING_ADMIN_JWT for a platform-admin Supabase JWT',
      'OPS_SLO_NON_ADMIN_JWT or STAGING_NON_ADMIN_JWT for an authenticated non-admin Supabase JWT',
      'WORKER_IAM_TOKEN, CLOUD_RUN_IDENTITY_TOKEN, or STAGING_GCP_IDENTITY for Cloud Run tag ingress when the service is IAM-protected',
      'CLOUD_RUN_AUDIENCE or STAGING_GCP_AUDIENCE for the Cloud Run identity-token audience',
    ]);

    expect(buildBlockedAdmission(['OPS_SLO_ADMIN_JWT'], new Date('2026-07-09T16:00:00.000Z'))).toMatchObject({
      pr: 1441,
      driver: 'ops-slo',
      status: 'blocked',
      exact_head_required: '97b8e7555f74da3ceeb45d259e956201b4d32874',
      missing: ['OPS_SLO_ADMIN_JWT'],
    });
  });

  it('parses secrets only from env and rejects command-line token material', () => {
    expect(() => parseConfig(['--admin-jwt=secret'], {
      WORKER_URL: 'https://worker.example.test',
      CLOUD_RUN_AUDIENCE: 'https://worker.example.test',
      OPS_SLO_ADMIN_JWT: 'admin.jwt',
      OPS_SLO_NON_ADMIN_JWT: 'member.jwt',
    })).toThrow('Do not pass --admin-jwt');

    expect(parseConfig(['--duration-min=720', '--concurrency=3'], {
      WORKER_URL: 'https://worker.example.test/',
      CLOUD_RUN_AUDIENCE: 'https://worker.example.test/',
      OPS_SLO_ADMIN_JWT: 'admin.jwt',
      OPS_SLO_NON_ADMIN_JWT: 'member.jwt',
      CLOUD_RUN_IDENTITY_TOKEN: 'iam.jwt',
    })).toMatchObject({
      workerUrl: 'https://worker.example.test',
      adminJwt: 'admin.jwt',
      nonAdminJwt: 'member.jwt',
      cloudRunIdentityToken: 'iam.jwt',
      cloudRunAudience: 'https://worker.example.test',
      durationMin: 720,
      concurrency: 3,
    });
  });
});

describe('ops-slo targeted driver checks', () => {
  it('accepts the current flat five-surface OPS SLO contract', () => {
    expect(hasOpsSloContract(goodBody)).toBe(true);
    expect(hasOpsSloContract({ surfaces: { old: { available: true } } })).toBe(false);
  });

  it('drives unauth 401, non-admin 403, and admin 200 contract with separate app JWT headers', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Authentication required' }))
      .mockResolvedValueOnce(jsonResponse(403, { error: 'Forbidden - platform admin access required' }))
      .mockResolvedValueOnce(jsonResponse(200, goodBody));

    const checks = await runOneCycle({
      workerUrl: 'https://worker.example.test',
      adminJwt: 'admin.jwt.secret',
      nonAdminJwt: 'member.jwt.secret',
      cloudRunIdentityToken: 'iam.jwt.secret',
      cloudRunAudience: 'https://worker.example.test',
      durationMin: 720,
      intervalMs: 30_000,
      concurrency: 1,
      timeoutMs: 1000,
      evidenceOut: null,
      admissionOut: null,
      dryRun: false,
    }, fetchImpl);

    expect(checks.map((check) => [check.name, check.status, check.http_status])).toEqual([
      ['unauthenticated', 'pass', 401],
      ['non_admin_forbidden', 'pass', 403],
      ['platform_admin_stats', 'pass', 200],
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      Accept: 'application/json',
      'X-Serverless-Authorization': 'Bearer iam.jwt.secret',
    });
    expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
    expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: 'Bearer member.jwt.secret',
      'X-Serverless-Authorization': 'Bearer iam.jwt.secret',
    });
    expect(fetchImpl.mock.calls[2][1]?.headers).toMatchObject({
      Authorization: 'Bearer admin.jwt.secret',
      'X-Serverless-Authorization': 'Bearer iam.jwt.secret',
    });
  });
});
