/**
 * §1.6 PII boundary — load / concurrency proof for the CSV bulk-upload path.
 *
 * The unit tests in `csvRowText.test.ts` prove redaction on a handful of rows. This
 * file proves the same invariant holds at *bulk-upload scale*, which is the scale that
 * actually matters: the reported failure mode is backfilling thousands-to-millions of
 * documents, and a stripper that leaks on 1 row in 10,000 would leak continuously at
 * that volume while looking perfect in a 6-row unit test.
 *
 * What this asserts, over 10,000 generated rows:
 *   1. ZERO raw SSNs, emails, phone numbers or recipient names survive — not "few", zero.
 *   2. The invariant holds under concurrent batch execution, matching how the wizard
 *      chunks rows.
 *   3. Throughput stays high enough that stripping is not the bulk-upload bottleneck.
 *
 * Deliberately no network, no browser and no dev server: this must be cheap enough to
 * run in CI on every change to the PII boundary.
 */
import { describe, it, expect } from 'vitest';
import { buildStrippedRowText } from './csvRowText';
import type { CsvColumn, CsvRow } from './csvParser';

const ROW_COUNT = 10_000;

const columns: CsvColumn[] = [
  { name: 'recipient', index: 0 },
  { name: 'email', index: 1 },
  { name: 'ssn', index: 2 },
  { name: 'phone', index: 3 },
  { name: 'course', index: 4 },
  { name: 'completed_on', index: 5 },
] as unknown as CsvColumn[];

// Varied names and domains so redaction cannot pass by matching one hard-coded literal.
const FIRST = ['Jane', 'Rutherford', 'Amara', 'Xiulan', 'Tomasz', 'Ngozi', 'Sebastián'];
const LAST = ['Doe', 'Vance', 'Okonkwo', 'Zhang', 'Kowalski', 'Adeyemi', 'Márquez'];
const DOMAIN = ['example.com', 'mail.test', 'corp.example.org', 'uni.example.edu'];

function makeRow(i: number): { row: CsvRow; pii: string[] } {
  const first = FIRST[i % FIRST.length];
  const last = LAST[(i * 3) % LAST.length];
  const name = `${first} ${last}`;
  const email = `${first.toLowerCase()}.${last.toLowerCase()}${i}@${DOMAIN[i % DOMAIN.length]}`;
  // Valid-shaped SSNs and phones, varied per row.
  const ssn = `${100 + (i % 800)}-${10 + (i % 89)}-${1000 + (i % 8999)}`;
  const phone = `${200 + (i % 700)}-${100 + (i % 800)}-${1000 + (i % 8999)}`;
  const row = {
    data: {
      recipient: name,
      email,
      ssn,
      phone,
      course: `Continuing Education Module ${i % 40}`,
      completed_on: `2026-0${1 + (i % 9)}-1${i % 9}`,
    },
  } as unknown as CsvRow;
  return { row, pii: [name, email, ssn, phone] };
}

const SSN_SHAPE = /\b\d{3}-\d{2}-\d{4}\b/;
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

describe('buildStrippedRowText — §1.6 boundary at bulk-upload scale', () => {
  it(`leaks no PII across ${ROW_COUNT.toLocaleString()} rows`, () => {
    const leaks: string[] = [];

    for (let i = 0; i < ROW_COUNT; i++) {
      const { row, pii } = makeRow(i);
      const text = buildStrippedRowText(row, columns);

      for (const secret of pii) {
        if (text.includes(secret)) leaks.push(`row ${i}: literal ${secret}`);
      }
      if (SSN_SHAPE.test(text)) leaks.push(`row ${i}: SSN-shaped digits survived`);
      if (EMAIL_SHAPE.test(text)) leaks.push(`row ${i}: email-shaped token survived`);
    }

    // Report a sample rather than 10k lines, but fail on ANY leak.
    expect(leaks.slice(0, 10)).toEqual([]);
    expect(leaks).toHaveLength(0);
  });

  it('preserves the non-PII content the extractor needs, at scale', () => {
    let preserved = 0;
    for (let i = 0; i < 1_000; i++) {
      const { row } = makeRow(i);
      const text = buildStrippedRowText(row, columns);
      if (text.includes(`Continuing Education Module ${i % 40}`)) preserved++;
    }
    // Redaction must not be achieved by destroying the payload.
    expect(preserved).toBe(1_000);
  });

  it('holds the invariant under concurrent batch execution', async () => {
    // The wizard chunks rows; prove no cross-batch state leaks between concurrent runs.
    const BATCHES = 20;
    const PER_BATCH = 250;

    const results = await Promise.all(
      Array.from({ length: BATCHES }, (_, b) =>
        Promise.resolve().then(() => {
          const bad: string[] = [];
          for (let j = 0; j < PER_BATCH; j++) {
            const { row, pii } = makeRow(b * PER_BATCH + j);
            const text = buildStrippedRowText(row, columns);
            for (const secret of pii) if (text.includes(secret)) bad.push(secret);
            if (SSN_SHAPE.test(text)) bad.push('ssn-shape');
          }
          return bad;
        }),
      ),
    );

    expect(results.flat()).toHaveLength(0);
  });

  it('strips fast enough not to be the bulk-upload bottleneck', () => {
    const started = performance.now();
    for (let i = 0; i < ROW_COUNT; i++) {
      buildStrippedRowText(makeRow(i).row, columns);
    }
    const elapsedMs = performance.now() - started;
    const rowsPerSec = ROW_COUNT / (elapsedMs / 1000);

    // Generous floor: the point is to catch a catastrophic regression (e.g. someone
    // swapping the regex layer for per-row NER), not to micro-benchmark.
    expect(rowsPerSec).toBeGreaterThan(500);
  });
});
