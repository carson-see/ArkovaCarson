/**
 * SCRUM-1733: parity contract tests.
 *
 * Validates that the canonical Zod schemas in mcpParity.ts:
 *   1. Reject internal-UUID-bearing payloads (banned fields).
 *   2. Accept the documented public-only shapes.
 *   3. Match the v2 REST handler return types compile-time via z.infer.
 *
 * The edge MCP side imports MCP_PARITY_SCHEMAS from the same module
 * (services/edge/src/mcp-tools.ts can pull a Zod-only ESM dep at the
 * Cloudflare Worker boundary). When it does, both sides validate
 * against the same source — drift fails loud at PR time.
 */

import { describe, it, expect } from 'vitest';
import {
  SearchResultSchema,
  SearchResponseSchema,
  VerifyAnchorResultSchema,
  ResourceDetailSchema,
  MCP_PARITY_SCHEMAS,
  BANNED_RESPONSE_FIELDS,
  assertNoBannedFields,
} from './mcpParity.js';

describe('SCRUM-1733 — REST v2 ↔ MCP parity contract', () => {
  describe('SearchResultSchema', () => {
    const valid = {
      type: 'org' as const,
      public_id: 'pub_org_xyz',
      score: 0.87,
      snippet: 'Example organization',
    };

    it('accepts a fully-populated public-only result', () => {
      expect(SearchResultSchema.safeParse(valid).success).toBe(true);
      expect(SearchResultSchema.safeParse({ ...valid, metadata: { foo: 'bar' } }).success).toBe(true);
    });

    it('rejects a result with a banned internal-UUID field (CLAUDE.md §6)', () => {
      for (const banned of BANNED_RESPONSE_FIELDS) {
        const tainted = { ...valid, [banned]: '550e8400-e29b-41d4-a716-446655440000' };
        expect(SearchResultSchema.safeParse(tainted).success).toBe(false);
      }
    });

    it('rejects unknown result types', () => {
      expect(SearchResultSchema.safeParse({ ...valid, type: 'pwned' }).success).toBe(false);
    });

    it('rejects scores outside [0, 1]', () => {
      expect(SearchResultSchema.safeParse({ ...valid, score: -0.1 }).success).toBe(false);
      expect(SearchResultSchema.safeParse({ ...valid, score: 1.5 }).success).toBe(false);
    });
  });

  describe('SearchResponseSchema', () => {
    const valid = {
      results: [{ type: 'record' as const, public_id: 'ARK-2026-X', score: 1, snippet: 'x' }],
      next_cursor: null,
    };

    it('accepts a single-page response', () => {
      expect(SearchResponseSchema.safeParse(valid).success).toBe(true);
    });

    it('accepts a paginated response with next_cursor', () => {
      expect(SearchResponseSchema.safeParse({ ...valid, next_cursor: 'eyJvZmZzZXQiOjUwfQ' }).success).toBe(true);
    });

    it('rejects unknown top-level keys', () => {
      expect(SearchResponseSchema.safeParse({ ...valid, total: 100 }).success).toBe(false);
    });
  });

  describe('VerifyAnchorResultSchema', () => {
    it('accepts the minimum verified=true response', () => {
      expect(VerifyAnchorResultSchema.safeParse({ verified: true, status: 'ACTIVE' }).success).toBe(true);
    });

    it('accepts the verified=false error response', () => {
      expect(VerifyAnchorResultSchema.safeParse({ verified: false, error: 'not_found' }).success).toBe(true);
    });

    it('rejects banned UUID fields on the verify response', () => {
      for (const banned of BANNED_RESPONSE_FIELDS) {
        expect(VerifyAnchorResultSchema.safeParse({
          verified: true,
          status: 'ACTIVE',
          [banned]: 'uuid',
        }).success).toBe(false);
      }
    });

    it('rejects unknown status values', () => {
      expect(VerifyAnchorResultSchema.safeParse({ verified: true, status: 'PWNED' }).success).toBe(false);
    });
  });

  describe('ResourceDetailSchema', () => {
    const valid = {
      type: 'record' as const,
      public_id: 'ARK-2026-A1',
      verified: true,
      status: 'ACTIVE',
    };

    it('accepts the minimum public detail shape', () => {
      expect(ResourceDetailSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects banned UUID fields on the detail response', () => {
      for (const banned of BANNED_RESPONSE_FIELDS) {
        expect(ResourceDetailSchema.safeParse({ ...valid, [banned]: 'uuid' }).success).toBe(false);
      }
    });

    it('accepts nullable optional fields', () => {
      expect(ResourceDetailSchema.safeParse({
        ...valid,
        title: null,
        description: null,
        credential_type: null,
      }).success).toBe(true);
    });
  });

  describe('MCP_PARITY_SCHEMAS export', () => {
    it('exposes all four canonical schemas', () => {
      expect(MCP_PARITY_SCHEMAS.searchResult).toBeDefined();
      expect(MCP_PARITY_SCHEMAS.searchResponse).toBeDefined();
      expect(MCP_PARITY_SCHEMAS.verifyAnchorResult).toBeDefined();
      expect(MCP_PARITY_SCHEMAS.resourceDetail).toBeDefined();
    });
  });

  describe('assertNoBannedFields runtime guard', () => {
    it('passes for a clean public-only object', () => {
      expect(() => assertNoBannedFields({ public_id: 'x', status: 'ACTIVE' }, 'test')).not.toThrow();
    });

    it('throws with a clear message when a banned field is present', () => {
      for (const banned of BANNED_RESPONSE_FIELDS) {
        expect(() => assertNoBannedFields({ public_id: 'x', [banned]: 'uuid' }, 'test'))
          .toThrow(new RegExp(`banned field "${banned}"`));
      }
    });
  });
});
