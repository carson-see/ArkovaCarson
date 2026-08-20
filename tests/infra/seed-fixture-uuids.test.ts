/**
 * DEG-5 regression guard — seed fixture UUIDs must be RFC 9562 compliant.
 *
 * Zod 4 enforces the RFC 9562 version (`[1-8]`) and variant (`[89ab]`) nibbles
 * in `z.string().uuid()`. The seed fixtures used to pin UUIDs whose version and
 * variant nibbles were both `0` (e.g. `aaaaaaaa-0000-0000-0000-000000000001`):
 * accepted by Postgres's `uuid` type, rejected by every strict worker
 * validator. On the fullsoak-2026-08 rig that mismatch made
 * `claimDueOrganizations` reject the rows `claim_due_org_queue_runs` had
 * already committed a claim for, 500-ing `/jobs/org-queue-scheduler` once per
 * ~20-minute reclaim cycle. Root cause:
 * `docs/staging/fullsoak-2026-08/deg5-org-queue-triage.md`.
 *
 * Production is structurally immune (its ids come from `gen_random_uuid()`), so
 * the defect can only ever be re-imported by hand-written fixtures. This test is
 * the ratchet: every UUID literal a seeding artifact writes into a database — and
 * every UUID literal the shared test fixtures pin against those rows — must parse
 * under the SAME zod the worker runs.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

/** The exact validator shape the worker uses at its 57 strict-uuid sites. */
const uuid = z.string().uuid();

/** 8-4-4-4-12 hex, shape only — deliberately looser than `uuid` so the scan
 *  collects the very literals the strict validator is meant to reject. */
const UUID_SHAPED = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

/**
 * Files whose UUID literals end up in (or are asserted against) a real database
 * row. Adding a seeding artifact here is what keeps the ratchet honest.
 */
const SEEDING_ARTIFACTS = [
  // Local + rig seed: the source of the DEG-5 org ids.
  'supabase/seed.sql',
  // Isolated-rig baseline fixture (`5eed0000-…` family).
  'scripts/staging/seed-baseline-fixture.sql',
  // Shared fixtures that pin the seeded ids for RLS / E2E assertions.
  'src/tests/rls/helpers.ts',
  'e2e/fixtures/supabase.ts',
] as const;

function uuidLiteralsIn(relPath: string): string[] {
  const body = readFileSync(resolve(ROOT, relPath), 'utf-8');
  return [...new Set(body.match(UUID_SHAPED) ?? [])].sort();
}

describe('seed fixture UUIDs are RFC 9562 compliant (DEG-5)', () => {
  it('validates against the same zod version the worker runs', () => {
    const declaredZod = (relPath: string): string => {
      const pkg = JSON.parse(readFileSync(resolve(ROOT, relPath), 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const spec = pkg.dependencies?.zod ?? pkg.devDependencies?.zod;
      expect(spec, `${relPath} declares no zod dependency`).toBeTruthy();
      return spec!.replace(/^[\^~]/, '');
    };

    // The `z` imported above resolves to the ROOT manifest's zod. If the
    // worker's zod ever diverges from it, this guard stops proving anything
    // about the worker's validators — fail loudly rather than silently weaken.
    expect(declaredZod('package.json')).toBe(declaredZod('services/worker/package.json'));
  });

  it('rejects the pre-fix literals (proves the validator is the strict one)', () => {
    // The two org ids named in the DEG-5 triage. If zod ever stops rejecting
    // these, this whole suite is vacuous and must be re-derived.
    expect(uuid.safeParse('aaaaaaaa-0000-0000-0000-000000000001').success).toBe(false);
    expect(uuid.safeParse('bbbbbbbb-0000-0000-0000-000000000001').success).toBe(false);
    // The nil UUID is explicitly permitted by RFC 9562 and by zod — sentinel
    // rows and "not found" probes stay legal.
    expect(uuid.safeParse('00000000-0000-0000-0000-000000000000').success).toBe(true);
  });

  it.each(SEEDING_ARTIFACTS)('every UUID literal in %s parses', (relPath) => {
    const literals = uuidLiteralsIn(relPath);

    // Guard the guard: a scan that matches nothing must not read as a pass.
    expect(literals.length).toBeGreaterThan(0);

    const invalid = literals.filter((value) => !uuid.safeParse(value).success);
    expect(invalid).toEqual([]);
  });
});
