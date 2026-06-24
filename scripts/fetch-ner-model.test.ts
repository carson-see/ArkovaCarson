/**
 * Tests for the self-hosted NER model vendoring + INTEGRITY check.
 *
 * S1.4 + S1.4b / WEBEXT-CSP (SCRUM-2503). The build-time fetch
 * (scripts/fetch-ner-model.ts) must:
 *   - pin the model to a 40-char commit SHA (never floating `main`),
 *   - verify each downloaded file's SHA-256 + byte length against the committed
 *     lockfile (scripts/ner-weights.lock.json), and
 *   - treat any mismatch / missing REQUIRED file as fatal (build fails closed),
 * so a tampered or wrong weight blob can NEVER silently become the on-device
 * PII model (a §1.6 fail-OPEN). Runtime serves the weights same-origin under
 * CSP 'self'; these tests need NO network.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readLock,
  verifyBuffer,
  srcUrl,
  destPath,
  LOCKFILE_PATH,
  type LockedFile,
  type WeightsLock,
} from './fetch-ner-model';
import { NER_MODEL_ID, NER_MODEL_REVISION } from '../src/lib/nerPiiDetector';

function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

const tmpDirs: string[] = [];
async function makeTmpLock(lock: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ner-lock-'));
  tmpDirs.push(dir);
  const path = join(dir, 'lock.json');
  await writeFile(path, JSON.stringify(lock));
  return path;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

describe('fetch-ner-model integrity (SCRUM-2503 / S1.4b)', () => {
  describe('verifyBuffer — the SHA-256 + length gate', () => {
    const payload = Buffer.from('the on-device PII model weights');
    const locked: LockedFile = {
      sha256: sha256(payload),
      bytes: payload.byteLength,
      required: true,
    };

    it('passes (returns null) when hash AND byte length match the lock', () => {
      expect(verifyBuffer('onnx/model_quantized.onnx', locked, payload)).toBeNull();
    });

    it('FAILS when the SHA-256 does not match (tampered weights)', () => {
      const tampered = Buffer.from('the on-device PII model weightX'); // same length, 1 byte off
      expect(tampered.byteLength).toBe(payload.byteLength);
      const err = verifyBuffer('onnx/model_quantized.onnx', locked, tampered);
      expect(err).not.toBeNull();
      expect(err).toMatch(/SHA-256/);
    });

    it('FAILS when the byte length does not match (truncated/padded blob)', () => {
      const truncated = payload.subarray(0, payload.byteLength - 1);
      const err = verifyBuffer('onnx/model_quantized.onnx', locked, truncated);
      expect(err).not.toBeNull();
      expect(err).toMatch(/byte length/);
    });
  });

  describe('readLock — pinned-revision enforcement', () => {
    it('rejects a floating revision like `main` (no silent re-publish window)', async () => {
      const path = await makeTmpLock({
        modelId: 'Xenova/bert-base-NER',
        revision: 'main',
        dtype: 'q8',
        files: { 'config.json': { sha256: 'x'.repeat(64), bytes: 1, required: true } },
      });
      await expect(readLock(path)).rejects.toThrow(/pinned 40-char commit SHA|main/i);
    });

    it('rejects a malformed lock (missing files)', async () => {
      const path = await makeTmpLock({ modelId: 'm', revision: 'a'.repeat(40) });
      await expect(readLock(path)).rejects.toThrow(/Malformed|files/i);
    });

    it('accepts a well-formed pinned lock', async () => {
      const lock: WeightsLock = {
        modelId: 'Xenova/bert-base-NER',
        revision: 'a'.repeat(40),
        dtype: 'q8',
        files: { 'config.json': { sha256: 'x'.repeat(64), bytes: 1, required: true } },
      };
      const path = await makeTmpLock(lock);
      await expect(readLock(path)).resolves.toMatchObject({ revision: 'a'.repeat(40) });
    });
  });

  describe('srcUrl / destPath — build fetch is pinned + remote, runtime is self-origin', () => {
    const lock: WeightsLock = {
      modelId: 'Xenova/bert-base-NER',
      revision: NER_MODEL_REVISION,
      dtype: 'q8',
      files: {},
    };

    it('build-time URL targets the PINNED revision on the HF host (allowed at build only)', () => {
      const url = srcUrl(lock, 'onnx/model_quantized.onnx');
      expect(url).toBe(
        `https://huggingface.co/Xenova/bert-base-NER/resolve/${NER_MODEL_REVISION}/onnx/model_quantized.onnx`,
      );
      // Must carry the pinned SHA, never a floating ref.
      expect(url).toContain(NER_MODEL_REVISION);
      expect(url).not.toMatch(/\/resolve\/main\//);
    });

    it('destination is Arkova-origin public/models/<modelId>/… (served under CSP self, no CDN host)', () => {
      const dest = destPath(lock, 'onnx/model_quantized.onnx');
      expect(dest).toMatch(/\/public\/models\/Xenova\/bert-base-NER\/onnx\/model_quantized\.onnx$/);
      expect(dest).not.toMatch(/^https?:/);
      expect(dest).not.toMatch(/huggingface/i);
    });
  });

  describe('committed lockfile ↔ detector constants are in sync', () => {
    it('the real lockfile pins the same model + a 40-char SHA the loader uses', async () => {
      const lock = await readLock(LOCKFILE_PATH);
      expect(lock.modelId).toBe(NER_MODEL_ID);
      expect(lock.revision).toBe(NER_MODEL_REVISION);
      expect(lock.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(lock.dtype).toBe('q8');
    });

    it('every locked hash is a real 64-char SHA-256, not a placeholder', async () => {
      const lock = await readLock(LOCKFILE_PATH);
      const entries = Object.entries(lock.files);
      expect(entries.length).toBeGreaterThan(0);
      for (const [file, f] of entries) {
        expect(f.sha256, file).toMatch(/^[0-9a-f]{64}$/);
        // Reject obvious placeholders (all-zero / repeated single char).
        expect(f.sha256, file).not.toMatch(/^0{64}$/);
        expect(f.sha256, file).not.toMatch(/^(.)\1{63}$/);
        expect(f.bytes, file).toBeGreaterThan(0);
      }
    });

    it('locks the exact file set transformers.js v4.2.0 requests for q8 (incl. the quantized onnx)', async () => {
      const lock = await readLock(LOCKFILE_PATH);
      const files = Object.keys(lock.files);
      // transformers.js v4.2.0 token-classification + q8 requests these:
      for (const required of [
        'config.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'onnx/model_quantized.onnx',
      ]) {
        expect(files, required).toContain(required);
        expect(lock.files[required].required, required).toBe(true);
      }
      // q8 maps to the *_quantized onnx — never an unquantized blob.
      expect(files).toContain('onnx/model_quantized.onnx');
    });
  });
});
