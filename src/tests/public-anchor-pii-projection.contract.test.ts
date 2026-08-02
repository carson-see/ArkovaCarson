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
 * key-NAME denylist that never inspects a value. Migration 0384 closes the SQL
 * side.
 *
 * ── HOW THESE ASSERTIONS STAY ALIVE ──────────────────────────────────────────
 *
 * Migrations are append-only, so a suite that reads a HARDCODED migration path
 * is a one-time verification, not a regression gate: it re-reads a frozen file
 * forever while production runs whatever the newest redefinition says. Every
 * behavioural assertion here therefore runs against the **latest redefiner** —
 * the highest-numbered migration that redefines `get_public_anchor` — which is
 * the only definition that matters at runtime. Today that is 0384; when an 0385
 * lands, these assertions automatically move to it.
 *
 * The SQL is also **comment-stripped** before matching. Without that, an 0385
 * written by following 0384's own documented ROLLBACK block would carry
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

const REPO = process.cwd();
const CONTRACT_PATH = path.join(REPO, 'scripts/ci/public-pii-projection-contract.json');
const MIGRATIONS_DIR = path.join(REPO, 'supabase/migrations');

interface Contract {
  sql_owner_migration: string;
  ts_owner_module: string;
  ts_owner_pending_pr: number;
  ts_pre_1815_module: string;
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

  it('gates EVERY key sourced from anchor text — derived from the SQL, not a hand-list', () => {
    // The failure mode this closes: per-field wrapping is OPT-IN, so a key added
    // by a future migration is emitted ungated by default. Rather than trusting
    // a hand-maintained list (which is how the gap arises in the first place),
    // parse every `'key', <expr>` pair out of the latest redefiner and require
    // each expression that reads anchor-controlled text to either call a cleaner
    // or be named in `contract.ungated_keys` with a stated reason.
    const m = latestRedefiner();
    const body = m.sql.slice(m.sql.search(REDEFINES_GET_PUBLIC_ANCHOR));

    const CLEANERS = /private\.(public_free_text_or_null|public_url_or_null|public_jsonb_text_or_null|academic_record_public_label)\(/;
    // Reads text the issuer or the extraction pipeline controls.
    const ANCHOR_TEXT = /a\.(metadata|cpe_metadata|cle_metadata)\s*->>?\s*'|a\.(filename|revocation_reason)\b/;

    const ungated: string[] = [];
    // `'key', <expr>` up to the next `'key',` at the same or shallower nesting.
    for (const match of body.matchAll(/'([a-z0-9_]+)',([\s\S]*?)(?=\n\s*'[a-z0-9_]+',|\n\s*\)\))/g)) {
      const [, key, expr] = match;
      if (!ANCHOR_TEXT.test(expr)) continue; // not anchor-controlled text
      if (CLEANERS.test(expr)) continue; // gated
      ungated.push(key);
    }

    expect(
      [...new Set(ungated)].sort(),
      why(
        m,
        `emits these keys from anchor-controlled text WITHOUT a value gate: ` +
          `${[...new Set(ungated)].sort().join(', ')}. Route each through a cleaner, or add it to ` +
          `"ungated_keys" in scripts/ci/public-pii-projection-contract.json with the reason it is ` +
          `safe. Per-field wrapping is opt-in, so a new key is ungated BY DEFAULT — this assertion ` +
          `is the only thing that makes that a decision instead of an accident.`,
      ),
    ).toEqual([...contract.ungated_keys].sort());
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

describe('public projection PII gate — detectors and vocabulary (migration 0384)', () => {
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
