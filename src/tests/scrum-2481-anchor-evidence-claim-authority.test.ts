/**
 * SCRUM-2481 DB half — migration 0384.
 *
 * THE HOLE THIS CLOSES: the API-route guard (`stripClientUnassertableEvidence
 * Claims`) only sees `POST /api/v1/anchor`. The browser writes `anchors`
 * DIRECTLY over PostgREST (`SecureDocumentDialog.tsx`,
 * `IssueCredentialForm.tsx`), and `anchors_insert_own` constrains `user_id` /
 * `status` / `org_id` and nothing about `metadata`. A free account could insert
 * `metadata.verification_level = 'issuer_anchored'`, let the nightly drain
 * SECURE it, and serve the forged issuer-authenticated badge (and the shareable
 * off-platform badge) out of `get_public_anchor`, which projects the key to
 * `anon`. `prevent_metadata_edit_after_secured` only covers NON-PENDING rows,
 * so the same upgrade was one PATCH away even for API-created anchors.
 *
 * Content-guard only (no DB), matching the convention in
 * `sec-recon-unguarded-rpc-family-revokes.test.ts` / `scrum-2485` / `scrum-2248`.
 * The behavioural RED/GREEN was run against a live local stack and is recorded
 * in the PR's evidence block: forged INSERT and PENDING-window UPDATE are
 * stripped, the `fingerprint_source` flip is refused, and bulk CSV import,
 * owner edits, browser inserts and service_role writes are unaffected.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0384_scrum2481_anchor_evidence_claim_authority.sql',
);
const PROVENANCE_PATH = path.join(process.cwd(), 'src/lib/sourceProvenance.ts');

const TRIGGER_NAME = 'trg_strip_unassertable_evidence_claims';
const FUNCTION_NAME = 'public.enforce_anchor_evidence_claim_authority()';

let migrationCache: string | null = null;
function migration(): string {
  if (migrationCache === null) {
    migrationCache = fs.readFileSync(MIGRATION_PATH, 'utf8');
  }
  return migrationCache;
}

/** Strip SQL comment lines so the header prose and ROLLBACK block never match. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('SCRUM-2481: migration 0384 shape', () => {
  it('exists, is transactional, and reloads the PostgREST schema cache', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    const sql = executableSql(migration());
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('carries a ROLLBACK comment that drops both objects', () => {
    const sql = migration();
    expect(sql).toContain('-- ROLLBACK:');
    expect(sql).toContain(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON public.anchors;`);
    expect(sql).toContain(`DROP FUNCTION IF EXISTS ${FUNCTION_NAME};`);
  });

  it('is SECURITY DEFINER with a pinned search_path (§1.4)', () => {
    const sql = executableSql(migration());
    expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${FUNCTION_NAME} RETURNS trigger`);
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path TO 'public'");
  });

  it('fires BEFORE INSERT OR UPDATE of the two evidence surfaces on anchors', () => {
    const sql = executableSql(migration());
    expect(sql).toContain(`CREATE TRIGGER ${TRIGGER_NAME}`);
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF metadata, fingerprint_source ON public.anchors');
    expect(sql).toContain('FOR EACH ROW');
  });

  it('sorts after trg_prevent_metadata_edit so that trigger keeps raising first', () => {
    // BEFORE triggers fire in name order. Sorting later means a post-SECURED
    // metadata edit still hits the existing RAISE rather than being silently
    // stripped into a no-op — this migration adds coverage, it does not change
    // an existing error path.
    expect(TRIGGER_NAME > 'trg_prevent_metadata_edit').toBe(true);
  });
});

describe('SCRUM-2481: what migration 0384 enforces', () => {
  it('exempts service_role — the only attesting writer', () => {
    const sql = executableSql(migration());
    expect(sql).toMatch(/IF get_caller_role\(\) = 'service_role' THEN\s*\n\s*RETURN NEW;/);
  });

  it('strips the level rather than rejecting the row', () => {
    const sql = executableSql(migration());
    expect(sql).toContain("NEW.metadata := NEW.metadata - 'verification_level';");
    expect(sql).not.toMatch(/RAISE EXCEPTION[^\n]*verification_level/);
  });

  it('refuses a fingerprint_source change, and only on UPDATE', () => {
    const sql = executableSql(migration());
    expect(sql).toContain(
      "IF TG_OP = 'UPDATE' AND NEW.fingerprint_source IS DISTINCT FROM OLD.fingerprint_source THEN",
    );
    expect(sql).toMatch(/RAISE EXCEPTION 'Cannot change fingerprint_source/);
    // INSERT must stay open: SecureDocumentDialog sets 'document_bytes' and
    // bulk_create_anchors (0376) computes the class server-side, both at insert.
    expect(sql).not.toMatch(/TG_OP = 'INSERT'[^\n]*fingerprint_source/);
  });

  it('leaves an unchanged server-attested level alone on unrelated edits', () => {
    const sql = executableSql(migration());
    expect(sql).toContain(
      "IF TG_OP = 'UPDATE' AND OLD.metadata ->> 'verification_level' IS NOT DISTINCT FROM v_new_level THEN",
    );
  });
});

describe('SCRUM-2481: drift guard against the public badge', () => {
  it('guards exactly the levels the public page renders as issuer-authenticated', () => {
    // `isIssuerAuthenticated` (src/lib/sourceProvenance.ts) decides which levels
    // earn the green badge. A level added there but not here is client-assertable
    // again — the exact regression SCRUM-2481 exists to prevent. The worker-side
    // twin of this assertion lives in
    // services/worker/src/lib/credential-evidence.test.ts.
    const provenance = fs.readFileSync(PROVENANCE_PATH, 'utf8');
    const block = provenance.match(
      /ISSUER_AUTHENTICATED_LEVELS[\s\S]*?new Set<VerificationLevel>\(\[([\s\S]*?)\]\)/,
    );
    expect(block).not.toBeNull();
    const badgeLevels = Array.from(block![1].matchAll(/'([a-z_]+)'/g)).map((m) => m[1]).sort();

    const guarded = executableSql(migration()).match(
      /v_new_level NOT IN \(([^)]*)\)/,
    );
    expect(guarded).not.toBeNull();
    const guardedLevels = Array.from(guarded![1].matchAll(/'([a-z_]+)'/g)).map((m) => m[1]).sort();

    expect(guardedLevels).toEqual(badgeLevels);
  });
});
