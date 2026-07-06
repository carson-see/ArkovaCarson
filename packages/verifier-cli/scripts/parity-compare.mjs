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
 * Run:  npm run parity        (builds dist/ first; needs python3 >= 3.9 — see below)
 * CI:   suggested job — build @arkova/verifier + this package, then `npm run parity`.
 *
 * The Python interpreter is NEVER resolved via $PATH (a writable dir on PATH
 * could shadow `python3` — Sonar S4036): it is taken from $ARKOVA_PYTHON when
 * set (must be an ABSOLUTE path), else probed at the fixed system locations
 * below.
 *
 * Fully offline: canned node responses only. Zero Arkova network calls.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { verifyProof } from '../dist/verify.js';
import { fixtureNodeFetch, packetFromProof08Vector, resolveProof08Vector } from '../dist/lib/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = join(here, '..');
const FIXTURES = join(PKG, 'fixtures');
const REPO_ROOT = join(PKG, '..', '..');
const PY_PKG = join(REPO_ROOT, 'packages', 'arkova-py');
const PROOF08 = join(REPO_ROOT, 'services', 'worker', 'src', 'proof', 'fixtures', 'proof-fixtures.json');

/** Fixed, root-owned interpreter locations — never a $PATH search (S4036). */
const PYTHON_CANDIDATES = [
  '/usr/bin/python3',
  '/usr/local/bin/python3',
  '/opt/homebrew/bin/python3',
];

function resolvePythonBin() {
  const override = process.env.ARKOVA_PYTHON;
  if (override) {
    if (!isAbsolute(override) || !existsSync(override)) {
      console.error(`FAIL: ARKOVA_PYTHON must be an absolute path to an existing python3 (got "${override}").`);
      process.exit(2);
    }
    return override;
  }
  const found = PYTHON_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    console.error(
      `FAIL: no python3 found at ${PYTHON_CANDIDATES.join(', ')}. ` +
        'Set ARKOVA_PYTHON to an absolute python3 (>= 3.9) path.',
    );
    process.exit(2);
  }
  return found;
}

const loadJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const manifest = loadJson(join(FIXTURES, 'manifest.json'));
const sources = {
  synthetic: loadJson(join(FIXTURES, 'synthetic-vectors.json')).fixtures,
  adversarial: loadJson(join(FIXTURES, 'adversarial-vectors.json')).fixtures,
};
const proof08 = loadJson(PROOF08);

function packetFromProof08(ref) {
  const v = resolveProof08Vector(proof08, ref);
  if (!v) throw new Error(`PROOF-08 vector ${ref} not found`);
  return packetFromProof08Vector(v);
}

async function runTs(entry) {
  const fixture =
    entry.source === 'proof08'
      ? { packet: packetFromProof08(entry.ref) }
      : sources[entry.source].find((f) => f.name === entry.ref);
  if (!fixture) throw new Error(`fixture ${entry.ref} not found in ${entry.source}`);
  const report = await verifyProof(fixture.packet, {
    chain:
      entry.mode === 'chain' && fixture.node
        ? { label: 'offline-fixture-node', fetch: fixtureNodeFetch(fixture.node) }
        : undefined,
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
  const pythonBin = resolvePythonBin();
  try {
    const out = execFileSync(pythonBin, [join(PY_PKG, 'scripts', 'run_manifest.py')], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    return JSON.parse(out);
  } catch (err) {
    console.error(`FAIL: could not run the Python verifier via ${pythonBin} (python3 >= 3.9 required).`);
    console.error(String(err?.message ?? err));
    process.exit(2);
  }
}

function agreementNote(expected) {
  const reason = expected.reason_code ? ` / ${expected.reason_code}` : '';
  return `${expected.verdict}${reason}`;
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
    note: problems.length === 0 ? agreementNote(expected) : problems.join('; '),
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
