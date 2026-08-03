/**
 * CE provenance key authority — migration 0394.
 *
 * THE HOLE THIS CLOSES (pre-existing, confirmed 2026-08-03 during the #1938
 * adversarial review): `anchors.metadata.registry_url` is served to anonymous
 * callers by `get_public_anchor`'s allow-list (0362, restored by 0383, value-
 * gated by 0385's `public_url_or_null`) and rendered on the public verify page
 * as the "Registry reference" link — but NOTHING at the DB layer restricts who
 * may WRITE it. `anchors_insert_own` constrains `user_id`/`status`/`org_id`
 * only, and 0384's trigger guards only `verification_level` +
 * `fingerprint_source`. So any authenticated user could insert an anchor with
 * `metadata.registry_url = 'https://attacker.example/phish'` and, once
 * SECURED, the public verify page links to it. `public_url_or_null` strips
 * query/fragment and scans for PII — it has no domain allow-list, so an
 * attacker origin passes it clean.
 *
 * The ONLY legitimate writers of the CE provenance key family are
 * service_role code paths: `credentials-ctdl-registry-anchor.ts` (stamps
 * `ce_registry_ctid`/`ce_registry_url`) and `credential-source-import.ts`
 * (stamps `registry_url`/`ce_envelope_sha256`). The browser CTDL import
 * dialog goes through those worker routes — it never writes these keys over
 * PostgREST. There is therefore no legitimate producer to break.
 *
 * Content-guard only (no DB), matching the convention in
 * `scrum-2481-anchor-evidence-claim-authority.test.ts`. The behavioural
 * RED/GREEN matrix was run against an isolated throwaway Postgres container
 * and is recorded in the PR's evidence block.
 *
 * LATEST-DEFINITION invariant: like `get-public-anchor-head-invariants.test.ts`,
 * every assertion here runs against the HIGHEST-numbered migration that
 * redefines `enforce_ce_provenance_key_authority()`, so a future redefinition
 * branched from a stale file fails CI instead of silently reopening the hole
 * (the 0376-clobber failure class).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
const REGISTRY_ANCHOR_ROUTE = path.join(
  process.cwd(),
  'services/worker/src/api/v1/credentials-ctdl-registry-anchor.ts',
);
const SOURCE_IMPORT = path.join(
  process.cwd(),
  'services/worker/src/lib/credential-source-import.ts',
);

const FUNCTION_NAME = 'public.enforce_ce_provenance_key_authority()';
const TRIGGER_NAME = 'trg_strip_unattested_ce_provenance_keys';

/**
 * The full set of service-stamped CE provenance keys the trigger must make
 * read-only for non-service_role callers. `registry_url` +
 * `ce_envelope_sha256` project to anon via the get_public_anchor allow-list;
 * `ce_registry_ctid` drives the ce-registry-drift job's outbound fetch;
 * `ce_registry_url` is the route-side source `registry_url` is derived from.
 */
const GUARDED_KEYS = [
  'registry_url',
  'ce_envelope_sha256',
  'ce_registry_url',
  'ce_registry_ctid',
].sort();

/** Strip SQL comment lines so header prose and ROLLBACK blocks never match. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** Highest-numbered migration file that redefines the guard function. */
function latestRedefiner(): { file: string; sql: string } {
  const redefiners = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .filter((f) =>
      executableSql(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')).includes(
        `CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}`,
      ),
    )
    .sort();
  expect(
    redefiners.length,
    'no migration defines enforce_ce_provenance_key_authority() — the CE provenance forgery hole is open',
  ).toBeGreaterThan(0);
  const file = redefiners[redefiners.length - 1];
  return { file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') };
}

describe('CE provenance key authority: migration shape', () => {
  it('exists, is transactional, and reloads the PostgREST schema cache', () => {
    const { sql } = latestRedefiner();
    const exec = executableSql(sql);
    expect(exec).toContain('BEGIN;');
    expect(exec).toContain('COMMIT;');
    expect(exec).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('carries a ROLLBACK comment that drops both objects', () => {
    const { sql } = latestRedefiner();
    expect(sql).toContain('-- ROLLBACK:');
    expect(sql).toContain(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON public.anchors;`);
    expect(sql).toContain(`DROP FUNCTION IF EXISTS ${FUNCTION_NAME};`);
  });

  it('is SECURITY DEFINER with a pinned search_path (§1.4)', () => {
    const { sql } = latestRedefiner();
    const exec = executableSql(sql);
    expect(exec).toContain(`CREATE OR REPLACE FUNCTION ${FUNCTION_NAME} RETURNS trigger`);
    expect(exec).toContain('SECURITY DEFINER');
    expect(exec).toContain("SET search_path TO 'public'");
  });

  it('fires BEFORE INSERT OR UPDATE of metadata on anchors, per row', () => {
    const { sql } = latestRedefiner();
    const exec = executableSql(sql);
    expect(exec).toContain(`CREATE TRIGGER ${TRIGGER_NAME}`);
    expect(exec).toContain('BEFORE INSERT OR UPDATE OF metadata ON public.anchors');
    expect(exec).toContain('FOR EACH ROW');
  });

  it('sorts after both existing anchors BEFORE-triggers', () => {
    // BEFORE triggers fire in name order. Sorting last means a post-SECURED
    // metadata edit still hits trg_prevent_metadata_edit's existing RAISE
    // first, and 0384's verification_level strip still runs unchanged — this
    // migration adds coverage without altering any existing error path.
    expect(TRIGGER_NAME > 'trg_prevent_metadata_edit').toBe(true);
    expect(TRIGGER_NAME > 'trg_strip_unassertable_evidence_claims').toBe(true);
  });
});

describe('CE provenance key authority: what the trigger enforces', () => {
  it('exempts service_role — the only attesting writer family', () => {
    const { sql } = latestRedefiner();
    expect(executableSql(sql)).toMatch(
      /IF get_caller_role\(\) = 'service_role' THEN\s*\n\s*RETURN NEW;/,
    );
  });

  it('guards exactly the service-stamped CE provenance key family', () => {
    const { sql } = latestRedefiner();
    const arrayMatch = executableSql(sql).match(/ARRAY\[([^\]]*)\]::text\[\]/);
    expect(arrayMatch).not.toBeNull();
    const guarded = Array.from(arrayMatch![1].matchAll(/'([a-z0-9_]+)'/g))
      .map((m) => m[1])
      .sort();
    expect(guarded).toEqual(GUARDED_KEYS);
  });

  it('strips on INSERT and reverts to OLD on UPDATE rather than rejecting the row', () => {
    // Same asymmetry rationale as 0384: these keys live in the free-form
    // metadata blob whose writers' contract is "persist what is understood,
    // ignore the rest" (bulk_create_anchors copies the blob wholesale, so a
    // RAISE would turn one ignorable key into a lost CSV row). Stripping keeps
    // the anchor and drops only the claim the server cannot stand behind;
    // reverting on UPDATE preserves a legitimately service-stamped value
    // instead of destroying it.
    const { sql } = latestRedefiner();
    const exec = executableSql(sql);
    expect(exec).toMatch(/jsonb_set\(/);
    expect(exec).toMatch(/-\s*v_key/);
    expect(exec).not.toMatch(/RAISE EXCEPTION/);
  });
});

describe('CE provenance key authority: drift guards', () => {
  it('covers every CE key the worker routes actually stamp', () => {
    // If a future writer stamps a new ce_* provenance key into
    // anchors.metadata, it must be added to the guarded array (or explicitly
    // exempted here with rationale) — otherwise it is client-forgeable.
    const route = fs.readFileSync(REGISTRY_ANCHOR_ROUTE, 'utf8');
    const importer = fs.readFileSync(SOURCE_IMPORT, 'utf8');
    for (const key of ['ce_registry_ctid', 'ce_registry_url']) {
      expect(route).toContain(key);
      expect(GUARDED_KEYS).toContain(key);
    }
    for (const key of ['registry_url', 'ce_envelope_sha256']) {
      expect(importer).toContain(key);
      expect(GUARDED_KEYS).toContain(key);
    }
  });

  it('guards the CE keys the public projection serves to anon', () => {
    // The two publicly-projected keys (0362 allow-list, live via 0383/0385)
    // must always be inside the guarded set — that pairing is the entire
    // point: anon-visible provenance may only ever be service-attested.
    for (const key of ['registry_url', 'ce_envelope_sha256']) {
      expect(GUARDED_KEYS).toContain(key);
    }
  });
});
