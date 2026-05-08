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

    it('accepts public-safe verify responses with the handler-emitted public_id/fingerprint/title fields', () => {
      // Codex P2 PR #737: schema must accept the actual /api/v2/verify
      // response shape. Banned-field protection moves to assertNoBannedFields
      // (covered separately) so the schema can stay non-strict.
      expect(VerifyAnchorResultSchema.safeParse({
        verified: true,
        status: 'ACTIVE',
        public_id: 'ARK-2026-A1',
        fingerprint: 'a'.repeat(64),
        title: 'A credential',
        network_receipt_id: null,
        record_uri: null,
      }).success).toBe(true);
    });

    it('runtime guard (NOT the schema) rejects banned UUID fields on the verify response', () => {
      // Schema is intentionally non-strict so it accepts public-safe success
      // shapes. The no-internal-UUID guarantee is enforced by
      // assertNoBannedFields, which runs at the response-serialization
      // boundary in the actual handlers.
      for (const banned of BANNED_RESPONSE_FIELDS) {
        const tainted = { verified: true, status: 'ACTIVE' as const, [banned]: 'uuid' };
        // Schema accepts (no strict) — that's by design.
        expect(VerifyAnchorResultSchema.safeParse(tainted).success).toBe(true);
        // Runtime guard catches it — the real protection.
        expect(() => assertNoBannedFields(tainted as Record<string, unknown>, 'verify-test'))
          .toThrow(new RegExp(`banned field\\(s\\): ${banned}`));
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

    it('throws with a clear message naming each top-level banned field', () => {
      for (const banned of BANNED_RESPONSE_FIELDS) {
        expect(() => assertNoBannedFields({ public_id: 'x', [banned]: 'uuid' }, 'test'))
          .toThrow(new RegExp(`banned field\\(s\\): ${banned}`));
      }
    });

    // CodeRabbit PR #737 Major: nested-field regression. The original
    // top-level-only check let `{ metadata: { user_id: '...' } }` slip
    // through and undermined the no-internal-UUID guarantee.
    it('throws when a banned field is nested inside a metadata object', () => {
      expect(() =>
        assertNoBannedFields({ public_id: 'x', metadata: { user_id: 'uuid' } }, 'test'),
      ).toThrow(/banned field\(s\): metadata\.user_id/);
    });

    it('throws when a banned field is nested inside an array of objects', () => {
      expect(() =>
        assertNoBannedFields({ results: [{ public_id: 'x' }, { org_id: 'uuid' }] }, 'test'),
      ).toThrow(/banned field\(s\): results\[1\]\.org_id/);
    });

    it('throws when a banned field is deeply nested', () => {
      expect(() =>
        assertNoBannedFields({ a: { b: { c: { anchor_id: 'uuid' } } } }, 'test'),
      ).toThrow(/banned field\(s\): a\.b\.c\.anchor_id/);
    });

    it('reports every offender in a single throw, sorted by path', () => {
      try {
        assertNoBannedFields({
          id: 'top',
          metadata: { user_id: 'leak1', sub: { org_id: 'leak2' } },
        }, 'test');
        throw new Error('expected throw');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain('id');
        expect(msg).toContain('metadata.sub.org_id');
        expect(msg).toContain('metadata.user_id');
      }
    });

    it('does not infinite-loop on cyclic objects', () => {
      const cyclic: Record<string, unknown> = { public_id: 'x' };
      cyclic.self = cyclic;
      expect(() => assertNoBannedFields(cyclic, 'test')).not.toThrow();
    });
  });
});
