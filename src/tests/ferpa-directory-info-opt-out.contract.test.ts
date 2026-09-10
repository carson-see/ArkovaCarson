/**
 * FD-FERPA-1 — the §99.37 directory-information opt-out must be READ by the
 * public projections that name it, and must stay read as new surfaces appear.
 *
 * ── THE DEFECT THIS ENCODES ─────────────────────────────────────────────────
 *
 * `anchors.directory_info_opt_out` was added by archive migration
 * `0197_reg02_directory_info_opt_out.sql`. Its own column comment states the
 * obligation: "when true, directory-level fields (name, degree type, dates) are
 * suppressed in verification API responses". The column shipped, three
 * production records carry it, all three are SECURED — and until migration
 * 0415 **no SQL projection function read it at all**. The control existed, was
 * represented as implemented, and was wired to nothing.
 *
 * ── WHY A RATCHET AND NOT JUST A FIX ────────────────────────────────────────
 *
 * A one-time fix to three functions repeats. This is the same shape as
 * FD-GATE-1 (three `/api/v1` route trees bypassing a kill switch §1.9 claims
 * covers them) and as the 0385/0387 pair (one projection hardened, its sibling
 * over the same rows left raw). The durable defence is a DERIVED set-equality:
 * every migration-defined `public.*` function whose newest definition reads
 * `anchors` and projects a DIRECTORY-LEVEL column, and which is not explicitly
 * revoked from `anon`, must be CLASSIFIED in
 * `scripts/ci/public-pii-projection-contract.json`. A new one shows up as a set
 * mismatch and has to be triaged; it cannot arrive silently.
 *
 * ── WHAT THIS FILE DOES NOT PROVE ───────────────────────────────────────────
 *
 * That the running database behaves this way. These are source assertions —
 * they prove the RULE cannot silently disappear, which behaviour alone cannot
 * (an edit deleting the gate and its tests together leaves nothing failing).
 * The behavioural half is `tests/rls/ferpa-directory-info-opt-out.test.ts`,
 * which seeds an opted-out anchor and reads it back through the real RPCs as a
 * real `anon` client.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripSqlComments } from '../../scripts/ci/check-views-security-invoker';
import { stripTsComments } from '../../services/worker/src/ctdl/strip-ts-comments';

const REPO = process.cwd();
const CONTRACT_PATH = path.join(REPO, 'scripts/ci/public-pii-projection-contract.json');
const MIGRATIONS_DIR = path.join(REPO, 'supabase/migrations');

/**
 * Four ways a surface can satisfy the obligation, and every one of them is
 * MACHINE-CHECKED below rather than taken on trust — a classification whose
 * claim nothing verifies is a comment, and a comment is how the 0197 column
 * came to be believed implemented for a year.
 */
interface DirectoryClassification {
  disposition:
    /** Reads the flag itself. */
    | 'consults_flag'
    /** Returns another projection's body verbatim, so it inherits the rule. */
    | 'delegates'
    /** Carries its own auth.uid()/role guard, so `anon` never reaches the body. */
    | 'identity_guarded'
    /** `RETURNS void` — structurally incapable of emitting a record's fields. */
    | 'returns_no_projection';
  /** For `delegates`, the function whose projection it returns verbatim. */
  delegates_to?: string;
  /** Free text — why this classification is true. Read by humans, not by regex. */
  reason: string;
}

interface Contract {
  ferpa_education_types: string[];
  directory_opt_out_predicate: string;
  directory_opt_out_owner_migration: string;
  directory_opt_out_fails_closed_on_absent_type: boolean;
  directory_opt_out_suppressed_fields: string[];
  directory_opt_out_controlled_fields: string[];
  directory_opt_out_omitted_fields: string[];
  directory_opt_out_residual_published_fields: string[];
  directory_opt_out_verification_fields: string[];
  directory_level_columns: string[];
  directory_opt_out_classifications: Record<string, DirectoryClassification>;
  verify_owner_module: string;
  ferpa_module: string;
}

const contract: Contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

interface Migration {
  prefix: number;
  file: string;
  raw: string;
  sql: string;
}

function numberedMigrations(): Migration[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}[a-z]?_.*\.sql$/.test(f))
    .map((file) => {
      const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      return { prefix: Number(file.slice(0, 4)), file, raw, sql: stripSqlComments(raw) };
    })
    .sort((a, b) => a.prefix - b.prefix || a.file.localeCompare(b.file));
}

/**
 * `CREATE [OR REPLACE] FUNCTION [public.]<name>(` — `CREATE FUNCTION` is
 * accepted as well, because Postgres FORCES a DROP + CREATE to change a return
 * type or a parameter name, and a redefinition that dropped the gate that way
 * would otherwise be invisible.
 */
const CREATE_FN =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?([a-z0-9_]+)"?\s*\(/gi;

/** `REVOKE ... ON FUNCTION [public.]<name>(...) FROM <roles>` naming `anon`. */
const REVOKE_FROM_ANON =
  /REVOKE\s+(?:ALL|EXECUTE)[^;]*?ON\s+FUNCTION\s+(?:"?public"?\s*\.\s*)?"?([a-z0-9_]+)"?\s*\([^)]*\)\s*FROM\s+([^;]+);/gi;

/**
 * The newest definition of every `public.*` function, plus the newest migration
 * that revoked it from `anon`. Both are needed: the ACL is decided by the LAST
 * statement to touch it, and the behaviour by the LAST definition.
 */
function latestDefinitions(): {
  defs: Map<string, { file: string; body: string }>;
  revokedFromAnon: Map<string, string>;
} {
  const defs = new Map<string, { file: string; body: string }>();
  const revokedFromAnon = new Map<string, string>();
  for (const m of numberedMigrations()) {
    for (const match of m.sql.matchAll(CREATE_FN)) {
      const name = match[1].toLowerCase();
      const rest = m.sql.slice(match.index as number);
      // A dollar-quoted body ends at the first `$$;`. Falling back to a bounded
      // slice keeps a `LANGUAGE sql` one-liner (no `$$;`) from swallowing the
      // rest of the file and reporting phantom column reads.
      const end = rest.indexOf('$$;');
      defs.set(name, { file: m.file, body: end > 0 ? rest.slice(0, end + 3) : rest.slice(0, 20000) });
    }
    for (const match of m.sql.matchAll(REVOKE_FROM_ANON)) {
      if (/\banon\b/i.test(match[2])) revokedFromAnon.set(match[1].toLowerCase(), m.file);
    }
  }
  return { defs, revokedFromAnon };
}

/**
 * Functions that read `anchors` and project a directory-level column, minus the
 * ones a migration has explicitly revoked from `anon`.
 *
 * The revoke subtraction is the only automatic exemption, and it is the one
 * that is machine-checkable: `REVOKE ... FROM ... anon` is a fact in the file.
 * Everything else — "it has its own auth.uid() guard", "it delegates" — is a
 * JUDGEMENT, and judgements go in the contract where a human wrote them down.
 */
function derivedDirectorySurfaces(): string[] {
  const { defs, revokedFromAnon } = latestDefinitions();
  const found: string[] = [];
  for (const [name, { body }] of defs) {
    if (!/\bFROM\s+(?:public\.)?anchors\b/i.test(body)) continue;
    if (revokedFromAnon.has(name)) continue;
    if (!contract.directory_level_columns.some((col) => body.includes(col))) continue;
    found.push(name);
  }
  return found.sort();
}

/** The newest migration that redefines the named `public` function. */
function latestRedefinerOf(fn: string): Migration {
  const pattern = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?${fn}"?\s*\(`,
    'i',
  );
  const hits = numberedMigrations().filter((m) => pattern.test(m.sql));
  expect(hits.length, `no migration defines public.${fn}`).toBeGreaterThan(0);
  return hits[hits.length - 1];
}

/** The `'key', <expr>` pairs a jsonb projection builds, in source order. */
function projectedClauses(m: Migration, fn: string): Map<string, string> {
  const start = m.sql.search(
    new RegExp(
      String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?${fn}"?\s*\(`,
      'i',
    ),
  );
  const body = m.sql.slice(start);
  const out = new Map<string, string>();
  for (const [, key, expr] of body.matchAll(
    /^[ \t]*'([a-z0-9_]+)',([\s\S]*?)(?=\n[ \t]*'[a-z0-9_]+',|\n[ \t]*\)\))/gm,
  )) {
    // First occurrence wins: `credit_hours` and `jurisdiction` are each
    // projected twice (cpe_metadata and cle_metadata carry their own), and the
    // top-level clause is the one these assertions are about.
    if (!out.has(key)) out.set(key, expr);
  }
  return out;
}

/**
 * The suppression predicate, however it is bound. `get_public_anchor` hoists it
 * into the same LATERAL that hoists `is_academic`, so accepting only the direct
 * call would make this a formatting assertion rather than a behavioural one.
 */
const SUPPRESS_PREDICATE = String.raw`(?:private\.is_directory_info_suppressed\([^)]*\)|g\.suppress_directory)`;

describe('FD-FERPA-1 — the directory-information opt-out is read by the SQL projections', () => {
  it('defines ONE suppression predicate, in the private schema, revoked from anon', () => {
    const owner = stripSqlComments(
      fs.readFileSync(path.join(REPO, contract.directory_opt_out_owner_migration), 'utf8'),
    );
    expect(
      owner,
      `${contract.directory_opt_out_owner_migration} must define ` +
        `private.${contract.directory_opt_out_predicate}. One predicate, called by every ` +
        'projection — a second hand-rolled copy is the drift this whole contract exists to stop.',
    ).toMatch(
      new RegExp(
        String.raw`CREATE OR REPLACE FUNCTION private\.${contract.directory_opt_out_predicate}\(`,
      ),
    );
    // The helper is internal machinery reached through SECURITY DEFINER callers,
    // so it needs no caller-side grant — and leaving it anon-callable would make
    // it a queryable oracle for the suppression rule (the 0388 defect class).
    expect(
      owner,
      `private.${contract.directory_opt_out_predicate} must be revoked from PUBLIC, anon, ` +
        'authenticated. On Supabase, ALTER DEFAULT PRIVILEGES grants anon/authenticated EXECUTE ' +
        'DIRECTLY at CREATE time, and REVOKE ... FROM PUBLIC does not remove a direct role grant.',
    ).toMatch(
      new RegExp(
        String.raw`REVOKE ALL ON FUNCTION private\.${contract.directory_opt_out_predicate}\([^)]*\) FROM PUBLIC, anon, authenticated`,
      ),
    );
  });

  it('FAILS CLOSED on an absent credential type — the state of all three live records', () => {
    // Measured on prod (vzwyaatejekddvltxyye, 2026-08-21): all three anchors
    // carrying directory_info_opt_out have `credential_type IS NULL`. A
    // predicate written as `type IN (education types)` evaluates FALSE for them
    // and suppresses NOTHING, so the "fix" would have shipped without touching
    // the only records the finding is about. This is the same fail-open 0390
    // closed for the academic free-text gate.
    expect(contract.directory_opt_out_fails_closed_on_absent_type).toBe(true);
    const owner = stripSqlComments(
      fs.readFileSync(path.join(REPO, contract.directory_opt_out_owner_migration), 'utf8'),
    );
    const predicate = owner.match(
      new RegExp(
        String.raw`CREATE OR REPLACE FUNCTION private\.${contract.directory_opt_out_predicate}[\s\S]*?\$\$;`,
      ),
    )?.[0];
    expect(predicate, 'the predicate must be defined').toBeTruthy();
    expect(
      predicate,
      'An absent credential type (NULL / empty / whitespace) must return TRUE. The set ' +
        'recognises which types the opt-out COVERS, so a type it cannot classify must be ' +
        'suppressed, not waved through.',
    ).toMatch(/p_credential_type IS NULL OR btrim\(p_credential_type\) = ''\s*THEN true/);
    // And the flag itself: an unreadable flag is doubt, and doubt suppresses.
    expect(
      predicate,
      'A NULL opt-out flag must return TRUE. The column is NOT NULL so this is unreachable ' +
        'today; it is the direction the predicate must fail when that stops being true.',
    ).toMatch(/p_opt_out IS NULL\s*THEN true/);
  });

  it('covers exactly the FERPA education-type set — no third list', () => {
    // services/worker/src/constants/ferpa.ts owns the same set for the REST
    // path. Two implementations, one set; a silent divergence here is how one
    // surface starts suppressing and its sibling stops.
    const owner = stripSqlComments(
      fs.readFileSync(path.join(REPO, contract.directory_opt_out_owner_migration), 'utf8'),
    );
    const predicate = owner.match(
      new RegExp(
        String.raw`CREATE OR REPLACE FUNCTION private\.${contract.directory_opt_out_predicate}[\s\S]*?\$\$;`,
      ),
    )?.[0];
    const listed = [...(predicate as string).matchAll(/'([A-Z_]{3,})'/g)].map((m) => m[1]).sort();
    expect(
      listed,
      'The SQL suppression set and FERPA_EDUCATION_TYPES must name the same credential types. ' +
        'Update scripts/ci/public-pii-projection-contract.json and BOTH implementations in one PR.',
    ).toEqual([...contract.ferpa_education_types].sort());
  });

  it('get_public_anchor suppresses every contract-listed directory field', () => {
    const m = latestRedefinerOf('get_public_anchor');
    const clauses = projectedClauses(m, 'get_public_anchor');
    for (const key of contract.directory_opt_out_suppressed_fields) {
      const expr = clauses.get(key.replace(/^metadata\./, ''));
      expect(expr, `${m.file} does not project '${key}' at all — the parse or the key changed`).toBeTruthy();
      expect(
        expr,
        `${m.file} is the newest definition of get_public_anchor — the one production runs — ` +
          `and it emits '${key}' without consulting the directory-information opt-out. ` +
          `'${key}' is directory information under FERPA §99.3; a learner who exercised §99.37 ` +
          'must not have it published to an anonymous caller.',
      ).toMatch(new RegExp(String.raw`WHEN\s+${SUPPRESS_PREDICATE}\s+THEN\s+NULL`, 'i'));
    }
  });

  it('get_public_anchor replaces suppressed DISPLAY fields with a controlled label, never NULL', () => {
    // `filename` is the record's public display title and its schema.org `name`.
    // `issuer_name` is rendered as the issuing institution. Both are strings a
    // consumer assumes are present, so they degrade to a controlled value that
    // asserts nothing rather than to null (0385's rule, applied unchanged).
    const m = latestRedefinerOf('get_public_anchor');
    const clauses = projectedClauses(m, 'get_public_anchor');
    for (const key of contract.directory_opt_out_controlled_fields) {
      const expr = clauses.get(key);
      expect(expr, `${m.file} does not project '${key}'`).toBeTruthy();
      expect(
        expr,
        `${m.file} emits '${key}' without a suppressed branch. It must fall back to a ` +
          'controlled label when the opt-out is set — never to NULL, which consumers that ' +
          'assume a display string do not survive.',
      ).toMatch(new RegExp(String.raw`WHEN\s+${SUPPRESS_PREDICATE}\s+THEN`, 'i'));
      expect(expr, `'${key}' must not degrade to NULL`).not.toMatch(
        new RegExp(String.raw`WHEN\s+${SUPPRESS_PREDICATE}\s+THEN\s+NULL`, 'i'),
      );
    }
  });

  it('get_public_anchor OMITS the recipient identifier rather than emitting a stand-in', () => {
    // Parity with the REST path, which does `expect(result).not.toHaveProperty
    // ('recipient_identifier')`. The key is appended after the projection, so
    // omission is expressible here and is strictly better than a sentinel.
    const m = latestRedefinerOf('get_public_anchor');
    expect(contract.directory_opt_out_omitted_fields).toContain('recipient_identifier');
    expect(
      m.sql,
      `${m.file} must not append recipient_identifier when the opt-out is set. A suppressed ` +
        'record and a record with no recipient must be indistinguishable.',
    ).toMatch(
      // The guard, not one specific spelling of it: the append must sit inside
      // an `IF NOT <something carrying the suppression flag>`.
      new RegExp(String.raw`IF\s+NOT\s+[^\n]*suppress_directory[\s\S]{0,900}?recipient_identifier`, 'i'),
    );
  });

  it('get_public_anchor still answers the VERIFICATION question when suppressed', () => {
    // The whole product is that the fingerprint proves the document. Suppression
    // drops directory FIELDS; it must never drop the record, null the receipt,
    // or turn a real anchor into "not found" — that would tell an anonymous
    // verifier a genuinely anchored document does not exist.
    const m = latestRedefinerOf('get_public_anchor');
    const clauses = projectedClauses(m, 'get_public_anchor');
    for (const key of contract.directory_opt_out_verification_fields) {
      const expr = clauses.get(key);
      expect(expr, `${m.file} does not project the verification field '${key}'`).toBeTruthy();
      expect(
        expr,
        `${m.file} gates the verification field '${key}' on the directory opt-out. Suppressing ` +
          'proof-bearing data does not protect the learner — it breaks the answer they are ' +
          'relying on the record to give.',
      ).not.toMatch(new RegExp(SUPPRESS_PREDICATE, 'i'));
    }
    // And the row filter must stay free of the predicate: a suppressed record
    // still RESOLVES.
    const whereClause = m.sql.match(/WHERE a\.public_id = p_public_id[\s\S]*?deleted_at IS NULL;/)?.[0];
    expect(whereClause, 'could not locate the get_public_anchor row filter').toBeTruthy();
    expect(
      whereClause,
      'The opt-out must not appear in the row filter — that would make an opted-out record ' +
        'return "Record not found", which is a broken verification answer, not a redaction.',
    ).not.toMatch(/directory_info_opt_out|is_directory_info_suppressed|suppress_directory/i);
  });

  it('search_public_credentials excludes opted-out records from MATCHING, not just from the title', () => {
    // 0387's invariant, restated: you can only search for text we would be
    // willing to show you. Blanking the projected title while leaving the row
    // matchable converts a disclosure into a HIT-COUNT ORACLE — a caller
    // confirms the record exists from a non-empty result set without ever
    // reading a field.
    const m = latestRedefinerOf('search_public_credentials');
    expect(
      m.sql,
      `${m.file} is the newest definition of search_public_credentials and it does not exclude ` +
        'opted-out records from the WHERE clause. Suppressing the projection alone leaves a ' +
        'hit-count oracle.',
    ).toMatch(new RegExp(String.raw`AND\s+NOT\s+private\.is_directory_info_suppressed\(`, 'i'));
  });

  it('classifies EVERY anon-reachable surface that reads a directory-level anchor column', () => {
    // The ratchet. Derived from the migrations, compared for SET EQUALITY
    // against the contract — so a NEW projection cannot arrive unclassified,
    // and a stale classification cannot silently pre-approve a name a future
    // migration rebinds to something else.
    const derived = derivedDirectorySurfaces();
    const classified = Object.keys(contract.directory_opt_out_classifications).sort();
    expect(
      derived,
      'The set of anon-reachable functions reading a directory-level anchors column changed.\n\n' +
        'If you ADDED one, classify it in scripts/ci/public-pii-projection-contract.json under ' +
        '"directory_opt_out_classifications" with a disposition of "consults_flag" (it reads ' +
        'directory_info_opt_out), "delegates" (it returns another projection verbatim), or ' +
        '"not_anon_reachable" (it carries its own auth.uid()/role guard, or is revoked from anon ' +
        'in the same migration that defines it).\n\n' +
        'This is the assertion that makes FD-FERPA-1 a class fix instead of a one-time patch: ' +
        'the column shipped in 0197 with a comment naming the obligation and was read by nothing ' +
        'for over a year, because nothing ever asked the question.',
    ).toEqual(classified);
  });

  it('holds every classification to its own claim', () => {
    const { defs } = latestDefinitions();
    for (const [fn, cls] of Object.entries(contract.directory_opt_out_classifications)) {
      const def = defs.get(fn);
      expect(def, `public.${fn} is classified but no migration defines it`).toBeTruthy();
      const body = (def as { body: string }).body;
      expect(cls.reason.length, `${fn} needs a real reason, not a placeholder`).toBeGreaterThan(30);
      if (cls.disposition === 'consults_flag') {
        expect(
          body,
          `${fn} is classified "consults_flag" but its newest definition never names ` +
            'directory_info_opt_out or the suppression predicate.',
        ).toMatch(/directory_info_opt_out|is_directory_info_suppressed|suppress_directory/i);
      }
      if (cls.disposition === 'delegates') {
        expect(cls.delegates_to, `${fn} must name what it delegates to`).toBeTruthy();
        expect(
          body,
          `${fn} is classified "delegates" to ${cls.delegates_to} but does not call it. A ` +
            'delegation that stops delegating is a silent fork of the redaction rules — this is ' +
            'exactly how 0376 reverted 0356 for four days.',
        ).toContain(cls.delegates_to as string);
      }
      if (cls.disposition === 'identity_guarded') {
        expect(
          body,
          `${fn} is classified "identity_guarded", so its own body must carry the guard that ` +
            'makes that true — an auth.uid()/role check or an explicit access RAISE. A grant ' +
            'that merely happens to be absent today is not a guard: prod ACLs drift, and both ' +
            'writers in this list are in fact anon-EXECUTABLE right now (checked 2026-08-21). ' +
            'The guard inside the body is the only thing standing between them and an ' +
            'unauthenticated caller.',
        ).toMatch(/auth\.uid\(\)|get_caller_role\(\)|is_platform_admin/i);
      }
      if (cls.disposition === 'returns_no_projection') {
        expect(
          body,
          `${fn} is classified "returns_no_projection", which is a claim about its RETURN TYPE: ` +
            'it must be `RETURNS void`, i.e. structurally unable to hand a caller any field of ' +
            'any record. If it ever starts returning rows, this stops being true and it needs a ' +
            'real classification.',
        ).toMatch(/RETURNS\s+"?void"?/i);
      }
    }
  });

  it('records the residual: fields the opt-out deliberately does NOT suppress', () => {
    // §1.5 / §1.13 R-7 — state what is suppressed, and what is NOT. The column
    // comment names "degree type", but the REST path PINS publishing it
    // (`expect(result.credential_type).toBe('DEGREE')` in verify.test.ts), and
    // making the two surfaces disagree recreates the asymmetry this fix exists
    // to remove. Publishing it on both is a decision, and it is written down
    // here rather than left as an accident for the next reader to discover.
    expect(contract.directory_opt_out_residual_published_fields).toContain('credential_type');
    const m = latestRedefinerOf('get_public_anchor');
    const expr = projectedClauses(m, 'get_public_anchor').get('credential_type');
    expect(expr, 'get_public_anchor must still project credential_type').toBeTruthy();
    expect(
      expr,
      'credential_type is recorded as a KNOWN RESIDUAL, published on both public paths. If you ' +
        'are suppressing it here, remove it from directory_opt_out_residual_published_fields AND ' +
        'change the REST path in the same PR — one row must not get two answers.',
    ).not.toMatch(new RegExp(SUPPRESS_PREDICATE, 'i'));
  });
});

describe('FD-FERPA-1 — the REST verification path fails closed on an absent credential type', () => {
  const verifySrc = (): string =>
    stripTsComments(fs.readFileSync(path.join(REPO, contract.verify_owner_module), 'utf8'));

  it('does not compute suppressDirectory from a truthiness test on credential_type', () => {
    // `anchor.credential_type && FERPA_EDUCATION_TYPES.includes(...)` is falsy
    // for a NULL type, so the REST path — the one the finding describes as
    // "does consult the flag" — also published directory fields for all three
    // affected production records. Consulting a flag and honouring it are not
    // the same thing.
    const src = verifySrc();
    // Scoped to the suppression STATEMENT, not the whole file. The REG-03
    // re-disclosure notice a few lines below keeps its `credential_type &&
    // FERPA_EDUCATION_TYPES.includes(...)` truthiness test ON PURPOSE and must
    // not be swept up here: that notice asserts "this result contains
    // information from education records", so emitting it for an untyped record
    // would be a false claim (§1.5, §1.13 R-7). Suppression fails closed;
    // ASSERTIONS fail open. They are different mechanisms with the same input.
    const statement = src.match(/const\s+suppressDirectory\s*=[\s\S]*?;/)?.[0];
    expect(statement, 'verify.ts must declare `const suppressDirectory =`').toBeTruthy();
    expect(
      statement,
      'verify.ts must not gate the opt-out behind a truthiness test on credential_type. An ' +
        'absent type has to SUPPRESS, matching private.is_directory_info_suppressed — otherwise ' +
        'the two public paths disagree on the exact rows that matter, which is every record in ' +
        'production that carries the flag.',
    ).not.toMatch(/FERPA_EDUCATION_TYPES/);
    expect(
      statement,
      'verify.ts must route the opt-out through the named fail-closed predicate so the rule is ' +
        'testable on its own and cannot be re-inlined as a truthiness check.',
    ).toMatch(/suppressesDirectoryInfo\(/);
  });

  it('shares the predicate with the SQL projection instead of re-implementing it', () => {
    const src = verifySrc();
    expect(
      src,
      'suppressesDirectoryInfo must be imported from constants/ferpa.js — the module that also ' +
        'owns FERPA_EDUCATION_TYPES, which the SQL predicate is pinned against. A local copy is ' +
        'the drift this whole contract exists to prevent.',
    ).toMatch(/from\s+'\.\.\/\.\.\/constants\/ferpa\.js'/);
    const ferpaSrc = stripTsComments(fs.readFileSync(path.join(REPO, contract.ferpa_module), 'utf8'));
    expect(ferpaSrc).toMatch(/export function suppressesDirectoryInfo\(/);
    // Same two fail-closed branches the SQL predicate carries, in the same
    // order: unknown flag, then unknown type.
    expect(
      ferpaSrc,
      'suppressesDirectoryInfo must treat a null/undefined flag as SUPPRESS.',
    ).toMatch(/optOut === null \|\| optOut === undefined\) return true/);
    expect(
      ferpaSrc,
      'suppressesDirectoryInfo must treat an absent credential type as SUPPRESS.',
    ).toMatch(/if \(!type\) return true/);
    expect(
      ferpaSrc,
      'suppressesDirectoryInfo must read the FERPA education set, not a fourth hand-rolled list.',
    ).toMatch(/FERPA_EDUCATION_TYPES as readonly string\[\]/);
  });
});
