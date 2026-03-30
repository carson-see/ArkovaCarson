/**
 * VAI-01: Extraction Manifest Tests (TDD)
 *
 * Tests for cryptographic binding of AI extraction output to source document hash.
 * Manifest = {source_hash, model_id, model_version, extraction_timestamp, extracted_fields, confidence_scores}
 */
import { describe, it, expect } from 'vitest';
import {
  buildExtractionManifest,
  computeManifestHash,
  type ExtractionManifestInput,
} from './extraction-manifest.js';

const SAMPLE_INPUT: ExtractionManifestInput = {
  fingerprint: 'a'.repeat(64),
  modelId: 'gemini',
  modelVersion: 'gemini-2.5-flash',
  extractedFields: {
    credentialType: 'DEGREE',
    issuerName: 'MIT',
    issuedDate: '2024-06-15',
    fieldOfStudy: 'Computer Science',
    degreeLevel: 'Bachelor',
  },
  confidenceScores: {
    overall: 0.87,
    grounding: 0.92,
    fields: {
      issuerName: 0.95,
      issuedDate: 0.88,
      fieldOfStudy: 0.79,
    },
  },
  promptVersion: 'abc123def456',
  extractionTimestamp: new Date('2026-03-29T12:00:00Z'),
};

describe('extraction-manifest', () => {
  describe('buildExtractionManifest', () => {
    it('builds a manifest with all required fields', () => {
      const manifest = buildExtractionManifest(SAMPLE_INPUT);

      expect(manifest.fingerprint).toBe('a'.repeat(64));
      expect(manifest.modelId).toBe('gemini');
      expect(manifest.modelVersion).toBe('gemini-2.5-flash');
      expect(manifest.extractedFields).toEqual(SAMPLE_INPUT.extractedFields);
      expect(manifest.confidenceScores).toEqual(SAMPLE_INPUT.confidenceScores);
      expect(manifest.promptVersion).toBe('abc123def456');
      expect(manifest.extractionTimestamp).toBe('2026-03-29T12:00:00.000Z');
      expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces deterministic hashes for identical inputs', () => {
      const m1 = buildExtractionManifest(SAMPLE_INPUT);
      const m2 = buildExtractionManifest(SAMPLE_INPUT);
      expect(m1.manifestHash).toBe(m2.manifestHash);
    });

    it('produces different hashes for different fingerprints', () => {
      const m1 = buildExtractionManifest(SAMPLE_INPUT);
      const m2 = buildExtractionManifest({
        ...SAMPLE_INPUT,
        fingerprint: 'b'.repeat(64),
      });
      expect(m1.manifestHash).not.toBe(m2.manifestHash);
    });

    it('produces different hashes for different model versions', () => {
      const m1 = buildExtractionManifest(SAMPLE_INPUT);
      const m2 = buildExtractionManifest({
        ...SAMPLE_INPUT,
        modelVersion: 'gemini-2.0-pro',
      });
      expect(m1.manifestHash).not.toBe(m2.manifestHash);
    });

    it('produces different hashes for different extracted fields', () => {
      const m1 = buildExtractionManifest(SAMPLE_INPUT);
      const m2 = buildExtractionManifest({
        ...SAMPLE_INPUT,
        extractedFields: {
          ...SAMPLE_INPUT.extractedFields,
          issuerName: 'Harvard',
        },
      });
      expect(m1.manifestHash).not.toBe(m2.manifestHash);
    });

    it('produces different hashes for different confidence scores', () => {
      const m1 = buildExtractionManifest(SAMPLE_INPUT);
      const m2 = buildExtractionManifest({
        ...SAMPLE_INPUT,
        confidenceScores: {
          ...SAMPLE_INPUT.confidenceScores,
          overall: 0.5,
        },
      });
      expect(m1.manifestHash).not.toBe(m2.manifestHash);
    });

    it('uses current timestamp when extractionTimestamp not provided', () => {
      const input = { ...SAMPLE_INPUT };
      delete (input as Partial<ExtractionManifestInput>).extractionTimestamp;
      const manifest = buildExtractionManifest(input as ExtractionManifestInput);
      // Should have a valid ISO timestamp
      expect(new Date(manifest.extractionTimestamp).getTime()).not.toBeNaN();
    });

    it('handles Nessie provider manifests', () => {
      const nessieInput: ExtractionManifestInput = {
        ...SAMPLE_INPUT,
        modelId: 'nessie',
        modelVersion: 'nessie-v2',
      };
      const manifest = buildExtractionManifest(nessieInput);
      expect(manifest.modelId).toBe('nessie');
      expect(manifest.modelVersion).toBe('nessie-v2');
      expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('handles empty extracted fields', () => {
      const manifest = buildExtractionManifest({
        ...SAMPLE_INPUT,
        extractedFields: {},
      });
      expect(manifest.extractedFields).toEqual({});
      expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('handles fraudSignals in extracted fields', () => {
      const manifest = buildExtractionManifest({
        ...SAMPLE_INPUT,
        extractedFields: {
          ...SAMPLE_INPUT.extractedFields,
          fraudSignals: ['date_inconsistency', 'suspicious_issuer'],
        },
      });
      expect(manifest.extractedFields.fraudSignals).toEqual([
        'date_inconsistency',
        'suspicious_issuer',
      ]);
      expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('computeManifestHash', () => {
    it('returns 64-char hex SHA-256 hash', () => {
      const hash = computeManifestHash({
        fingerprint: 'a'.repeat(64),
        modelId: 'gemini',
        modelVersion: 'gemini-2.5-flash',
        extractedFields: { credentialType: 'DEGREE' },
        confidenceScores: { overall: 0.87 },
        extractionTimestamp: '2026-03-29T12:00:00.000Z',
      });
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is order-independent for object keys (canonical JSON)', () => {
      const hash1 = computeManifestHash({
        fingerprint: 'a'.repeat(64),
        modelId: 'gemini',
        modelVersion: 'v1',
        extractedFields: { a: '1', b: '2' },
        confidenceScores: { overall: 0.5 },
        extractionTimestamp: '2026-03-29T12:00:00.000Z',
      });
      const hash2 = computeManifestHash({
        modelVersion: 'v1',
        fingerprint: 'a'.repeat(64),
        extractedFields: { b: '2', a: '1' },
        confidenceScores: { overall: 0.5 },
        modelId: 'gemini',
        extractionTimestamp: '2026-03-29T12:00:00.000Z',
      });
      expect(hash1).toBe(hash2);
    });

    it('excludes undefined values from hash computation', () => {
      const hash1 = computeManifestHash({
        fingerprint: 'a'.repeat(64),
        modelId: 'gemini',
        modelVersion: 'v1',
        extractedFields: { credentialType: 'DEGREE' },
        confidenceScores: { overall: 0.87 },
        extractionTimestamp: '2026-03-29T12:00:00.000Z',
      });
      const hash2 = computeManifestHash({
        fingerprint: 'a'.repeat(64),
        modelId: 'gemini',
        modelVersion: 'v1',
        extractedFields: { credentialType: 'DEGREE', issuerName: undefined },
        confidenceScores: { overall: 0.87 },
        extractionTimestamp: '2026-03-29T12:00:00.000Z',
      });
      // JSON.stringify drops undefined values, so these should be equal
      expect(hash1).toBe(hash2);
    });
  });
});
