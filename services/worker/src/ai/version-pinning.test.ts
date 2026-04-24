/**
 * GME-20: Gemini Model Version Pinning Tests
 *
 * Verifies that all model references use dated/versioned IDs (not aliases),
 * extraction manifests record exact model versions, and version metadata
 * is tracked for auditability.
 */

import { describe, it, expect } from 'vitest';
import {
  MODEL_VERSION_PINS,
  getActiveModelVersions,
  validateVersionPins,
} from './gemini-config.js';
import { buildExtractionManifest } from './extraction-manifest.js';

describe('GME-20: Model Version Pinning', () => {
  describe('MODEL_VERSION_PINS', () => {
    it('has entries for all active model roles', () => {
      expect(MODEL_VERSION_PINS).toHaveProperty('generation');
      expect(MODEL_VERSION_PINS).toHaveProperty('embedding');
      expect(MODEL_VERSION_PINS).toHaveProperty('vision');
      expect(MODEL_VERSION_PINS).toHaveProperty('distillation');
    });

    it('each pin has model ID, pinnedAt date, and verifiedAt date', () => {
      for (const [, pin] of Object.entries(MODEL_VERSION_PINS)) {
        expect(pin).toHaveProperty('modelId');
        expect(pin).toHaveProperty('pinnedAt');
        expect(pin).toHaveProperty('verifiedAt');
        expect(typeof pin.modelId).toBe('string');
        expect(pin.modelId.length).toBeGreaterThan(0);
        // Dates should be ISO format
        expect(new Date(pin.pinnedAt).toISOString()).toContain(pin.pinnedAt.slice(0, 10));
        expect(new Date(pin.verifiedAt).toISOString()).toContain(pin.verifiedAt.slice(0, 10));
      }
    });

    it('no pin uses a bare alias without version suffix', () => {
      // Aliases like "gemini-flash" or just "gemini-3-flash" without -preview/-001 etc.
      // are too vague. We need at least a version qualifier.
      for (const [role, pin] of Object.entries(MODEL_VERSION_PINS)) {
        // Must have at least one version qualifier (preview, 001, 004, etc.)
        const hasVersion = /(-\d{3}|-preview|embedding-\d+)/.test(pin.modelId);
        expect(hasVersion, `${role} model "${pin.modelId}" should have a version qualifier`).toBe(true);
      }
    });
  });

  describe('getActiveModelVersions', () => {
    it('returns all active model versions with their roles', () => {
      const versions = getActiveModelVersions();
      expect(versions).toBeInstanceOf(Array);
      expect(versions.length).toBeGreaterThanOrEqual(4);
      for (const entry of versions) {
        expect(entry).toHaveProperty('role');
        expect(entry).toHaveProperty('modelId');
        expect(entry).toHaveProperty('pinnedAt');
      }
    });

    it('deduplicates models used for multiple roles', () => {
      const versions = getActiveModelVersions();
      // generation and vision may share the same model — should still list both roles
      const roles = versions.map((v) => v.role);
      expect(new Set(roles).size).toBe(roles.length);
    });
  });

  describe('validateVersionPins', () => {
    it('returns valid when all pins match config', () => {
      const result = validateVersionPins();
      expect(result.valid).toBe(true);
      expect(result.mismatches).toHaveLength(0);
    });

    it('detects mismatch when env overrides a pin', () => {
      const original = process.env.GEMINI_MODEL;
      process.env.GEMINI_MODEL = 'some-unknown-model';
      try {
        const result = validateVersionPins();
        expect(result.valid).toBe(false);
        expect(result.mismatches.length).toBeGreaterThan(0);
        expect(result.mismatches[0]).toHaveProperty('role', 'generation');
        expect(result.mismatches[0]).toHaveProperty('expected');
        expect(result.mismatches[0]).toHaveProperty('actual', 'some-unknown-model');
      } finally {
        if (original) {
          process.env.GEMINI_MODEL = original;
        } else {
          delete process.env.GEMINI_MODEL;
        }
      }
    });
  });

  describe('Extraction manifest records pinned version', () => {
    it('manifest modelVersion matches the pinned generation model', () => {
      const { generationModel } = getActiveModelVersions().reduce(
        (acc, v) => ({ ...acc, [v.role + 'Model']: v.modelId }),
        {} as Record<string, string>,
      );

      const manifest = buildExtractionManifest({
        fingerprint: 'abc123',
        modelId: 'gemini',
        modelVersion: generationModel,
        extractedFields: { credentialType: 'DEGREE', holderName: 'Test' },
        confidenceScores: { overall: 0.9 },
      });

      expect(manifest.modelVersion).toBe(MODEL_VERSION_PINS.generation.modelId);
    });
  });
});
