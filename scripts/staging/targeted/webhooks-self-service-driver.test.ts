import { describe, expect, it } from 'vitest';

import {
  dlqIdFromInsert,
  jwtExpiresAtMs,
  planWebhookDlqApiKeyRequests,
  planWebhookSelfServiceRequests,
  WEBHOOKS_DRIVER,
  WEBHOOKS_PASS_INTERVAL_MS,
} from './webhooks-self-service-driver';

const BASE = 'https://pr-1443---arkova-worker-staging-x-uc.a.run.app';

const JWT_ARGS = {
  orgAdminJwt: 'jwt_admin',
  endpointId: 'ep-1',
  deliveryId: 'del-1',
  dlqId: 'dlq-1',
};

const API_KEY_ARGS = {
  orgAdminKey: 'ak_admin',
  dlqId: 'dlq-1',
};

describe('webhooks-self-service-driver: #1443 JWT plan hits test/replay/dlq/resolve', () => {
  const plan = planWebhookSelfServiceRequests(BASE, JWT_ARGS);

  it('drives POST /webhooks/self-service/:id/test with the ORG_ADMIN JWT', () => {
    const test = plan.find((p) => p.label === 'test');
    expect(test).toBeDefined();
    expect(test!.method).toBe('POST');
    expect(test!.endpoint).toBe('/api/v1/webhooks/self-service/ep-1/test');
    expect(test!.headers?.Authorization).toBe('Bearer jwt_admin');
    expect(test!.body).toBeUndefined();
  });

  it('drives POST /webhooks/self-service/deliveries/:id/replay', () => {
    const replay = plan.find((p) => p.label === 'replay');
    expect(replay).toBeDefined();
    expect(replay!.endpoint).toBe('/api/v1/webhooks/self-service/deliveries/del-1/replay');
    expect(replay!.method).toBe('POST');
  });

  it('drives GET /webhooks/self-service/dlq (list)', () => {
    const dlqList = plan.find((p) => p.label === 'dlq-list');
    expect(dlqList).toBeDefined();
    expect(dlqList!.endpoint).toBe('/api/v1/webhooks/self-service/dlq');
    expect(dlqList!.method).toBe('GET');
    expect(dlqList!.allowedStatuses).toContain(200);
  });

  it('drives POST /webhooks/self-service/dlq/:id/resolve strictly against the per-pass seeded DLQ fixture', () => {
    const resolve = plan.find((p) => p.label === 'dlq-resolve');
    expect(resolve).toBeDefined();
    expect(resolve!.endpoint).toBe('/api/v1/webhooks/self-service/dlq/dlq-1/resolve');
    expect(resolve!.method).toBe('POST');
    // 404 is not accepted — that was #1471's false-return symptom; per-pass
    // reseeding guarantees a live target.
    expect(resolve!.allowedStatuses).toEqual([200]);
  });

  it('includes a 401 unauthenticated negative (no Supabase JWT), tolerating anonymous-limiter 429s', () => {
    const noKey = plan.find((p) => p.label === 'unauthenticated');
    expect(noKey).toBeDefined();
    expect(noKey!.headers?.Authorization).toBeUndefined();
    expect(noKey!.allowedStatuses).toContain(401);
    expect(noKey!.allowedStatuses).toContain(429);
  });

  it('every authenticated request carries the ORG_ADMIN Supabase JWT', () => {
    for (const p of plan.filter((x) => x.label !== 'unauthenticated')) {
      expect(p.headers?.Authorization).toBe('Bearer jwt_admin');
    }
  });
});

describe('webhooks-self-service-driver: merged #1471 API-key DLQ plan', () => {
  const plan = planWebhookDlqApiKeyRequests(BASE, API_KEY_ARGS);

  it('drives GET /webhooks/dlq (list)', () => {
    const dlqList = plan.find((p) => p.label === 'api-dlq-list');
    expect(dlqList).toBeDefined();
    expect(dlqList!.endpoint).toBe('/api/v1/webhooks/dlq');
    expect(dlqList!.method).toBe('GET');
    expect(dlqList!.allowedStatuses).toContain(200);
  });

  it('drives POST /webhooks/dlq/:id/resolve against the seeded DLQ fixture', () => {
    const resolve = plan.find((p) => p.label === 'api-dlq-resolve');
    expect(resolve).toBeDefined();
    expect(resolve!.endpoint).toBe('/api/v1/webhooks/dlq/dlq-1/resolve');
    expect(resolve!.method).toBe('POST');
    // 404 is not accepted because that was #1471's false-return symptom.
    expect(resolve!.allowedStatuses).toEqual([200]);
  });

  it('includes a 401 unauthenticated negative (no key)', () => {
    const noKey = plan.find((p) => p.label === 'api-unauthenticated');
    expect(noKey).toBeDefined();
    expect(noKey!.headers?.['X-API-Key']).toBeUndefined();
    expect(noKey!.allowedStatuses).toContain(401);
  });

  it('every authenticated request carries the ORG_ADMIN key', () => {
    for (const p of plan.filter((x) => x.label !== 'api-unauthenticated')) {
      expect(p.headers?.['X-API-Key']).toBe('ak_admin');
    }
  });

  it('keeps the per-pass request count below the effective staging limiter edge', () => {
    expect(plan).toHaveLength(3);
  });
});

describe('webhooks-self-service-driver: metadata', () => {
  it('names PR #1443 and the driver', () => {
    expect(WEBHOOKS_DRIVER.pr).toBe('#1443');
    expect(WEBHOOKS_DRIVER.driver).toBe('webhooks-self-service');
  });

  it('paces passes below the JWT-gated batch limiter budget', () => {
    expect(WEBHOOKS_PASS_INTERVAL_MS).toBeGreaterThanOrEqual(65_000);
  });
});

describe('webhooks-self-service-driver: JWT refresh helpers', () => {
  it('reads exp from a Supabase-style JWT payload', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000 }), 'utf8').toString('base64url');

    expect(jwtExpiresAtMs(`header.${payload}.sig`)).toBe(1_800_000_000_000);
  });

  it('returns null for malformed JWTs', () => {
    expect(jwtExpiresAtMs('not-a-jwt')).toBeNull();
  });
});

describe('webhooks-self-service-driver: seeded DLQ id', () => {
  it('uses the real inserted id for dlq-resolve planning', () => {
    expect(dlqIdFromInsert([{ id: 'dlq-real-1' }])).toBe('dlq-real-1');
  });

  it('fails closed instead of substituting a fake id when seeding returns no row', () => {
    expect(() => dlqIdFromInsert([])).toThrow(/DLQ fixture seeding returned no row/);
  });
});
