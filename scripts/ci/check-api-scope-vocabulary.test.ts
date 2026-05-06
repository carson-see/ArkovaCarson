import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectScopeVocabularyViolations,
  diffOrdered,
  diffSet,
  extractMarkdownCodeScopes,
  extractMarkdownSectionCodeScopes,
  extractOpenApiCanonicalScopes,
  extractSqlConstraintScopes,
  latestConstraintMigration,
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

  it('reports non-canonical extras on checked surfaces', () => {
    expect(
      diffSet('database api_keys_scopes_known_values CHECK constraint', ['verify'], ['verify', 'batch']),
    ).toEqual([
      {
        surface: 'database api_keys_scopes_known_values CHECK constraint',
        detail: 'extra: batch | expected: verify | actual: verify, batch',
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

  it('extracts pg_dump inline quoted DB CHECK constraint scope arrays', () => {
    const scopes = extractSqlConstraintScopes(`
      CREATE TABLE IF NOT EXISTS "public"."api_keys" (
        "scopes" "text"[] NOT NULL,
        CONSTRAINT "api_keys_scopes_known_values" CHECK (("scopes" <@ ARRAY['read:records'::"text", 'verify'::"text"]))
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

  it('extracts scope names from a targeted markdown section', () => {
    expect(extractMarkdownSectionCodeScopes(`
      ## Authentication
      Scope: \`read:records\`
      ## Error Handling
      Error detail mentions \`verify\`
    `, '## Authentication')).toEqual(['read:records']);
  });

  it('extracts exact OpenAPI canonical scopes without matching unrelated path text', () => {
    expect(extractOpenApiCanonicalScopes(`
      /verify:
        get:
          summary: Verify endpoint
      x-arkova-canonical-scopes:
        - read:records
        - verify
    `)).toEqual(['read:records', 'verify']);
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
      apiReadmeMarkdown: '### Canonical API key scope vocabulary\n`read:records`, `read:search`, `verify`, `oracle:read`',
      v2MigrationMarkdown: '## Authentication\n`read:records`, `read:search`',
      v1OpenApiYaml: `
        x-arkova-canonical-scopes:
          - read:records
          - read:search
          - verify
          - oracle:read
      `,
    });

    expect(violations).toEqual([]);
  });

  it('ignores non-canonical aliases that appear outside the canonical README section', () => {
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
      // The canonical section is correct; a deprecated alias `batch` is
      // mentioned in unrelated migration notes elsewhere in the README.
      // The CI gate must NOT treat that as scope drift.
      apiReadmeMarkdown: [
        '## Migration notes',
        'Earlier API keys used the legacy `batch` short alias before SCRUM-1581.',
        '',
        '### Canonical API key scope vocabulary',
        '`read:records`, `read:search`, `verify`, `oracle:read`',
        '',
        '### Other section',
        'Some other example referencing `keys:manage` for context.',
      ].join('\n'),
      v2MigrationMarkdown: '## Authentication\n`read:records`, `read:search`',
      v1OpenApiYaml: `
        x-arkova-canonical-scopes:
          - read:records
          - read:search
          - verify
          - oracle:read
      `,
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
      apiReadmeMarkdown: '### Canonical API key scope vocabulary\n`read:records`, `read:search`, `verify`, `oracle:read`',
      v2MigrationMarkdown: '## Authentication\n`read:records`, `read:search`',
      v1OpenApiYaml: `
        x-arkova-canonical-scopes:
          - read:records
          - read:search
          - verify
          - oracle:read
      `,
    });

    expect(violations).toEqual([
      {
        surface: 'database api_keys_scopes_known_values CHECK constraint',
        detail: 'missing: oracle:read | expected: read:records, read:search, verify, oracle:read | actual: read:records, read:search, verify',
      },
    ]);
  });

  it('flags stale aliases in SQL constraints and OpenAPI canonical metadata', () => {
    const violations = collectScopeVocabularyViolations({
      workerSource: WORKER_SCOPE_SOURCE,
      frontendSource: WORKER_SCOPE_SOURCE,
      dbConstraintSql: `
        ALTER TABLE public.api_keys
          ADD CONSTRAINT api_keys_scopes_known_values
          CHECK (scopes <@ ARRAY['read:records', 'read:search', 'verify', 'oracle:read', 'batch']::text[]);
        ALTER TABLE public.agents
          ADD CONSTRAINT agents_allowed_scopes_known_values
          CHECK (allowed_scopes <@ ARRAY['read:records', 'read:search', 'verify', 'oracle:read']::text[]);
      `,
      apiReadmeMarkdown: '### Canonical API key scope vocabulary\n`read:records`, `read:search`, `verify`, `oracle:read`',
      v2MigrationMarkdown: '## Authentication\n`read:records`, `read:search`',
      v1OpenApiYaml: `
        /verify:
          get:
            summary: Verify endpoint
        x-arkova-canonical-scopes:
          - read:records
          - read:search
          - verify
          - oracle:read
          - usage
      `,
    });

    expect(violations).toEqual([
      {
        surface: 'database api_keys_scopes_known_values CHECK constraint',
        detail: 'extra: batch | expected: read:records, read:search, verify, oracle:read | actual: read:records, read:search, verify, oracle:read, batch',
      },
      {
        surface: 'docs/api/openapi.yaml x-arkova-canonical-scopes',
        detail: 'extra: usage | expected: read:records, read:search, verify, oracle:read | actual: read:records, read:search, verify, oracle:read, usage',
      },
    ]);
  });

  it('resolves the latest migration independently for each DB constraint', () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-vocab-'));

    try {
      const migrationsDir = join(root, 'supabase', 'migrations');
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(join(migrationsDir, '0285_both.sql'), `
        ALTER TABLE public.api_keys
          ADD CONSTRAINT api_keys_scopes_known_values
          CHECK (scopes <@ ARRAY['verify']::text[]);
        ALTER TABLE public.agents
          ADD CONSTRAINT agents_allowed_scopes_known_values
          CHECK (allowed_scopes <@ ARRAY['verify']::text[]);
      `);
      writeFileSync(join(migrationsDir, '0286_agents_only.sql'), `
        ALTER TABLE public.agents
          ADD CONSTRAINT agents_allowed_scopes_known_values
          CHECK (allowed_scopes <@ ARRAY['verify', 'oracle:read']::text[]);
      `);
      writeFileSync(join(migrationsDir, '00000000000000_baseline.sql'), `
        CREATE TABLE IF NOT EXISTS "public"."inline_api_keys" (
          CONSTRAINT "inline_constraint" CHECK (scopes <@ ARRAY['verify'::"text"])
        );
      `);

      expect(latestConstraintMigration(root, 'api_keys_scopes_known_values')).toContain('0285_both.sql');
      expect(latestConstraintMigration(root, 'agents_allowed_scopes_known_values')).toContain('0286_agents_only.sql');
      expect(latestConstraintMigration(root, 'inline_constraint')).toContain('00000000000000_baseline.sql');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
