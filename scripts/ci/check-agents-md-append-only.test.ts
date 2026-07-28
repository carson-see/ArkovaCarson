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

  it('does NOT flag a ledger row rewritten past the similarity threshold (the #1615 struck-0361 class)', () => {
    // PR #1615 deliberately restruck this reservation. The row still exists,
    // keyed by its first cell, but the prose shares almost no tokens.
    const base = '| `0361` | (unclaimed) | SCRUM-2916 | watermark partial index | RESERVED — placeholder, not yet filed |';
    const head =
      '| `0361` | (unclaimed — RELEASED 2026-07-28) | SCRUM-2916 | watermark partial index | ' +
      'STRUCK — PR #1615 Wave-0 conflict-resolution shipped SCRUM-2916 as design-only, so the prefix returns to the pool |';
    expect(findDrops(base, head)).toEqual([]);
  });

  it('FLAGS a removed table row whose first cell no longer appears at head', () => {
    const base = [
      '| `0363` | lane2 | G4 | flag seed | RESERVED |',
      '| `0364` | security-revokes PR #1652 | — | security revokes | RESERVED — pre-soak, file-only |',
    ].join('\n');
    const head = '| `0363` | lane2 | G4 | flag seed | RESERVED |';
    expect(findDrops(base, head).join(' ')).toContain('0364');
  });

  it('FLAGS a deleted ledger row even when an unrelated NEW row shares its boilerplate', () => {
    // Ledger rows share so much stock wording that prose similarity between two
    // DIFFERENT reservations clears 0.5. A table row's identity is its first
    // cell, so `0370` disappearing is a drop no matter what `0371` looks like.
    const base = [
      '| `0369` | lane1 | SCRUM-2917 | proof materializer | RESERVED — pre-soak, file-only, NOT applied |',
      '| `0370` | lane1 | SCRUM-2918 | credit ledger index | RESERVED — pre-soak, file-only, NOT applied |',
    ].join('\n');
    const head = [
      '| `0369` | lane1 | SCRUM-2917 | proof materializer | RESERVED — pre-soak, file-only, NOT applied |',
      '| `0371` | lane1 | SCRUM-2919 | folders backfill | RESERVED — pre-soak, file-only, NOT applied |',
    ].join('\n');
    expect(findDrops(base, head).join(' ')).toContain('0370');
  });

  it('FLAGS the second of two duplicate-key rows when head keeps only one', () => {
    // A duplicate key (itself a symptom of an earlier bad merge) must not let
    // one surviving row account for both deletions.
    const base = [
      '| `0361` | lane1 | SCRUM-2916 | watermark partial index | RESERVED — first claim |',
      '| `0361` | lane2 | SCRUM-2940 | folders anchor link | RESERVED — duplicate claim |',
    ].join('\n');
    const head = '| `0361` | lane1 | SCRUM-2916 | watermark partial index | RESERVED — kept |';
    expect(findDrops(base, head)).toHaveLength(1);
  });

  it('does not let ONE new line absorb several unrelated deletions', () => {
    const base = [
      'The queue drain runs nightly at 3am and batches roughly ten thousand anchors.',
      'The reconciler sweeps stuck anchors and re-enqueues them for the next drain.',
    ].join('\n');
    const head = 'The queue drain runs nightly at 3am and batches about ten thousand anchors now.';
    // The first line is a plausible rewrite; the second is a genuine deletion.
    expect(findDrops(base, head)).toHaveLength(1);
  });

  it('does NOT flag a bullet that was EXTENDED with a new clause (the #1736 class)', () => {
    // Appending to a line drives symmetric token overlap DOWN, so a purely
    // Jaccard-based check reads a big append as a deletion. The shared prefix
    // is what identifies it as an edit.
    const base = '- `FileUpload.tsx` — Drag-and-drop file upload with client-side fingerprint generation (never uploaded to server)';
    const head = base + '. **W2 spreadsheet dual-mode**: a .xlsx/.csv now offers anchor-as-document as well as import-as-rows, and the chosen mode drives the downstream fingerprint path.';
    expect(findDrops(base, head)).toEqual([]);
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
