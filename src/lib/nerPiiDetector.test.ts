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
  ORT_WASM_VENDOR_PATH,
  TRANSFORMERS_BROWSER_MODULE,
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

  // WEBEXT-01 F-1/F-2 (gate #13, §1.6): the vendored runtime must be a
  // SELF-CONTAINED browser bundle (no bare specifiers — F-1) and the ort WASM
  // artifacts must be pinned to a same-origin vendor path BEFORE any session
  // creation, or onnxruntime-web silently defaults `wasmPaths` to a jsdelivr
  // CDN URL the deployed CSP (connect-src 'self') blocks (F-2).
  describe('self-contained runtime + same-origin ort WASM (WEBEXT-01 F-1/F-2)', () => {
    function makeFakeModule(opts: {
      pipelineImpl: (...args: unknown[]) => Promise<unknown>;
    }) {
      const env = {
        allowRemoteModels: true,
        allowLocalModels: false,
        localModelPath: '/models/',
        backends: {
          onnx: {
            wasm: {
              numThreads: undefined as number | undefined,
              wasmPaths: undefined as string | { wasm?: string; mjs?: string } | undefined,
            },
          },
        },
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

    it('loads the runtime from a self-contained same-origin bundle path (F-1)', () => {
      // Must be app-origin-relative (script-src 'self') and must be the
      // SELF-CONTAINED bundle artifact — the plain `.web.` build carries
      // top-level bare specifiers ('onnxruntime-web/webgpu') that no browser
      // can link without an import map (the F-1 dead-on-arrival failure).
      expect(TRANSFORMERS_BROWSER_MODULE.startsWith('/vendor/')).toBe(true);
      expect(TRANSFORMERS_BROWSER_MODULE).not.toMatch(/^https?:\/\//);
      expect(TRANSFORMERS_BROWSER_MODULE).toContain('bundle');
      expect(TRANSFORMERS_BROWSER_MODULE).not.toBe('/vendor/transformers.web.min.js');
    });

    it('exposes a same-origin ort WASM vendor path (F-2)', () => {
      expect(ORT_WASM_VENDOR_PATH.startsWith('/vendor/')).toBe(true);
      expect(ORT_WASM_VENDOR_PATH.endsWith('/')).toBe(true);
      expect(ORT_WASM_VENDOR_PATH).not.toMatch(/^https?:\/\//);
      expect(ORT_WASM_VENDOR_PATH).not.toMatch(/jsdelivr|unpkg|huggingface|hf\.co|cdn/i);
    });

    it('pins ort wasmPaths to the vendor path BEFORE building the pipeline (F-2)', async () => {
      // Capture the wasmPaths value AT pipeline-build time: the pin must land
      // before session creation, not after — an unset value at this point lets
      // ort's jsdelivr default win the race and the deployed CSP kills the load.
      let wasmPathsAtBuildTime: unknown = 'NOT_CAPTURED';
      const modelFn = vi.fn(async () => []);
      const { module, env } = makeFakeModule({
        pipelineImpl: async () => {
          wasmPathsAtBuildTime = env.backends.onnx.wasm.wasmPaths;
          return modelFn;
        },
      });
      __setTransformersLoaderForTesting(async () => module);

      await detectPIIWithNER('Some text', 'wasm');

      expect(wasmPathsAtBuildTime).toBe(ORT_WASM_VENDOR_PATH);
      expect(env.backends.onnx.wasm.wasmPaths).toBe(ORT_WASM_VENDOR_PATH);
    });

    // WEBEXT-01 F-3 (found by the browser-real probe): the transformers.js
    // 4.2.0 token-classification output carries NO start/end character
    // offsets ({entity, score, index, word} only). The old merge code copied
    // `raw.start`/`raw.end` through as undefined, and redactNEREntities then
    // sliced with undefined — producing exponentially duplicated text WITH
    // ALL PII STILL PRESENT (a §1.6 leak the moment F-1/F-2 unblock NER).
    // The detector must now COMPUTE spans against the input text, and the
    // redactor must fail CLOSED when an entity cannot be located at all.
    describe('entity spans without pipeline offsets (F-3)', () => {
      /** Raw output shaped EXACTLY like the real 4.2.0 browser pipeline: no start/end. */
      const RAW_420 = (tokens: Array<[string, string, number]>) =>
        tokens.map(([entity, word, score], index) => ({ entity, word, score, index }));

      it('computes correct spans from the input text when the pipeline provides none', async () => {
        const text = 'John Smith works at Acme Corporation in Seattle';
        const modelFn = vi.fn(async () =>
          RAW_420([
            ['B-PER', 'John', 0.99],
            ['I-PER', 'Smith', 0.99],
            ['B-ORG', 'Acme', 0.98],
            ['I-ORG', 'Corporation', 0.97],
            ['B-LOC', 'Seattle', 0.99],
          ]),
        );
        const { module } = makeFakeModule({ pipelineImpl: async () => modelFn });
        __setTransformersLoaderForTesting(async () => module);

        const res = await detectPIIWithNER(text, 'wasm');
        expect(res.entityCount).toBe(3);
        const [per, org, loc] = res.entities;
        expect(per.text).toBe('John Smith');
        expect(text.slice(per.start, per.end)).toBe('John Smith');
        expect(org.text).toBe('Acme Corporation');
        expect(text.slice(org.start, org.end)).toBe('Acme Corporation');
        expect(loc.text).toBe('Seattle');
        expect(text.slice(loc.start, loc.end)).toBe('Seattle');
        // Redaction over the computed spans must remove the PII, not duplicate text.
        const redacted = redactNEREntities(text, res.entities);
        expect(redacted).toBe('[PERSON_REDACTED] works at [ORG_REDACTED] in [LOCATION_REDACTED]');
      });

      it('merges ## subword continuations and still locates the span', async () => {
        const text = 'Signed by Johanna in Reykjavik';
        const modelFn = vi.fn(async () =>
          RAW_420([
            ['B-PER', 'Joh', 0.95],
            ['I-PER', '##anna', 0.94],
            ['B-LOC', 'Rey', 0.93],
            ['I-LOC', '##kja', 0.92],
            ['I-LOC', '##vik', 0.91],
          ]),
        );
        const { module } = makeFakeModule({ pipelineImpl: async () => modelFn });
        __setTransformersLoaderForTesting(async () => module);

        const res = await detectPIIWithNER(text, 'wasm');
        expect(res.entities.map((e) => e.text)).toEqual(['Johanna', 'Reykjavik']);
        for (const e of res.entities) {
          expect(text.slice(e.start, e.end)).toBe(e.text);
        }
      });

      it('maps repeated entity text to successive occurrences (cursor advances)', async () => {
        const text = 'Bob met Bob';
        const modelFn = vi.fn(async () =>
          RAW_420([
            ['B-PER', 'Bob', 0.99],
            ['O', 'met', 0.99],
            ['B-PER', 'Bob', 0.99],
          ]),
        );
        const { module } = makeFakeModule({ pipelineImpl: async () => modelFn });
        __setTransformersLoaderForTesting(async () => module);

        const res = await detectPIIWithNER(text, 'wasm');
        expect(res.entityCount).toBe(2);
        expect(res.entities[0].start).toBe(0);
        expect(res.entities[1].start).toBe(8);
        expect(redactNEREntities(text, res.entities)).toBe('[PERSON_REDACTED] met [PERSON_REDACTED]');
      });

      it('still honors pipeline-provided offsets when they are valid', async () => {
        const text = 'Alice in Paris';
        const modelFn = vi.fn(async () => [
          { entity: 'B-PER', word: 'Alice', score: 0.99, start: 0, end: 5 },
          { entity: 'B-LOC', word: 'Paris', score: 0.99, start: 9, end: 14 },
        ]);
        const { module } = makeFakeModule({ pipelineImpl: async () => modelFn });
        __setTransformersLoaderForTesting(async () => module);

        const res = await detectPIIWithNER(text, 'wasm');
        expect(res.entities.map((e) => [e.start, e.end])).toEqual([[0, 5], [9, 14]]);
      });
    });

    describe('redactNEREntities fail-closed on unlocatable entities (F-3)', () => {
      it('falls back to literal text redaction when spans are invalid but the text is present', () => {
        const text = 'Contact Jane Roe today';
        const entities: NEREntity[] = [
          { text: 'Jane Roe', type: 'PERSON', score: 0.95, start: -1, end: -1 },
        ];
        expect(redactNEREntities(text, entities)).toBe('Contact [PERSON_REDACTED] today');
      });

      it('THROWS (fail closed) when a detected entity cannot be located at all', () => {
        const text = 'some visible text';
        const entities: NEREntity[] = [
          { text: 'Ghost Name', type: 'PERSON', score: 0.95, start: -1, end: -1 },
        ];
        expect(() => redactNEREntities(text, entities)).toThrow(/locat/i);
        // The thrown message must never contain the entity text (it IS the PII).
        try {
          redactNEREntities(text, entities);
        } catch (e) {
          expect((e as Error).message).not.toContain('Ghost Name');
        }
      });
    });

    it('fails CLOSED (typed) when the runtime exposes no ort wasm env to pin', async () => {
      // If we cannot pin wasmPaths, ort would fall back to its CDN default —
      // refuse to create a session rather than let that race the CSP.
      const pipeline = vi.fn(async () => vi.fn(async () => []));
      const module = {
        pipeline,
        env: {
          allowRemoteModels: true,
          allowLocalModels: false,
          localModelPath: '/models/',
          // no backends.onnx.wasm at all
        },
      };
      __setTransformersLoaderForTesting(async () => module);

      await expect(detectPIIWithNER('Some text', 'wasm')).rejects.toBeInstanceOf(
        NERModelLoadError,
      );
      // The session must never have been created.
      expect(pipeline).not.toHaveBeenCalled();
    });
  });

  // Review-hardening (WEBEXT-01 F-3): the adversarial code review empirically
  // reproduced wrong-span redactions that left model-detected PII in the
  // output. The invariant is asserted by STRING ABSENCE of the detected entity
  // text — not by span coordinates (which cannot see a wrong-occurrence bind).
  describe('redactNEREntities never leaves detected entity text (review-hardening)', () => {
    it('redacts every occurrence when an earlier occurrence was untagged (cursor-theft class)', () => {
      const text = 'Apple pie recipe. Apple announced earnings.';
      // Only the second "Apple" is the detected ORG (no valid span → literal path).
      const entities: NEREntity[] = [
        { text: 'Apple', type: 'ORGANIZATION', score: 0.99, start: -1, end: -1 },
      ];
      const out = redactNEREntities(text, entities);
      expect(out).not.toContain('Apple'); // neither occurrence may survive
      expect(out).toContain('[ORG_REDACTED]');
    });

    it('does not garble a longer word that merely contains the entity (substring collision)', () => {
      const text = 'Johnson & Johnson hired John.';
      const entities: NEREntity[] = [
        { text: 'John', type: 'PERSON', score: 0.99, start: -1, end: -1 },
      ];
      const out = redactNEREntities(text, entities);
      expect(out).toContain('Johnson & Johnson'); // longer word preserved
      expect(out).toContain('[PERSON_REDACTED]'); // standalone John redacted
      expect(out).not.toMatch(/\bJohn\b/); // no standalone "John" survives
    });

    it('demotes a wrong-but-structurally-valid offset to the literal path (F-3 offset trust)', () => {
      const text = 'Report for Alice Zimmer on Friday';
      // Structurally valid span [0,12] but it points at "Report for A", not the name.
      const entities: NEREntity[] = [
        { text: 'Alice Zimmer', type: 'PERSON', score: 0.95, start: 0, end: 12 },
      ];
      const out = redactNEREntities(text, entities);
      expect(out).not.toContain('Alice Zimmer'); // real name must be gone
    });

    it('fails CLOSED (typed, no PII in message) on an out-of-vocabulary entity', () => {
      const text = 'Met with Zoe Miller today';
      const entities: NEREntity[] = [
        { text: 'Miller', type: 'PERSON', score: 0.95, start: -1, end: -1, hasUnknownToken: true },
      ];
      expect(() => redactNEREntities(text, entities)).toThrow(/out-of-vocabulary|fail-closed/i);
      try {
        redactNEREntities(text, entities);
      } catch (e) {
        expect((e as Error).message).not.toContain('Miller');
      }
    });

    it('still redacts both occurrences when the same entity is legitimately tagged twice', () => {
      const text = 'Bob called Bob';
      const entities: NEREntity[] = [
        { text: 'Bob', type: 'PERSON', score: 0.99, start: 0, end: 3 },
        { text: 'Bob', type: 'PERSON', score: 0.99, start: 11, end: 14 },
      ];
      const out = redactNEREntities(text, entities);
      expect(out).not.toContain('Bob');
    });
  });
});
