/**
 * SCRUM-1847 (CPE-R1) + SCRUM-1869 (CLE-R1): get_public_anchor must surface
 * cpe_metadata and cle_metadata on the public verification payload.
 *
 * The public verify path (src/components/verification/PublicVerification.tsx
 * and src/components/embed/VerificationWidget.tsx) calls get_public_anchor
 * directly via the Supabase anon client and assigns the whole RPC result to
 * the public anchor object — a passthrough, not a worker-mediated allowlist.
 * The frontend (open draft PRs #1023/#1025) reads data.cpe_metadata /
 * data.cle_metadata and self-hides when absent, allowlisting display fields.
 *
 * Migration 0331 redefines get_public_anchor to ALSO return:
 *   - cpe_metadata: an EXPLICIT public ALLOWLIST projected from a.cpe_metadata
 *     (NULL when the column is NULL)
 *   - cle_metadata: same allowlist approach
 * These are additive nullable fields (CLAUDE.md §1.8 — no API version bump).
 * The server-side allowlist is defense in depth, matching the frontend display
 * allowlists (cpeMetadataView / cleMetadataView, in unmerged #1023/#1025):
 * ONLY the public display keys are projected, so internal fields — sponsor_id,
 * course_id, reporting_period_start/end, the extraction_confidence /
 * extraction_source signals, and any FUTURE internal field — can never reach
 * the anon-granted public payload, even if a client forgets to filter them.
 * (A denylist, by contrast, auto-leaks any internal field added later — this is
 * the MEDIUM data-exposure fix that replaced the original two-key denylist.)
 *
 * These assertions read migration 0331 directly (content-guard), mirroring
 * the convention in scrum-2189-rpc-reads-cache.test.ts and
 * scrum-1980-public-search-perf.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0331_scrum1847_1869_public_anchor_cpe_cle_metadata.sql',
);

function migration(): string {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

/** The body of the CREATE OR REPLACE FUNCTION get_public_anchor definition. */
function functionBlock(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION');
  expect(start).toBeGreaterThan(-1);
  // Body runs to the closing $$; of the function definition.
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('SCRUM-1847/1869: get_public_anchor surfaces cpe/cle_metadata', () => {
  it('migration 0331 redefines get_public_anchor', () => {
    expect(migration()).toMatch(
      /CREATE OR REPLACE FUNCTION\s+public\.get_public_anchor/,
    );
  });

  it('returns cpe_metadata as a top-level key', () => {
    expect(functionBlock(migration())).toContain("'cpe_metadata'");
  });

  it('returns cle_metadata as a top-level key', () => {
    expect(functionBlock(migration())).toContain("'cle_metadata'");
  });

  // ── EXPLICIT ALLOWLIST (MEDIUM data-exposure fix) ─────────────────────────
  // The cpe_metadata / cle_metadata projections must build the public object
  // from ONLY these keys (matching the worker Cpe/CleMetadataSchema in
  // services/worker/src/compliance/professional-education.ts and the frontend
  // cpe/cleMetadataView allowlists). Anything not on the allowlist — including
  // any FUTURE internal field — must never reach the anon-granted RPC.
  const CPE_PUBLIC_KEYS = [
    'credit_hours',
    'field_of_study',
    'delivery_method',
    'nasba_status',
    'nasba_lookup_date',
    'requires_manual_review',
  ] as const;
  const CPE_INTERNAL_KEYS = [
    'sponsor_id',
    'reporting_period_start',
    'reporting_period_end',
    'extraction_confidence',
    'extraction_source',
  ] as const;
  const CLE_PUBLIC_KEYS = [
    'credit_hours',
    'ethics_hours',
    'jurisdiction',
    'approved_provider_name',
    'provider_approval_status',
    'provider_lookup_date',
    'delivery_format',
    'course_title',
    'requires_manual_review',
  ] as const;
  const CLE_INTERNAL_KEYS = [
    'course_id',
    'reporting_period_start',
    'reporting_period_end',
    'extraction_confidence',
    'extraction_source',
  ] as const;

  /**
   * Extract just the jsonb_build_object(...) argument list that projects the
   * named source column (a.cpe_metadata / a.cle_metadata) for the public key.
   * This lets each projection be asserted in isolation.
   */
  function projection(block: string, column: 'cpe_metadata' | 'cle_metadata'): string {
    const key = `'${column}', CASE`;
    const start = block.indexOf(key);
    expect(start).toBeGreaterThan(-1);
    // The projection runs to its CASE's `END` (the build-object + strip live
    // inside the THEN branch). Slice generously to the next top-level key or
    // the close of the jsonb_build_object; the per-key assertions below scope
    // matching to `a.<column> ->`.
    const afterStart = block.slice(start);
    const end = afterStart.indexOf('\n      END');
    expect(end).toBeGreaterThan(-1);
    return afterStart.slice(0, end);
  }

  it('builds cpe_metadata from an explicit allowlist via jsonb_build_object + jsonb_strip_nulls', () => {
    const proj = projection(functionBlock(migration()), 'cpe_metadata');
    expect(proj).toContain('jsonb_build_object');
    expect(proj).toContain('jsonb_strip_nulls');
  });

  it('cpe_metadata projects every public allowlist key (sourced with -> to preserve jsonb types)', () => {
    const proj = projection(functionBlock(migration()), 'cpe_metadata');
    for (const k of CPE_PUBLIC_KEYS) {
      // 'key', a.cpe_metadata -> 'key'
      expect(proj).toMatch(
        new RegExp(`'${k}',\\s*a\\.cpe_metadata\\s*->\\s*'${k}'`),
      );
    }
  });

  it('cpe_metadata NEVER projects an internal key (denylist regression — incl. future fields)', () => {
    const proj = projection(functionBlock(migration()), 'cpe_metadata');
    for (const k of CPE_INTERNAL_KEYS) {
      expect(proj).not.toContain(`'${k}'`);
      expect(proj).not.toContain(`a.cpe_metadata -> '${k}'`);
    }
  });

  it('builds cle_metadata from an explicit allowlist via jsonb_build_object + jsonb_strip_nulls', () => {
    const proj = projection(functionBlock(migration()), 'cle_metadata');
    expect(proj).toContain('jsonb_build_object');
    expect(proj).toContain('jsonb_strip_nulls');
  });

  it('cle_metadata projects every public allowlist key (sourced with -> to preserve jsonb types)', () => {
    const proj = projection(functionBlock(migration()), 'cle_metadata');
    for (const k of CLE_PUBLIC_KEYS) {
      expect(proj).toMatch(
        new RegExp(`'${k}',\\s*a\\.cle_metadata\\s*->\\s*'${k}'`),
      );
    }
  });

  it('cle_metadata NEVER projects an internal key (course_id + reporting_period + extraction signals)', () => {
    const proj = projection(functionBlock(migration()), 'cle_metadata');
    for (const k of CLE_INTERNAL_KEYS) {
      expect(proj).not.toContain(`'${k}'`);
      expect(proj).not.toContain(`a.cle_metadata -> '${k}'`);
    }
  });

  it('does not use the old two-key denylist strip (regression guard for the MEDIUM fix)', () => {
    const block = functionBlock(migration());
    // The original under-stripping denylist must be gone entirely.
    expect(block).not.toMatch(
      /a\.cpe_metadata\s*-\s*'extraction_confidence'\s*-\s*'extraction_source'/,
    );
    expect(block).not.toMatch(
      /a\.cle_metadata\s*-\s*'extraction_confidence'\s*-\s*'extraction_source'/,
    );
  });

  it('returns NULL for cpe_metadata / cle_metadata when the column is NULL (nullable, §1.8)', () => {
    const block = functionBlock(migration());
    // CASE WHEN a.cpe_metadata IS NOT NULL THEN (...) ELSE NULL END
    expect(block).toMatch(
      /CASE\s+WHEN\s+a\.cpe_metadata\s+IS\s+NOT\s+NULL[\s\S]*?ELSE\s+NULL\s+END/i,
    );
    expect(block).toMatch(
      /CASE\s+WHEN\s+a\.cle_metadata\s+IS\s+NOT\s+NULL[\s\S]*?ELSE\s+NULL\s+END/i,
    );
  });

  it('never leaks the internal extraction signals into any other returned key', () => {
    const block = functionBlock(migration());
    // The only mentions of the internal signals must be inside the strip
    // subtraction. They must never appear as a ->>' accessor that would surface
    // them as their own output field.
    expect(block).not.toMatch(/->>\s*'extraction_confidence'/);
    expect(block).not.toMatch(/->>\s*'extraction_source'/);
  });

  it('preserves SECURITY DEFINER and search_path hardening', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/SECURITY DEFINER/);
    expect(block).toMatch(/SET search_path TO 'public'/);
  });

  it('preserves the public-status filter and soft-delete guard', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(
      /a\.status IN \('SECURED', 'REVOKED', 'EXPIRED', 'SUPERSEDED', 'PENDING', 'SUBMITTED'\)/,
    );
    expect(block).toContain('a.deleted_at IS NULL');
  });

  it('preserves the recipient-identifier SHA-256 hashing logic', () => {
    const block = functionBlock(migration());
    expect(block).toContain("encode(extensions.digest(v_recipient_raw::bytea, 'sha256'), 'hex')");
    expect(block).toContain("'recipient_identifier'");
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration()).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('documents a ROLLBACK path', () => {
    expect(migration()).toMatch(/--\s*ROLLBACK:/i);
  });
});
