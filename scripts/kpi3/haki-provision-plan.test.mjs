import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, externalIdFor, parseArgs } from './haki-provision-plan.mjs';

const FP = (n) => String(n).padStart(64, '0').replace(/ /g, '0'); // 64-hex fill
const realFp = (seed) => (seed.repeat(64)).slice(0, 64); // e.g. 'a'*64

test('externalIdFor is deterministic + zero-padded', () => {
  assert.equal(externalIdFor(5), 'HAKI-KPI1-05');
  assert.equal(externalIdFor(11), 'HAKI-KPI1-11');
});

test('parseArgs reads flags, rejects unknown', () => {
  const o = parseArgs(['--current-secured', '4', '--target', '15', '--json']);
  assert.equal(o.currentSecured, 4);
  assert.equal(o.target, 15);
  assert.equal(o.json, true);
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

test('shortfall math: 4 SECURED, target 15 → 11 to provision', () => {
  const plan = buildPlan({ currentSecured: 4, manifest: Array.from({ length: 11 }, (_, i) => ({ fingerprint: realFp('abcdef0123456789'[i % 16]) })) });
  assert.equal(plan.shortfall, 11);
  assert.equal(plan.target, 15);
  assert.equal(plan.request.anchors.length, 11);
});

test('idempotent short-circuit: already at/above target → complete, no request', () => {
  const plan = buildPlan({ currentSecured: 15, target: 15 });
  assert.equal(plan.status, 'complete');
  assert.equal(plan.shortfall, 0);
  assert.equal(plan.request, null);
  const over = buildPlan({ currentSecured: 20, target: 15 });
  assert.equal(over.status, 'complete');
  assert.equal(over.shortfall, 0);
});

test('request is ALWAYS dry_run:true and duplicate_strategy:"skip"', () => {
  const plan = buildPlan({ currentSecured: 4, manifest: Array.from({ length: 11 }, () => ({ fingerprint: realFp('a') })) });
  assert.equal(plan.request.dry_run, true);
  assert.equal(plan.request.duplicate_strategy, 'skip');
});

test('no real fingerprints → status blocked, placeholders flagged, no real fp leaks', () => {
  const plan = buildPlan({ currentSecured: 4 }); // no manifest
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.usesPlaceholders, true);
  assert.match(plan.reasons[0], /BLOCKED/);
  for (const row of plan.request.anchors) {
    assert.match(row.fingerprint, /PLACEHOLDER/);
    // placeholder must NOT be a valid 64-hex fingerprint the endpoint would accept as real
    assert.doesNotMatch(row.fingerprint, /^[0-9a-f]{64}$/);
  }
});

test('partial manifest (fewer than shortfall) → blocked with explicit reason', () => {
  const plan = buildPlan({ currentSecured: 4, manifest: [{ fingerprint: realFp('a') }, { fingerprint: realFp('b') }] });
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.reasons.some((r) => /manifest supplies 2 rows but shortfall is 11/.test(r)));
});

test('full real manifest → ready-dry-run with deterministic external_ids continuing after existing', () => {
  const manifest = Array.from({ length: 11 }, (_, i) => ({
    fingerprint: realFp('0123456789abcdef'[i % 16]),
    document_type: 'legal_filing',
  }));
  const plan = buildPlan({ currentSecured: 4, manifest, batchId: 'haki-kpi1-2026' });
  assert.equal(plan.status, 'ready-dry-run');
  assert.equal(plan.usesPlaceholders, false);
  assert.equal(plan.request.batch_id, 'haki-kpi1-2026');
  // numbering continues after the 4 existing anchors: 05..15
  assert.equal(plan.request.anchors[0].external_id, 'HAKI-KPI1-05');
  assert.equal(plan.request.anchors[10].external_id, 'HAKI-KPI1-15');
  // pass-through metadata preserved
  assert.equal(plan.request.anchors[0].document_type, 'legal_filing');
});

test('every emitted real fingerprint is a valid 64-hex SHA-256 the endpoint accepts', () => {
  const manifest = Array.from({ length: 11 }, () => ({ fingerprint: realFp('a') }));
  const plan = buildPlan({ currentSecured: 4, manifest });
  for (const row of plan.request.anchors) {
    assert.match(row.fingerprint, /^[0-9a-f]{64}$/);
  }
});

test('rejects invalid --current-secured', () => {
  assert.throws(() => buildPlan({ currentSecured: -1 }), /non-negative integer/);
  assert.throws(() => buildPlan({ currentSecured: 1.5 }), /non-negative integer/);
});

test('the module contains no SQL / no direct DB write (routes through the API only)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./haki-provision-plan.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(src, /\bUPDATE\s+\w+\s+SET\b/i);
  // actual DB-client code patterns (prose mentions of "Postgres" are fine)
  assert.doesNotMatch(src, /createClient\s*\(|supabase\.|\.from\s*\(|execute_sql\s*\(|new\s+Pool\b|pg\.connect/);
  // never emits a real write path
  assert.doesNotMatch(src, /dry_run:\s*false/);
});
