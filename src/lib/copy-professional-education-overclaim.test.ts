/**
 * CLE-01 (SCRUM-2379) — overclaim guard for CPE/CLE copy keys.
 *
 * Constitution §1.5 + the R-7 claims-review gate: jurisdiction tags are
 * informational metadata only, and Arkova copy must never assert legal
 * sufficiency or that a requirement is "met"/"satisfied". This test greps every
 * CPE/CLE-facing copy key (including function-valued keys, invoked with sample
 * counts) for the banned overclaim phrases.
 */
import { describe, expect, it } from 'vitest';
import {
  PROFESSIONAL_EDUCATION_EXPORT_LABELS,
  PROFESSIONAL_EDUCATION_S3_LABELS,
  ORG_CPE_DASHBOARD_LABELS,
} from './copy';

const OVERCLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  /\bmeets?\b/i,
  /\bmet\b/i,
  /\bsatisf(?:y|ies|ied|action)\b/i,
  /legally\s+sufficient/i,
  /listed in the (credential )?registry/i,
];

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (typeof value === 'function') {
    // Function-valued copy keys take a count — sample singular + plural.
    for (const sample of [0, 1, 2, 42]) {
      const produced = (value as (n: number) => unknown)(sample);
      if (typeof produced === 'string') out.push(produced);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) collectStrings(nested, out);
  }
}

describe('CPE/CLE copy keys never overclaim (SCRUM-2379 / §1.5 / R-7)', () => {
  const surfaces: Array<[string, Record<string, unknown>]> = [
    ['PROFESSIONAL_EDUCATION_EXPORT_LABELS', PROFESSIONAL_EDUCATION_EXPORT_LABELS],
    ['PROFESSIONAL_EDUCATION_S3_LABELS', PROFESSIONAL_EDUCATION_S3_LABELS],
    ['ORG_CPE_DASHBOARD_LABELS', ORG_CPE_DASHBOARD_LABELS],
  ];

  it.each(surfaces)('%s contains no overclaim phrase', (_name, labels) => {
    const strings: string[] = [];
    collectStrings(labels, strings);
    expect(strings.length).toBeGreaterThan(0);
    for (const text of strings) {
      for (const pattern of OVERCLAIM_PATTERNS) {
        expect(text).not.toMatch(pattern);
      }
    }
  });

  it('the jurisdiction disclaimer states the informational-only framing (§1.5)', () => {
    expect(PROFESSIONAL_EDUCATION_S3_LABELS.JURISDICTION_DISCLAIMER).toMatch(
      /informational metadata only/i,
    );
  });
});
