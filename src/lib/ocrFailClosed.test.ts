/**
 * Tests for the §1.6 fail-closed contract (WEBEXT-03 / SCRUM-2505).
 *
 * These guard the cross-lane error contract that hard-blocks egress when the
 * on-device PII model or OCR engine fails. The recognizer must catch Lane 1's
 * `NERModelLoadError` (DEPENDS ON #1253) structurally, before that class lands
 * on main.
 */

import { describe, it, expect } from 'vitest';
import {
  PiiStripFailClosedError,
  OcrEngineLoadError,
  NerPiiFailClosedError,
  UnsupportedImageFormatError,
  isNerModelLoadError,
  isPiiStripFailClosedError,
  isUnsupportedImageFormatError,
} from './ocrFailClosed';

describe('ocrFailClosed contract', () => {
  describe('PiiStripFailClosedError', () => {
    it('is an Error with a stable name + failClosed discriminator', () => {
      const e = new PiiStripFailClosedError('boom', 'pipeline');
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(PiiStripFailClosedError);
      expect(e.name).toBe('PiiStripFailClosedError');
      expect(e.failClosed).toBe(true);
      expect(e.stage).toBe('pipeline');
      expect(e.message).toBe('boom');
    });

    it('survives instanceof after prototype reset (transpilation-safe)', () => {
      const e = new PiiStripFailClosedError('x');
      // Re-running setPrototypeOf must not break instanceof.
      expect(e instanceof PiiStripFailClosedError).toBe(true);
    });

    it('carries an optional cause', () => {
      const cause = new Error('root');
      const e = new PiiStripFailClosedError('wrap', 'ner', { cause });
      expect((e as { cause?: unknown }).cause).toBe(cause);
    });
  });

  describe('subclasses', () => {
    it('OcrEngineLoadError is a fail-closed error tagged ocr', () => {
      const e = new OcrEngineLoadError('ocr down');
      expect(e).toBeInstanceOf(PiiStripFailClosedError);
      expect(e).toBeInstanceOf(OcrEngineLoadError);
      expect(e.name).toBe('OcrEngineLoadError');
      expect(e.stage).toBe('ocr');
      expect(e.failClosed).toBe(true);
    });

    it('NerPiiFailClosedError is a fail-closed error tagged ner', () => {
      const e = new NerPiiFailClosedError('ner down');
      expect(e).toBeInstanceOf(PiiStripFailClosedError);
      expect(e).toBeInstanceOf(NerPiiFailClosedError);
      expect(e.name).toBe('NerPiiFailClosedError');
      expect(e.stage).toBe('ner');
    });
  });

  describe('isNerModelLoadError (DEPENDS ON #1253)', () => {
    it('matches an error named NERModelLoadError by name', () => {
      // Simulate Lane 1's class without importing it (not on main yet).
      const fake = Object.assign(new Error('model load failed'), { name: 'NERModelLoadError' });
      expect(isNerModelLoadError(fake)).toBe(true);
    });

    it('matches a real subclass whose constructor is NERModelLoadError', () => {
      class NERModelLoadError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = 'NERModelLoadError';
          Object.setPrototypeOf(this, NERModelLoadError.prototype);
        }
      }
      expect(isNerModelLoadError(new NERModelLoadError('nope'))).toBe(true);
    });

    it('does not match arbitrary errors', () => {
      expect(isNerModelLoadError(new Error('generic'))).toBe(false);
      expect(isNerModelLoadError(new TypeError('Failed to fetch'))).toBe(false);
      expect(isNerModelLoadError(null)).toBe(false);
      expect(isNerModelLoadError('NERModelLoadError')).toBe(false);
      expect(isNerModelLoadError(undefined)).toBe(false);
    });
  });

  describe('isPiiStripFailClosedError (the egress gate)', () => {
    it('returns true for every fail-closed subclass', () => {
      expect(isPiiStripFailClosedError(new PiiStripFailClosedError('x'))).toBe(true);
      expect(isPiiStripFailClosedError(new OcrEngineLoadError('x'))).toBe(true);
      expect(isPiiStripFailClosedError(new NerPiiFailClosedError('x'))).toBe(true);
    });

    it('returns true for Lane 1 NERModelLoadError by name (cross-bundle)', () => {
      const fake = Object.assign(new Error('model load failed'), { name: 'NERModelLoadError' });
      expect(isPiiStripFailClosedError(fake)).toBe(true);
    });

    it('returns true for a duck-typed failClosed object (cross-bundle instanceof miss)', () => {
      // Simulates the same class loaded from a different module instance.
      const crossBundle = Object.assign(new Error('x'), { failClosed: true, name: 'OcrEngineLoadError' });
      expect(isPiiStripFailClosedError(crossBundle)).toBe(true);
    });

    it('returns false for ordinary/non-fatal errors', () => {
      expect(isPiiStripFailClosedError(new Error('No text found in document'))).toBe(false);
      expect(isPiiStripFailClosedError(new TypeError('Failed to fetch'))).toBe(false);
      expect(isPiiStripFailClosedError({ message: 'whatever' })).toBe(false);
      expect(isPiiStripFailClosedError(null)).toBe(false);
    });

    // SCRUM-2911 sub-item 1: an unsupported image format (.heic / .tiff) is a
    // BENIGN "we can't read this format" case — the document was never at risk.
    // It must NOT be treated as a §1.6 privacy fail-closed error, or the UI
    // shows the FALSE privacy-failure screen.
    it('returns false for an UnsupportedImageFormatError (benign, not a privacy breach)', () => {
      expect(
        isPiiStripFailClosedError(new UnsupportedImageFormatError('cannot read heic', 'image/heic')),
      ).toBe(false);
    });
  });

  // SCRUM-2911 sub-item 1: the benign unsupported-format contract.
  describe('UnsupportedImageFormatError (SCRUM-2911 — benign soft-fail)', () => {
    it('is a plain Error, NOT a fail-closed error', () => {
      const e = new UnsupportedImageFormatError('cannot read tiff', 'image/tiff');
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(UnsupportedImageFormatError);
      expect(e).not.toBeInstanceOf(PiiStripFailClosedError);
      expect(e.name).toBe('UnsupportedImageFormatError');
      expect(e.formatLabel).toBe('image/tiff');
      // Must not carry the fail-closed discriminator.
      expect((e as { failClosed?: unknown }).failClosed).toBeUndefined();
    });

    it('isUnsupportedImageFormatError matches the class and duck-typed copies', () => {
      expect(
        isUnsupportedImageFormatError(new UnsupportedImageFormatError('x', 'image/heic')),
      ).toBe(true);
      // Cross-bundle instanceof miss — match by name/discriminator.
      const crossBundle = Object.assign(new Error('x'), {
        name: 'UnsupportedImageFormatError',
        unsupportedFormat: true,
      });
      expect(isUnsupportedImageFormatError(crossBundle)).toBe(true);
    });

    it('isUnsupportedImageFormatError does not match fail-closed or ordinary errors', () => {
      expect(isUnsupportedImageFormatError(new OcrEngineLoadError('engine down'))).toBe(false);
      expect(isUnsupportedImageFormatError(new Error('generic'))).toBe(false);
      expect(isUnsupportedImageFormatError(null)).toBe(false);
      expect(isUnsupportedImageFormatError('UnsupportedImageFormatError')).toBe(false);
    });
  });
});
