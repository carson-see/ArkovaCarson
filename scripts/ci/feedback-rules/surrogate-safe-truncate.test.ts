/**
 * Tests for the surrogate-safe truncation ratchet.
 *
 * WHY THIS TEST EXISTS AS WELL AS THE RULE
 *   The rule runs in the `Policy Lints` CI job, which is NOT one of Mergify's
 *   merge conditions (see .mergify.yml). This test runs in `Tests`, which IS.
 *   So the ratchet is enforced at merge time by this file, not by the lint job.
 *
 * The class being ratcheted: `.slice(0, N)` cuts at UTF-16 code-unit
 * boundaries; a cut inside a surrogate pair leaves a lone high surrogate,
 * which cannot encode as UTF-8 and makes the enclosing PostgREST request body
 * invalid JSON (PGRST102) — the 2026-08-17 poison-record mechanism that
 * blocked public-record anchoring for 16 days.
 */
import { describe, it, expect } from 'vitest';
import {
  blankComments,
  spanEnd,
  findViolationsInSource,
  scanWorkerSrc,
  loadBaseline,
} from './surrogate-safe-truncate.js';

const INSERT_WITH_SLICE = `
await db.from('anchors').insert({
  label: label.slice(0, 500),
  description,
});
`;

const UPDATE_WITH_SLICE = `
await db.from('webhook_delivery_logs').update({
  response_body: responseBody.slice(0, 1000),
}).eq('id', id);
`;

const UPSERT_WITH_SUBSTRING = `
await db.from('t').upsert({ v: text.substring(0, 200) });
`;

const SLICE_OUTSIDE_WRITE = `
const bounded = text.slice(0, 500);
await db.from('t').insert({ v: bounded });
`;

const SAFE_TRUNCATE_IN_WRITE = `
await db.from('anchors').insert({
  label: truncateUtf16Safe(label, 500),
});
`;

const HASH_UPDATE = `
const h = createHash('sha256').update(raw.slice(0, 32)).digest('hex');
`;

const COMMENTED_OUT = `
// await db.from('t').insert({ v: text.slice(0, 500) });
await db.from('t').insert({ v: safe });
`;

const SLICE_IN_STRING_LITERAL = `
await db.from('t').insert({ v: "docs say .slice(0, 500) is dangerous" });
`;

describe('findViolationsInSource', () => {
  it('flags .slice(0, N) inside an insert payload', () => {
    const v = findViolationsInSource('x.ts', INSERT_WITH_SLICE);
    expect(v).toHaveLength(1);
    expect(v[0].snippet).toContain('label.slice(0, 500)');
  });

  it('flags .slice(0, N) inside an update payload', () => {
    const v = findViolationsInSource('x.ts', UPDATE_WITH_SLICE);
    expect(v).toHaveLength(1);
    expect(v[0].snippet).toContain('responseBody.slice(0, 1000)');
  });

  it('flags .substring(0, N) inside an upsert payload', () => {
    expect(findViolationsInSource('x.ts', UPSERT_WITH_SUBSTRING)).toHaveLength(1);
  });

  it('does NOT flag a truncation outside the write span (documented lexical limit)', () => {
    expect(findViolationsInSource('x.ts', SLICE_OUTSIDE_WRITE)).toEqual([]);
  });

  it('does NOT flag truncateUtf16Safe in a write payload', () => {
    expect(findViolationsInSource('x.ts', SAFE_TRUNCATE_IN_WRITE)).toEqual([]);
  });

  it('does NOT flag createHash().update(...) receivers', () => {
    expect(findViolationsInSource('x.ts', HASH_UPDATE)).toEqual([]);
  });

  it('does NOT flag a commented-out write', () => {
    expect(findViolationsInSource('x.ts', COMMENTED_OUT)).toEqual([]);
  });

  it('does NOT flag the pattern inside a string literal argument', () => {
    expect(findViolationsInSource('x.ts', SLICE_IN_STRING_LITERAL)).toEqual([]);
  });

  it('assigns stable per-snippet occurrence keys for duplicate lines', () => {
    const twice = UPDATE_WITH_SLICE + UPDATE_WITH_SLICE;
    const v = findViolationsInSource('x.ts', twice);
    expect(v).toHaveLength(2);
    expect(v[0].key.endsWith('#1')).toBe(true);
    expect(v[1].key.endsWith('#2')).toBe(true);
  });
});

describe('span mechanics', () => {
  it('spanEnd balances parens across string literals containing parens', () => {
    const src = `f("a ) b", x)`;
    expect(spanEnd(src, 1)).toBe(src.length);
  });

  it('blankComments preserves offsets', () => {
    const src = `a /* xx */ b // yy\nc`;
    expect(blankComments(src)).toHaveLength(src.length);
  });
});

/**
 * The ratchet itself. Historical violations are pinned in the baseline as a
 * burn-down list; anything NEW fails here.
 */
describe('repo-wide ratchet', () => {
  const all = scanWorkerSrc();
  const baseline = loadBaseline();

  it('the sweep is non-vacuous — it still sees the write-payload truncation surface', () => {
    // A scanner that silently stops matching would make this suite pass while
    // checking nothing. The baseline had 11 entries at introduction; pin a
    // floor well below that so genuine burn-down never trips it.
    expect(all.length).toBeGreaterThan(3);
  });

  it('no bare truncation inside a DB write payload outside the baseline', () => {
    const fresh = all.filter((v) => !baseline.has(v.key));
    expect(
      fresh.map((v) => `${v.file}:${v.line} ${v.snippet}`),
      'New bare .slice/.substring/.substr(0, N) inside an insert/update/upsert payload. ' +
        'Use truncateUtf16Safe(value, N) from services/worker/src/utils/utf16-truncate.ts — ' +
        'a code-unit cut can split a surrogate pair and PGRST102 the whole write.',
    ).toEqual([]);
  });

  it('the migrated incident-class sites are clean and NOT grandfathered', () => {
    const migrated = [
      'services/worker/src/utils/jobQueue.ts',
      'services/worker/src/api/v1/credentials-ctdl-registry-anchor.ts',
      'services/worker/src/api/v1/compliance-audit.ts',
      'services/worker/src/webhooks/delivery.ts',
    ];
    for (const file of migrated) {
      expect(all.map((v) => v.file), `${file} should have no in-span violations`).not.toContain(file);
      expect([...baseline].some((k) => k.startsWith(`${file}::`)), `${file} must not be baselined`).toBe(
        false,
      );
    }
  });

  it('every baseline entry still corresponds to a real violation (no baseline rot)', () => {
    const live = new Set(all.map((v) => v.key));
    const stale = [...baseline].filter((k) => !live.has(k));
    expect(stale, 'baseline entries that no longer violate — delete them').toEqual([]);
  });
});
