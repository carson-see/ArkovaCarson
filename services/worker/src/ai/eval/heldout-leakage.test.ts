/**
 * AI-01/AI-02 (SCRUM-2381/2382) — held-out leakage control.
 *
 * The held-out fixtures exist to measure generalization. If their text (or ids)
 * ever land in a prompt, few-shot block, or tuning corpus committed to the repo,
 * the held-out F1 stops being evidence. This suite:
 *
 *   1. Unit-tests the detector on synthetic corpora (positive + negative).
 *   2. Runs the REAL repo scan — training-data corpora + prompt-building AI
 *      sources — and fails the build on any leak (fail-closed, SCRUM-2200 spirit).
 */

import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fingerprintFixtureText,
  normalizeForLeakageScan,
  checkHeldoutLeakage,
  loadLeakageCorpus,
  type CorpusFile,
} from './heldout-leakage.js';
import { CPE_CLE_S3_HELDOUT_ENTRIES } from './golden-dataset-cpe-cle-s3.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(__dirname, '..', '..', '..');

describe('fingerprintFixtureText', () => {
  it('is whitespace/case insensitive so cosmetic edits cannot dodge the check', () => {
    const a = fingerprintFixtureText('CPE Credits:  8.0\nProvider: Ridgeline');
    const b = fingerprintFixtureText('cpe credits: 8.0 provider:   ridgeline');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different content', () => {
    expect(fingerprintFixtureText('alpha')).not.toBe(fingerprintFixtureText('beta'));
  });
});

describe('checkHeldoutLeakage — detector', () => {
  const heldOut = [
    {
      id: 'GD-TEST-HELDOUT-1',
      strippedText: 'Certificate of CPE. Course ID: ZZZ-LEAK-001. Credits: 4.0. Provider: Example Institute.',
      tags: ['held-out'],
    },
  ];

  it('returns no violations for a clean corpus', () => {
    const corpus: CorpusFile[] = [
      { path: 'training-data/clean.jsonl', content: '{"text":"totally unrelated fixture"}' },
    ];
    expect(checkHeldoutLeakage(heldOut, corpus)).toEqual([]);
  });

  it('FAILS when held-out fixture text appears in a corpus file (even reformatted)', () => {
    const corpus: CorpusFile[] = [
      {
        path: 'training-data/contaminated.jsonl',
        content:
          '{"prompt":"certificate of cpe.   course id: zzz-leak-001. credits: 4.0. provider: example institute."}',
      },
    ];
    const violations = checkHeldoutLeakage(heldOut, corpus);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      fixtureId: 'GD-TEST-HELDOUT-1',
      corpusFile: 'training-data/contaminated.jsonl',
      kind: 'content',
    });
  });

  it('FAILS when a held-out fixture ID is referenced in a corpus file', () => {
    const corpus: CorpusFile[] = [
      { path: 'src/ai/prompt.ts', content: 'const FEW_SHOT = ["GD-TEST-HELDOUT-1"];' },
    ];
    const violations = checkHeldoutLeakage(heldOut, corpus);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('id');
  });

  it('normalization collapses whitespace and case', () => {
    expect(normalizeForLeakageScan('A  B\n\tC')).toBe('a b c');
  });
});

describe('checkHeldoutLeakage — REAL repo scan (fail-closed gate input)', () => {
  it('no held-out S3 fixture leaks into any committed prompt/few-shot/tuning corpus', () => {
    const corpus = loadLeakageCorpus(WORKER_ROOT);
    // Sanity: the scan must actually cover the known corpora — an empty corpus
    // would make this test vacuously green (fail-closed guard).
    expect(corpus.length).toBeGreaterThan(0);
    expect(corpus.some((f) => f.path.includes('training-data'))).toBe(true);

    const violations = checkHeldoutLeakage(CPE_CLE_S3_HELDOUT_ENTRIES, corpus);
    expect(violations).toEqual([]);
  });

  it('the corpus scan does NOT include the golden dataset module itself (self-match exclusion)', () => {
    const corpus = loadLeakageCorpus(WORKER_ROOT);
    expect(corpus.some((f) => f.path.includes('golden-dataset-cpe-cle-s3'))).toBe(false);
    expect(corpus.some((f) => f.path.includes('cpe-cle-s3-manifest'))).toBe(false);
  });
});
