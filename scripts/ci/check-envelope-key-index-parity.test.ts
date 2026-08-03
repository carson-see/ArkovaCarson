import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { collectMigrationFiles } from './check-anchor-index-justification.js';
import {
  collectIndexedMetadataKeys,
  findUnindexedKeys,
  indexedExpressionOf,
  parseEnvelopeKeys,
} from './check-envelope-key-index-parity.js';

const REPO = resolve(import.meta.dirname, '..', '..');

function indexOn(key: string): string {
  return `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_metadata_${key}
     ON public.anchors ((metadata ->> '${key}'))
     WHERE (metadata ->> '${key}') IS NOT NULL;`;
}

describe('parseEnvelopeKeys', () => {
  it('reads the keys out of an `as const` array', () => {
    expect(
      parseEnvelopeKeys(`export const ENVELOPE_ID_METADATA_KEYS = [
        'source_envelope_id',
        'envelope_id',
        'external_ref',
      ] as const;`),
    ).toEqual(['source_envelope_id', 'envelope_id', 'external_ref']);
  });

  it('fails closed when the constant is renamed or removed', () => {
    expect(() => parseEnvelopeKeys('export const SOMETHING_ELSE = [];')).toThrow(
      /could not locate/i,
    );
  });

  it('fails closed on an empty array rather than passing vacuously', () => {
    expect(() => parseEnvelopeKeys('const ENVELOPE_ID_METADATA_KEYS = [] as const;')).toThrow(
      /empty key list/i,
    );
  });
});

describe('indexedExpressionOf', () => {
  it('drops the partial predicate so WHERE-only keys do not count', () => {
    const expression = indexedExpressionOf(indexOn('envelope_id'));
    expect(expression).toContain("(metadata ->> 'envelope_id')");
    expect(expression).not.toMatch(/WHERE/i);
  });

  it('does not split on a WHERE nested inside parentheses', () => {
    const statement =
      "CREATE INDEX i ON public.anchors ((metadata ->> 'k')) WHERE (status = 'WHEREVER');";
    expect(indexedExpressionOf(statement)).not.toMatch(/status/);
  });
});

describe('collectIndexedMetadataKeys', () => {
  it('counts a key indexed as an expression', () => {
    const found = collectIndexedMetadataKeys(
      new Map([['0999_x.sql', indexOn('external_ref')]]),
    );
    expect(found.get('external_ref')).toBe('0999_x.sql');
  });

  it('does NOT count a key that only appears in the partial predicate', () => {
    const found = collectIndexedMetadataKeys(
      new Map([
        [
          '0999_x.sql',
          `CREATE INDEX i ON public.anchors (org_id)
             WHERE (metadata ->> 'external_ref') IS NOT NULL;`,
        ],
      ]),
    );
    expect(found.has('external_ref')).toBe(false);
  });

  it('does NOT count an index that a comment merely DOCUMENTS but never creates', () => {
    // Regression: the failure message of this very check hands authors a
    // ready-to-paste CREATE INDEX template. If that template lands in a header
    // block or a "planned follow-up" note instead of in the statement body, a
    // comment-blind scanner reports the key as covered and the guard silently
    // stops guarding — the precise false-pass it exists to prevent.
    const found = collectIndexedMetadataKeys(
      new Map([
        [
          '0999_planned.sql',
          `-- Planned follow-up (NOT applied in this migration):
           --   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_metadata_fourth_key
           --     ON public.anchors ((metadata ->> 'fourth_key'))
           --     WHERE (metadata ->> 'fourth_key') IS NOT NULL;
           SELECT 1;`,
        ],
      ]),
    );

    expect(found.has('fourth_key')).toBe(false);
  });

  it('does NOT count a rollback comment that DROPs the index', () => {
    const found = collectIndexedMetadataKeys(
      new Map([
        [
          '0999_rollback_note.sql',
          `-- ROLLBACK:
           --   DROP INDEX CONCURRENTLY IF EXISTS public.idx_anchors_metadata_external_ref;
           SELECT 1;`,
        ],
      ]),
    );

    expect(found.has('external_ref')).toBe(false);
  });

  it('still counts a real statement that has a trailing comment on the same line', () => {
    const found = collectIndexedMetadataKeys(
      new Map([
        [
          '0999_trailing.sql',
          "CREATE INDEX i ON public.anchors ((metadata ->> 'envelope_id')); -- point lookup",
        ],
      ]),
    );

    expect(found.get('envelope_id')).toBe('0999_trailing.sql');
  });

  it('ignores indexes on other tables', () => {
    const found = collectIndexedMetadataKeys(
      new Map([['0999_x.sql', "CREATE INDEX i ON public.job_queue ((metadata ->> 'envelope_id'));"]]),
    );
    expect(found.has('envelope_id')).toBe(false);
  });
});

describe('findUnindexedKeys', () => {
  it('flags a newly added fourth key that has no migration — the drift case', () => {
    const keys = ['source_envelope_id', 'envelope_id', 'external_ref', 'docusign_account_ref'];
    const indexed = collectIndexedMetadataKeys(
      new Map([
        [
          '0381_docusign_envelope_metadata_lookup_indexes.sql',
          [indexOn('source_envelope_id'), indexOn('envelope_id'), indexOn('external_ref')].join(
            '\n',
          ),
        ],
      ]),
    );

    expect(findUnindexedKeys(keys, indexed)).toEqual(['docusign_account_ref']);
  });
});

describe('live repository state', () => {
  it('every ENVELOPE_ID_METADATA_KEYS entry has a supporting anchors index migration', () => {
    const keys = parseEnvelopeKeys(
      readFileSync(
        join(REPO, 'services', 'worker', 'src', 'jobs', 'docusign-anchor-reconciliation.ts'),
        'utf8',
      ),
    );
    const sqlByFile = new Map(
      collectMigrationFiles(REPO).map((file) => [file, readFileSync(join(REPO, file), 'utf8')]),
    );

    expect(findUnindexedKeys(keys, collectIndexedMetadataKeys(sqlByFile))).toEqual([]);
  });
});
