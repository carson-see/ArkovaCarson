import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Request } from 'express';
import request from 'supertest';

vi.mock('../../config.js', () => ({
  config: { nodeEnv: 'test', apiKeyHmacSecret: 'test-secret' },
}));

vi.mock('../../middleware/featureGate.js', () => ({
  verificationApiGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('./auth.js', () => ({
  apiKeyAuthV2: () => (req: Request, _res: unknown, next: () => void) => {
    req.apiKey = {
      keyId: 'key-1',
      orgId: 'org-1',
      userId: 'user-1',
      scopes: ['read:search', 'read:records', 'read:orgs'],
      rateLimitTier: 'paid',
      keyPrefix: 'ak_test_',
    };
    next();
  },
}));

vi.mock('./rateLimit.js', () => ({
  v2ApiKeyRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  createV2ScopeRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../middleware/errorSanitizer.js', () => ({
  sanitizeErrorMessage: (m: string) => m,
}));

import { apiV2Router } from './router.js';
import { openApiV2Spec } from './openapi.js';
import { db } from '../../utils/db.js';

function buildApp() {
  const app = express();
  app.use('/api/v2', apiV2Router);
  return app;
}

type JsonSchema = {
  $ref?: string;
  type?: string | readonly string[];
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
};

type QueryTerminal = 'order' | 'maybeSingle';

function resolveSchema(schema: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace('#/components/schemas/', '');
  const resolved = (openApiV2Spec.components.schemas as Record<string, JsonSchema>)[name];
  if (!resolved) throw new Error(`Unknown OpenAPI schema ref ${schema.$ref}`);
  return resolved;
}

function schemaTypes(schema: JsonSchema): string[] {
  const { type } = schema;
  if (Array.isArray(type)) return [...type] as string[];
  return typeof type === 'string' ? [type] : [];
}

function matchesJsonType(type: string, value: unknown): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

function validateObject(schema: JsonSchema, value: unknown, path: string): void {
  expect(typeof value, `${path} type`).toBe('object');
  expect(Array.isArray(value), `${path} type`).toBe(false);
  const objectValue = value as Record<string, unknown>;

  for (const required of schema.required ?? []) {
    expect(objectValue, `${path}.${required} required`).toHaveProperty(required);
  }

  for (const [key, childValue] of Object.entries(objectValue)) {
    const childSchema = schema.properties?.[key];
    if (childSchema) {
      validateSchema(childSchema, childValue, `${path}.${key}`);
      continue;
    }

    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      validateSchema(schema.additionalProperties, childValue, `${path}.${key}`);
      continue;
    }

    expect(
      schema.additionalProperties === true,
      `${path}.${key} is not documented in OpenAPI schema`,
    ).toBe(true);
  }
}

function validateSchema(schema: JsonSchema, value: unknown, path = '$'): void {
  const resolved = resolveSchema(schema);
  if (resolved.enum) {
    expect(resolved.enum, `${path} enum`).toContain(value);
  }

  const allowedTypes = schemaTypes(resolved);

  if (value === null) {
    expect(allowedTypes, `${path} nullability`).toContain('null');
    return;
  }

  if (allowedTypes.length > 0) {
    const matchesType = allowedTypes.some(type => matchesJsonType(type, value));
    expect(matchesType, `${path} type`).toBe(true);
  }

  if (allowedTypes.includes('array')) {
    expect(Array.isArray(value), `${path} type`).toBe(true);
    const itemSchema = resolved.items;
    if (itemSchema) {
      for (const [index, item] of (value as unknown[]).entries()) {
        validateSchema(itemSchema, item, `${path}[${index}]`);
      }
    }
    return;
  }

  if (!allowedTypes.includes('object')) return;

  validateObject(resolved, value, path);
}

function successSchemaFor(specPath: keyof typeof openApiV2Spec.paths): JsonSchema {
  const schema = openApiV2Spec.paths[specPath].get.responses['200'].content?.['application/json']?.schema;
  if (!schema) throw new Error(`Missing 200 application/json schema for ${String(specPath)}`);
  return schema as JsonSchema;
}

function mockQueryResult(data: unknown, terminal: QueryTerminal) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(),
    order: vi.fn(),
  };
  chain.order.mockImplementation(() => (
    terminal === 'order'
      ? Promise.resolve({ data, error: null })
      : chain
  ));
  chain.maybeSingle.mockResolvedValue({ data, error: null });
  return chain;
}

const anchorRow = {
  public_id: 'ARK-DOC-ABC',
  filename: 'Credential.pdf',
  description: 'Verified credential',
  credential_type: 'PROFESSIONAL',
  sub_type: 'employment',
  status: 'SECURED',
  fingerprint: 'a'.repeat(64),
  created_at: '2026-05-05T12:00:00Z',
  chain_timestamp: '2026-05-05T12:01:00Z',
  chain_tx_id: 'tx-abc',
  issued_at: '2026-05-01',
  expires_at: null,
  metadata: {
    issuer: 'Acme HR',
    source_url: 'https://issuer.example/abc',
    recipient_email: 'private@example.com',
  },
};

const orgRow = {
  public_id: 'org_acme',
  display_name: 'Acme Corp',
  description: 'Verified issuer',
  domain: 'acme.com',
  website_url: 'https://acme.com',
};

const orgDetailRow = {
  ...orgRow,
  verification_status: 'VERIFIED',
};

function fromResult(data: unknown, terminal: QueryTerminal) {
  return () => {
    vi.mocked(db.from).mockReturnValueOnce(mockQueryResult(data, terminal) as never);
  };
}

function rpcResult(data: unknown) {
  return () => {
    vi.mocked(db.rpc).mockResolvedValueOnce({ data, error: null } as never);
  };
}

describe('apiV2Router', () => {
  it('serves the OpenAPI 3.1 spec before API-key auth', async () => {
    const res = await request(buildApp()).get('/api/v2/openapi.json');

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/search'].get['x-agent-usage']).toBeTruthy();
  });

  it('returns problem+json for unmatched v2 routes', async () => {
    const res = await request(buildApp()).get('/api/v2/nope');

    expect(res.status).toBe(404);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/not-found');
  });

  it('keeps implemented 200 response bodies aligned with OpenAPI schemas', async () => {
    const app = buildApp();
    const fingerprint = 'a'.repeat(64);
    const cases = [
      {
        specPath: '/search',
        requestPath: '/api/v2/search?q=acme&type=org',
        arrange: fromResult([orgRow], 'order'),
      },
      {
        specPath: '/organizations',
        requestPath: '/api/v2/organizations?q=acme',
        arrange: fromResult([orgRow], 'order'),
      },
      {
        specPath: '/records',
        requestPath: '/api/v2/records?q=credential',
        arrange: () => {
          vi.mocked(db.from).mockReturnValueOnce(mockQueryResult([{
            public_id: 'ARK-DOC-ABC',
            filename: 'Credential.pdf',
            description: 'Verified credential',
            credential_type: 'PROFESSIONAL',
            status: 'SECURED',
            fingerprint,
          }], 'order') as never);
        },
      },
      {
        specPath: '/fingerprints',
        requestPath: `/api/v2/fingerprints?q=${fingerprint}`,
        arrange: () => {
          vi.mocked(db.from).mockReturnValueOnce(mockQueryResult([{
            public_id: 'ARK-DOC-ABC',
            filename: 'Credential.pdf',
            status: 'SECURED',
            fingerprint,
          }], 'order') as never);
        },
      },
      {
        specPath: '/documents',
        requestPath: '/api/v2/documents?q=credential',
        arrange: () => {
          vi.mocked(db.from).mockReturnValueOnce(mockQueryResult([{
            public_id: 'ARK-DOC-ABC',
            filename: 'Credential.pdf',
            description: 'Verified credential',
            metadata: { issuer: 'Acme HR' },
            credential_type: 'PROFESSIONAL',
            status: 'SECURED',
          }], 'order') as never);
        },
      },
      {
        specPath: '/verify/{fingerprint}',
        requestPath: `/api/v2/verify/${fingerprint}`,
        arrange: () => {
          vi.mocked(db.from).mockReturnValueOnce(mockQueryResult({
            public_id: 'ARK-DOC-ABC',
            fingerprint,
            filename: 'Credential.pdf',
            status: 'SECURED',
            created_at: '2026-05-05T12:00:00Z',
            chain_tx_id: 'tx-abc',
          }, 'maybeSingle') as never);
        },
      },
      {
        specPath: '/anchors/{public_id}',
        requestPath: '/api/v2/anchors/ARK-DOC-ABC',
        arrange: rpcResult({
          org_name: 'Acme Corp',
          credential_type: 'PROFESSIONAL',
          status: 'SECURED',
          issued_at: '2026-05-01',
          expires_at: null,
          created_at: '2026-05-05T12:00:00Z',
          chain_tx_id: 'tx-abc',
        }),
      },
      {
        specPath: '/orgs',
        requestPath: '/api/v2/orgs',
        arrange: fromResult(orgDetailRow, 'maybeSingle'),
      },
      {
        specPath: '/organizations/{public_id}',
        requestPath: '/api/v2/organizations/org_acme',
        arrange: fromResult(orgDetailRow, 'maybeSingle'),
      },
      {
        specPath: '/records/{public_id}',
        requestPath: '/api/v2/records/ARK-DOC-ABC',
        arrange: fromResult(anchorRow, 'maybeSingle'),
      },
      {
        specPath: '/fingerprints/{fingerprint}',
        requestPath: `/api/v2/fingerprints/${fingerprint}`,
        arrange: fromResult(anchorRow, 'maybeSingle'),
      },
      {
        specPath: '/documents/{public_id}',
        requestPath: '/api/v2/documents/ARK-DOC-ABC',
        arrange: fromResult(anchorRow, 'maybeSingle'),
      },
    ] as const;

    for (const testCase of cases) {
      vi.clearAllMocks();
      testCase.arrange();

      const res = await request(app).get(testCase.requestPath);

      expect(res.status, testCase.requestPath).toBe(200);
      validateSchema(successSchemaFor(testCase.specPath), res.body);
      expect(JSON.stringify(res.body), `${testCase.requestPath} metadata exposure`).not.toContain('recipient_email');
      expect(JSON.stringify(res.body), `${testCase.requestPath} metadata exposure`).not.toContain('private@example.com');
    }
  });
});
