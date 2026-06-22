/**
 * NER-based PII Detector (Phase 4)
 *
 * CLIENT-SIDE ONLY — uses Transformers.js to run a pre-trained NER model
 * in the browser for PII detection, augmenting the regex-based stripper.
 *
 * Constitution 1.6: All inference runs client-side via WebGPU/WASM.
 * Constitution 4A: PII must be stripped before any data leaves the browser.
 *
 * Architecture:
 * 1. Load NER model (Xenova/bert-base-NER) on first use, cache in browser
 * 2. Run NER to detect PERSON, LOCATION, ORGANIZATION entities
 * 3. Merge NER detections with regex patterns for comprehensive PII stripping
 * 4. Regex handles structured patterns (SSN, email, phone, DOB, IDs)
 * 5. NER handles unstructured names, locations, org references
 *
 * Self-hosting (S1.4 / WEBEXT-CSP / SCRUM-2503):
 * The model weights are loaded from an Arkova app-origin path (`/models/`,
 * served from `public/models/` → covered by `connect-src 'self'`), NOT the
 * HuggingFace CDN. We set `env.allowRemoteModels = false` so transformers.js
 * never reaches out to the HF CDN — that fetch is blocked by the production
 * CSP and previously caused a SILENT regex fallback (a §1.6 fail-OPEN).
 * If the self-hosted model cannot be loaded, the loader throws a typed
 * `NERModelLoadError` (it never silently returns null), so the fail-CLOSED
 * stripper (WEBEXT-03) can catch it and refuse to let unstripped text leave
 * the browser. Vendor the weights with `scripts/fetch-ner-model.ts` (ops step;
 * the binaries are git-ignored, never committed).
 */

import type { MLBackend } from './mlRuntime';

/** NER entity types relevant to PII */
export type PIIEntityType = 'PERSON' | 'LOCATION' | 'ORGANIZATION' | 'MISC';

/** A single NER-detected entity */
export interface NEREntity {
  /** The entity text */
  text: string;
  /** Entity type */
  type: PIIEntityType;
  /** Confidence score (0-1) */
  score: number;
  /** Start character offset in the original text */
  start: number;
  /** End character offset in the original text */
  end: number;
}

/** Result from NER-based PII detection */
export interface NERPIIResult {
  /** Entities detected by NER */
  entities: NEREntity[];
  /** PII categories found */
  piiCategories: string[];
  /** Total entities detected */
  entityCount: number;
  /** Model load time in ms */
  modelLoadTimeMs: number;
  /** Inference time in ms */
  inferenceTimeMs: number;
  /** Backend used (webgpu, wasm, cpu) */
  backend: MLBackend;
}

/** Progress callback for model loading and inference */
export interface NERProgress {
  stage: 'loading' | 'inference' | 'complete' | 'error';
  progress: number; // 0-100
  message?: string;
}

// Model configuration
const NER_MODEL_ID = 'Xenova/bert-base-NER';
const NER_CONFIDENCE_THRESHOLD = 0.7;
const MAX_TEXT_LENGTH = 15_000; // Limit input to avoid OOM
const TRANSFORMERS_BROWSER_MODULE = '/vendor/transformers.web.min.js';

/**
 * App-origin path the NER model weights are served from.
 *
 * Files live in `public/models/<repo>/...` and Vite serves `public/` at the
 * site root, so this resolves to a same-origin URL — covered by the existing
 * `connect-src 'self'` CSP. Must stay a leading-slash, app-relative path
 * (never an absolute HTTP(S) URL / CDN host) so §1.6 self-hosting holds.
 *
 * NOTE: transformers.js itself defaults `localModelPath` to `/models/`; we set
 * it explicitly so the contract is enforced in code (and tested) rather than
 * relying on a library default that a future upgrade could change.
 */
export const NER_LOCAL_MODEL_PATH = '/models/';

/**
 * Thrown when the self-hosted NER model cannot be loaded — e.g. the weights are
 * missing under `public/models/`, the vendored runtime bundle fails to load, or
 * `pipeline(...)` rejects/returns nothing.
 *
 * This is intentionally a distinct, typed error so the fail-closed PII stripper
 * (Lane 2 / WEBEXT-03, enhancedPiiStripper.ts) can `instanceof`-detect a model
 * load failure and refuse to release text, rather than the loader silently
 * returning null and falling back to regex-only stripping (a §1.6 fail-OPEN).
 */
export class NERModelLoadError extends Error {
  /**
   * The underlying error that caused the load to fail (transformers.js error,
   * bundle fetch failure, etc.). Declared explicitly rather than via the
   * ES2022 `Error.cause` option because the project targets ES2020/lib ES2021.
   */
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'NERModelLoadError';
    this.cause = options?.cause;
    // Maintain prototype chain for `instanceof` after TS downlevel.
    Object.setPrototypeOf(this, NERModelLoadError.prototype);
  }
}

interface TransformersJsEnv {
  /** When false, transformers.js never fetches from the remote (HF CDN) host. */
  allowRemoteModels: boolean;
  /** When true, transformers.js may load model files from the local origin. Pinned explicitly. */
  allowLocalModels: boolean;
  /** App-origin path local model weights are loaded from (e.g. `/models/`). */
  localModelPath: string;
  backends?: {
    onnx?: {
      wasm?: {
        numThreads?: number;
      };
    };
  };
}

interface TransformersJsModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipeline: (...args: any[]) => Promise<unknown>;
  env: TransformersJsEnv;
}

/**
 * Module-loader seam. Production loads the vendored browser bundle from the app
 * origin via a dynamic import; tests override this so no network/bundle access
 * is needed. Kept overridable rather than `vi.mock`-ed because the bundle is
 * imported by absolute URL string, which the mocker can't intercept.
 */
type TransformersLoader = () => Promise<TransformersJsModule>;

const defaultTransformersLoader: TransformersLoader = async () =>
  // Keep the large, on-demand NER runtime out of the homepage bundle.
  // Vite serves `public/` files at the site root in both dev and prod.
  (await import(/* @vite-ignore */ TRANSFORMERS_BROWSER_MODULE)) as TransformersJsModule;

let _transformersLoader: TransformersLoader = defaultTransformersLoader;

/** TEST-ONLY: inject a fake transformers.js module loader. */
export function __setTransformersLoaderForTesting(loader: TransformersLoader): void {
  _transformersLoader = loader;
}

/** TEST-ONLY: restore the real dynamic-import loader. */
export function __resetTransformersLoaderForTesting(): void {
  _transformersLoader = defaultTransformersLoader;
}

// Singleton pipeline — loaded once, reused across calls
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipeline: any = null;
let _pipelinePromise: Promise<{ pipeline: unknown; loadTimeMs: number }> | null = null;
let _loadTimeMs = 0;

/**
 * Map NER label to our PII entity type.
 * Standard NER labels: B-PER, I-PER, B-LOC, I-LOC, B-ORG, I-ORG, B-MISC, I-MISC, O
 */
function mapNERLabel(label: string): PIIEntityType | null {
  const normalized = label.replace(/^[BI]-/, '');
  switch (normalized) {
    case 'PER': return 'PERSON';
    case 'LOC': return 'LOCATION';
    case 'ORG': return 'ORGANIZATION';
    case 'MISC': return 'MISC';
    default: return null;
  }
}

/**
 * Get or load the NER pipeline. Loads model on first call, caches for reuse.
 */
async function getNERPipeline(
  backend: MLBackend,
  onProgress?: (progress: NERProgress) => void,
): Promise<{ pipeline: unknown; loadTimeMs: number }> {
  if (_pipeline) {
    return { pipeline: _pipeline, loadTimeMs: _loadTimeMs };
  }

  if (_pipelinePromise) {
    // Concurrent first-load: return the SAME promise so every racing caller gets
    // the SAME typed result/error. The rejection→NERModelLoadError mapping lives
    // INSIDE the promise below (not on one privileged call site), so a racing
    // caller can't receive a raw, untyped error that slips past WEBEXT-03's
    // `instanceof NERModelLoadError` fail-closed check (a §1.6 fail-OPEN under a race).
    return _pipelinePromise;
  }

  const start = Date.now();
  onProgress?.({ stage: 'loading', progress: 0, message: 'Loading NER model...' });

  _pipelinePromise = (async () => {
    try {
      const { pipeline, env } = await _transformersLoader();

      // §1.6 / SCRUM-2503: SELF-HOST. Forbid the HF CDN and pin loading to the
      // Arkova app origin. `allowRemoteModels = false` is the equivalent of
      // `local_files_only=true`, so a missing local file throws instead of
      // silently hitting the network (which prod CSP would block anyway).
      // `allowLocalModels = true` is pinned explicitly (not trusted as a library
      // default) so remote-off + local-on is enforced in code and tested.
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = NER_LOCAL_MODEL_PATH;

      // Configure backend
      if (backend === 'webgpu' && env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }

      // Determine device based on backend
      const device = backend === 'webgpu' ? 'webgpu' : 'wasm';

      onProgress?.({ stage: 'loading', progress: 30, message: 'Loading model weights...' });

      const loaded = await pipeline('token-classification', NER_MODEL_ID, {
        device,
        dtype: 'q8', // 8-bit quantized — ~130MB vs ~420MB fp32
      });

      // FAIL LOUD: a self-hosted model that builds to nothing is not usable.
      // Never let the pipeline be a falsy value that downstream treats as "no PII".
      if (!loaded) {
        throw new Error('NER pipeline resolved to an empty value');
      }

      _pipeline = loaded;
      _loadTimeMs = Date.now() - start;
      onProgress?.({ stage: 'loading', progress: 100, message: 'Model loaded' });
      return { pipeline: _pipeline, loadTimeMs: _loadTimeMs };
    } catch (err) {
      // Do NOT cache a rejected load — clear the singletons so a later attempt
      // (after the weights are vendored / a transient error clears) can retry
      // instead of every future call rejecting forever. The typed-error mapping
      // is HERE so the creator AND every concurrent awaiter get NERModelLoadError.
      _pipeline = null;
      _pipelinePromise = null;
      _loadTimeMs = 0;

      if (err instanceof NERModelLoadError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new NERModelLoadError(
        `Failed to load the self-hosted NER model from '${NER_LOCAL_MODEL_PATH}${NER_MODEL_ID}'. ` +
          'Ensure the weights are vendored under public/models/ (see scripts/fetch-ner-model.ts) ' +
          `and that the runtime bundle is reachable from the app origin. Cause: ${detail}`,
        { cause: err },
      );
    }
  })();

  return _pipelinePromise;
}

/**
 * Merge subword tokens into complete entity spans.
 *
 * BERT NER uses BIO tagging: B-PER starts an entity, I-PER continues it.
 * Adjacent I-tokens of the same type without a B- prefix also get merged.
 */
function mergeEntities(
  rawEntities: Array<{ entity: string; score: number; word: string; start: number; end: number }>,
): NEREntity[] {
  const merged: NEREntity[] = [];
  let current: NEREntity | null = null;

  for (const raw of rawEntities) {
    const entityType = mapNERLabel(raw.entity);
    if (!entityType) {
      // O label — flush current entity
      if (current && current.score >= NER_CONFIDENCE_THRESHOLD) {
        merged.push(current);
      }
      current = null;
      continue;
    }

    const isBegin = raw.entity.startsWith('B-');

    if (isBegin || !current || current.type !== entityType) {
      // Start new entity
      if (current && current.score >= NER_CONFIDENCE_THRESHOLD) {
        merged.push(current);
      }
      current = {
        text: raw.word.replace(/^##/, ''),
        type: entityType,
        score: raw.score,
        start: raw.start,
        end: raw.end,
      };
    } else {
      // Continue current entity (I- token)
      const wordPart = raw.word.startsWith('##')
        ? raw.word.slice(2) // Subword continuation
        : ` ${raw.word}`; // New word in same entity
      current.text += wordPart;
      current.end = raw.end;
      current.score = Math.min(current.score, raw.score); // Conservative: use min score
    }
  }

  // Flush last entity
  if (current && current.score >= NER_CONFIDENCE_THRESHOLD) {
    merged.push(current);
  }

  return merged;
}

/**
 * Detect PII entities in text using NER.
 *
 * @param text - Raw text to analyze (client-side only)
 * @param backend - ML backend to use (webgpu, wasm, cpu)
 * @param onProgress - Optional progress callback
 * @returns NER-detected PII entities
 */
export async function detectPIIWithNER(
  text: string,
  backend: MLBackend = 'wasm',
  onProgress?: (progress: NERProgress) => void,
): Promise<NERPIIResult> {
  // Truncate to prevent OOM
  const inputText = text.length > MAX_TEXT_LENGTH
    ? text.slice(0, MAX_TEXT_LENGTH)
    : text;

  try {
    const { loadTimeMs } = await getNERPipeline(backend, onProgress);

    onProgress?.({ stage: 'inference', progress: 50, message: 'Analyzing text for PII...' });
    const inferenceStart = Date.now();

    // Run NER pipeline
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawResults = await (_pipeline as any)(inputText) as Array<{
      entity: string;
      score: number;
      word: string;
      start: number;
      end: number;
    }>;

    const inferenceTimeMs = Date.now() - inferenceStart;

    // Merge subword tokens into complete entities
    const entities = mergeEntities(rawResults);

    // Collect PII categories
    const categories = new Set<string>();
    for (const e of entities) {
      switch (e.type) {
        case 'PERSON': categories.add('person_name'); break;
        case 'LOCATION': categories.add('location'); break;
        case 'ORGANIZATION': categories.add('organization'); break;
        case 'MISC': categories.add('misc_entity'); break;
      }
    }

    onProgress?.({ stage: 'complete', progress: 100, message: 'PII detection complete' });

    return {
      entities,
      piiCategories: Array.from(categories),
      entityCount: entities.length,
      modelLoadTimeMs: loadTimeMs,
      inferenceTimeMs,
      backend,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'NER detection failed';
    onProgress?.({ stage: 'error', progress: 0, message });
    throw err;
  }
}

/**
 * Redact NER-detected entities from text.
 *
 * Replaces each detected entity with a type-specific redaction token:
 * - PERSON → [PERSON_REDACTED]
 * - LOCATION → [LOCATION_REDACTED]
 * - ORGANIZATION → [ORG_REDACTED]
 * - MISC → [ENTITY_REDACTED]
 *
 * Processes entities in reverse order (by position) to preserve offsets.
 */
export function redactNEREntities(text: string, entities: NEREntity[]): string {
  // Sort by start position descending to preserve offsets
  const sorted = [...entities].sort((a, b) => b.start - a.start);
  let result = text;

  for (const entity of sorted) {
    const token = getRedactionToken(entity.type);
    result = result.slice(0, entity.start) + token + result.slice(entity.end);
  }

  return result;
}

function getRedactionToken(type: PIIEntityType): string {
  switch (type) {
    case 'PERSON': return '[PERSON_REDACTED]';
    case 'LOCATION': return '[LOCATION_REDACTED]';
    case 'ORGANIZATION': return '[ORG_REDACTED]';
    case 'MISC': return '[ENTITY_REDACTED]';
  }
}

/**
 * Dispose the loaded NER pipeline to free memory.
 * Call this when the user navigates away or the model is no longer needed.
 */
export async function disposeNERPipeline(): Promise<void> {
  if (_pipeline) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (_pipeline as any).dispose?.();
    } catch {
      // Ignore disposal errors
    }
    _pipeline = null;
    _pipelinePromise = null;
    _loadTimeMs = 0;
  }
}
