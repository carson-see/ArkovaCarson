import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  S33_V71_HISTORICAL_SOURCE,
  S33_V71_SOURCE_MODULES,
  buildS33V71Surgery,
  buildS33V71TuningRequestTemplate,
  normalizeS33V71GoodStandingStatus,
  writeS33V71OfflineArtifacts,
} from './s33-v71-surgery.js';
import { S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY } from '../src/ai/eval/s33-wave3-deterministic-eval-gates.js';

const SHA256 = /^[0-9a-f]{64}$/u;

describe('S3.3 v7.1 deterministic dataset surgery', () => {
  it('pins the ordered April v7 source instead of current FULL_GOLDEN_DATASET', () => {
    expect(S33_V71_SOURCE_MODULES.map(({ name, count }) => [name, count])).toEqual([
      ['base', 100],
      ['extended', 110],
      ['phase2', 100],
      ['phase3', 190],
      ['phase4', 250],
      ['phase5', 200],
      ['phase6', 80],
      ['phase7', 150],
      ['phase8', 150],
      ['phase9', 130],
      ['phase10', 125],
      ['phase11', 80],
      ['phase12', 80],
      ['phase13-fcra', 22],
      ['phase14', 120],
      ['phase15', 13],
      ['phase17', 586],
      ['phase18-v7', 170],
    ]);
    expect(S33_V71_HISTORICAL_SOURCE).toHaveLength(2656);
    expect(new Set(S33_V71_HISTORICAL_SOURCE.map(({ id }) => id)).size).toBe(2656);
  });

  it('reconciles every source row once without forcing the held-out 621 count', () => {
    const result = buildS33V71Surgery();

    expect(result.manifest.counts).toEqual({
      source: 2656,
      toxicDropped: 15,
      fraudSplit: 201,
      retained: 961,
      unresolved: 1479,
      train: 865,
      validation: 96,
    });
    expect(result.manifest.subtypeSources).toEqual({
      ground_truth: 37,
      backfill: 186,
      deduced: 737,
      adjudicated: 1,
    });
    expect(result.retainedRows).not.toHaveLength(621);

    const dispositionIds = result.dispositions.map(({ id }) => id);
    expect(dispositionIds).toHaveLength(2656);
    expect(new Set(dispositionIds).size).toBe(2656);
    expect(dispositionIds).toEqual(S33_V71_HISTORICAL_SOURCE.map(({ id }) => id));
  });

  it('drops exactly GD-3030..GD-3044 before splitting every whole fraud row', () => {
    const result = buildS33V71Surgery();
    expect(result.toxicDroppedRows.map(({ id }) => id)).toEqual(
      Array.from({ length: 15 }, (_, index) => `GD-${3030 + index}`),
    );
    expect(result.fraudSplitRows).toHaveLength(201);
    expect(result.fraudSplitRows.every(
      ({ entry }) => Array.isArray(entry.groundTruth.fraudSignals)
        && entry.groundTruth.fraudSignals.length > 0,
    )).toBe(true);
    expect(result.retainedRows.every(
      ({ sourceEntry }) => (sourceEntry.groundTruth.fraudSignals?.length ?? 0) === 0,
    )).toBe(true);
  });

  it('retains only source-backed concrete taxonomy pairs and emits no fraud field', () => {
    const result = buildS33V71Surgery();
    const sourceIds = new Set(S33_V71_HISTORICAL_SOURCE.map(({ id }) => id));

    for (const row of result.retainedRows) {
      expect(sourceIds.has(row.id)).toBe(true);
      expect(S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY[row.credentialType])
        .toContain(row.subType);
      expect(row.subType).not.toBe('other');
      expect(Object.keys(row.target).some((key) => /fraud/iu.test(key))).toBe(false);
      if (Object.hasOwn(row.target, 'goodStandingStatus')) {
        expect(typeof row.target.goodStandingStatus).toBe('string');
        expect((row.target.goodStandingStatus as string).trim()).not.toBe('');
      }
      expect(row.id).not.toMatch(/^(?:GD-S33|S33-W)/u);
    }
  });

  it('requires source-native goodStandingStatus strings without boolean coercion', () => {
    expect(normalizeS33V71GoodStandingStatus(undefined)).toBeUndefined();
    expect(normalizeS33V71GoodStandingStatus(' Active ')).toBe('Active');
    expect(() => normalizeS33V71GoodStandingStatus(true)).toThrow(/goodStandingStatus/u);
    expect(() => normalizeS33V71GoodStandingStatus(false)).toThrow(/goodStandingStatus/u);
    expect(() => normalizeS33V71GoodStandingStatus('   ')).toThrow(/goodStandingStatus/u);
    expect(() => normalizeS33V71GoodStandingStatus(1)).toThrow(/goodStandingStatus/u);
  });

  it('records only the CTO-bound GD-1920 adjudication and leaves ambiguity unresolved', () => {
    const result = buildS33V71Surgery();
    const adjudicated = result.retainedRows.filter(({ subtypeSource }) => (
      subtypeSource === 'adjudicated'
    ));

    expect(adjudicated.map(({ id, credentialType, subType, target }) => ({
      id,
      credentialType,
      subType,
      goodStandingStatus: target.goodStandingStatus,
    }))).toEqual([{
      id: 'GD-1920',
      credentialType: 'BUSINESS_ENTITY',
      subType: 'corporation',
      goodStandingStatus: 'Good Standing',
    }]);
    expect(result.manifest.adjudications).toEqual([{
      id: 'GD-1920',
      credentialType: 'BUSINESS_ENTITY',
      subType: 'corporation',
      basis: 'groundTruth.entityType=Corporation',
      rawSourceMutated: false,
    }]);
    expect(result.unresolvedRows.find(({ id }) => id === 'GD-470')?.reason)
      .toMatch(/multiple concrete/u);
    expect(result.unresolvedRows.find(({ id }) => id === 'GD-1911')?.reason)
      .toMatch(/outside the frozen/u);
  });

  it('is byte-deterministic and binds source, dispositions, split, and artifacts', () => {
    const first = buildS33V71Surgery();
    const second = buildS33V71Surgery();

    expect(second.manifest).toEqual(first.manifest);
    expect(second.trainJsonl).toBe(first.trainJsonl);
    expect(second.validationJsonl).toBe(first.validationJsonl);
    expect(second.fraudSplitJsonl).toBe(first.fraudSplitJsonl);
    expect(Object.values(first.manifest.digests).every((digest) => SHA256.test(digest)))
      .toBe(true);
    expect(first.manifest.digests).toEqual({
      sourceOrderedIdsSha256: 'd7d41cc1a956e9d76cd60ce30f728adde80e854e31ec24df213caf4546a2fa0f',
      sourceContentCanonicalSha256: '1ee0d9a41c3f5af2e4a00bb76cb43a1cd5ec1cef2d362b8f1cb879ecfddf6e48',
      dispositionsCanonicalSha256: '96eb79575ca6747c2f97c6d92a68235ad3e6aacdd14f4b6f9206f22223cbdac6',
      retainedTargetsCanonicalSha256: '6a069b6c8eeae631f9c49bdedbbf6ba00476bc7eb519807630f53aca095e6831',
      trainJsonlSha256: 'f9581728f0656cb832afea3d1f1c1796ee3b10c9ed38ef6787f93be27fbe2303',
      validationJsonlSha256: 'a61723ff24864df7717faf1869847153870aed9d51ab200e6dc72b2d499b8d9f',
      fraudSplitJsonlSha256: '216478bca21e62229dc33e23edfc7c671712400f0f7a6feb5b39d693c1e2ca6a',
      unresolvedCanonicalSha256: '08ca3400685cb99b514eadbc21d837e3e65ae094c777e5071f22a9c5b1a281c0',
      manifestCanonicalSha256: '0b7f5dd2c504e9fb0cdd342d575d53f271c90e56d529b87d9b665b70c9fd3b0b',
    });
  });

  it('fails closed on source membership or order drift', () => {
    expect(() => buildS33V71Surgery(S33_V71_HISTORICAL_SOURCE.slice(1)))
      .toThrow(/historical source/u);
    expect(() => buildS33V71Surgery([
      S33_V71_HISTORICAL_SOURCE[1],
      S33_V71_HISTORICAL_SOURCE[0],
      ...S33_V71_HISTORICAL_SOURCE.slice(2),
    ])).toThrow(/historical source/u);
  });

  it('records the exact Vertex configuration without exposing a submit path', () => {
    const surgery = buildS33V71Surgery();
    const artifact = buildS33V71TuningRequestTemplate({
      surgery,
      trainingDatasetUri: 'gs://arkova-training-data/s33-v71/train.jsonl',
      validationDatasetUri: 'gs://arkova-training-data/s33-v71/validation.jsonl',
    });

    expect(artifact).toMatchObject({
      schemaVersion: 'arkova.s33.v71.tuning-request-template/v1',
      project: 'arkova1',
      location: 'us-central1',
      maxBudgetUsd: 40,
      submissionAuthorized: false,
      admission: 'HOLD',
      request: {
        baseModel: 'gemini-2.5-flash',
        tunedModelDisplayName: 'arkova-gemini-golden-v7-1',
        supervisedTuningSpec: {
          trainingDatasetUri: 'gs://arkova-training-data/s33-v71/train.jsonl',
          validationDatasetUri: 'gs://arkova-training-data/s33-v71/validation.jsonl',
          exportLastCheckpointOnly: true,
          hyperParameters: {
            epochCount: 6,
            adapterSize: 'ADAPTER_SIZE_FOUR',
            learningRateMultiplier: 1,
          },
        },
      },
    });
    expect(artifact.exportManifestCanonicalSha256)
      .toBe(surgery.manifest.digests.manifestCanonicalSha256);
  });

  it('writes a one-shot deterministic offline export with no submission capability', () => {
    const parent = mkdtempSync(join(tmpdir(), 'arkova-s33-v71-'));
    const outputDirectory = join(parent, 'export');
    try {
      const surgery = buildS33V71Surgery();
      const index = writeS33V71OfflineArtifacts({ surgery, outputDirectory });

      expect(index).toMatchObject({
        schemaVersion: 'arkova.s33.v71.offline-artifact-index/v1',
        submissionEligible: false,
        counts: surgery.manifest.counts,
      });
      expect(Object.keys(index.files)).toEqual([
        'manifest.json',
        'dispositions.json',
        'unresolved.json',
        'retained-targets.json',
        'train.jsonl',
        'validation.jsonl',
        'fraud-split.jsonl',
        'surgery-evidence.json',
      ]);
      expect(readFileSync(join(outputDirectory, 'train.jsonl'), 'utf8'))
        .toBe(surgery.trainJsonl);
      expect(readFileSync(join(outputDirectory, 'validation.jsonl'), 'utf8'))
        .toBe(surgery.validationJsonl);
      expect(JSON.parse(readFileSync(join(outputDirectory, 'manifest.json'), 'utf8')))
        .toEqual(surgery.manifest);
      expect(() => writeS33V71OfflineArtifacts({ surgery, outputDirectory }))
        .toThrow(/already exists/u);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
