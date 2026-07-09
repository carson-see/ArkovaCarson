import { describe, expect, it } from 'vitest';

import {
  dlqIdFromInsert,
  planWebhookSelfServiceRequests,
  WEBHOOKS_DRIVER,
} from './webhooks-self-service-driver';

const BASE = 'https://pr-1443---arkova-worker-staging-x-uc.a.run.app';

const ARGS = {
  orgAdminKey: 'ak_admin',
  endpointId: 'ep-1',
  deliveryId: 'del-1',
  dlqId: 'dlq-1',
};

describe('webhooks-self-service-driver: request plan hits test/replay/dlq/resolve', () => {
  const plan = planWebhookSelfServiceRequests(BASE, ARGS);

  it('drives POST /webhooks/test with the ORG_ADMIN key', () => {
    const test = plan.find((p) => p.label === 'test');
    expect(test).toBeDefined();
    expect(test!.method).toBe('POST');
    expect(test!.endpoint).toBe('/api/v1/webhooks/test');
    expect(test!.headers?.['X-API-Key']).toBe('ak_admin');
    expect(JSON.parse(test!.body!)).toEqual({ endpoint_id: 'ep-1' });
  });

  it('drives POST /webhooks/deliveries/:id/replay', () => {
    const replay = plan.find((p) => p.label === 'replay');
    expect(replay).toBeDefined();
    expect(replay!.endpoint).toBe('/api/v1/webhooks/deliveries/del-1/replay');
    expect(replay!.method).toBe('POST');
  });

  it('drives GET /webhooks/dlq (list)', () => {
    const dlqList = plan.find((p) => p.label === 'dlq-list');
    expect(dlqList).toBeDefined();
    expect(dlqList!.endpoint).toBe('/api/v1/webhooks/dlq');
    expect(dlqList!.method).toBe('GET');
    expect(dlqList!.allowedStatuses).toContain(200);
  });

  it('drives POST /webhooks/dlq/:id/resolve against the seeded DLQ fixture', () => {
    const resolve = plan.find((p) => p.label === 'dlq-resolve');
    expect(resolve).toBeDefined();
    expect(resolve!.endpoint).toBe('/api/v1/webhooks/dlq/dlq-1/resolve');
    expect(resolve!.method).toBe('POST');
    expect(resolve!.allowedStatuses).toEqual([200]);
  });

  it('includes a cross-org 401 unauthenticated negative (no key)', () => {
    const noKey = plan.find((p) => p.label === 'unauthenticated');
    expect(noKey).toBeDefined();
    expect(noKey!.headers?.['X-API-Key']).toBeUndefined();
    expect(noKey!.allowedStatuses).toContain(401);
  });

  it('every authenticated request carries the ORG_ADMIN key', () => {
    for (const p of plan.filter((x) => x.label !== 'unauthenticated')) {
      expect(p.headers?.['X-API-Key']).toBe('ak_admin');
    }
  });
});

describe('webhooks-self-service-driver: metadata', () => {
  it('names PR #1471 and the driver', () => {
    expect(WEBHOOKS_DRIVER.pr).toBe('#1471');
    expect(WEBHOOKS_DRIVER.driver).toBe('webhooks-self-service');
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
