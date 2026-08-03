/**
 * `get_public_anchor` HEAD-STATE INVARIANTS — regression guard for the
 * CREATE-OR-REPLACE clobber class.
 *
 * WHY THIS EXISTS
 * ---------------
 * `public.get_public_anchor` is the anon-callable public verification
 * projection. It is redefined WHOLESALE by every migration that touches it
 * (`CREATE OR REPLACE FUNCTION` overwrites the entire body). That makes it
 * uniquely fragile: an author who branches the body from an older migration
 * file silently DELETES every change made in between, and nothing errors,
 * warns, or shows up in the migration ledger.
 *
 * That is not hypothetical. It happened:
 *   0355 (SCRUM-2485) explicit metadata allow-list
 *   0356 (SCRUM-2484) keyed-HMAC recipient_identifier, fail-closed
 *   0362 (SCRUM-2913) allow-list += registry_url, ce_envelope_sha256
 *   0376 (R19)        += top-level fingerprint_source
 * 0376's header states its body is "otherwise IDENTICAL to 0355's definition"
 * — it was branched from 0355, so it reverted BOTH 0356 and 0362 in
 * production. The pre-existing per-migration tests all still passed, because
 * each one content-guards ITS OWN file and 0362's file was still perfectly
 * correct. Nobody was asserting anything about the CURRENT head definition.
 *
 * WHAT THIS GUARDS
 * ----------------
 * This suite finds the HIGHEST-NUMBERED migration that redefines
 * `get_public_anchor` — i.e. the definition that actually wins — and asserts
 * every invariant accumulated so far is present in it. Any future migration
 * that redefines the function must carry all of them forward or this fails.
 *
 * It is deliberately head-relative rather than pinned to a filename, so it
 * keeps working (and keeps biting) as new migrations land.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
// Paren-anchored: without it this is a PREFIX match, and 0386's redefinition
// of get_public_anchor_by_fingerprint was wrongly resolved as the head of
// get_public_anchor itself, failing every invariant against the wrong body.
const REDEFINES = 'CREATE OR REPLACE FUNCTION public.get_public_anchor(';

/** Strip SQL comment lines so header prose can never satisfy an assertion. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/**
 * The highest-numbered `NNNN_*.sql` that redefines get_public_anchor. Matching
 * on the EXECUTABLE text only — a migration that merely mentions the function
 * in its header (e.g. a ROLLBACK note) does not count as a redefinition.
 */
function headDefinition(): { file: string; prefix: number; sql: string } {
  const candidates = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}[a-z]?_.*\.sql$/.test(f))
    .map((file) => ({
      file,
      prefix: Number.parseInt(file.slice(0, 4), 10),
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'),
    }))
    .filter((c) => executableSql(c.sql).includes(REDEFINES))
    .sort((a, b) => a.prefix - b.prefix);

  if (candidates.length === 0) {
    throw new Error(
      `No migration in ${MIGRATIONS_DIR} redefines get_public_anchor — ` +
        `the invariant guard cannot run. This is itself a failure.`,
    );
  }
  return candidates[candidates.length - 1];
}

describe('get_public_anchor head-state invariants (CREATE OR REPLACE clobber guard)', () => {
  const head = headDefinition();
  const sql = executableSql(head.sql);
  // Everything between the allow-list open and its closing `))` — the base
  // `metadata` sub-object only, not the whole function.
  const metaBlock = sql.slice(
    sql.indexOf("'metadata', jsonb_strip_nulls(jsonb_build_object("),
    sql.indexOf("'created_at'"),
  );

  it(`resolves a head definition (currently ${head.file})`, () => {
    expect(head.prefix).toBeGreaterThan(0);
    expect(metaBlock.length).toBeGreaterThan(0);
  });

  // --- 0356 / SCRUM-2484 -----------------------------------------------------
  it('0356: derives recipient_identifier from a KEYED HMAC, not a bare sha256', () => {
    expect(sql).toContain('extensions.hmac(');
    expect(sql).toContain("current_setting('app.recipient_pepper', true)");
  });

  it('0356: NEVER falls back to an unsalted digest of the recipient', () => {
    // The exact pre-0356 construction. Its reappearance is the regression.
    expect(sql).not.toContain("extensions.digest(v_recipient_raw::bytea, 'sha256')");
  });

  it('0356: fails CLOSED — no pepper means an empty identifier, not a hash', () => {
    expect(sql).toMatch(/v_recipient_pepper\s+IS\s+NOT\s+NULL/i);
    expect(sql).toContain("jsonb_build_object('recipient_identifier', '')");
  });

  // --- 0362 / SCRUM-2913 -----------------------------------------------------
  it('0362: allow-list projects registry_url + ce_envelope_sha256', () => {
    expect(metaBlock).toContain("'registry_url'");
    expect(metaBlock).toContain("'ce_envelope_sha256'");
  });

  // --- 0376 / R19 ------------------------------------------------------------
  it('0376: projects the top-level fingerprint_source key', () => {
    expect(sql).toContain("'fingerprint_source', a.fingerprint_source");
  });

  // --- 0355 / SCRUM-2485 -----------------------------------------------------
  it('0355: base metadata stays an EXPLICIT allow-list, not a denylist dump', () => {
    expect(sql).toContain("'metadata', jsonb_strip_nulls(jsonb_build_object(");
    // A denylist pass-through would hand the whole sanitized jsonb straight
    // through instead of naming each key.
    expect(metaBlock).not.toMatch(/'metadata',\s*sanitize_metadata_for_public\(/);
  });

  it('0355: keys off the allow-list still cannot project', () => {
    expect(metaBlock).not.toContain('ctid');
    expect(metaBlock).not.toContain('competency');
    expect(metaBlock).not.toContain("'recipient'");
  });

  // --- Standing security invariants (CLAUDE.md §1.4 / §6) --------------------
  it('preserves SECURITY DEFINER + search_path hardening', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toMatch(/SET\s+search_path\s+TO\s+'public'/i);
  });

  it('preserves the status filter and the deleted_at guard', () => {
    expect(sql).toContain('a.deleted_at IS NULL');
    expect(sql).toMatch(/a\.status\s+IN\s*\(/);
  });

  it('never projects internal identifiers (user_id / org_id / anchors.id)', () => {
    // Only public_id and derived fields may leave this function (CLAUDE.md §6).
    expect(sql).not.toMatch(/'user_id'\s*,/);
    expect(sql).not.toMatch(/'org_id'\s*,/);
    expect(sql).not.toMatch(/'id'\s*,\s*a\.id/);
  });

  it('reloads the PostgREST schema cache', () => {
    expect(head.sql).toContain("NOTIFY pgrst, 'reload schema'");
  });
});
