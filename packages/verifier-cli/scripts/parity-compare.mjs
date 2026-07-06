#!/usr/bin/env node
/**
 * S3-B three-way parity comparator: TS verifier == Python verifier == manifest.
 *
 * Runs EVERY fixture in fixtures/manifest.json through:
 *   1. the TypeScript verifier (this package's built dist/), and
 *   2. the independent Python verifier
 *      (packages/arkova-py/src/arkova/proofs.py via scripts/run_manifest.py),
 * then asserts all three agree on { verdict, reason_code } (and the signature
 * status where the manifest pins one). Any disagreement exits non-zero with a
 * per-fixture diff table.
 *
 * Run:  npm run parity        (builds dist/ first; needs python3 >= 3.9 on PATH)
 * CI:   suggested job — build @arkova/verifier + this package, then `npm run parity`.
 *
 * Fully offline: canned node responses only. Zero Arkova network calls.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyProof } from '../dist/verify.js';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = join(here, '..');
const FIXTURES = join(PKG, 'fixtures');
const REPO_ROOT = join(PKG, '..', '..');
const PY_PKG = join(REPO_ROOT, 'packages', 'arkova-py');
const PROOF08 = join(REPO_ROOT, 'services', 'worker', 'src', 'proof', 'fixtures', 'proof-fixtures.json');

const loadJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const manifest = loadJson(join(FIXTURES, 'manifest.json'));
const sources = {
  synthetic: loadJson(join(FIXTURES, 'synthetic-vectors.json')).fixtures,
  adversarial: loadJson(join(FIXTURES, 'adversarial-vectors.json')).fixtures,
};
const proof08 = loadJson(PROOF08);

function packetFromProof08(ref) {
  const v = ref === 'valid-inclusion' ? proof08.valid : proof08.invalid.find((i) => i.id === ref);
  if (!v) throw new Error(`PROOF-08 vector ${ref} not found`);
  return {
    fingerprint: v.fingerprint,
    merkle_root: v.merkle_root,
    merkle_proof: v.merkle_proof,
    merkle_index: v.merkle_index,
    leaf_count: v.leaf_count,
    tx_id: null,
    block_height: null,
    block_timestamp: null,
    batch_id: null,
  };
}

function offlineNode(responses) {
  return {
    label: 'offline-fixture-node',
    fetch: async (path) => {
      if (!(path in responses)) return { ok: false, status: 404 };
      const value = responses[path];
      if (typeof value === 'string') return { ok: true, status: 200, text: value };
      return { ok: true, status: 200, json: value };
    },
  };
}

async function runTs(entry) {
  const fixture =
    entry.source === 'proof08'
      ? { packet: packetFromProof08(entry.ref) }
      : sources[entry.source].find((f) => f.name === entry.ref);
  if (!fixture) throw new Error(`fixture ${entry.ref} not found in ${entry.source}`);
  const report = await verifyProof(fixture.packet, {
    chain: entry.mode === 'chain' && fixture.node ? offlineNode(fixture.node) : undefined,
    signedBundle: entry.mode === 'signature' ? fixture.signedBundle : undefined,
    publishedKeys: entry.mode === 'signature' ? fixture.publishedKeys : undefined,
  });
  return {
    verdict: report.ok ? 'VERIFIED' : 'NOT_VERIFIED',
    reason_code: report.reasonCode ?? null,
    signature_status: report.signature.status,
  };
}

function runPython() {
  try {
    const out = execFileSync('python3', [join(PY_PKG, 'scripts', 'run_manifest.py')], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    return JSON.parse(out);
  } catch (err) {
    console.error('FAIL: could not run the Python verifier (python3 >= 3.9 required on PATH).');
    console.error(String(err?.message ?? err));
    process.exit(2);
  }
}

const pyResults = runPython();
const rows = [];
let disagreements = 0;

for (const entry of manifest.fixtures) {
  const expected = {
    verdict: entry.expected.verdict,
    reason_code: entry.expected.reason_code ?? null,
  };
  const ts = await runTs(entry);
  const py = pyResults[entry.id];
  if (!py) {
    disagreements++;
    rows.push({ id: entry.id, ok: false, note: 'MISSING from Python results' });
    continue;
  }

  const problems = [];
  if (ts.verdict !== expected.verdict) problems.push(`TS verdict ${ts.verdict} != manifest ${expected.verdict}`);
  if (py.verdict !== expected.verdict) problems.push(`PY verdict ${py.verdict} != manifest ${expected.verdict}`);
  if ((ts.reason_code ?? null) !== expected.reason_code)
    problems.push(`TS reason ${ts.reason_code} != manifest ${expected.reason_code}`);
  if ((py.reason_code ?? null) !== expected.reason_code)
    problems.push(`PY reason ${py.reason_code} != manifest ${expected.reason_code}`);
  if (entry.expected.signature) {
    if (ts.signature_status !== entry.expected.signature)
      problems.push(`TS signature ${ts.signature_status} != manifest ${entry.expected.signature}`);
    if (py.signature_status !== entry.expected.signature)
      problems.push(`PY signature ${py.signature_status} != manifest ${entry.expected.signature}`);
  }

  if (problems.length > 0) disagreements++;
  rows.push({
    id: entry.id,
    ok: problems.length === 0,
    note:
      problems.length === 0
        ? `${expected.verdict}${expected.reason_code ? ` / ${expected.reason_code}` : ''}`
        : problems.join('; '),
  });
}

const width = Math.max(...rows.map((r) => r.id.length));
console.log(`\nS3-B parity: TS == Python == manifest (${manifest.fixtures.length} fixtures, enum v${manifest.reason_enum_version})\n`);
for (const r of rows) {
  console.log(`  ${r.ok ? 'AGREE ' : 'DIFFER'}  ${r.id.padEnd(width)}  ${r.note}`);
}
console.log('');

if (disagreements > 0) {
  console.error(`FAIL: ${disagreements} fixture(s) disagree across TS / Python / manifest.`);
  process.exit(1);
}
console.log(`PASS: three-way agreement on all ${manifest.fixtures.length} fixtures.`);
