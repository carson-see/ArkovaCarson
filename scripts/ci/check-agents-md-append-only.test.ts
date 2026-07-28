import { describe, it, expect } from 'vitest';
import { findDrops } from './check-agents-md-append-only.ts';

/**
 * Regression suite for the 2026-07-28 union-driver silent-drop incident.
 * `merge.union.driver = true` shadowed git's built-in union algorithm with a
 * no-op, so merges kept "ours" and discarded "theirs" without a conflict.
 * The gate must catch that class while staying quiet on ordinary edits.
 */
describe('findDrops — agents.md append-only gate', () => {
  it('passes when the head is a pure append (the union convention working)', () => {
    const base = ['# jobs', '- `batch-anchor.ts` drains the queue nightly at 3am.'].join('\n');
    const head = [
      '# jobs',
      '- `batch-anchor.ts` drains the queue nightly at 3am.',
      '- `txid-journal.ts` records the pre-broadcast transaction id.',
    ].join('\n');
    expect(findDrops(base, head)).toEqual([]);
  });

  it('FAILS when a documented section vanishes (the #1675 sidebar-test class)', () => {
    const base = [
      '# pages',
      '## 2026-07-22 Platform-admin role-source cutover (SCRUM-2939)',
      'Every admin page derives platform-admin status from `isPlatformAdmin(profile)`.',
    ].join('\n');
    const head = '# pages';
    const drops = findDrops(base, head);
    expect(drops).toHaveLength(2);
    expect(drops.join(' ')).toContain('SCRUM-2939');
  });

  it('does NOT flag a line that was edited in place — the #1711 false-positive class', () => {
    const base = '| `rules-templates.ts` | Public rules templates discovery endpoint (SCRUM-1973) |';
    const head =
      '| `rules-templates.ts` | Public rules templates discovery endpoint (SCRUM-1973). ' +
      'Re-exports `RULE_TEMPLATES` from `rule-templates-data.ts` |';
    expect(findDrops(base, head)).toEqual([]);
  });

  it('ignores the _Last updated:_ footer, which every edit rewrites by design', () => {
    expect(findDrops('_Last updated: 2026-07-21_', '_Last updated: 2026-07-27_')).toEqual([]);
  });

  it('ignores structural noise below the significance threshold', () => {
    const base = ['|---|---|', '---', '- a'].join('\n');
    expect(findDrops(base, '# replaced')).toEqual([]);
  });

  it('FAILS a dropped migration reservation row (the #1615 stale-0361 class)', () => {
    const base = [
      '| `0360` | lane1 | SCRUM-2917 | proof materializer | RESERVED — pre-soak, file-only |',
      '| `0361` | (unclaimed) | SCRUM-2916 | watermark partial index | RESERVED — placeholder, not yet filed |',
    ].join('\n');
    const head =
      '| `0360` | lane1 | SCRUM-2917 | proof materializer | RESERVED — pre-soak, file-only |';
    const drops = findDrops(base, head);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain('0361');
  });

  it('still flags a deletion when a similar-looking line was already in the base', () => {
    // The surviving `0365` row is unchanged, so it must not be mistaken for the
    // edited counterpart of the deleted `0366` row and mask the drop.
    const base = [
      '| `0365` | lane2 | SCRUM-2940 | folders table and anchor link | RESERVED — pre-soak |',
      '| `0366` | lane2 | SCRUM-2940 | anchors folder_id index | RESERVED — pre-soak |',
    ].join('\n');
    const head = '| `0365` | lane2 | SCRUM-2940 | folders table and anchor link | RESERVED — pre-soak |';
    expect(findDrops(base, head).join(' ')).toContain('0366');
  });
});
