import { describe, it, expect } from 'vitest';

import {
  allGoldenEntries,
  gateGoldenEntries,
  heldOutGoldenEntries,
  goldenProvenance,
} from './golden.js';
import { matchesGate, type EntryEvalResult } from './scoring.js';

describe('vendored AI-01 golden set', () => {
  it('carries provenance pinning it to #1413 SCRUM-2381', () => {
    const p = goldenProvenance();
    expect(p.source).toContain('golden-dataset-cpe-cle-s3.ts');
    expect(p.sourceRef).toContain('lane3/s3-ai');
    expect(p.sourceCommit).toBe('b95851d57a59f32bc0425f43715339806d511fc3');
  });

  it('has 60 fixtures split 48 gate + 12 held-out (matches the manifest)', () => {
    expect(allGoldenEntries()).toHaveLength(60);
    expect(gateGoldenEntries()).toHaveLength(48);
    expect(heldOutGoldenEntries()).toHaveLength(12);
  });

  it('is 30 CPE × 30 CLE, all synthetic, zero real PII markers', () => {
    const all = allGoldenEntries();
    expect(all.filter((e) => e.tags.includes('cpe'))).toHaveLength(30);
    expect(all.filter((e) => e.tags.includes('cle'))).toHaveLength(30);
    // Every fixture is tagged synthetic and sourced from the synthetic slug.
    expect(all.every((e) => e.tags.includes('synthetic'))).toBe(true);
    expect(all.every((e) => e.source.startsWith('synthetic/'))).toBe(true);
  });

  it('every gate entry is a non-held-out s3-cpe-cle fixture (matchesGate true)', () => {
    const gate = gateGoldenEntries();
    for (const entry of gate) {
      const asResult: EntryEvalResult = { entryId: entry.id, tags: entry.tags, fieldResults: [] };
      expect(matchesGate(asResult)).toBe(true);
    }
  });

  it('held-out entries are excluded from the gate split (matchesGate false)', () => {
    for (const entry of heldOutGoldenEntries()) {
      const asResult: EntryEvalResult = { entryId: entry.id, tags: entry.tags, fieldResults: [] };
      expect(matchesGate(asResult)).toBe(false);
    }
  });

  it('every gate entry has the SCRUM-2382 required fields in ground truth', () => {
    // creditHours + issuedDate + credentialType are the gate-floored fields.
    for (const entry of gateGoldenEntries()) {
      expect(entry.groundTruth.credentialType).toBeDefined();
      expect(entry.groundTruth.issuedDate).toBeDefined();
      expect(entry.groundTruth.creditHours).toBeDefined();
      expect(entry.strippedText.length).toBeGreaterThan(0);
    }
  });
});
