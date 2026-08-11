/**
 * Guard: never compare an ENUM column to a `text` / `text[]` FUNCTION PARAMETER
 * without an explicit `::text` cast.
 *
 * ── THE INCIDENT THIS ENCODES ──────────────────────────────────────────────
 *
 * Migration 0408's `claim_supplementary_proof_cohort` shipped
 *
 *     AND a.credential_type = ANY(p_deprioritized_credential_types)
 *
 * where `p_deprioritized_credential_types` is declared `text[]` and
 * `public.anchors.credential_type` is an ENUM in prod (`pg_type.typtype='e'`,
 * 27 labels — including the exact PUBLICATION / SEC_FILING values the
 * migration's own comment names as deprioritized). Postgres has no implicit
 * enum<->text operator, so this raises
 *
 *     ERROR: 42883: operator does not exist: credential_type = text
 *
 * and because the function is `LANGUAGE sql`, the body is parsed and validated
 * at CREATE time — so the migration fails hard at apply, not at first call.
 * It aborted a production apply of 0408.
 *
 * ── WHY A STATIC GUARD ─────────────────────────────────────────────────────
 *
 * The real gap was that nothing exercised the function against a schema where
 * `credential_type` is an enum. The strongest test is applying the migration to
 * a Postgres carrying the real enum; this file is the half that runs in ordinary
 * CI with no database, so the defect cannot silently return.
 *
 * Comparisons to string LITERALS (`a.status = 'SECURED'`) are fine — an unknown
 * literal coerces to the enum. Only a comparison against a `text`-typed
 * PARAMETER is broken, which is exactly what this scans for.
 *
 * ZERO TOLERANCE, NO BASELINE: at the time of writing the repo contained exactly
 * one instance across all migrations (the 0408 defect). There is nothing to
 * grandfather, so any hit is new.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');

/**
 * Columns confirmed ENUM-typed in prod (`vzwyaatejekddvltxyye`, 2026-08-11):
 *   public.anchors.credential_type -> credential_type   (27 labels)
 *   public.anchors.status          -> anchor_status     (8 labels)
 * Verified by query, not assumed from the type name.
 */
const ENUM_COLUMNS = ['credential_type', 'status', 'verification_level', 'fingerprint_source'];

export interface EnumTextHit {
  file: string;
  column: string;
  param: string;
  snippet: string;
}

function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find every `<alias>.<enumCol> = [ANY(]<p_textParam>` in a SQL text where the
 * parameter is declared `text` or `text[]` and no `::text` cast is present.
 *
 * Exported so the negative control below can exercise it on synthetic input —
 * a guard that has never been seen failing is not a guard.
 */
export function findEnumTextComparisons(file: string, rawSql: string): EnumTextHit[] {
  const sql = stripComments(rawSql);
  const hits: EnumTextHit[] = [];

  // Each CREATE FUNCTION ... $$; block, so a parameter list is scoped to its
  // own body rather than leaking across definitions.
  for (const block of sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION[\s\S]{0,20000}?\$\$;/gi)) {
    const body = block[0];
    const textParams = [...body.matchAll(/(p_[a-z0-9_]+)\s+(?:text\[\]|text)\b/gi)].map((m) => m[1]);
    if (textParams.length === 0) continue;

    for (const param of textParams) {
      for (const column of ENUM_COLUMNS) {
        const re = new RegExp(
          `\\.${escapeRegExp(column)}\\s*(?:=|<>)\\s*(?:ANY\\s*\\(\\s*)?${escapeRegExp(param)}\\b`,
          'gi',
        );
        for (const m of body.matchAll(re)) {
          const snippet = body
            .slice(Math.max(0, m.index - 60), m.index + 100)
            .replace(/\s+/g, ' ')
            .trim();
          // `::text` anywhere in the immediate neighbourhood means the author
          // cast it; the cast can sit on either side of the operator.
          if (!snippet.includes('::text')) {
            hits.push({ file, column, param, snippet });
          }
        }
      }
    }
  }
  return hits;
}

function migrations(): { file: string; sql: string }[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ file: f, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8') }));
}

const GOOD = `
CREATE OR REPLACE FUNCTION public.f(p_types text[])
RETURNS TABLE (id uuid)
LANGUAGE sql
AS $$
  SELECT a.id FROM public.anchors a
  WHERE a.credential_type::text = ANY(p_types);
$$;
`;

const BAD = GOOD.replace('a.credential_type::text', 'a.credential_type');

describe('detector behaviour (negative control)', () => {
  it('flags an un-cast enum vs text[] parameter comparison', () => {
    const hits = findEnumTextComparisons('bad.sql', BAD);
    expect(hits).toHaveLength(1);
    expect(hits[0].column).toBe('credential_type');
    expect(hits[0].param).toBe('p_types');
  });

  it('accepts the same comparison once ::text is added', () => {
    expect(findEnumTextComparisons('good.sql', GOOD)).toEqual([]);
  });

  it('does not flag a comparison against a string literal', () => {
    const literal = `
CREATE OR REPLACE FUNCTION public.g(p_note text)
RETURNS TABLE (id uuid)
LANGUAGE sql
AS $$
  SELECT a.id FROM public.anchors a WHERE a.status = 'SECURED';
$$;
`;
    expect(findEnumTextComparisons('lit.sql', literal)).toEqual([]);
  });

  it('does not flag a uuid[] parameter comparison', () => {
    const uuids = `
CREATE OR REPLACE FUNCTION public.h(p_ids uuid[])
RETURNS TABLE (id uuid)
LANGUAGE sql
AS $$
  SELECT a.id FROM public.anchors a WHERE a.id = ANY(p_ids);
$$;
`;
    expect(findEnumTextComparisons('uuid.sql', uuids)).toEqual([]);
  });
});

describe('repo-wide: no enum column is compared to a text parameter uncast', () => {
  const files = migrations();

  it('the sweep is non-vacuous — it still sees functions with text parameters', () => {
    // A regex that stopped matching would make the assertion below pass while
    // scanning nothing.
    const withTextParams = files.filter((f) =>
      /CREATE\s+OR\s+REPLACE\s+FUNCTION[\s\S]{0,20000}?p_[a-z0-9_]+\s+(?:text\[\]|text)\b/i.test(
        stripComments(f.sql),
      ),
    );
    expect(withTextParams.length).toBeGreaterThan(5);
  });

  it('finds zero un-cast enum/text comparisons', () => {
    const hits = files.flatMap((f) => findEnumTextComparisons(f.file, f.sql));
    expect(
      hits.map((h) => `${h.file}: .${h.column} vs ${h.param}`),
      'Enum column compared to a text parameter with no ::text cast. Postgres has ' +
        'no implicit enum<->text operator, so this raises 42883 — and in a ' +
        'LANGUAGE sql function the body is validated at CREATE time, so the ' +
        'MIGRATION FAILS AT APPLY. Add ::text to the column side.',
    ).toEqual([]);
  });
});

describe('0408: the specific regression that aborted a prod apply', () => {
  const sql = fs.readFileSync(
    path.join(MIGRATIONS_DIR, '0408_supplementary_proof_anchor.sql'),
    'utf8',
  );

  it('claim_supplementary_proof_cohort casts credential_type to text', () => {
    expect(stripComments(sql)).toContain(
      'a.credential_type::text = ANY(p_deprioritized_credential_types)',
    );
  });

  it('every CREATE POLICY is preceded by DROP POLICY IF EXISTS (re-apply safety)', () => {
    // Every other object in 0408 is IF NOT EXISTS; bare CREATE POLICY made a
    // re-apply error out partway, which is how a half-applied migration happens.
    const body = stripComments(sql);
    const policies = [...body.matchAll(/CREATE POLICY\s+([a-z0-9_]+)/gi)].map((m) => m[1]);
    expect(policies.length).toBeGreaterThan(0);
    for (const name of policies) {
      expect(body, `${name} needs a preceding DROP POLICY IF EXISTS`).toMatch(
        new RegExp(`DROP POLICY IF EXISTS\\s+${name}\\b`, 'i'),
      );
    }
  });
});
