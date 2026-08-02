import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, externalIdFor, parseArgs } from './haki-provision-plan.mjs';

const realFp = (seed) => (seed.repeat(64)).slice(0, 64); // e.g. 'a'*64

test('externalIdFor is deterministic + zero-padded', () => {
  assert.equal(externalIdFor(5), 'HAKI-KPI1-05');
  assert.equal(externalIdFor(11), 'HAKI-KPI1-11');
});

test('parseArgs reads --count (explicit operator input), rejects unknown flags', () => {
  const o = parseArgs(['--current-secured', '4', '--count', '2', '--json']);
  assert.equal(o.currentSecured, 4);
  assert.equal(o.count, 2);
  assert.equal(o.json, true);
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

test('parseArgs no longer accepts --target: count is never derived by subtraction from a quota/target', () => {
  // --target is intentionally not a recognized flag anymore. A quota-minus-current
  // computation is exactly the retracted "shortfall" framing (see
  // memory/project_hakichain_account_state.md) — the tool must not resurrect it
  // under a different flag name.
  assert.throws(() => parseArgs(['--current-secured', '4', '--target', '15']), /unknown flag/);
});

test('buildPlan never computes a difference between currentSecured and any quota/target — count is what the caller explicitly asked for', () => {
  const manifest = Array.from({ length: 3 }, () => ({ fingerprint: realFp('a') }));
  const plan = buildPlan({ currentSecured: 4, count: 3, manifest });
  assert.equal(plan.count, 3);
  assert.equal(plan.request.anchors.length, 3);
  // the returned plan object must not expose a 'shortfall' or 'target' field at all —
  // those framings are retired, not merely renamed.
  assert.equal('shortfall' in plan, false);
  assert.equal('target' in plan, false);
});

test('count=0 short-circuits to complete, no request — an explicit operator choice, not "already at target"', () => {
  const plan = buildPlan({ currentSecured: 4, count: 0 });
  assert.equal(plan.status, 'complete');
  assert.equal(plan.count, 0);
  assert.equal(plan.request, null);
});

test('request is ALWAYS dry_run:true and duplicate_strategy:"skip"', () => {
  const plan = buildPlan({ currentSecured: 4, count: 2, manifest: Array.from({ length: 2 }, () => ({ fingerprint: realFp('a') })) });
  assert.equal(plan.request.dry_run, true);
  assert.equal(plan.request.duplicate_strategy, 'skip');
});

test('no real fingerprints → status blocked, placeholders flagged, no real fp leaks', () => {
  const plan = buildPlan({ currentSecured: 4, count: 2 }); // no manifest
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.usesPlaceholders, true);
  assert.match(plan.reasons[0], /BLOCKED/);
  for (const row of plan.request.anchors) {
    assert.match(row.fingerprint, /PLACEHOLDER/);
    assert.doesNotMatch(row.fingerprint, /^[0-9a-f]{64}$/);
  }
});

test('partial manifest (fewer rows than count) → blocked with explicit reason naming count, not "shortfall"', () => {
  const plan = buildPlan({ currentSecured: 4, count: 5, manifest: [{ fingerprint: realFp('a') }, { fingerprint: realFp('b') }] });
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.reasons.some((r) => /manifest supplies 2 rows but count is 5/.test(r)));
});

test('full real manifest → ready-dry-run with deterministic external_ids continuing after existing anchors', () => {
  const manifest = Array.from({ length: 3 }, (_, i) => ({
    fingerprint: realFp('0123456789abcdef'[i % 16]),
    document_type: 'legal_filing',
  }));
  const plan = buildPlan({ currentSecured: 4, count: 3, manifest, batchId: 'haki-batch-2026' });
  assert.equal(plan.status, 'ready-dry-run');
  assert.equal(plan.usesPlaceholders, false);
  assert.equal(plan.request.batch_id, 'haki-batch-2026');
  // numbering continues after the operator-supplied currentSecured count: 05..07
  assert.equal(plan.request.anchors[0].external_id, 'HAKI-KPI1-05');
  assert.equal(plan.request.anchors[2].external_id, 'HAKI-KPI1-07');
  assert.equal(plan.request.anchors[0].document_type, 'legal_filing');
});

test('every emitted real fingerprint is a valid 64-hex SHA-256 the endpoint accepts', () => {
  const manifest = Array.from({ length: 2 }, () => ({ fingerprint: realFp('a') }));
  const plan = buildPlan({ currentSecured: 4, count: 2, manifest });
  for (const row of plan.request.anchors) {
    assert.match(row.fingerprint, /^[0-9a-f]{64}$/);
  }
});

test('rejects invalid --current-secured', () => {
  assert.throws(() => buildPlan({ currentSecured: -1, count: 1 }), /non-negative integer/);
  assert.throws(() => buildPlan({ currentSecured: 1.5, count: 1 }), /non-negative integer/);
});

test('rejects invalid --count (must be an explicit non-negative integer; no default)', () => {
  assert.throws(() => buildPlan({ currentSecured: 4 }), /--count must be/);
  assert.throws(() => buildPlan({ currentSecured: 4, count: -1 }), /--count must be/);
  assert.throws(() => buildPlan({ currentSecured: 4, count: 1.5 }), /--count must be/);
});

test('the module contains no SQL / no direct DB write (routes through the API only)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./haki-provision-plan.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(src, /\bUPDATE\s+\w+\s+SET\b/i);
  assert.doesNotMatch(src, /createClient\s*\(|supabase\.|\.from\s*\(|execute_sql\s*\(|new\s+Pool\b|pg\.connect/);
  assert.doesNotMatch(src, /dry_run:\s*false/);
});

test('the module never frames currentSecured/count/quota as a subtraction ("shortfall"/"gap"/"target") — banned per memory/project_hakichain_account_state.md', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./haki-provision-plan.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bshortfall\b/i);
  assert.doesNotMatch(src, /\bgap\b/i);
  assert.doesNotMatch(src, /\btarget\b/i);
  assert.doesNotMatch(src, /4\s*of\s*15/i);
  assert.doesNotMatch(src, /11\s*(more|additional)?\s*anchors/i);
});
