/**
 * RLS-suite parallel-safety ratchet (SCRUM-3618 / SCRUM-3577).
 *
 * The RLS suite (`npm run test:rls`) runs every file in its own worker,
 * concurrently, against ONE shared database and ONE shared set of seeded demo
 * users. Two suites (`docusign-integrations`, `credential-source-providers`)
 * flaked for months in full-suite runs while passing in isolation. Mechanism
 * (reproduced live; see `tests/rls/agents.md` "Fixture rules for full-parallel
 * runs"): supabase-js `signOut()` defaults to `scope: 'global'`, revoking
 * EVERY session of that user server-side. Whichever suite's afterAll ran
 * first signed the shared demo user out from under suites still running;
 * their mid-run `auth.getUser()` then failed ("Auth session missing!"), a
 * `?? ''` fallback poisoned seeded user_ids to '', and the fixtures died with
 * 22P02 — or the client silently degraded to anon.
 *
 * This is the SAME session-revocation cascade the 2026-08-15 e2e guard
 * (`signout-scope-guard.test.ts`, sibling file) already ratchets for `e2e/` —
 * the RLS suite was simply never covered. This file extends that ratchet,
 * reusing the same pure detector, and adds the RLS-specific rule the e2e
 * guard has no analogue for:
 *
 * Rule 1 — no `auth.getUser()` inside the RLS suite. Fixture identities come
 *   from the pinned `DEMO_CREDENTIALS.*Id` / `ORG_IDS.*` constants in
 *   `src/tests/rls/helpers.ts` (the pattern `p7.test.ts` /
 *   `rls-extended.test.ts` always used), never from a session round-trip
 *   another worker can invalidate mid-run.
 *
 * Rule 2 — no bare `auth.signOut()` in the RLS suite or its shared helpers.
 *   Scope must be explicit — normally `{ scope: 'local' }` (what
 *   `cleanupClient()` does); a deliberate global sign-out must be spelled
 *   out, never implied by the default.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findUnscopedSignOutCalls } from '../../e2e/helpers/signout-scope-guard';

// __dirname, not import.meta.url — same convention as the sibling
// signout-scope-guard.test.ts.
const ROOT = path.join(__dirname, '..', '..');
const RLS_DIR = path.join(ROOT, 'tests', 'rls');

/** Every TS source the RLS suite executes, plus the shared helpers module. */
const files = [
  ...fs
    .readdirSync(RLS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(RLS_DIR, f)),
  path.join(ROOT, 'src', 'tests', 'rls', 'helpers.ts'),
];

const rel = (file: string) => path.relative(ROOT, file);

/** 1-based lines of `.auth.getUser()` calls (the poisonable round-trip). */
function findGetUserCalls(source: string): number[] {
  return source
    .split('\n')
    .map((line, i) => (/\.auth\.getUser\(\)/.test(line) ? i + 1 : 0))
    .filter((line) => line !== 0);
}

describe('RLS suite parallel-safety ratchet (SCRUM-3618)', () => {
  it('scans a non-empty suite (the guard must never pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${rel(file)} derives no fixture identity from auth.getUser()`, () => {
      const lines = findGetUserCalls(fs.readFileSync(file, 'utf8'));
      expect(
        lines,
        `auth.getUser() is a session round-trip a PARALLEL suite can ` +
          `invalidate mid-run (another worker's sign-out of the shared demo ` +
          `user makes it fail with "Auth session missing!"), which poisoned ` +
          `member_integrations fixtures to user_id '' (SCRUM-3618). Use the ` +
          `pinned DEMO_CREDENTIALS.*Id / ORG_IDS.* constants instead. ` +
          `Offending lines: ${lines.join(', ')}`,
      ).toHaveLength(0);
    });

    it(`${rel(file)} carries no unscoped auth.signOut()`, () => {
      const hits = findUnscopedSignOutCalls(fs.readFileSync(file, 'utf8'));
      expect(
        hits,
        `bare auth.signOut() defaults to scope:'global' and revokes EVERY ` +
          `session of that shared demo user — suites still running in other ` +
          `vitest workers lose their sessions mid-run (SCRUM-3618; same ` +
          `cascade as the 2026-08-15 e2e incident). Pass an explicit scope, ` +
          `normally { scope: 'local' }: ` +
          hits.map((h) => `line ${h.line}: ${h.snippet}`).join('; '),
      ).toHaveLength(0);
    });
  }
});
