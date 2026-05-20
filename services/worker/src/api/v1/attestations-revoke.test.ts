import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Filter = {
  column: string;
  value: unknown;
};

type QueryRecord = {
  table: string;
  filters: Filter[];
  updatePayload?: unknown;
};

const { mockFrom, verifyAuthToken, queries } = vi.hoisted(() => {
  type LocalFilter = {
    column: string;
    value: unknown;
  };

  type LocalQueryRecord = {
    table: string;
    filters: LocalFilter[];
    updatePayload?: unknown;
  };

  const queries: LocalQueryRecord[] = [];
  const verifyAuthToken = vi.fn(async () => 'user-auth');

  const fixture = {
    id: 'attestation-internal-id',
    status: 'ACTIVE',
    attester_user_id: 'other-user',
    attester_org_id: 'org-a',
  };

  function hasEq(filters: LocalFilter[], column: string, value: unknown): boolean {
    return filters.some((filter) => filter.column === column && filter.value === value);
  }

  function createBuilder(table: string) {
    const record: LocalQueryRecord = { table, filters: [] };
    queries.push(record);

    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn((column: string, value: unknown) => {
      record.filters.push({ column, value });
      return builder;
    });
    builder.neq = vi.fn((column: string, value: unknown) => {
      record.filters.push({ column, value });
      return builder;
    });
    builder.update = vi.fn((payload: unknown) => {
      record.updatePayload = payload;
      return builder;
    });
    builder.single = vi.fn(async () => {
      if (
        table === 'attestations'
        && hasEq(record.filters, 'public_id', 'ARK-ORGA-VER-ABC123')
        && !hasEq(record.filters, 'attester_user_id', 'user-auth')
      ) {
        return { data: fixture, error: null };
      }

      return { data: null, error: { code: 'PGRST116', message: 'No rows' } };
    });
    builder.maybeSingle = vi.fn(async () => ({ data: { id: fixture.id }, error: null }));

    return builder;
  }

  return {
    mockFrom: vi.fn((table: string) => createBuilder(table)),
    verifyAuthToken,
    queries,
  };
});

vi.mock('../../utils/db.js', () => ({
  db: { from: mockFrom },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai', bitcoinNetwork: 'signet' },
}));

vi.mock('../../auth.js', () => ({
  verifyAuthToken,
}));

vi.mock('../../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: vi.fn(),
}));

import { attestationsRouter } from './attestations.js';

function appWithRouter() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/attestations', attestationsRouter);
  return app;
}

describe('attestation revoke ownership responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queries.length = 0;
    verifyAuthToken.mockResolvedValue('user-auth');
  });

  it('returns the published 403 response when a different user owns the attestation', async () => {
    const res = await request(appWithRouter())
      .patch('/api/v1/attestations/ARK-ORGA-VER-ABC123/revoke')
      .set('Authorization', 'Bearer jwt-token')
      .send({ reason: 'Wrong owner regression test' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Only the attester can revoke an attestation' });

    const findQuery = queries.find((query: QueryRecord) => query.table === 'attestations');
    expect(findQuery?.filters).toContainEqual({ column: 'public_id', value: 'ARK-ORGA-VER-ABC123' });
    expect(findQuery?.filters).not.toContainEqual({ column: 'attester_user_id', value: 'user-auth' });
    expect(queries.some((query: QueryRecord) => query.updatePayload)).toBe(false);
  });
});
