/**
 * DocuSign metadata key write authority — migration 0423.
 *
 * THE HOLE THIS CLOSES: CTO Decision Record ruling R1
 * (docs/staging/docusign-bilateral-2026-08/CTO-DECISION-RECORD.md, security
 * Finding 2). `services/worker/src/constants/connectorFingerprint.ts`
 * documents its own gap: "the metadata blob is org-writable on some legacy
 * paths (e.g. bulk_create_anchors persists client metadata verbatim)".
 * `anchors_insert_own` constrains `user_id`/`status`/`org_id` only, and
 * neither 0384's evidence-claim guard nor 0394's CE-provenance guard covers
 * the DocuSign key family. So today, any authenticated caller could call
 * `bulk_create_anchors(jsonb)` (self-authorizes via auth.uid(), copies its
 * metadata blob wholesale) or write `anchors` directly over PostgREST with
 * `metadata = {"connector_source":"docusign","account_id":"<fake>",
 * "envelope_id":"<fake>","_signers":[...]}`, and once SECURED by the nightly
 * drain, the record UI would render forged "Verified via DocuSign" links and
 * signer rows sourced entirely from attacker-supplied strings.
 *
 * The ONLY legitimate writers of this key family are service_role worker
 * jobs — `jobs/connector-artifact-drain.ts` (`connector_source`,
 * `connector_artifact_id`), `jobs/rule-action-dispatcher.ts`
 * (`connector_source`), `jobs/docusign-envelope-completed.ts` (`account_id`,
 * `envelope_id`, via the connector_artifact staging row) — all three
 * authenticate through `services/worker/src/utils/db.ts`'s
 * `config.supabaseServiceKey` client. `_signers`/`_docusign_env`/`_direction`/
 * `_sending_account_id` have no writer yet (PR-2/PR-4 of this sequence);
 * guarding them now, before any writer exists, avoids a window where the
 * first version of a future writer is forgeable. There is no legitimate
 * non-service_role producer of any of the 8 keys to break.
 *
 * Content-guard only (no DB), matching the convention in
 * `sec-ce-provenance-key-authority.test.ts` (0394) and
 * `scrum-2481-anchor-evidence-claim-authority.test.ts` (0384). This is a T3
 * migration (CLAUDE.md §1.12); the live INSERT/UPDATE RED/GREEN behavioral
 * matrix for non-service_role strip+revert and service_role pass-through is
 * exercised by the staging soak, not a local container in this repo (Docker
 * daemon unavailable in this session; the shared local Supabase stack is
 * explicitly off-limits to a single worktree per
 * `memory/reference_local_supabase_shared_project_id.md` — a `db reset
 * --local`/`stop` here would wipe concurrent sibling worktrees' state).
 *
 * LATEST-DEFINITION invariant: like `get-public-anchor-head-invariants.test.ts`,
 * every assertion here runs against the HIGHEST-numbered migration that
 * redefines `enforce_docusign_metadata_key_authority()`, so a future
 * redefinition branched from a stale file fails CI instead of silently
 * reopening the hole (the 0376-clobber failure class).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
const CONNECTOR_ARTIFACT_DRAIN = path.join(
  process.cwd(),
  'services/worker/src/jobs/connector-artifact-drain.ts',
);
const RULE_ACTION_DISPATCHER = path.join(
  process.cwd(),
  'services/worker/src/jobs/rule-action-dispatcher.ts',
);
const DOCUSIGN_ENVELOPE_COMPLETED = path.join(
  process.cwd(),
  'services/worker/src/jobs/docusign-envelope-completed.ts',
);

const FUNCTION_NAME = 'public.enforce_docusign_metadata_key_authority()';
const TRIGGER_NAME = 'trg_strip_unattested_docusign_metadata_keys';

/**
 * The full set of service-stamped DocuSign provenance keys the trigger must
 * make read-only for non-service_role callers (CTO Decision Record R1).
 */
const GUARDED_KEYS = [
  'connector_source',
  'connector_artifact_id',
  'account_id',
  'envelope_id',
  '_signers',
  '_docusign_env',
  '_direction',
  '_sending_account_id',
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
    'no migration defines enforce_docusign_metadata_key_authority() — the DocuSign metadata forgery hole is open',
  ).toBeGreaterThan(0);
  const file = redefiners[redefiners.length - 1];
  return { file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') };
}

describe('DocuSign metadata key authority: migration shape', () => {
  it('exists, is transactional, and reloads the PostgREST schema cache', () => {
    const { sql } = latestRedefiner();
    const exec = executableSql(sql);
    expect(exec).toContain('BEGIN;');
    expect(exec).toContain('COMMIT;');
    expect(exec).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('guards the CREATE TRIGGER statement with a bounded lock_timeout (CLAUDE.md §1.2 hot table)', () => {
    const { sql } = latestRedefiner();
    const exec = executableSql(sql);
    expect(exec).toMatch(/SET LOCAL lock_timeout\s*=\s*'5s';/);
    const guardIdx = exec.indexOf("SET LOCAL lock_timeout = '5s';");
    const triggerIdx = exec.indexOf(`CREATE TRIGGER ${TRIGGER_NAME}`);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(triggerIdx).toBeGreaterThan(-1);
    // The guard must be a top-level statement preceding CREATE TRIGGER in the
    // same transaction — a file-level guard only covers statements after it.
    expect(guardIdx).toBeLessThan(triggerIdx);
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

  it('sorts after every existing anchors BEFORE-trigger', () => {
    // BEFORE triggers fire in name order. Sorting last means a post-SECURED
    // metadata edit still hits trg_prevent_metadata_edit's existing RAISE
    // first, and 0384's / 0394's strips still run unchanged — this migration
    // adds coverage for a disjoint key set without altering any existing
    // error path.
    expect(TRIGGER_NAME > 'trg_prevent_metadata_edit').toBe(true);
    expect(TRIGGER_NAME > 'trg_strip_unassertable_evidence_claims').toBe(true);
    expect(TRIGGER_NAME > 'trg_strip_unattested_ce_provenance_keys').toBe(true);
  });
});

describe('DocuSign metadata key authority: what the trigger enforces', () => {
  it('exempts service_role — the only attesting writer family, via the shared get_caller_role() helper', () => {
    const { sql } = latestRedefiner();
    // Same predicate 0384/0394 use — CLAUDE.md §6 bans hand-rolling
    // current_setting('request.jwt.claim.role', true) in new code.
    expect(executableSql(sql)).not.toMatch(/current_setting\(\s*'request\.jwt\.claim\.role'/);
    expect(executableSql(sql)).toMatch(
      /IF get_caller_role\(\) = 'service_role' THEN\s*\n\s*RETURN NEW;/,
    );
  });

  it('guards exactly the service-stamped DocuSign provenance key family', () => {
    const { sql } = latestRedefiner();
    const arrayMatch = executableSql(sql).match(/ARRAY\[([^\]]*)\]::text\[\]/s);
    expect(arrayMatch).not.toBeNull();
    const guarded = Array.from(arrayMatch![1].matchAll(/'([a-zA-Z0-9_]+)'/g))
      .map((m) => m[1])
      .sort();
    expect(guarded).toEqual(GUARDED_KEYS);
  });

  it('strips on INSERT and reverts to OLD on UPDATE rather than rejecting the row', () => {
    // Same asymmetry rationale as 0384/0394: these keys live in the free-form
    // metadata blob whose writers' contract is "persist what is understood,
    // ignore the rest" (bulk_create_anchors copies the blob wholesale, so a
    // RAISE would turn one ignorable key into a lost CSV row). Stripping
    // keeps the anchor and drops only the claim the server cannot stand
    // behind; reverting on UPDATE preserves a legitimately service-stamped
    // value instead of destroying it.
    const { sql } = latestRedefiner();
    const exec = executableSql(sql);
    expect(exec).toMatch(/jsonb_set\(/);
    expect(exec).toMatch(/-\s*v_key/);
    expect(exec).not.toMatch(/RAISE EXCEPTION/);
  });

  it('preserves an explicit NULL metadata when the guard changes nothing', () => {
    const { sql } = latestRedefiner();
    const exec = executableSql(sql);
    expect(exec).toMatch(/NOT \(NEW\.metadata IS NULL AND v_meta = '\{\}'::jsonb\)/);
  });
});

describe('DocuSign metadata key authority: drift guards', () => {
  it('covers every DocuSign key the worker connector pipeline actually stamps today', () => {
    // If a future writer stamps a new DocuSign-provenance key into
    // anchors.metadata, it must be added to the guarded array (or explicitly
    // exempted here with rationale) — otherwise it is client-forgeable.
    const drain = fs.readFileSync(CONNECTOR_ARTIFACT_DRAIN, 'utf8');
    const dispatcher = fs.readFileSync(RULE_ACTION_DISPATCHER, 'utf8');
    const envelopeCompleted = fs.readFileSync(DOCUSIGN_ENVELOPE_COMPLETED, 'utf8');

    for (const key of ['connector_source', 'connector_artifact_id']) {
      expect(drain).toContain(key);
      expect(GUARDED_KEYS).toContain(key);
    }
    expect(dispatcher).toContain('connector_source');
    expect(GUARDED_KEYS).toContain('connector_source');
    for (const key of ['account_id', 'envelope_id']) {
      expect(envelopeCompleted).toContain(key);
      expect(GUARDED_KEYS).toContain(key);
    }
  });

  it('does NOT guard the declared-hash rules-path key pair (already hashed, not raw)', () => {
    // rule-action-dispatcher.ts deliberately persists source_envelope_id /
    // account_id_sha256 for its own declared-hash path instead of raw
    // envelope_id/account_id — a different key pair this guard must leave
    // alone (it is already a one-way hash, not a forgeable identifier).
    const dispatcher = fs.readFileSync(RULE_ACTION_DISPATCHER, 'utf8');
    expect(dispatcher).toContain('source_envelope_id');
    expect(dispatcher).toContain('account_id_sha256');
    expect(GUARDED_KEYS).not.toContain('source_envelope_id');
    expect(GUARDED_KEYS).not.toContain('account_id_sha256');
  });

  it('holds the not-yet-written signer/inbound keys as foundation (R6/R4)', () => {
    // _signers / _docusign_env / _direction / _sending_account_id have no
    // writer yet (PR-2/PR-4 of the DocuSign bilateral sequence ship later).
    // Guarding them now, before any writer exists, means the very first
    // version of a future writer is never forgeable.
    for (const key of ['_signers', '_docusign_env', '_direction', '_sending_account_id']) {
      expect(GUARDED_KEYS).toContain(key);
    }
  });

  it('matches the CTO Decision Record R1 key family exactly', () => {
    expect(GUARDED_KEYS).toEqual(
      [
        'connector_source',
        'connector_artifact_id',
        'account_id',
        'envelope_id',
        '_signers',
        '_docusign_env',
        '_direction',
        '_sending_account_id',
      ].sort(),
    );
  });
});
