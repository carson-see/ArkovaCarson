/**
 * Tests for SCRUM-1122 — CIBA OpenAPI spec module.
 */
import { describe, expect, it } from 'vitest';
import { cibaOpenApiSpec, getCibaOpenApiSpec } from './openapi-ciba.js';

describe('CIBA OpenAPI spec (SCRUM-1122)', () => {
  it('valid OpenAPI 3.x metadata', () => {
    expect(cibaOpenApiSpec.openapi).toMatch(/^3\./);
    expect(cibaOpenApiSpec.info?.title).toMatch(/Arkova/i);
    expect(typeof cibaOpenApiSpec.info?.version).toBe('string');
  });

  it('lists every CIBA endpoint shipped in this release', () => {
    const paths = Object.keys(cibaOpenApiSpec.paths ?? {});
    // Endpoints from PR #538 (batch 1)
    expect(paths).toContain('/api/rules');
    expect(paths).toContain('/api/rules/{id}');
    expect(paths).toContain('/api/rules/test');
    expect(paths).toContain('/api/rules/demo-event');
    expect(paths).toContain('/api/compliance-inbox/summary');
    // Endpoints from PR #539 (batch 2)
    expect(paths).toContain('/api/queue/pending');
    expect(paths).toContain('/api/queue/resolve');
    expect(paths).toContain('/api/queue/collision/{externalFileId}');
    expect(paths).toContain('/api/connectors/health');
    expect(paths).toContain('/api/proof-packet/execution/{executionId}');
    // Webhook endpoints
    expect(paths).toContain('/webhooks/docusign');
    expect(paths).toContain('/webhooks/adobe-sign');
    expect(paths).toContain('/webhooks/checkr');
  });

  it('every operation declares an auth model in security or tags', () => {
    const paths = cibaOpenApiSpec.paths ?? {};
    const verbs = ['get', 'post', 'put', 'patch', 'delete'] as const;
    for (const [path, item] of Object.entries(paths)) {
      const operations = item as Record<string, unknown>;
      for (const verb of verbs) {
        const op = operations[verb] as { security?: unknown[]; tags?: string[] } | undefined;
        if (!op) continue;
        const hasSecurity = Array.isArray(op.security);
        const hasAuthTag = (op.tags ?? []).some((t) => /auth|admin|hmac|webhook/i.test(t));
        expect(hasSecurity || hasAuthTag).toBe(true);
        if (!hasSecurity && !hasAuthTag) {
          throw new Error(`Operation ${verb.toUpperCase()} ${path} lacks an auth declaration`);
        }
      }
    }
  });

  it('declares OrgAdminBearer + PlatformAdminBearer + WebhookHmac security schemes', () => {
    const schemes = cibaOpenApiSpec.components?.securitySchemes ?? {};
    expect(Object.keys(schemes)).toEqual(
      expect.arrayContaining(['OrgAdminBearer', 'PlatformAdminBearer', 'WebhookHmac']),
    );
  });

  it('every webhook endpoint references the WebhookHmac scheme', () => {
    const paths = cibaOpenApiSpec.paths ?? {};
    for (const [path, item] of Object.entries(paths)) {
      if (!path.startsWith('/webhooks/')) continue;
      const post = (item as { post?: { security?: Array<Record<string, string[]>> } }).post;
      const declares = (post?.security ?? []).some((entry) => 'WebhookHmac' in entry);
      expect(declares).toBe(true);
    }
  });

  it('spec serializes to valid JSON via getCibaOpenApiSpec()', () => {
    const json = JSON.stringify(getCibaOpenApiSpec());
    expect(json.length).toBeGreaterThan(1000);
    expect(JSON.parse(json).openapi).toMatch(/^3\./);
  });

  it('cross-references the source-of-truth Zod schemas in path descriptions', () => {
    const json = JSON.stringify(cibaOpenApiSpec);
    expect(json).toContain('rules/schemas.ts');
    expect(json).toContain('queue-resolution.ts');
  });
});
