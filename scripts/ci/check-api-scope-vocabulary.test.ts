import { describe, expect, it } from 'vitest';
import {
  collectScopeVocabularyViolations,
  diffOrdered,
  extractMarkdownCodeScopes,
  extractSqlConstraintScopes,
  parseScopeVocabulary,
} from './check-api-scope-vocabulary.js';

const WORKER_SCOPE_SOURCE = `
  export const API_V2_SCOPES = ['read:records', 'read:search'] as const;
  export const LEGACY_API_SCOPES = ['verify'] as const;
  export const COMPLIANCE_API_SCOPES = ['oracle:read'] as const;
  export const API_KEY_SCOPES = [
    ...API_V2_SCOPES,
    ...LEGACY_API_SCOPES,
    ...COMPLIANCE_API_SCOPES,
  ] as const;
  export const DEFAULT_API_KEY_SCOPES: ApiV2Scope[] = ['read:search'];
`;

describe('check-api-scope-vocabulary', () => {
  it('resolves spread-backed exported scope arrays in order', () => {
    expect(parseScopeVocabulary(WORKER_SCOPE_SOURCE)).toEqual({
      API_V2_SCOPES: ['read:records', 'read:search'],
      LEGACY_API_SCOPES: ['verify'],
      COMPLIANCE_API_SCOPES: ['oracle:read'],
      API_KEY_SCOPES: ['read:records', 'read:search', 'verify', 'oracle:read'],
      DEFAULT_API_KEY_SCOPES: ['read:search'],
    });
  });

  it('reports ordered array drift', () => {
    expect(diffOrdered('frontend API_KEY_SCOPES', ['a', 'b'], ['b', 'a'])).toEqual([
      {
        surface: 'frontend API_KEY_SCOPES',
        detail: 'same values, different order | expected: a, b | actual: b, a',
      },
    ]);
  });

  it('extracts only the active DB CHECK constraint scope array', () => {
    const scopes = extractSqlConstraintScopes(`
      -- COMMENT ON COLUMN public.api_keys.scopes IS 'oracle:read';
      ALTER TABLE public.api_keys
        ADD CONSTRAINT api_keys_scopes_known_values
        CHECK (
          array_length(scopes, 1) >= 1
          AND scopes <@ ARRAY[
            'read:records',
            'verify'
          ]::text[]
        );
    `);

    expect(scopes).toEqual(['read:records', 'verify']);
  });

  it('extracts backticked scope names from markdown', () => {
    expect(extractMarkdownCodeScopes('Scopes: `read:records`, `verify`, and `not a scope`.')).toEqual([
      'read:records',
      'verify',
    ]);
  });

  it('passes when every surface matches the worker vocabulary', () => {
    const violations = collectScopeVocabularyViolations({
      workerSource: WORKER_SCOPE_SOURCE,
      frontendSource: WORKER_SCOPE_SOURCE,
      dbConstraintSql: `
        ALTER TABLE public.api_keys
          ADD CONSTRAINT api_keys_scopes_known_values
          CHECK (scopes <@ ARRAY['read:records', 'read:search', 'verify', 'oracle:read']::text[]);
        ALTER TABLE public.agents
          ADD CONSTRAINT agents_allowed_scopes_known_values
          CHECK (allowed_scopes <@ ARRAY['read:records', 'read:search', 'verify', 'oracle:read']::text[]);
      `,
      apiReadmeMarkdown: '`read:records`, `read:search`, `verify`, `oracle:read`',
      v2MigrationMarkdown: '`read:records`, `read:search`',
      v1OpenApiYaml: 'read:records\nread:search\nverify\noracle:read',
    });

    expect(violations).toEqual([]);
  });

  it('flags old SQL constraints that miss compliance scopes', () => {
    const violations = collectScopeVocabularyViolations({
      workerSource: WORKER_SCOPE_SOURCE,
      frontendSource: WORKER_SCOPE_SOURCE,
      dbConstraintSql: `
        ALTER TABLE public.api_keys
          ADD CONSTRAINT api_keys_scopes_known_values
          CHECK (scopes <@ ARRAY['read:records', 'read:search', 'verify']::text[]);
        ALTER TABLE public.agents
          ADD CONSTRAINT agents_allowed_scopes_known_values
          CHECK (allowed_scopes <@ ARRAY['read:records', 'read:search', 'verify', 'oracle:read']::text[]);
      `,
      apiReadmeMarkdown: '`read:records`, `read:search`, `verify`, `oracle:read`',
      v2MigrationMarkdown: '`read:records`, `read:search`',
      v1OpenApiYaml: 'read:records\nread:search\nverify\noracle:read',
    });

    expect(violations).toEqual([
      {
        surface: 'database api_keys_scopes_known_values CHECK constraint',
        detail: 'missing: oracle:read',
      },
    ]);
  });
});
