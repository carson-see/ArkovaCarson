/**
 * Tests for the SECURITY DEFINER grant ratchet.
 *
 * WHY THIS TEST EXISTS AS WELL AS THE RULE
 *   The rule runs in the `Policy Lints` CI job, which is NOT one of Mergify's
 *   merge conditions (see .mergify.yml). This test runs in `Tests`, which IS.
 *   So the ratchet is enforced at merge time by this file, not by the lint job.
 *
 * The class being ratcheted: on Supabase, ALTER DEFAULT PRIVILEGES grants anon
 * and authenticated EXECUTE *directly* when a function is created, and
 * `REVOKE ... FROM PUBLIC` does not remove a direct role grant. A SECURITY
 * DEFINER function bypasses RLS, so the residue is an anon-reachable
 * RLS-bypassing RPC. Occurred in 0364, 0377, 0378, 0388 and 0406.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSecurityDefinerFunctions,
  hasExplicitRevoke,
  findViolations,
  loadBaseline,
  realMigrations,
  findMissingReplayParityRevokes,
  DELIBERATELY_PUBLIC,
  REPLAY_PARITY_REVOKES,
  SQUASHED_BASELINE,
} from './secdef-function-grants.js';

const SECDEF = `
CREATE OR REPLACE FUNCTION public.widget_count(p_hours integer DEFAULT 24)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM public.widgets;
$$;
`;

const REVOKE_PUBLIC_ONLY = `
REVOKE ALL ON FUNCTION public.widget_count(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.widget_count(integer) TO service_role;
`;

const REVOKE_NAMED = `
REVOKE ALL ON FUNCTION public.widget_count(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.widget_count(integer) TO service_role;
`;

/**
 * The revoke is correct SQL but lands BEFORE the definition. `CREATE OR
 * REPLACE` re-runs ALTER DEFAULT PRIVILEGES, so the re-grant to anon and
 * authenticated happens AFTER this revoke and the hole is open on disk.
 */
const REVOKE_BEFORE_CREATE = `
REVOKE ALL ON FUNCTION public.widget_count(integer) FROM PUBLIC, anon, authenticated;
${SECDEF}
GRANT EXECUTE ON FUNCTION public.widget_count(integer) TO service_role;
`;

/** Correct revoke, then an explicit re-grant that puts anon straight back. */
const REVOKE_THEN_REGRANT_ANON = `
${SECDEF}
${REVOKE_NAMED}
GRANT EXECUTE ON FUNCTION public.widget_count(integer) TO anon;
`;

const REVOKE_THEN_REGRANT_AUTHENTICATED = `
${SECDEF}
${REVOKE_NAMED}
GRANT EXECUTE ON FUNCTION public.widget_count(integer) TO authenticated;
`;

describe('statement ORDER matters (CREATE OR REPLACE re-grants)', () => {
  it('flags a revoke that precedes the CREATE OR REPLACE it is meant to close', () => {
    // The whole point of the rule: a revoke the CREATE later undoes is not a
    // revoke. Position, not mere presence, is what makes the ACL correct.
    expect(hasExplicitRevoke(REVOKE_BEFORE_CREATE, 'public', 'widget_count')).toBe(false);
    const v = findViolations([{ file: '9999_order.sql', sql: REVOKE_BEFORE_CREATE }]);
    expect(v.map((x) => x.name)).toEqual(['widget_count']);
  });

  it('still accepts the revoke when it follows the definition', () => {
    expect(hasExplicitRevoke(`${SECDEF}${REVOKE_NAMED}`, 'public', 'widget_count')).toBe(true);
    expect(findViolations([{ file: '9999_ok.sql', sql: `${SECDEF}${REVOKE_NAMED}` }])).toEqual([]);
  });

  it('accepts a revoke after the LAST of several CREATE OR REPLACE statements', () => {
    const sql = `${SECDEF}${REVOKE_NAMED}${SECDEF}${REVOKE_NAMED}`;
    expect(findViolations([{ file: '9999_twice.sql', sql }])).toEqual([]);
  });

  it('flags when a re-definition follows the only revoke', () => {
    // revoke closes the first CREATE, then a second CREATE re-opens it.
    const sql = `${SECDEF}${REVOKE_NAMED}${SECDEF}`;
    expect(findViolations([{ file: '9999_reopen.sql', sql }]).map((x) => x.name)).toEqual([
      'widget_count',
    ]);
  });
});

describe('a later GRANT re-opens the function', () => {
  it('flags an explicit re-grant of EXECUTE to anon after the revoke', () => {
    expect(hasExplicitRevoke(REVOKE_THEN_REGRANT_ANON, 'public', 'widget_count')).toBe(false);
    expect(
      findViolations([{ file: '9999_regrant.sql', sql: REVOKE_THEN_REGRANT_ANON }]).map(
        (x) => x.name,
      ),
    ).toEqual(['widget_count']);
  });

  it('flags an explicit re-grant to authenticated after the revoke', () => {
    expect(
      findViolations([
        { file: '9999_regrant2.sql', sql: REVOKE_THEN_REGRANT_AUTHENTICATED },
      ]).map((x) => x.name),
    ).toEqual(['widget_count']);
  });

  it('does NOT flag the service_role grant the rule itself prescribes', () => {
    // REVOKE_NAMED already ends with `GRANT ... TO service_role` — the shape the
    // rule's own error message tells authors to write must stay clean.
    expect(findViolations([{ file: '9999_ok2.sql', sql: `${SECDEF}${REVOKE_NAMED}` }])).toEqual([]);
  });

  it('does NOT flag a grant to anon on a DIFFERENT function', () => {
    const sql = `${SECDEF}${REVOKE_NAMED}
GRANT EXECUTE ON FUNCTION public.other_thing(integer) TO anon;`;
    expect(findViolations([{ file: '9999_other.sql', sql }])).toEqual([]);
  });
});

describe('parseSecurityDefinerFunctions', () => {
  it('finds a SECURITY DEFINER function', () => {
    const found = parseSecurityDefinerFunctions('x.sql', SECDEF);
    expect(found.map((f) => f.name)).toEqual(['widget_count']);
    expect(found[0].schema).toBe('public');
  });

  it('ignores a SECURITY INVOKER function', () => {
    const sql = SECDEF.replace('SECURITY DEFINER', 'SECURITY INVOKER');
    expect(parseSecurityDefinerFunctions('x.sql', sql)).toEqual([]);
  });

  it('ignores a function with no SECURITY clause (defaults to INVOKER)', () => {
    const sql = SECDEF.replace('SECURITY DEFINER\n', '');
    expect(parseSecurityDefinerFunctions('x.sql', sql)).toEqual([]);
  });

  it('does NOT match the phrase inside the function body', () => {
    // A body that merely mentions the words must not promote the function.
    const sql = `
CREATE OR REPLACE FUNCTION public.note_fn()
RETURNS text
LANGUAGE sql
AS $$
  SELECT 'this text mentions SECURITY DEFINER but is only a string'::text;
$$;
`;
    expect(parseSecurityDefinerFunctions('x.sql', sql)).toEqual([]);
  });

  it('does NOT match a commented-out declaration', () => {
    const sql = SECDEF.split('\n')
      .map((l) => (l.trim() === 'SECURITY DEFINER' ? `-- ${l}` : l))
      .join('\n');
    expect(parseSecurityDefinerFunctions('x.sql', sql)).toEqual([]);
  });

  it('finds several functions in one file independently', () => {
    const two = SECDEF + SECDEF.replace(/widget_count/g, 'gadget_count');
    expect(parseSecurityDefinerFunctions('x.sql', two).map((f) => f.name)).toEqual([
      'widget_count',
      'gadget_count',
    ]);
  });
});

describe('hasExplicitRevoke', () => {
  it('is false when the revoke only names PUBLIC — the actual defect', () => {
    expect(hasExplicitRevoke(SECDEF + REVOKE_PUBLIC_ONLY, 'public', 'widget_count')).toBe(false);
  });

  it('is true when anon and authenticated are named', () => {
    expect(hasExplicitRevoke(SECDEF + REVOKE_NAMED, 'public', 'widget_count')).toBe(true);
  });

  it('is false when only anon is named (authenticated still holds EXECUTE)', () => {
    const partial = REVOKE_NAMED.replace('PUBLIC, anon, authenticated', 'PUBLIC, anon');
    expect(hasExplicitRevoke(SECDEF + partial, 'public', 'widget_count')).toBe(false);
  });

  it('does not credit a revoke aimed at a DIFFERENT function', () => {
    const other = REVOKE_NAMED.replace(/widget_count/g, 'gadget_count');
    expect(hasExplicitRevoke(SECDEF + other, 'public', 'widget_count')).toBe(false);
  });

  it('ignores a revoke that is commented out', () => {
    const commented = REVOKE_NAMED.split('\n')
      .map((l) => (l.startsWith('REVOKE') ? `-- ${l}` : l))
      .join('\n');
    expect(hasExplicitRevoke(SECDEF + commented, 'public', 'widget_count')).toBe(false);
  });
});

describe('findViolations', () => {
  it('flags a SECURITY DEFINER function whose revoke names only PUBLIC', () => {
    const v = findViolations([{ file: '9001_bad.sql', sql: SECDEF + REVOKE_PUBLIC_ONLY }]);
    expect(v.map((x) => x.key)).toEqual(['9001_bad.sql::public.widget_count']);
  });

  it('passes the same function once the roles are named', () => {
    expect(findViolations([{ file: '9002_ok.sql', sql: SECDEF + REVOKE_NAMED }])).toEqual([]);
  });

  it('exempts a deliberately-public function', () => {
    const sql = SECDEF.replace(/widget_count/g, 'get_public_anchor') + REVOKE_PUBLIC_ONLY;
    const v = findViolations([{ file: '9003.sql', sql }], {
      deliberatelyPublic: new Set(['public.get_public_anchor']),
    });
    expect(v).toEqual([]);
  });
});

/**
 * The ratchet itself. Historical violations are pinned in the baseline and are
 * a burn-down list; anything NEW fails here.
 */
describe('repo-wide ratchet', () => {
  const files = realMigrations();
  const baseline = loadBaseline();

  it('the sweep is non-vacuous — it still sees the SECURITY DEFINER surface', () => {
    // A parser that silently stops matching would make this suite pass while
    // checking nothing. Pin a floor well below the true count.
    const all = files.flatMap((f) => parseSecurityDefinerFunctions(f.file, f.sql));
    expect(all.length).toBeGreaterThan(40);
  });

  it('no SECURITY DEFINER function is missing its anon/authenticated REVOKE outside the baseline', () => {
    const violations = findViolations(files, {
      deliberatelyPublic: DELIBERATELY_PUBLIC,
      replayParityRevokes: REPLAY_PARITY_REVOKES,
    }).filter((v) => !baseline.has(v.key));

    expect(
      violations.map((v) => v.key),
      'New SECURITY DEFINER function(s) without an explicit ' +
        '`REVOKE ALL ON FUNCTION <fn> FROM PUBLIC, anon, authenticated;` in the same ' +
        'migration. REVOKE ... FROM PUBLIC alone does NOT remove the direct grants ' +
        'ALTER DEFAULT PRIVILEGES gives anon/authenticated at CREATE time.',
    ).toEqual([]);
  });

  it('0406 is compliant and is NOT grandfathered', () => {
    const key = '0406_proof_coverage_window_and_reconstruction_classes.sql::public.proof_coverage_window';
    expect(baseline.has(key)).toBe(false);
    expect(findViolations(files).map((v) => v.key)).not.toContain(key);
  });

  it('every baseline entry still corresponds to a real violation (no baseline rot)', () => {
    // If someone fixes a baselined file, the entry must be removed so the
    // baseline shrinks monotonically and never re-authorises a regression.
    const live = new Set(
      findViolations(files, {
        deliberatelyPublic: DELIBERATELY_PUBLIC,
        replayParityRevokes: REPLAY_PARITY_REVOKES,
      }).map((v) => v.key),
    );
    const stale = [...baseline].filter((k) => !live.has(k));
    expect(stale, 'baseline entries that no longer violate — delete them').toEqual([]);
  });
});

/**
 * REPLAY-PARITY REVOKES (FD-17 class, second instance).
 *
 * The same-file requirement above is right for the ordinary case, but there is
 * a family of functions it structurally cannot cover: those whose LAST
 * definition sits in a file nobody is allowed to edit — the generated squashed
 * baseline, or an already-merged numbered migration. For those the closing
 * REVOKE has to live in a LATER migration, and the only meaningful question is
 * whether an ordered replay ENDS with the function closed.
 *
 * Left unpinned, that revoke is invisible to CI: it defines no function, so the
 * per-file rule never looks at it, and deleting it would keep the suite green
 * while every rebuilt environment silently reopened the hole.
 */
describe('replay-parity revokes', () => {
  const DEF = '00000000000000_baseline_at_main_HEAD.sql';
  const PINNED = new Map([['public.widget_count', 'test fixture']]);

  const baselineFile = { file: DEF, sql: SECDEF };
  const revokeFile = (name: string) => ({
    file: name,
    sql: 'REVOKE ALL ON FUNCTION public.widget_count(integer) FROM PUBLIC, anon, authenticated;\n' +
      'GRANT EXECUTE ON FUNCTION public.widget_count(integer) TO service_role;\n',
  });

  it('flags a pinned function that no later migration revokes', () => {
    const v = findMissingReplayParityRevokes([baselineFile], PINNED);
    expect(v.map((x) => x.fn)).toEqual(['public.widget_count']);
  });

  it('accepts a compliant revoke in a later migration', () => {
    const v = findMissingReplayParityRevokes([baselineFile, revokeFile('0418_x.sql')], PINNED);
    expect(v).toEqual([]);
  });

  it('rejects a revoke that names only PUBLIC — the direct grants survive it', () => {
    const publicOnly = {
      file: '0418_x.sql',
      sql: 'REVOKE ALL ON FUNCTION public.widget_count(integer) FROM PUBLIC;',
    };
    expect(findMissingReplayParityRevokes([baselineFile, publicOnly], PINNED)).toHaveLength(1);
  });

  it('rejects a revoke that sorts BEFORE the last definition of the function', () => {
    // 0335-style: a merged migration re-defines the function after the revoke,
    // and CREATE OR REPLACE re-runs ALTER DEFAULT PRIVILEGES.
    const v = findMissingReplayParityRevokes(
      [baselineFile, revokeFile('0100_early.sql'), { file: '0335_redefine.sql', sql: SECDEF }],
      PINNED,
    );
    expect(v).toHaveLength(1);
  });

  it('rejects a later migration that grants EXECUTE back to anon', () => {
    const regrant = {
      file: '0418_regrant.sql',
      sql: 'GRANT EXECUTE ON FUNCTION public.widget_count(integer) TO anon;',
    };
    const v = findMissingReplayParityRevokes(
      [baselineFile, revokeFile('0418_x.sql'), regrant],
      PINNED,
    );
    expect(v).toHaveLength(1);
  });

  it('does not credit a revoke aimed at a DIFFERENT function', () => {
    const other = {
      file: '0418_x.sql',
      sql: 'REVOKE ALL ON FUNCTION public.widget_count_fast(integer) FROM PUBLIC, anon, authenticated;',
    };
    expect(findMissingReplayParityRevokes([baselineFile, other], PINNED)).toHaveLength(1);
  });

  it('suppresses only the squashed-baseline key, never a numbered migration key', () => {
    // The numbered migration that re-defines the function keeps its own
    // violation: the NEXT re-definition would reopen what the later revoke
    // closed, so its author still has to write the revoke inline.
    const files = [
      baselineFile,
      { file: '0335_redefine.sql', sql: SECDEF },
      revokeFile('0418_x.sql'),
    ];
    const keys = findViolations(files, { replayParityRevokes: PINNED }).map((v) => v.key);
    expect(keys).toEqual(['0335_redefine.sql::public.widget_count']);
  });
});

describe('repo-wide replay-parity ratchet', () => {
  const files = realMigrations();
  const baseline = loadBaseline();

  it('the pinned set is non-empty — an emptied map would pass vacuously', () => {
    expect(REPLAY_PARITY_REVOKES.size).toBeGreaterThan(0);
  });

  it('every pinned function is closed to anon at the end of an ordered replay', () => {
    const missing = findMissingReplayParityRevokes(files);
    expect(
      missing.map((m) => m.fn),
      'A pinned replay-parity REVOKE is missing from supabase/migrations/. ' +
        'A rebuilt environment would carry these SECURITY DEFINER functions ' +
        'anon-callable while prod does not — the FD-17 divergence class.',
    ).toEqual([]);
  });

  it('the squashed-baseline key of every pinned function is burned down, not grandfathered', () => {
    // Once the replay-path revoke exists, keeping the key in the burn-down list
    // would re-authorise its removal: delete the migration and CI stays green.
    const stillGrandfathered = [...REPLAY_PARITY_REVOKES.keys()]
      .map((fn) => `${SQUASHED_BASELINE}::${fn}`)
      .filter((key) => baseline.has(key));
    expect(stillGrandfathered).toEqual([]);
  });
});
