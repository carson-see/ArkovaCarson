/**
 * NER PII Detector Tests (Phase 4)
 *
 * Tests entity merging, redaction, and pipeline behavior.
 * Mocks @huggingface/transformers since we can't load models in CI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  redactNEREntities,
  detectPIIWithNER,
  disposeNERPipeline,
  NERModelLoadError,
  NER_LOCAL_MODEL_PATH,
  __setTransformersLoaderForTesting,
  __resetTransformersLoaderForTesting,
  type NEREntity,
} from './nerPiiDetector';

// We test the exported pure functions directly.
// detectPIIWithNER requires the actual model, so we test its integration
// through the enhanced stripper tests with mocks.

describe('nerPiiDetector', () => {
  describe('redactNEREntities', () => {
    it('redacts PERSON entities', () => {
      const text = 'John Smith received a degree from MIT';
      const entities: NEREntity[] = [
        { text: 'John Smith', type: 'PERSON', score: 0.95, start: 0, end: 10 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('[PERSON_REDACTED] received a degree from MIT');
    });

    it('redacts LOCATION entities', () => {
      const text = 'Licensed in New York State';
      const entities: NEREntity[] = [
        { text: 'New York State', type: 'LOCATION', score: 0.92, start: 12, end: 26 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('Licensed in [LOCATION_REDACTED]');
    });

    it('redacts ORGANIZATION entities', () => {
      const text = 'Issued by Harvard University on 2025-01-15';
      const entities: NEREntity[] = [
        { text: 'Harvard University', type: 'ORGANIZATION', score: 0.98, start: 10, end: 28 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('Issued by [ORG_REDACTED] on 2025-01-15');
    });

    it('redacts MISC entities', () => {
      const text = 'The HIPAA regulation requires compliance';
      const entities: NEREntity[] = [
        { text: 'HIPAA', type: 'MISC', score: 0.85, start: 4, end: 9 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('The [ENTITY_REDACTED] regulation requires compliance');
    });

    it('handles multiple entities in correct order', () => {
      const text = 'Jane Doe works at Google in California';
      const entities: NEREntity[] = [
        { text: 'Jane Doe', type: 'PERSON', score: 0.95, start: 0, end: 8 },
        { text: 'Google', type: 'ORGANIZATION', score: 0.97, start: 18, end: 24 },
        { text: 'California', type: 'LOCATION', score: 0.93, start: 28, end: 38 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('[PERSON_REDACTED] works at [ORG_REDACTED] in [LOCATION_REDACTED]');
    });

    it('handles empty entity list', () => {
      const text = 'No entities here';
      const result = redactNEREntities(text, []);
      expect(result).toBe('No entities here');
    });

    it('handles adjacent entities', () => {
      const text = 'JohnDoe';
      const entities: NEREntity[] = [
        { text: 'John', type: 'PERSON', score: 0.9, start: 0, end: 4 },
        { text: 'Doe', type: 'PERSON', score: 0.85, start: 4, end: 7 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('[PERSON_REDACTED][PERSON_REDACTED]');
    });

    it('preserves text between entities', () => {
      const text = 'From: Alice To: Bob Subject: Report';
      const entities: NEREntity[] = [
        { text: 'Alice', type: 'PERSON', score: 0.9, start: 6, end: 11 },
        { text: 'Bob', type: 'PERSON', score: 0.88, start: 16, end: 19 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('From: [PERSON_REDACTED] To: [PERSON_REDACTED] Subject: Report');
    });
  });

  // S1.4 / WEBEXT-CSP (SCRUM-2503): the model loader must self-host from an
  // Arkova app-origin path (covered by `connect-src 'self'`), never the HF CDN,
  // and must FAIL LOUD when the self-hosted model can't load so Lane 2's
  // fail-closed stripper (WEBEXT-03) can catch it. §1.6 must hold fail-CLOSED.
  describe('self-hosted model loading (SCRUM-2503)', () => {
    /** Build a fake transformers.js module whose `env` we can assert against. */
    function makeFakeModule(opts: {
      pipelineImpl: (...args: unknown[]) => Promise<unknown>;
    }) {
      const env = {
        allowRemoteModels: true, // intentionally the unsafe default; loader must flip it
        allowLocalModels: false, // intentionally off; loader must turn it ON
        localModelPath: '/models/', // library default; loader should set explicitly
        remoteHost: 'https://huggingface.co',
        backends: { onnx: { wasm: { numThreads: undefined as number | undefined } } },
      };
      const pipeline = vi.fn(opts.pipelineImpl);
      return { module: { pipeline, env }, env, pipeline };
    }

    beforeEach(async () => {
      await disposeNERPipeline();
      __resetTransformersLoaderForTesting();
    });

    afterEach(async () => {
      await disposeNERPipeline();
      __resetTransformersLoaderForTesting();
    });

    it('exposes a local-origin model path served from self', () => {
      // Path must be app-origin-relative so it resolves to `'self'` and is
      // covered by the existing `connect-src 'self'` CSP — no CDN host.
      expect(NER_LOCAL_MODEL_PATH).toBe('/models/');
      expect(NER_LOCAL_MODEL_PATH.startsWith('/')).toBe(true);
      expect(NER_LOCAL_MODEL_PATH).not.toMatch(/^https?:\/\//);
      expect(NER_LOCAL_MODEL_PATH).not.toMatch(/huggingface|hf\.co|cdn/i);
    });

    it('disables remote models and pins the local path before loading', async () => {
      // A successful pipeline build resolves to a callable model fn.
      const modelFn = vi.fn(async () => []);
      const { module, env, pipeline } = makeFakeModule({
        pipelineImpl: async () => modelFn,
      });
      __setTransformersLoaderForTesting(async () => module);

      await detectPIIWithNER('Some text', 'wasm');

      // §1.6: remote fetch from the HF CDN must be turned OFF.
      expect(env.allowRemoteModels).toBe(false);
      // Local-origin loading must be explicitly ON (pinned, not trusted as a default).
      expect(env.allowLocalModels).toBe(true);
      // Model is pinned to the self-hosted app-origin path.
      expect(env.localModelPath).toBe(NER_LOCAL_MODEL_PATH);
      // Pipeline was actually invoked for the NER model.
      expect(pipeline).toHaveBeenCalledTimes(1);
      const [task, modelId] = pipeline.mock.calls[0];
      expect(task).toBe('token-classification');
      expect(modelId).toBe('Xenova/bert-base-NER');
    });

    it('throws a typed NERModelLoadError when the local model is missing', async () => {
      // transformers.js throws when local_files_only and the model file is absent.
      const { module } = makeFakeModule({
        pipelineImpl: async () => {
          throw new Error(
            'Could not locate file: "/models/Xenova/bert-base-NER/onnx/model_quantized.onnx"',
          );
        },
      });
      __setTransformersLoaderForTesting(async () => module);

      await expect(detectPIIWithNER('Some text', 'wasm')).rejects.toBeInstanceOf(
        NERModelLoadError,
      );
    });

    it('NERModelLoadError carries a clear, actionable message + cause', async () => {
      const underlying = new Error('Could not locate file: model_quantized.onnx');
      const { module } = makeFakeModule({
        pipelineImpl: async () => {
          throw underlying;
        },
      });
      __setTransformersLoaderForTesting(async () => module);

      let caught: unknown;
      try {
        await detectPIIWithNER('Some text', 'wasm');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(NERModelLoadError);
      const err = caught as NERModelLoadError;
      expect(err.name).toBe('NERModelLoadError');
      expect(err.message).toMatch(/self-hosted|local|\/models\//i);
      // Original error preserved for diagnosis (Error.cause).
      expect(err.cause).toBe(underlying);
    });

    it('does NOT silently return null on load failure', async () => {
      const { module } = makeFakeModule({
        pipelineImpl: async () => {
          throw new Error('load failed');
        },
      });
      __setTransformersLoaderForTesting(async () => module);

      const result = await detectPIIWithNER('Some text', 'wasm').catch((e) => e);
      // Must be a thrown error, never a falsy/null silent result.
      expect(result).toBeInstanceOf(Error);
      expect(result).not.toBeNull();
    });

    it('throws NERModelLoadError if the module loader itself fails (vendor bundle blocked)', async () => {
      __setTransformersLoaderForTesting(async () => {
        throw new Error('Failed to fetch dynamically imported module: /vendor/transformers.web.min.js');
      });

      await expect(detectPIIWithNER('Some text', 'wasm')).rejects.toBeInstanceOf(
        NERModelLoadError,
      );
    });

    it('maps a CONCURRENT first-load failure to NERModelLoadError for ALL racing callers', async () => {
      // Two PII-strip calls race the single initial model load, which fails.
      // BOTH must reject with the TYPED error: a racing caller receiving a raw
      // error would slip past WEBEXT-03's `instanceof NERModelLoadError` check
      // and fall back to regex (a §1.6 fail-OPEN under a race). The gated loader
      // makes the shared-promise path deterministic.
      let failLoad: (e: Error) => void = () => {};
      const gate = new Promise<never>((_resolve, reject) => {
        failLoad = reject;
      });
      __setTransformersLoaderForTesting(() => gate);

      const p1 = detectPIIWithNER('text one', 'wasm');
      const p2 = detectPIIWithNER('text two', 'wasm');
      await Promise.resolve(); // let both callers reach the shared _pipelinePromise
      failLoad(new Error('transient bundle fetch error'));

      const [a, b] = await Promise.allSettled([p1, p2]);
      expect(a.status).toBe('rejected');
      expect(b.status).toBe('rejected');
      expect((a as PromiseRejectedResult).reason).toBeInstanceOf(NERModelLoadError);
      expect((b as PromiseRejectedResult).reason).toBeInstanceOf(NERModelLoadError);
    });

    it('does not cache a failed load — a later success can still load', async () => {
      // First attempt fails (e.g. transient bundle fetch error).
      __setTransformersLoaderForTesting(async () => {
        throw new Error('transient network error');
      });
      await expect(detectPIIWithNER('Some text', 'wasm')).rejects.toBeInstanceOf(
        NERModelLoadError,
      );

      // Second attempt: loader now resolves. The earlier rejected promise must
      // NOT be cached (otherwise every later call rejects forever).
      const modelFn = vi.fn(async () => []);
      const { module } = makeFakeModule({ pipelineImpl: async () => modelFn });
      __setTransformersLoaderForTesting(async () => module);

      const res = await detectPIIWithNER('Some text', 'wasm');
      expect(res.entityCount).toBe(0);
      expect(res.backend).toBe('wasm');
    });
  });
});
