/**
 * AI-01 (SCRUM-2381) — CPE/CLE extraction golden set: structure + stratification
 * + manifest version-pin tests.
 *
 * The set is 100% synthetic / public-specimen-style: fictitious providers,
 * [NAME_REDACTED]-style tokens, invented course IDs. These tests fail closed if
 * the stratification drifts from the committed manifest, if the held-out split
 * shrinks, or if an entry ever carries unredacted PII-looking content.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GOLDEN_DATASET_CPE_CLE_S3,
  CPE_CLE_S3_GATE_ENTRIES,
  CPE_CLE_S3_HELDOUT_ENTRIES,
  S3_DATASET_TAG,
  S3_HELDOUT_TAG,
  S3_QUALITY_TAGS,
  S3_ADVERSARIAL_TAGS,
} from './golden-dataset-cpe-cle-s3.js';
import { fingerprintFixtureText } from './heldout-leakage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface S3Manifest {
  version: string;
  datasetTag: string;
  totalEntries: number;
  heldOutEntries: number;
  gateEntries: number;
  counts: {
    byCredentialType: Record<string, number>;
    byQuality: Record<string, number>;
    byAdversarialClass: Record<string, number>;
    heldOutByCredentialType: Record<string, number>;
  };
  heldOutFingerprints: Record<string, string>;
  coverageRationale: string;
}

function loadManifest(): S3Manifest {
  return JSON.parse(
    readFileSync(resolve(__dirname, 'cpe-cle-s3-manifest.json'), 'utf-8'),
  ) as S3Manifest;
}

const countBy = (entries: { tags: string[] }[], tag: string) =>
  entries.filter((e) => e.tags.includes(tag)).length;

describe('AI-01 S3 CPE/CLE golden set — size and stratification', () => {
  it('has at least 60 labeled fixtures', () => {
    expect(GOLDEN_DATASET_CPE_CLE_S3.length).toBeGreaterThanOrEqual(60);
  });

  it('every entry carries the s3 dataset tag and a synthetic tag', () => {
    for (const entry of GOLDEN_DATASET_CPE_CLE_S3) {
      expect(entry.tags).toContain(S3_DATASET_TAG);
      expect(entry.tags).toContain('synthetic');
    }
  });

  it('every entry is tagged exactly one of cpe|cle', () => {
    for (const entry of GOLDEN_DATASET_CPE_CLE_S3) {
      const kinds = ['cpe', 'cle'].filter((t) => entry.tags.includes(t));
      expect(kinds, `entry ${entry.id} must have exactly one kind tag`).toHaveLength(1);
    }
  });

  it('every entry is tagged exactly one quality stratum (clean|degraded-scan)', () => {
    for (const entry of GOLDEN_DATASET_CPE_CLE_S3) {
      const quality = S3_QUALITY_TAGS.filter((t) => entry.tags.includes(t));
      expect(quality, `entry ${entry.id} must have exactly one quality tag`).toHaveLength(1);
    }
  });

  it('every entry has at most one adversarial class tag', () => {
    for (const entry of GOLDEN_DATASET_CPE_CLE_S3) {
      const adv = S3_ADVERSARIAL_TAGS.filter((t) => entry.tags.includes(t));
      expect(adv.length, `entry ${entry.id} adversarial tags`).toBeLessThanOrEqual(1);
    }
  });

  it('covers every adversarial class for BOTH cpe and cle with >= 3 entries each', () => {
    for (const kind of ['cpe', 'cle']) {
      const kindEntries = GOLDEN_DATASET_CPE_CLE_S3.filter((e) => e.tags.includes(kind));
      for (const adv of S3_ADVERSARIAL_TAGS) {
        expect(
          countBy(kindEntries, adv),
          `${kind} × ${adv} stratum coverage`,
        ).toBeGreaterThanOrEqual(3);
      }
      expect(countBy(kindEntries, 'degraded-scan'), `${kind} degraded coverage`).toBeGreaterThanOrEqual(8);
      expect(countBy(kindEntries, 'clean'), `${kind} clean coverage`).toBeGreaterThanOrEqual(10);
    }
  });

  it('has unique ids', () => {
    const ids = GOLDEN_DATASET_CPE_CLE_S3.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry has labeled ground truth for the critical gate fields', () => {
    for (const entry of GOLDEN_DATASET_CPE_CLE_S3) {
      expect(entry.groundTruth.credentialType, `${entry.id} credentialType`).toBeTruthy();
      expect(entry.groundTruth.issuedDate, `${entry.id} issuedDate`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof entry.groundTruth.creditHours, `${entry.id} creditHours`).toBe('number');
    }
  });

  it('contains zero unredacted PII-looking content (synthetic-only guarantee)', () => {
    for (const entry of GOLDEN_DATASET_CPE_CLE_S3) {
      // SSN-shaped
      expect(entry.strippedText).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
      // Email addresses
      expect(entry.strippedText).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      // Phone-shaped
      expect(entry.strippedText).not.toMatch(/\(\d{3}\)\s?\d{3}-\d{4}/);
      // Participant names must be redaction tokens, never literals
      expect(entry.strippedText).not.toMatch(/Participant:\s+(?!\[)/);
      // Source must declare itself synthetic
      expect(entry.source).toMatch(/^synthetic\//);
    }
  });
});

describe('AI-01 S3 golden set — held-out split', () => {
  it('holds out at least 10 entries, disjoint from the gate set', () => {
    expect(CPE_CLE_S3_HELDOUT_ENTRIES.length).toBeGreaterThanOrEqual(10);
    const heldOutIds = new Set(CPE_CLE_S3_HELDOUT_ENTRIES.map((e) => e.id));
    for (const entry of CPE_CLE_S3_GATE_ENTRIES) {
      expect(heldOutIds.has(entry.id), `${entry.id} in both splits`).toBe(false);
    }
    expect(CPE_CLE_S3_GATE_ENTRIES.length + CPE_CLE_S3_HELDOUT_ENTRIES.length).toBe(
      GOLDEN_DATASET_CPE_CLE_S3.length,
    );
  });

  it('held-out entries carry the held-out tag (excluded from merge gates)', () => {
    for (const entry of CPE_CLE_S3_HELDOUT_ENTRIES) {
      expect(entry.tags).toContain(S3_HELDOUT_TAG);
    }
    for (const entry of CPE_CLE_S3_GATE_ENTRIES) {
      expect(entry.tags).not.toContain(S3_HELDOUT_TAG);
    }
  });

  it('held-out split is stratified across cpe and cle', () => {
    expect(countBy(CPE_CLE_S3_HELDOUT_ENTRIES, 'cpe')).toBeGreaterThanOrEqual(4);
    expect(countBy(CPE_CLE_S3_HELDOUT_ENTRIES, 'cle')).toBeGreaterThanOrEqual(4);
  });
});

describe('AI-01 S3 golden set — manifest version pin', () => {
  it('manifest counts match the dataset exactly (regeneration guard)', () => {
    const manifest = loadManifest();
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.datasetTag).toBe(S3_DATASET_TAG);
    expect(manifest.totalEntries).toBe(GOLDEN_DATASET_CPE_CLE_S3.length);
    expect(manifest.heldOutEntries).toBe(CPE_CLE_S3_HELDOUT_ENTRIES.length);
    expect(manifest.gateEntries).toBe(CPE_CLE_S3_GATE_ENTRIES.length);
    expect(manifest.coverageRationale.length).toBeGreaterThan(100);

    expect(manifest.counts.byCredentialType).toEqual({
      cpe: countBy(GOLDEN_DATASET_CPE_CLE_S3, 'cpe'),
      cle: countBy(GOLDEN_DATASET_CPE_CLE_S3, 'cle'),
    });
    expect(manifest.counts.byQuality).toEqual({
      clean: countBy(GOLDEN_DATASET_CPE_CLE_S3, 'clean'),
      'degraded-scan': countBy(GOLDEN_DATASET_CPE_CLE_S3, 'degraded-scan'),
    });
    const advCounts: Record<string, number> = {};
    for (const adv of S3_ADVERSARIAL_TAGS) {
      advCounts[adv] = countBy(GOLDEN_DATASET_CPE_CLE_S3, adv);
    }
    expect(manifest.counts.byAdversarialClass).toEqual(advCounts);
    expect(manifest.counts.heldOutByCredentialType).toEqual({
      cpe: countBy(CPE_CLE_S3_HELDOUT_ENTRIES, 'cpe'),
      cle: countBy(CPE_CLE_S3_HELDOUT_ENTRIES, 'cle'),
    });
  });

  it('manifest pins a fingerprint for every held-out fixture (leakage control input)', () => {
    const manifest = loadManifest();
    expect(Object.keys(manifest.heldOutFingerprints).sort()).toEqual(
      CPE_CLE_S3_HELDOUT_ENTRIES.map((e) => e.id).sort(),
    );
    for (const entry of CPE_CLE_S3_HELDOUT_ENTRIES) {
      expect(manifest.heldOutFingerprints[entry.id]).toBe(
        fingerprintFixtureText(entry.strippedText),
      );
    }
  });
});
