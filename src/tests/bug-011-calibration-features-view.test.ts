/**
 * BUG-011 (P2, 2026-08 soak) — `POST /jobs/calibration-refit` returned 500 with
 * `PGRST205 Could not find the table 'public.calibration_features'`. The view is
 * absent from production too (`information_schema.tables` count = 0): it shipped
 * as archived migration 0222 and was lost in the Path C baseline cutover, whose
 * `pg_dump` could only capture what prod actually had.
 *
 * 0413 recreates it — the job is fully implemented, read-only and advisory, and
 * a `501` would have been a false claim that it is not. What 0413 does NOT do is
 * recreate 0222 verbatim: the view is now `security_invoker`, and the Supabase
 * default-privileges auto-grant is stripped explicitly.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION = 'supabase/migrations/0413_bug011_calibration_features_view.sql';
const ARCHIVED = 'docs/migrations-archive/0222_calibration_features_view.sql';
const VIEWS_BASELINE = 'scripts/ci/snapshots/views-security-invoker-baseline.json';
const JOB = 'services/worker/src/jobs/calibration-refit.ts';

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

/** Comment lines are prose, not behaviour. */
function code(sql: string): string {
  return sql.replace(/^\s*--.*$/gm, '');
}

describe('BUG-011: migration 0413 recreates calibration_features', () => {
  const sql = () => read(MIGRATION);

  it('creates the view the job queries by name', () => {
    expect(code(sql())).toMatch(/CREATE OR REPLACE VIEW public\.calibration_features/);
  });

  it('declares security_invoker so RLS is evaluated against the caller', () => {
    // The archived 0222 was a bare definer view over `anchors` — a cross-tenant
    // read surface one grant away from being reachable. SCRUM-1276 / R3-3.
    expect(code(sql())).toMatch(/WITH \(security_invoker = true\)/);
  });

  it('was NOT a security_invoker view in the archived 0222 (the delta, pinned)', () => {
    expect(code(read(ARCHIVED))).toMatch(/CREATE OR REPLACE VIEW calibration_features/);
    expect(code(read(ARCHIVED))).not.toMatch(/security_invoker/);
  });

  it('strips the Supabase default-privileges auto-grant, naming PUBLIC', () => {
    // baseline:15104 does ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
    // anon, authenticated — every new relation is auto-granted. 0222 revoked
    // from anon/authenticated only, which is a no-op against a PUBLIC grant.
    const c = code(sql());
    expect(c).toMatch(/REVOKE ALL ON public\.calibration_features FROM PUBLIC, anon, authenticated;/);
    expect(c).toMatch(/GRANT SELECT ON public\.calibration_features TO service_role;/);
    expect(c).not.toMatch(/GRANT[^;]*TO[^;]*\b(?:anon|authenticated)\b/);
  });

  it('projects exactly the columns the job selects', () => {
    const c = code(sql());
    for (const col of ['a.id', 'a.credential_type', 'a.created_at']) {
      expect(c).toContain(col);
    }
    expect(c).toMatch(/AS confidence/);
    expect(c).toMatch(/AS extraction_accuracy/);
  });

  it('does not project a document fingerprint (§1.6) even though it joins on one', () => {
    const select = code(sql());
    const body = select.slice(select.indexOf('SELECT'), select.indexOf('FROM anchors'));
    expect(body).not.toMatch(/fingerprint/);
    // The join still needs it — that is the point of asserting on the SELECT
    // list rather than the whole statement.
    expect(select).toMatch(/aue\.fingerprint = a\.fingerprint/);
  });

  it('bounds the migration with a lock_timeout — it references a hot table', () => {
    expect(code(sql())).toMatch(/SET LOCAL lock_timeout = '5s';/);
  });

  it('carries a ROLLBACK comment and reloads the PostgREST schema cache', () => {
    expect(sql()).toMatch(/^-- ROLLBACK:/m);
    expect(sql()).toContain("NOTIFY pgrst, 'reload schema';");
  });
});

describe('BUG-011: the security_invoker ratchet tightens', () => {
  it('drops calibration_features from the grandfathered set', () => {
    const baseline = JSON.parse(read(VIEWS_BASELINE)) as { grandfathered: string[] };
    expect(baseline.grandfathered).not.toContain('calibration_features');
  });

  it('leaves the remaining grandfathered view untouched', () => {
    const baseline = JSON.parse(read(VIEWS_BASELINE)) as { grandfathered: string[] };
    expect(baseline.grandfathered).toEqual(['v_slow_queries']);
  });
});

describe('BUG-011: the job still targets the view', () => {
  it('reads calibration_features, not a column on anchors', () => {
    const job = read(JOB);
    expect(job).toContain("from('calibration_features'");
    expect(job).toMatch(/confidence, extraction_accuracy/);
  });
});
