/**
 * ANTI-DRIFT SUITE for the public, unauthenticated projections of an anchor.
 *
 * Arkova answers "is this document real?" over two independent code paths that
 * project the SAME anchor rows to the SAME anonymous caller:
 *
 *   SQL  public.get_public_anchor(text) + get_public_anchor_by_fingerprint(text)
 *        — GRANTed to `anon`, called straight from the browser over PostgREST by
 *          the verify page, the embeddable widget, and the edge MCP tools.
 *   TS   services/worker/src/ctdl/ctdl-pii-guard.ts (lands with PR #1815)
 *        — behind GET /api/v1/credentials/:publicId/ctdl.
 *
 * They drifted, and the drift WAS the defect: the CTDL path was hardened while
 * the SQL path kept shipping learner names, raw filenames, and raw revocation
 * reasons to anonymous callers, because `sanitize_metadata_for_public` is a
 * key-NAME denylist that never inspects a value. Migration 0385 closes the SQL
 * side.
 *
 * ── HOW THESE ASSERTIONS STAY ALIVE ──────────────────────────────────────────
 *
 * Migrations are append-only, so a suite that reads a HARDCODED migration path
 * is a one-time verification, not a regression gate: it re-reads a frozen file
 * forever while production runs whatever the newest redefinition says. Every
 * behavioural assertion here therefore runs against the **latest redefiner** —
 * the highest-numbered migration that redefines `get_public_anchor` — which is
 * the only definition that matters at runtime. Today that is 0385; when an 0386
 * lands, these assertions automatically move to it.
 *
 * The SQL is also **comment-stripped** before matching. Without that, an 0385
 * written by following 0385's own documented ROLLBACK block would carry
 * `public_free_text_or_null` and `is_academic_record_credential_type` in its
 * DROP list and satisfy a naive substring check while removing the gate.
 *
 * That combination encodes the 2026-08-01 incident as an assertion: 0376 was
 * branched from the 0355 file instead of the current head, silently reverted
 * 0356's keyed recipient HMAC and 0362's allow-list, and put a
 * dictionary-reversible SHA-256 of recipient e-mail addresses on an anon
 * endpoint for four days.
 *
 * The behavioural proof that the leak is closed lives in
 * tests/rls/public-anchor-pii-projection.test.ts, which seeds the leak shapes
 * into real anchors and reads them back through the real RPC as a real anon
 * client. This file proves the rule cannot silently disappear.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
// Shared with check-views-security-invoker.ts. Its version also strips `/* */`
// BLOCK comments, which a local copy did not — and a commented-out prior
// definition pasted into a future migration looks exactly like a block comment.
import { stripSqlComments } from '../../scripts/ci/check-views-security-invoker';
// The TS half needs the same treatment for the same reason: verify.ts documents
// at length WHY it does not import `containsLearnerNamePii`, and a naive
// substring match on the raw file reads that explanation as the import it warns
// against. String-aware (a `//` inside a URL literal is not a comment).
import { stripTsComments } from '../../services/worker/src/ctdl/strip-ts-comments';

const REPO = process.cwd();
const CONTRACT_PATH = path.join(REPO, 'scripts/ci/public-pii-projection-contract.json');
const MIGRATIONS_DIR = path.join(REPO, 'supabase/migrations');

interface Contract {
  sql_owner_migration: string;
  ts_owner_module: string;
  ts_owner_pending_pr: number;
  ts_pre_1815_module: string;
  verify_owner_module: string;
  provenance_owner_module: string;
  provenance_academic_suppressed_fields: string[];
  provenance_value_gated_fields: string[];
  provenance_never_emitted_fields: string[];
  provenance_implements_learner_name_heuristics: boolean;
  provenance_fails_closed: boolean;
  verify_academic_suppressed_fields: string[];
  verify_value_gated_fields: string[];
  verify_structural_api_rich_keys: string[];
  verify_implements_learner_name_heuristics: boolean;
  verify_fails_closed: boolean;
  ferpa_module: string;
  ferpa_education_types: string[];
  academic_record_credential_types: string[];
  sql_academic_controlled_labels: Record<string, string>;
  sql_academic_suppressed_fields: string[];
  sql_academic_controlled_fields: string[];
  sql_non_academic_fallback_label: string;
  high_confidence_detector_families: string[];
  sql_implements_learner_name_heuristics: boolean;
  max_scan_chars: number;
  max_public_url_chars: number;
  ungated_keys: string[];
  projection_keys: string[];
  structural_keys: string[];
}

const contract: Contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

/**
 * Matches a redefinition of `get_public_anchor` itself, NOT its
 * `_by_fingerprint` sibling: after the name the pattern demands an open paren,
 * which `get_public_anchor_by_fingerprint(` cannot supply.
 *
 * `CREATE FUNCTION` is accepted as well as `CREATE OR REPLACE FUNCTION`, because
 * Postgres FORCES a DROP + CREATE to change a return type or a parameter name —
 * a redefinition that dropped the gate that way would otherwise be invisible.
 */
const REDEFINES_GET_PUBLIC_ANCHOR =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\.)?"?get_public_anchor"?\s*\(/i;

interface Migration {
  prefix: number;
  file: string;
  raw: string;
  sql: string;
}

/**
 * Every migration in `supabase/migrations`, ascending. The lettered-suffix form
 * (`0055b_...`) is a real pattern in this repo — CLAUDE.md §1.11 documents it —
 * so it must not be invisible here.
 */
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

/** The definition that actually runs: the highest-numbered redefinition. */
function latestRedefiner(): Migration {
  const redefiners = numberedMigrations().filter((m) => REDEFINES_GET_PUBLIC_ANCHOR.test(m.sql));
  expect(redefiners.length, 'no migration redefines get_public_anchor').toBeGreaterThan(0);
  return redefiners[redefiners.length - 1];
}

/**
 * The message every gate failure carries. A future author who trips one of
 * these needs to know WHY the rule exists, not just that a regex did not match.
 */
/**
 * The academic-record predicate, however it is bound. The projection hoists it
 * into a LATERAL (`g.is_academic`) so it is evaluated once per row instead of
 * six times; accepting only the direct call would make this gate a formatting
 * assertion rather than a behavioural one.
 */
const ACADEMIC_PREDICATE =
  String.raw`(?:private\.is_academic_record_credential_type\([^)]*\)|g\.is_academic)`;

/** The value-level gates. An expression calling one of these is cleaned. */
const CLEANERS =
  /private\.(public_free_text_or_null|public_url_or_null|public_jsonb_text_or_null|academic_record_public_label)\(/;

/**
 * Every `'key', <expr>` pair the projection builds, as [key, expr], in source
 * order. Shared by the parse pin and the value gate so the two cannot disagree
 * about what was read.
 *
 * The key must OPEN a line: that is what distinguishes a jsonb_build_object
 * argument from a string literal appearing mid-expression, e.g. the
 * `a.metadata->>'recipient',` SELECT input, which is HMAC'd rather than
 * projected. `expr` runs to the next line-opening key or to the object close.
 */
function projectedKeys(m: Migration): [string, string][] {
  const body = m.sql.slice(m.sql.search(REDEFINES_GET_PUBLIC_ANCHOR));
  return [
    ...body.matchAll(/^[ \t]*'([a-z0-9_]+)',([\s\S]*?)(?=\n[ \t]*'[a-z0-9_]+',|\n[ \t]*\)\))/gm),
  ].map(([, key, expr]): [string, string] => [key, expr]);
}

/** Unique, sorted — the shape every assertion below compares against. */
function uniqueSorted(keys: string[]): string[] {
  return [...new Set(keys)].sort();
}

function why(m: Migration, detail: string): string {
  return (
    `${m.file} is the newest definition of get_public_anchor — the one production runs — ` +
    `and ${detail}\n\n` +
    `get_public_anchor is redefined WHOLESALE by every migration that touches it. ` +
    `Base your migration on the CURRENT definition (pg_get_functiondef in prod, or ` +
    `${contract.sql_owner_migration}), never on an older migration file. Branching 0376 from ` +
    `the 0355 file is what reverted 0356's keyed HMAC and 0362's allow-list and put an ` +
    `unsalted recipient hash on an anon endpoint for four days.`
  );
}

describe('public projection PII gate — the definition production runs', () => {
  it('is a migration that actually calls the gate (not just mentions it in a comment)', () => {
    const m = latestRedefiner();
    for (const marker of ['is_academic_record_credential_type', 'public_free_text_or_null']) {
      expect(m.sql, why(m, `does not call ${marker}() in executable SQL.`)).toContain(marker);
    }
  });

  it('keeps the recipient identifier a KEYED HMAC, never a bare digest', () => {
    // The other half of the 0376 regression: the keyed HMAC was reverted to a
    // dictionary-reversible sha256 of recipient e-mail addresses.
    const m = latestRedefiner();
    expect(m.sql, why(m, 'does not compute recipient_identifier with extensions.hmac().')).toMatch(
      /extensions\.hmac\(/,
    );
    expect(m.sql, why(m, 'does not read the recipient pepper.')).toMatch(/recipient_pepper/);
    expect(
      m.sql,
      why(m, 'hashes the recipient with a bare digest() — that is the exact 0376 regression.'),
    ).not.toMatch(/digest\(\s*lower\s*\(\s*btrim/i);
  });

  it('suppresses every contract-listed academic free-text field', () => {
    const m = latestRedefiner();
    for (const field of contract.sql_academic_suppressed_fields) {
      const key = field.replace(/^metadata\./, '');
      // `'<key>', CASE WHEN is_academic_record_credential_type(...) THEN NULL`
      const pattern = new RegExp(
        String.raw`'${key}',\s*CASE\s+WHEN\s+${ACADEMIC_PREDICATE}\s*THEN\s+NULL`,
        'i',
      );
      expect(m.sql, why(m, `does not force ${field} to NULL for academic records.`)).toMatch(pattern);
    }
  });

  it('replaces every contract-listed academic display field with a controlled label', () => {
    const m = latestRedefiner();
    for (const key of contract.sql_academic_controlled_fields) {
      const pattern = new RegExp(
        String.raw`'${key}',\s*CASE\s+WHEN\s+${ACADEMIC_PREDICATE}\s*THEN\s+private\.academic_record_public_label\(`,
        'i',
      );
      expect(
        m.sql,
        why(m, `does not give ${key} a controlled label for academic records.`),
      ).toMatch(pattern);
    }
  });

  it('runs the value gate on the NON-academic branch too, not just the academic one', () => {
    // Asserting only the academic branch would accept
    //   'description', CASE WHEN academic THEN NULL ELSE a.metadata->>'description' END
    // which re-leaks raw issuer text on every other credential type.
    const m = latestRedefiner();
    const gatedFreeText = ['title', 'credential_title', 'description', 'category', 'issuer'];
    for (const key of gatedFreeText) {
      const clause = m.sql.match(new RegExp(String.raw`'${key}',[\s\S]{0,400}?(?=\n\s{8}')`));
      expect(clause, `could not locate the '${key}' projection clause`).toBeTruthy();
      expect(
        clause?.[0],
        why(m, `emits metadata.${key} without routing it through public_free_text_or_null().`),
      ).toContain('public_free_text_or_null');
    }
    expect(
      m.sql,
      why(m, 'emits revocation_reason without the value gate on the non-academic branch.'),
    ).toMatch(/'revocation_reason',[\s\S]{0,300}?private\.public_free_text_or_null\(/);
  });

  it('sees EVERY key the projection emits — so the derived gate cannot silently stop parsing', () => {
    // The gate below reports "nothing ungated" both when everything is gated
    // and when the matcher matched nothing, and those two must not look alike.
    // Pinning the parsed key set makes a parse that stops seeing keys fail
    // LOUDLY rather than hand back a clean bill of health.
    const m = latestRedefiner();
    // Deduped: `credit_hours`, `jurisdiction` and `requires_manual_review` are
    // each projected twice (cpe_metadata and cle_metadata carry their own).
    expect(
      uniqueSorted(projectedKeys(m).map(([key]) => key)),
      why(
        m,
        `emits a different set of keys than scripts/ci/public-pii-projection-contract.json ` +
          `pins in "projection_keys". If you ADDED a public key, add it there and decide ` +
          `explicitly whether it belongs in "structural_keys" (carries no issuer- or ` +
          `extraction-authored text) or must route through a cleaner. If you did not change the ` +
          `key set, the parse itself broke — fix it, because a broken parse makes the value gate ` +
          `below silently vacuous.`,
      ),
    ).toEqual(uniqueSorted(contract.projection_keys));
  });

  it('gates EVERY key that is not structural — fail-closed, derived from the SQL', () => {
    // The failure mode this closes: per-field wrapping is OPT-IN, so a key added
    // by a future migration is emitted ungated by default.
    //
    // The exemption is an ALLOW-LIST of structural keys, never a pattern that
    // tries to RECOGNISE anchor-controlled expressions. Recognising danger fails
    // OPEN: the previous form matched only `a.metadata ->> '...'` and friends, so
    // it never even evaluated the six free-text keys 0385 itself reads through
    // the `g.safe_metadata` alias, and adding `'awarded_to', g.safe_metadata ->>
    // 'awarded_to'` re-opened this exact leak with the suite fully green.
    const m = latestRedefiner();
    const structural = new Set(contract.structural_keys);

    const ungated = uniqueSorted(
      projectedKeys(m)
        .filter(([key, expr]) => !structural.has(key) && !CLEANERS.test(expr))
        .map(([key]) => key),
    );

    expect(
      ungated,
      why(
        m,
        `emits these keys WITHOUT a value gate: ${ungated.join(', ')}. Route each through a ` +
          `cleaner (private.public_free_text_or_null / public_url_or_null / ` +
          `public_jsonb_text_or_null / academic_record_public_label), or — if the value carries ` +
          `no issuer- or extraction-authored text — add it to "structural_keys" in ` +
          `scripts/ci/public-pii-projection-contract.json. Per-field wrapping is opt-in, so a new ` +
          `key is ungated BY DEFAULT; this assertion is the only thing that makes that a decision ` +
          `instead of an accident.`,
      ),
    ).toEqual(uniqueSorted(contract.ungated_keys));
  });

  it('classifies structural_keys as a subset of the keys actually projected', () => {
    // Otherwise the allow-list rots: a stale entry silently pre-exempts a key
    // name that a future migration reintroduces for a different, unsafe value.
    const projected = new Set(contract.projection_keys);
    expect(
      contract.structural_keys.filter((k) => !projected.has(k)),
      'structural_keys names keys the projection does not emit. Remove them — a stale exemption ' +
        'silently pre-approves whatever a future migration binds to that name.',
    ).toEqual([]);
  });

  it('never emits a raw filename, and never emits a NULL one', () => {
    const m = latestRedefiner();
    const clause = m.sql.match(/'filename',[\s\S]{0,600}?'file_size'/)?.[0];
    expect(clause, "could not locate the 'filename' projection clause").toBeTruthy();
    expect(
      clause,
      why(m, 'emits a.filename raw — an upload named after the learner is published to anon.'),
    ).toContain('public_free_text_or_null');
    // COALESCE to a controlled label: the verify page renders filename as the
    // record's display title and embeds it in schema.org JSON-LD.
    expect(clause, why(m, 'can emit a NULL filename, which consumers assume is a string.')).toContain(
      'COALESCE',
    );
  });

  it('routes every emitted URL through the drop-on-overflow URL cleaner', () => {
    // Truncating a URL yields a valid-looking WRONG link that the frontend
    // renders live, which is worse than omitting it.
    const m = latestRedefiner();
    for (const key of ['proof_url', 'source_url', 'registry_url']) {
      const clause = m.sql.match(new RegExp(String.raw`'${key}',[\s\S]{0,300}?\)`))?.[0];
      expect(clause, `could not locate the '${key}' projection clause`).toBeTruthy();
      expect(clause, why(m, `emits ${key} without public_url_or_null().`)).toContain(
        'public_url_or_null',
      );
    }
  });

  it('never emits a null top-level jurisdiction (CLAUDE.md §6, frozen schema)', () => {
    // This key sits OUTSIDE jsonb_strip_nulls, so the presence test must run on
    // the CLEANED value; testing the raw one publishes "jurisdiction": null
    // whenever the gate drops it.
    const m = latestRedefiner();
    expect(
      m.sql,
      why(m, 'can emit a null top-level jurisdiction — it must be inside a jsonb_strip_nulls.'),
    ).toMatch(
      /jsonb_strip_nulls\(jsonb_build_object\(\s*'jurisdiction',\s*private\.public_free_text_or_null\(/,
    );
  });

  it('keeps SECURITY DEFINER pinned to a fixed search_path (CLAUDE.md §1.4)', () => {
    const m = latestRedefiner();
    expect(m.sql, why(m, 'is not SECURITY DEFINER.')).toMatch(/SECURITY DEFINER/);
    expect(m.sql, why(m, 'does not pin search_path.')).toMatch(/SET search_path TO 'public'/);
  });

  it('reloads the PostgREST schema cache', () => {
    expect(latestRedefiner().sql).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });

  it('never fails closed — this path answers a verification question', () => {
    // A RAISE here would tell an anonymous verifier that a genuinely anchored
    // document does not exist. The gate omits FIELDS, never records.
    const m = latestRedefiner();
    const body = m.sql.slice(m.sql.search(REDEFINES_GET_PUBLIC_ANCHOR));
    expect(body, why(m, 'raises on detected PII instead of omitting the field.')).not.toMatch(
      /RAISE\s+EXCEPTION/i,
    );
    const whereClause = body.match(/WHERE a\.public_id = p_public_id[\s\S]*?deleted_at IS NULL;/)?.[0];
    expect(whereClause).toBeTruthy();
    // A detector in the row filter would turn a false positive into "not found".
    expect(whereClause).not.toContain('contains_learner_name_pii');
    expect(whereClause).not.toContain('contains_high_confidence_pii');
  });
});

describe('public projection PII gate — detectors and vocabulary (migration 0385)', () => {
  // These assert the OWNING migration, which defines the helper functions. They
  // are re-verified behaviourally, against a real database, by the live suite.
  const owner = stripSqlComments(
    fs.readFileSync(path.join(REPO, contract.sql_owner_migration), 'utf8'),
  );

  it('declares exactly the contract academic-record type set', () => {
    const predicate = owner.match(
      /CREATE OR REPLACE FUNCTION private\.is_academic_record_credential_type[\s\S]*?\$\$;/,
    )?.[0];
    expect(predicate, 'is_academic_record_credential_type must be defined').toBeTruthy();
    const listed = [...(predicate as string).matchAll(/'([A-Z_]{3,})'/g)].map((m) => m[1]).sort();
    // Set equality both ways: a silent WIDENING replaces real credential titles
    // with generic ones; a silent NARROWING reopens the leak for the dropped
    // type, which is exactly how TRANSCRIPT went ungated on the CTDL path.
    expect(listed).toEqual([...contract.academic_record_credential_types].sort());
  });

  it('binds each academic type to its label in ONE expression', () => {
    const labelFn = owner.match(
      /CREATE OR REPLACE FUNCTION private\.academic_record_public_label[\s\S]*?\$\$;/,
    )?.[0];
    expect(labelFn, 'academic_record_public_label must be defined').toBeTruthy();
    for (const [type, label] of Object.entries(contract.sql_academic_controlled_labels)) {
      // WHEN and THEN asserted TOGETHER — checked separately, swapping two
      // labels passes.
      expect(labelFn, `${type} must map to ${JSON.stringify(label)}`).toMatch(
        new RegExp(String.raw`WHEN\s+'${type}'\s+THEN\s+'${label}'`),
      );
    }
    expect(Object.keys(contract.sql_academic_controlled_labels).sort()).toEqual(
      [...contract.academic_record_credential_types].sort(),
    );
  });

  it('implements every high-confidence detector family, case-insensitively where required', () => {
    const detector = owner.match(
      /CREATE OR REPLACE FUNCTION private\.contains_high_confidence_pii[\s\S]*?\n\$\$;/,
    )?.[0];
    expect(detector, 'contains_high_confidence_pii must be defined').toBeTruthy();

    const familyMarkers: Record<string, RegExp> = {
      // `~*` is load-bearing: with `~` every lowercase e-mail stops matching.
      email: /~\*\s*'\\y\[A-Z0-9\._%\+-\]\+@/,
      ssn_separated: /~\s*'\\y\\d\{3\}\[-\\s\]\\d\{2\}\[-\\s\]\\d\{4\}\\y'/,
      ssn_keyword: /~\*\s*'\\y\(\?:ssn\|social\\ssecurity/,
      us_phone: /~\s*'\(\?:\\\+1\\d\{10\}/,
      international_phone: /regexp_matches\(v_text, '\(\\\+\\d\{1,3\}/,
      date_of_birth_keyword: /~\*\s*'\(\?:\\yd\\\.\?/,
      student_id_keyword: /~\*\s*'\\y\(\?:\(\?:student\|learner/,
    };
    for (const family of contract.high_confidence_detector_families) {
      const marker = familyMarkers[family];
      expect(marker, `no assertion wired for detector family ${family}`).toBeTruthy();
      expect(detector, `detector family ${family} is missing or lost its case sensitivity`).toMatch(
        marker,
      );
    }
    // Candidate regex + procedural E.164 digit count; without the count,
    // "+1 2026-03-27" reads as a phone number.
    expect(detector).toMatch(/BETWEEN 10 AND 15/);
  });

  it('implements NO learner-name heuristic — measured as negative-value on this path', () => {
    // The CTDL serializer's two capitalised-pair patterns are deliberately not
    // reproduced here: zero measured true positives against this contract's own
    // leak_vectors, and abundant measured false positives because `for` is a
    // bare preposition ("Center for Professional Development"). The strings
    // they used to blank are pinned in must_publish_vectors and exercised
    // end-to-end by the live suite, so reintroducing them fails loudly.
    expect(contract.sql_implements_learner_name_heuristics).toBe(false);
    expect(owner).not.toContain('contains_learner_name_pii');
    // The `for`-triggered alternation must not reappear under any name.
    expect(owner).not.toMatch(/\(\?:for\|learner\|student\|recipient\|issued to/);
  });

  it('pins the non-academic fallback label — a user-visible string lint:copy cannot see', () => {
    // Reached when the value gate drops a non-academic filename. It is emitted
    // as the record's display title and its schema.org `name`, but it lives in
    // SQL, so no copy linter covers it and nothing else asserts it.
    expect(owner).toContain(`'${contract.sql_non_academic_fallback_label}'`);
  });

  it('bounds text scans and URL length at the contract caps', () => {
    expect(owner).toContain(`left(p_text, ${contract.max_scan_chars})`);
    expect(owner).toMatch(
      new RegExp(String.raw`length\(v_url\)\s*>\s*${contract.max_public_url_chars}`),
    );
    // A URL is dropped, never truncated — truncation yields a valid-looking
    // wrong link.
    const urlFn = owner.match(
      /CREATE OR REPLACE FUNCTION private\.public_url_or_null[\s\S]*?\n\$\$;/,
    )?.[0];
    expect(urlFn).toBeTruthy();
    expect(urlFn).not.toMatch(/left\(v_url/);
  });

  it('revokes every helper from anon and authenticated', () => {
    for (const fn of [
      'is_academic_record_credential_type',
      'academic_record_public_label',
      'contains_high_confidence_pii',
      'public_free_text_or_null',
      'public_url_or_null',
      'public_jsonb_text_or_null',
    ]) {
      expect(owner, `${fn} must be revoked from anon/authenticated`).toMatch(
        new RegExp(
          String.raw`REVOKE ALL ON FUNCTION private\.${fn}\([^)]*\) FROM PUBLIC, anon, authenticated`,
        ),
      );
    }
  });

  it('documents which definition it was diffed against', () => {
    // Not saying so is how 0376 happened. This one gate is deliberately a
    // documentation check, and is named as such.
    const raw = fs.readFileSync(path.join(REPO, contract.sql_owner_migration), 'utf8');
    expect(raw).toMatch(/--\s*ROLLBACK:/);
    expect(raw).toMatch(/pg_get_functiondef/);
    expect(raw).toMatch(/0383/);
  });
});

describe('public projection PII gate — cross-implementation parity (self-arming)', () => {
  const TS_GUARD = path.join(REPO, contract.ts_owner_module);

  it('the TypeScript guard declares the same academic-record type set', () => {
    if (!fs.existsSync(TS_GUARD)) {
      // NOT a skip (CLAUDE.md §0 rule 1). The guard lands with PR #1815, which
      // is open and out of draft; until it merges, the only honest assertion is
      // that the file is genuinely absent and the contract records why. The
      // moment it appears this branch stops running and the parity assertion
      // below takes over, with no follow-up ticket.
      expect(contract.ts_owner_pending_pr).toBe(1815);
      expect(fs.existsSync(TS_GUARD)).toBe(false);
      return;
    }
    const src = fs.readFileSync(TS_GUARD, 'utf8');
    const block = src.match(/EDUCATION_CREDENTIAL_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1];
    expect(block, 'ctdl-pii-guard.ts must export EDUCATION_CREDENTIAL_TYPES as a Set literal').toBeTruthy();
    const tsTypes = [...(block as string).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(
      tsTypes,
      'ctdl-pii-guard.ts and the SQL projection must gate the SAME credential types. ' +
        'Update scripts/ci/public-pii-projection-contract.json and BOTH implementations in ' +
        'one PR — asymmetry between these two public paths is the defect this contract exists ' +
        'to prevent.',
    ).toEqual([...contract.academic_record_credential_types].sort());
  });

  it('the TypeScript guard bounds its scans at the same character cap', () => {
    if (!fs.existsSync(TS_GUARD)) {
      expect(contract.ts_owner_pending_pr).toBe(1815);
      return;
    }
    const src = fs.readFileSync(TS_GUARD, 'utf8');
    expect(src).toMatch(new RegExp(String.raw`MAX_SCAN_CHARS\s*=\s*${contract.max_scan_chars}\b`));
  });

  it('pins the THIRD education-type set (FERPA) so it cannot drift unnoticed', () => {
    // services/worker/src/constants/ferpa.ts carries its own education-type list
    // that deliberately DIFFERS (it includes CLE) because it drives a FERPA
    // re-disclosure notice, not free-text suppression. Two lists with two
    // purposes is fine; two lists where nobody knows the second exists is how
    // this class of bug happens. Pin it, so a change is a decision.
    const src = fs.readFileSync(path.join(REPO, contract.ferpa_module), 'utf8');
    const block = src.match(/FERPA_EDUCATION_TYPES\s*=\s*\[([\s\S]*?)\]/)?.[1];
    expect(block, 'FERPA_EDUCATION_TYPES must be an array literal').toBeTruthy();
    const types = [...(block as string).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(
      types,
      'FERPA_EDUCATION_TYPES changed. It is intentionally NOT the same set as the public-projection ' +
        'academic types (it includes CLE). If you changed one, decide explicitly whether the other ' +
        'should follow, and update scripts/ci/public-pii-projection-contract.json.',
    ).toEqual([...contract.ferpa_education_types].sort());
  });
});

/**
 * The THIRD projection: `GET /api/v1/verify/:publicId`.
 *
 * `router.ts` allows anonymous GET on it, and `buildVerificationResult` shipped
 * `anchor.description` raw — including for the three credential types the other
 * two projections suppress outright. The behavioural proof runs in
 * `services/worker/src/api/v1/verify-pii-projection.test.ts` (supertest through
 * the real route). These assertions prove the RULE cannot silently disappear
 * from the source, which a behavioural suite alone cannot: a future edit that
 * deletes the gate and its tests together would leave nothing failing.
 */
describe('public projection PII gate — the verify API surface', () => {
  const VERIFY = path.join(REPO, contract.verify_owner_module);
  /**
   * COMMENT-STRIPPED, for the same reason the SQL assertions are: verify.ts
   * carries a long design note naming the very symbols these assertions forbid
   * (`containsLearnerNamePii`), and matching the raw file would read the
   * explanation as the thing it warns against — a test that fails on its own
   * documentation and passes once you delete the documentation.
   */
  const verifySrc = (): string => stripTsComments(fs.readFileSync(VERIFY, 'utf8'));

  it('reuses the shared detector and the shared value layer, re-implementing neither', () => {
    const src = verifySrc();
    // The STRUCTURAL half comes from the guard (dependency-free by design, so a
    // non-CTDL path can use it without dragging in the CTDL serializer); the
    // VALUE half comes from public-projection-text.ts, which every TS
    // projection shares. A second hand-rolled copy of either is exactly the
    // drift this contract exists to stop.
    expect(
      src,
      'verify.ts must import isEducationCredentialType from ctdl-pii-guard.js',
    ).toMatch(/from\s+'\.\.\/\.\.\/ctdl\/ctdl-pii-guard\.js'/);
    expect(src).toContain('isEducationCredentialType');
    expect(
      src,
      'verify.ts must import the value layer from ./public-projection-text.js rather than ' +
        'carrying its own copy.',
    ).toMatch(/from\s+'\.\/public-projection-text\.js'/);
    expect(src).toContain('publicFreeTextOrNull');
  });

  it('suppresses every contract-listed academic field structurally', () => {
    const src = verifySrc();
    // The academic branch must key off the GUARD's set, not FERPA_EDUCATION_TYPES
    // (which additionally contains CLE and drives a different mechanism).
    expect(src).toMatch(/isAcademicRecord\s*=\s*isEducationCredentialType\(/);
    for (const field of contract.verify_academic_suppressed_fields) {
      // Escaped: the sibling SQL list already carries dotted names like
      // `metadata.description`, where an unescaped `.` would silently become a
      // wildcard and the assertion would stop meaning what it says.
      const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(
        src,
        `verify.ts must suppress '${field}' on an academic record — it is listed in ` +
          'verify_academic_suppressed_fields.',
      ).toMatch(new RegExp(String.raw`if\s*\(!isAcademicRecord\)[\s\S]{0,400}?\b${escaped}\b`));
    }
  });

  it('does NOT gate the academic suppression on directory_info_opt_out', () => {
    // THE POLICY DECISION. `suppressDirectory` is the REG-02 §99.37 opt-out and
    // stays exactly as it was; the academic free-text rule must not be folded
    // into it, because opt-out means the default is PUBLISH and that default is
    // the defect class. Asserted as source shape because the distinction is
    // invisible in a passing behavioural test that only sets the flag one way.
    const src = verifySrc();
    expect(src).toMatch(/const\s+suppressDirectory\s*=/);
    expect(
      src,
      'The academic-record suppression must not be conditioned on suppressDirectory. ' +
        'If you are deliberately switching this surface to opt-out-conditional, say so in ' +
        'scripts/ci/public-pii-projection-contract.json $verify_note and change this test — ' +
        'it is a decision, not a refactor.',
    ).not.toMatch(/isAcademicRecord\s*&&\s*suppressDirectory|suppressDirectory\s*&&\s*isAcademicRecord/);
  });

  it('routes every contract-listed value-gated field through the gate', () => {
    const src = verifySrc();
    // The two explicitly-wired fields. `description` is covered above;
    // `sub_type`/`file_mime` go through the API-RICH allow-list asserted next.
    for (const field of ['issuer_name', 'jurisdiction']) {
      expect(
        contract.verify_value_gated_fields,
        `${field} must be listed in verify_value_gated_fields`,
      ).toContain(field);
    }
    expect(src).toMatch(/const\s+issuerName\s*=\s*publicFreeTextOrNull\(/);
    expect(src).toMatch(/const\s+jurisdiction\s*=\s*publicFreeTextOrNull\(/);
    expect(src).toMatch(/const\s+description\s*=\s*publicFreeTextOrNull\(/);
  });

  it('gates API-RICH strings by ALLOW-list, so a new additive field fails closed', () => {
    const src = verifySrc();
    const block = src.match(/STRUCTURAL_API_RICH_KEYS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1];
    expect(block, 'verify.ts must declare STRUCTURAL_API_RICH_KEYS as a Set literal').toBeTruthy();
    const keys = [...(block as string).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(
      keys,
      'The API-RICH exemption list changed. Every string key NOT on it is value-gated, so ' +
        'ADDING one here publishes that field raw to anonymous callers. State why it is safe in ' +
        'scripts/ci/public-pii-projection-contract.json.',
    ).toEqual([...contract.verify_structural_api_rich_keys].sort());
    // The fail-closed direction: strings are gated unless exempted, rather than
    // exempted unless recognised as dangerous.
    expect(src).toMatch(/typeof\s+v\s*===\s*'string'\s*&&\s*!STRUCTURAL_API_RICH_KEYS\.has\(/);
  });

  it('implements NO learner-name heuristic — same measured reason as the SQL path', () => {
    expect(contract.verify_implements_learner_name_heuristics).toBe(false);
    const src = verifySrc();
    expect(
      src,
      'verify.ts must not import containsLearnerNamePii. Measured in PR #1815 and again for ' +
        '0385: zero true positives on the real leak shapes, abundant false positives because ' +
        "`for` is a bare preposition. The must_publish_vectors pin the strings it would blank.",
    ).not.toMatch(/\bcontainsLearnerNamePii\b/);
  });

  it('omits rather than fails closed — this path answers a verification question', () => {
    expect(contract.verify_fails_closed).toBe(false);
    const src = verifySrc();
    // A PII hit must never become a thrown error / 404 on this surface: that
    // would tell an anonymous verifier a genuinely anchored document does not
    // exist. The guard's fail-closed error type must not appear here.
    expect(src).not.toMatch(/\bCtdlPiiSafetyError\b/);
    expect(src).not.toMatch(/\bassertNoPiiInJsonLd\b/);
  });
});

/**
 * The FOURTH projection: `GET /api/v1/verify/:publicId/provenance`, mounted in
 * `router.ts` with no `requireScope` and no auth middleware.
 *
 * Behavioural proof is `services/worker/src/api/v1/provenance-pii-projection.test.ts`
 * (supertest through the real anonymous route). These assertions prove the RULE
 * cannot silently disappear from the source, which behaviour alone cannot: an
 * edit that deletes the gate and its tests together leaves nothing failing.
 */
describe('public projection PII gate — the provenance API surface', () => {
  const PROVENANCE = path.join(REPO, contract.provenance_owner_module);
  /** Comment-stripped for the same reason as the verify half — this file also
   *  documents the symbols the assertions forbid. */
  const provenanceSrc = (): string => stripTsComments(fs.readFileSync(PROVENANCE, 'utf8'));

  it('reuses the ONE shared value layer instead of a second copy', () => {
    const src = provenanceSrc();
    expect(
      src,
      'provenance.ts must import publicFreeTextOrNull from ./public-projection-text.js. ' +
        'A second copy of the wrapper is the drift this contract exists to prevent.',
    ).toMatch(/from\s+'\.\/public-projection-text\.js'/);
    expect(src).toContain('publicFreeTextOrNull');
    // And the structural half comes from the guard, not a local type list.
    expect(src).toMatch(/from\s+'\.\.\/\.\.\/ctdl\/ctdl-pii-guard\.js'/);
    expect(src).toContain('isEducationCredentialType');
  });

  it('suppresses every contract-listed academic field structurally', () => {
    const src = provenanceSrc();
    for (const field of contract.provenance_academic_suppressed_fields) {
      const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(
        src,
        `provenance.ts must suppress '${field}' on an academic record`,
      ).toMatch(
        new RegExp(String.raw`isEducationCredentialType\([\s\S]{0,200}?\b${escaped}\b`),
      );
    }
  });

  it('never emits a contract-listed never-emit field, and never SELECTs it', () => {
    const src = provenanceSrc();
    for (const qualified of contract.provenance_never_emitted_fields) {
      const column = qualified.split('.').pop() as string;
      expect(
        src,
        `${qualified} is a person's identity by construction (X.509 Subject CN), not prose that ` +
          'might contain one. No value detector can catch a bare name — that is the measured ' +
          'finding behind this whole contract — so it must not appear in provenance.ts at all, ' +
          'including in the SELECT list.',
      ).not.toContain(column);
    }
  });

  it('does not gate the academic suppression on directory_info_opt_out', () => {
    const src = provenanceSrc();
    expect(src).not.toMatch(/directory_info_opt_out/);
  });

  it('implements NO learner-name heuristic', () => {
    expect(contract.provenance_implements_learner_name_heuristics).toBe(false);
    expect(provenanceSrc()).not.toMatch(/\bcontainsLearnerNamePii\b/);
  });

  it('omits rather than fails closed', () => {
    expect(contract.provenance_fails_closed).toBe(false);
    const src = provenanceSrc();
    expect(src).not.toMatch(/\bCtdlPiiSafetyError\b/);
  });

  it('never asserts "no reason provided" over a suppressed reason', () => {
    // Three distinct facts, three distinct strings (CLAUDE.md §1.5, §1.13 R-7).
    // The `hasStoredFreeText` branch is what keeps the false claim off a
    // revocation whose reason exists but is not publishable.
    const src = provenanceSrc();
    expect(
      src,
      'provenance.ts must distinguish "no reason stored" from "reason stored but suppressed" ' +
        'via hasStoredFreeText — asserting the first when the second is true is a false claim ' +
        'on a public projection.',
    ).toContain('hasStoredFreeText');
  });
});

/**
 * The shared TS value layer. One function, four callers; a second copy is the
 * drift in miniature.
 */
describe('public projection PII gate — the shared TS value layer', () => {
  const MODULE = path.join(REPO, 'services/worker/src/api/v1/public-projection-text.ts');

  it('exists and imports its detectors from the guard rather than restating them', () => {
    expect(fs.existsSync(MODULE)).toBe(true);
    const src = stripTsComments(fs.readFileSync(MODULE, 'utf8'));
    expect(src).toMatch(/from\s+'\.\.\/\.\.\/ctdl\/ctdl-pii-guard\.js'/);
    for (const symbol of ['containsHighConfidencePii', 'normalizePublicText', 'MAX_SCAN_CHARS']) {
      expect(src, `the shared value layer must reuse ${symbol}`).toContain(symbol);
    }
    // No hand-rolled detector may live here — the guard owns them.
    expect(
      src,
      'public-projection-text.ts must not define its own PII patterns; the guard is the single ' +
        'source of truth for detection.',
    ).not.toMatch(/new RegExp\(|=\s*\/\^?\[/);
  });

  it('is the only TS definition of the wrapper', () => {
    const callers = [
      'services/worker/src/api/v1/verify.ts',
      contract.provenance_owner_module,
    ];
    for (const rel of callers) {
      const src = stripTsComments(fs.readFileSync(path.join(REPO, rel), 'utf8'));
      expect(
        src,
        `${rel} must IMPORT publicFreeTextOrNull, not define its own.`,
      ).not.toMatch(/function\s+publicFreeTextOrNull\s*\(/);
      expect(src).toMatch(/from\s+'\.\/public-projection-text\.js'/);
    }
  });
});
