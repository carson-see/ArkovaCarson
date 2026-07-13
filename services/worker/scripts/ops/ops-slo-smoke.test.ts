import { describe, expect, it, vi } from 'vitest';
import {
  parseArgs,
  runOpsSloSmoke,
} from './ops-slo-smoke.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function htmlResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

describe('ops-slo-smoke', () => {
  it('requires JWTs from env and rejects command-line token material', () => {
    expect(() => parseArgs(['--admin-jwt=do-not-do-this'], {
      WORKER_URL: 'https://worker.example.test',
      OPS_SLO_ADMIN_JWT: 'admin.jwt',
      OPS_SLO_NON_ADMIN_JWT: 'member.jwt',
    })).toThrow('Do not pass --admin-jwt');

    expect(() => parseArgs(['--non-admin-jwt=do-not-do-this'], {
      WORKER_URL: 'https://worker.example.test',
      OPS_SLO_ADMIN_JWT: 'admin.jwt',
      OPS_SLO_NON_ADMIN_JWT: 'member.jwt',
    })).toThrow('Do not pass --non-admin-jwt');

    expect(() => parseArgs([], {
      WORKER_URL: 'https://worker.example.test',
      OPS_SLO_ADMIN_JWT: 'admin.jwt',
    })).toThrow('OPS_SLO_NON_ADMIN_JWT is required');
  });

  it('normalizes worker and optional dashboard URLs without credentials', () => {
    expect(parseArgs(['--dashboard-url=https://app.example.test/admin/ops-slo'], {
      WORKER_URL: 'https://worker.example.test/',
      OPS_SLO_ADMIN_JWT: 'admin.jwt',
      OPS_SLO_NON_ADMIN_JWT: 'member.jwt',
      WORKER_IAM_TOKEN: 'cloud-run-token',
    })).toMatchObject({
      workerUrl: 'https://worker.example.test',
      dashboardUrl: 'https://app.example.test/admin/ops-slo',
      adminJwt: 'admin.jwt',
      nonAdminJwt: 'member.jwt',
      workerIamToken: 'cloud-run-token',
      timeoutMs: 10000,
    });

    expect(() => parseArgs([], {
      WORKER_URL: 'https://user:pass@worker.example.test',
      OPS_SLO_ADMIN_JWT: 'admin.jwt',
      OPS_SLO_NON_ADMIN_JWT: 'member.jwt',
    })).toThrow('must not include credentials');
  });

  it('probes unauth, non-admin, admin, and optional dashboard route without leaking tokens', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Authentication required' }))
      .mockResolvedValueOnce(jsonResponse(403, { error: 'Forbidden - platform admin access required' }))
      .mockResolvedValueOnce(jsonResponse(200, {
        anchorSecuredRate: { available: true },
        connectorQueue: { available: true },
        creditConservation: { available: true },
        webhookDelivery: { available: true },
        apiErrors: { available: true },
        overallBreach: false,
        checkedAt: '2026-07-09T12:00:00.000Z',
      }))
      .mockResolvedValueOnce(htmlResponse(200, '<html><div id="root"></div></html>'));

    const result = await runOpsSloSmoke({
      workerUrl: 'https://worker.example.test/',
      dashboardUrl: 'https://app.example.test/admin/ops-slo',
      adminJwt: 'admin.jwt.secret',
      nonAdminJwt: 'member.jwt.secret',
      workerIamToken: 'cloud-run-token.secret',
      timeoutMs: 1000,
    }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([
      expect.objectContaining({ name: 'unauth_rejected', status: 'pass', http_status: 401 }),
      expect.objectContaining({ name: 'non_admin_forbidden', status: 'pass', http_status: 403 }),
      expect.objectContaining({ name: 'platform_admin_stats_success', status: 'pass', http_status: 200 }),
      expect.objectContaining({ name: 'dashboard_route_smoke', status: 'pass', http_status: 200 }),
    ]);
    expect(JSON.stringify(result)).not.toContain('admin.jwt.secret');
    expect(JSON.stringify(result)).not.toContain('member.jwt.secret');
    expect(JSON.stringify(result)).not.toContain('cloud-run-token.secret');

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://worker.example.test/api/admin/ops-slo-stats');
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      'X-Serverless-Authorization': 'Bearer cloud-run-token.secret',
    });
    expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
    expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: 'Bearer member.jwt.secret',
      'X-Serverless-Authorization': 'Bearer cloud-run-token.secret',
    });
    expect(fetchImpl.mock.calls[2][1]?.headers).toMatchObject({
      Authorization: 'Bearer admin.jwt.secret',
      'X-Serverless-Authorization': 'Bearer cloud-run-token.secret',
    });
    expect(fetchImpl.mock.calls[3][0]).toBe('https://app.example.test/admin/ops-slo');
  });

  it('skips dashboard route smoke when no dashboard URL is configured', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Authentication required' }))
      .mockResolvedValueOnce(jsonResponse(403, { error: 'Forbidden - platform admin access required' }))
      .mockResolvedValueOnce(jsonResponse(200, {
        anchorSecuredRate: { available: false },
        connectorQueue: { available: false },
        creditConservation: { available: false },
        webhookDelivery: { available: false },
        apiErrors: { available: false },
        overallBreach: false,
        checkedAt: '2026-07-09T12:00:00.000Z',
      }));

    const result = await runOpsSloSmoke({
      workerUrl: 'https://worker.example.test',
      dashboardUrl: null,
      adminJwt: 'admin.jwt.secret',
      nonAdminJwt: 'member.jwt.secret',
      workerIamToken: null,
      timeoutMs: 1000,
    }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([
      expect.objectContaining({ name: 'unauth_rejected', status: 'pass' }),
      expect.objectContaining({ name: 'non_admin_forbidden', status: 'pass' }),
      expect.objectContaining({ name: 'platform_admin_stats_success', status: 'pass' }),
      expect.objectContaining({ name: 'dashboard_route_smoke', status: 'skip' }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
