/**
 * SCRUM-2248 (HARDEN-1-E) — BUG-2026-06-05-001, SEV1.
 *
 * get_public_anchor is GRANTed to anon and called by the public verification
 * page. It returns the freeform anchors.metadata blob via
 * sanitize_metadata_for_public(...), which was a DENYLIST: it strips a fixed set
 * of named PII keys (recipient, email, ssn, ...) but does NOT strip the
 * `_`-prefixed worker/chain internals the anchoring pipeline stamps onto
 * metadata — `_raw_tx_hex` (the full signed Bitcoin transaction hex), `_fee_sats`,
 * `_metadata_hash`, and any future `_`-prefixed internal. Those leak to ANONYMOUS
 * callers of the public verify path.
 *
 * Migration 0332 redefines sanitize_metadata_for_public to ALSO strip every
 * top-level key matching `^_` (via a key-filtered jsonb_object_agg), while
 * keeping the existing named PII denylist as defense in depth. The fix is a pure
 * function-body redefinition — no schema change, no data migration.
 *
 * These assertions read migration 0332 directly (content-guard), mirroring the
 * convention in scrum-1847-1869-public-anchor-cpe-cle-metadata.test.ts: no local
 * Supabase stack is assumed in CI, so the regression is enforced against the
 * migration SQL. The underscore-strip and PII denylist are both asserted, plus
 * the migration-hygiene gates (search_path, NOTIFY, ROLLBACK).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0332_scrum2248_sanitize_metadata_strip_underscore.sql',
);

function migration(): string {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

/** The body of the CREATE OR REPLACE FUNCTION sanitize_metadata_for_public def. */
function functionBlock(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION');
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('SCRUM-2248: sanitize_metadata_for_public strips `_`-prefixed internals', () => {
  it('migration 0332 redefines sanitize_metadata_for_public', () => {
    expect(migration()).toMatch(
      /CREATE OR REPLACE FUNCTION\s+(?:"?public"?\.)?"?sanitize_metadata_for_public"?/,
    );
  });

  // ── THE FIX: strip every key matching ^_ ─────────────────────────────────
  // The function must filter out any top-level key whose name starts with an
  // underscore. We assert the LIKE-based key filter that drops `_*` keys, which
  // is what removes `_raw_tx_hex` / `_fee_sats` / `_metadata_hash` and any
  // FUTURE `_`-prefixed worker/chain internal.
  it('filters out every key starting with an underscore (LIKE ^_ pattern)', () => {
    const block = functionBlock(migration());
    // key NOT LIKE '\_%' (the underscore is LIKE-escaped) gates the agg.
    expect(block).toMatch(/NOT\s+LIKE\s+'\\_%'/);
  });

  it('rebuilds the object excluding underscore keys (jsonb_each + jsonb_object_agg)', () => {
    const block = functionBlock(migration());
    expect(block).toContain('jsonb_each');
    expect(block).toContain('jsonb_object_agg');
  });

  // Spot-check the concrete leaking keys from the bug report. Because the strip
  // is by `^_` prefix (not an enumerated list), the function body should NOT
  // re-emit them as build keys.
  const LEAKING_INTERNAL_KEYS = ['_raw_tx_hex', '_fee_sats', '_metadata_hash'];
  it('never re-projects the known leaking internal keys as output', () => {
    const block = functionBlock(migration());
    for (const k of LEAKING_INTERNAL_KEYS) {
      expect(block).not.toMatch(new RegExp(`jsonb_build_object[\\s\\S]*'${k}'`));
    }
  });

  // ── DEFENSE IN DEPTH: keep the named PII denylist ────────────────────────
  const PII_DENYLIST_KEYS = [
    'recipient',
    'email',
    'phone',
    'ssn',
    'social_security',
    'student_id',
    'address',
    'dob',
    'date_of_birth',
    'national_id',
    'passport_number',
    'drivers_license',
  ];
  it('keeps the named PII denylist as defense in depth', () => {
    const block = functionBlock(migration());
    for (const k of PII_DENYLIST_KEYS) {
      expect(block).toContain(`'${k}'`);
    }
  });

  // ── Benign / public keys must survive ────────────────────────────────────
  // The function must not be a blanket wipe: a non-underscore, non-PII key like
  // `issuer` must pass through. We assert the function is NOT the trivial empty
  // return and preserves a COALESCE to '{}' for the null case.
  it('preserves a COALESCE empty-object fallback (not a blanket wipe)', () => {
    const block = functionBlock(migration());
    expect(block).toContain("'{}'::jsonb");
    expect(block).toMatch(/COALESCE/i);
  });

  // ── Migration hygiene gates ──────────────────────────────────────────────
  it('preserves search_path hardening', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/SET\s+search_path\s+TO\s+'public'/i);
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration()).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('documents a ROLLBACK path with the prior denylist-only body', () => {
    const sql = migration();
    expect(sql).toMatch(/--\s*ROLLBACK:/i);
    expect(sql).toMatch(/--\s*ROLLBACK:[\s\S]*sanitize_metadata_for_public/i);
  });

  it('references the Jira id and bug id in the header', () => {
    const sql = migration();
    expect(sql).toContain('SCRUM-2248');
    expect(sql).toContain('BUG-2026-06-05-001');
  });
});
