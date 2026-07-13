/**
 * SCRUM-2484 — get_public_anchor recipient_identifier: unsalted sha256 → keyed HMAC.
 *
 * get_public_anchor projects `recipient_identifier` to anonymous callers. In
 * 0311/0331/0355 it was `encode(digest(recipient::bytea, 'sha256'), 'hex')` — a
 * BARE, UNSALTED sha256 of the raw recipient value. Because the digest is public
 * AND unkeyed, anyone can compute sha256(known_email) offline and enumerate which
 * anchored credentials belong to a person (rainbow-table / correlation attack).
 *
 * Migration 0356 keys it with a server pepper GUC (`app.recipient_pepper`, set
 * DB-side exactly like `app.base_url`): the digest becomes
 * HMAC-SHA256(pepper, recipient) via extensions.hmac, so it cannot be
 * precomputed without the pepper. FAIL CLOSED: when the pepper GUC is unset, the
 * function returns an EMPTY recipient_identifier — it must NEVER fall back to the
 * enumerable bare sha256.
 *
 * The `recipient_identifier` KEY stays in the payload (it is part of the frozen
 * public verification API contract, §1.8) — only its VALUE derivation changes.
 * PEPPER VALUE + the `ALTER DATABASE ... SET app.recipient_pepper` are
 * Carson/RTE-gated; this migration codes the path.
 *
 * SQL content-guard test (no live DB in CI) — same convention as scrum-2248 /
 * scrum-2485.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0356_scrum2484_public_anchor_recipient_hmac.sql',
);

function migration(): string {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

function functionBlock(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION');
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('SCRUM-2484: get_public_anchor recipient_identifier is a keyed HMAC', () => {
  it('migration 0356 redefines get_public_anchor', () => {
    expect(migration()).toMatch(
      /CREATE OR REPLACE FUNCTION\s+(?:"?public"?\.)?"?get_public_anchor"?/,
    );
  });

  it('reads a server pepper from the app.recipient_pepper GUC', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/current_setting\(\s*'app\.recipient_pepper'\s*,\s*true\s*\)/);
  });

  it('derives the recipient hash via a KEYED HMAC (extensions.hmac), not a bare digest', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/extensions\.hmac\s*\(/);
  });

  it('FAILS CLOSED: no pepper ⇒ empty recipient_identifier, never a bare sha256 fallback', () => {
    const block = functionBlock(migration());
    // The bare-sha256 path must be gone: no `digest(<recipient>::bytea, 'sha256')`
    // that feeds recipient_identifier directly.
    expect(block).not.toMatch(/recipient_identifier[\s\S]{0,120}digest\([^,]*::bytea,\s*'sha256'\)/);
    // And there must be a guard that yields '' (or NULL) when the pepper is
    // absent/blank.
    expect(block).toMatch(/v_recipient_pepper/);
  });

  it('keeps the recipient_identifier KEY in the payload (frozen API contract §1.8)', () => {
    const block = functionBlock(migration());
    expect(block).toContain("'recipient_identifier'");
  });

  // ── Migration hygiene / security envelope ──────────────────────────────────
  it('preserves SECURITY DEFINER + search_path + status filter + deleted_at guard', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/SECURITY\s+DEFINER/i);
    expect(block).toMatch(/SET\s+search_path\s+TO\s+'public'/i);
    expect(block).toMatch(/a\.status\s+IN\s*\(/i);
    expect(block).toMatch(/a\.deleted_at\s+IS\s+NULL/i);
  });

  it('preserves the SCRUM-2485 base metadata allow-list (does not regress the projection)', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/'metadata',\s*jsonb_strip_nulls\(\s*jsonb_build_object\(/);
    expect(block).not.toMatch(/'metadata',\s*sanitize_metadata_for_public\(\s*COALESCE\(a\.metadata/);
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration()).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('documents a ROLLBACK path', () => {
    expect(migration()).toMatch(/--\s*ROLLBACK:[\s\S]*get_public_anchor/i);
  });

  it('carries the SCRUM-2484 ticket reference', () => {
    expect(migration()).toContain('SCRUM-2484');
  });
});
