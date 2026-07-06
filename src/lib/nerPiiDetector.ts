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
 * `NERModelLoadError` (it never silently returns null).
 *
 * SCOPE — this module (SCRUM-2503 / #1253) is the PRODUCER half only:
 *   1. self-host loading from the app origin (remote off, local on),
 *   2. a typed `NERModelLoadError` raised on any load failure (incl. concurrent
 *      first-load races), and
 *   3. the build-time integrity pin (scripts/ner-weights.lock.json +
 *      scripts/fetch-ner-model.ts).
 * It does NOT, on its own, deliver the end-to-end §1.6 fail-CLOSED guarantee.
 * That is delivered by the CONSUMER change in #1262 / WEBEXT-03 (Lane 2), which
 * makes `enhancedPiiStripper.ts` THROW on `NERModelLoadError` instead of
 * degrading to regex-only stripping. BOTH halves are on `main`: #1253 merged
 * 2026-06-24 and #1262 merged 2026-06-25, so a raised `NERModelLoadError` is
 * now acted on fail-CLOSED end-to-end (see `enhancedPiiStripper.ts` +
 * `ocrFailClosed.ts` `isPiiStripFailClosedError`).
 *
 * Vendor the weights with `scripts/fetch-ner-model.ts` (ops step; the binaries
 * are git-ignored, never committed).
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
  /**
   * True when the entity was assembled from one or more out-of-vocabulary
   * (`[UNK]`) subword tokens. The reconstructed `text` cannot represent the
   * original OOV characters, so such an entity cannot be reliably located or
   * redacted by literal text — `redactNEREntities` fails CLOSED on it (§1.6).
   */
  hasUnknownToken?: boolean;
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
/**
 * The self-hosted NER model repository id. Exported so the vendoring script
 * (scripts/fetch-ner-model.ts) and the integrity lockfile (scripts/ner-weights.lock.json)
 * load from the EXACT same repo the runtime loads from — no drift between
 * build-time fetch and runtime path.
 */
export const NER_MODEL_ID = 'Xenova/bert-base-NER';

/**
 * Pinned model revision (a 40-char git commit SHA, NOT a floating `main`).
 *
 * §1.6 / SCRUM-2503: the on-device PII model is a privacy-critical artifact —
 * its weights determine what counts as PII before anything leaves the browser.
 * Pinning the revision (rather than tracking `main`) means a silent upstream
 * re-publish can't change detection behavior, and the build-time integrity
 * check (SHA-256 vs scripts/ner-weights.lock.json) stays meaningful. Bumping
 * this is a deliberate, reviewed change that requires a re-soak.
 *
 * Kept in sync with `revision` in scripts/ner-weights.lock.json and
 * MODEL_REVISION in scripts/fetch-ner-model.ts.
 */
export const NER_MODEL_REVISION = '24c7e5aba9ae350923357a6f0b92571be34037ec';

/**
 * Pinned transformers.js runtime version.
 *
 * §1.6 / SCRUM-2503: the vendored browser bundle at
 * `public/vendor/transformers.bundle.min.js` (see TRANSFORMERS_BROWSER_MODULE)
 * is what actually resolves the model
 * files in the browser, and the integrity lockfile
 * (scripts/ner-weights.lock.json `transformersJsVersion`) was built for the
 * exact file set THIS version requests for `Xenova/bert-base-NER` q8. If the
 * vendored bundle and the lock drift (e.g. the bundle is 4.1.0 but the lock is
 * pinned to 4.2.0), runtime loading can break while CI stays green. The
 * regression test in scripts/vendor-transformers-version.test.ts fails the
 * build if the bundle's embedded version != this constant != the lock's
 * `transformersJsVersion`, so the skew can never recur silently.
 *
 * Keep in sync with `transformersJsVersion` in scripts/ner-weights.lock.json
 * and the `@huggingface/transformers` pin in package.json.
 */
export const TRANSFORMERS_JS_VERSION = '4.2.0';

const NER_CONFIDENCE_THRESHOLD = 0.7;
const MAX_TEXT_LENGTH = 15_000; // Limit input to avoid OOM

/**
 * The vendored transformers.js runtime the browser natively imports at runtime.
 *
 * WEBEXT-01 F-1 (2026-07-06, PR #1409 §6): this MUST be the package's
 * SELF-CONTAINED browser build (`dist/transformers.min.js`, onnxruntime
 * inlined) — NOT the `.web.` build, whose top-level bare specifiers
 * (`onnxruntime-web/webgpu`, `onnxruntime-common`) no browser can link
 * without an import map. The `.web.` build shipped to prod and module
 * linking threw `TypeError: Failed to resolve module specifier` on EVERY
 * load — weights present or not, CSP irrelevant — hard-blocking NER for all
 * users (privacy held fail-closed; the feature was dead). Vendored +
 * hash-locked by scripts/vendor-ner-runtime.ts (scripts/ner-runtime.lock.json);
 * bare specifiers in the vendored bundle are a build-fatal CI finding
 * (scripts/ci/check-csp-runtime-deps.ts).
 *
 * Exported so the vendoring lock + CI gates assert against the EXACT path the
 * runtime imports (no drift between loader, lockfile, and served artifact).
 */
export const TRANSFORMERS_BROWSER_MODULE = '/vendor/transformers.bundle.min.js';

/**
 * App-origin path the onnxruntime WASM artifacts are served from.
 *
 * WEBEXT-01 F-2 (2026-07-06, PR #1409 §6): when `wasmPaths` is UNSET,
 * onnxruntime-web defaults it to a third-party CDN URL — which the deployed
 * CSP (`connect-src 'self'`) correctly blocks, so the model load would die at
 * the WASM fetch. The loader pins `env.backends.onnx.wasm.wasmPaths` to this
 * same-origin directory BEFORE any session creation. The artifacts
 * (`ort-wasm-simd-threaded.asyncify.{wasm,mjs}` — the flavor the pinned 4.2.0
 * bundle requests) are vendored + hash-locked at build time by
 * scripts/vendor-ner-runtime.ts into `public/vendor/ort/` (git-ignored, like
 * the model weights). Must stay a leading-slash app-relative path — never an
 * absolute HTTP(S)/CDN URL — so §1.6 self-hosting holds; CI-enforced by
 * scripts/ci/check-csp-runtime-deps.ts (checkOrtWasmPathsPinned).
 */
export const ORT_WASM_VENDOR_PATH = '/vendor/ort/';

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
 * This is intentionally a distinct, typed error: it is the PRODUCER contract
 * (this module / #1253) that the fail-closed PII stripper consumer
 * (`enhancedPiiStripper.ts`, Lane 2 / #1262 / WEBEXT-03) detects — via
 * `isPiiStripFailClosedError` (name/prototype match) — to refuse to release
 * text, rather than the loader silently returning null and the caller falling
 * back to regex-only stripping (a §1.6 fail-OPEN). Both halves are merged on
 * `main` (#1253 on 2026-06-24, #1262 on 2026-06-25), so the end-to-end
 * fail-CLOSED path is live (see the module header).
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
  /** transformers.js runtime version (e.g. `4.2.0`). Used to catch a vendored-bundle ↔ integrity-lock skew at runtime. */
  version?: string;
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
        /**
         * Where onnxruntime loads its WASM artifacts from. UNSET means the
         * library's third-party-CDN default (WEBEXT-01 F-2) — must be pinned
         * to ORT_WASM_VENDOR_PATH before any session creation. 4.2.0 accepts
         * a directory-prefix string or an explicit `{ wasm, mjs }` pair.
         */
        wasmPaths?: string | { wasm?: string; mjs?: string };
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

      // §1.6 / SCRUM-2503: guard against a vendored-bundle ↔ integrity-lock skew.
      // The SHA-256 lockfile (scripts/ner-weights.lock.json) is built for the
      // EXACT file set transformers.js TRANSFORMERS_JS_VERSION requests for this
      // model in q8. If the served bundle reports a different version, it may
      // resolve a file set the lock does not cover — fail CLOSED (typed error)
      // rather than load weights that bypassed the integrity check. The build-time
      // test (scripts/vendor-transformers-version.test.ts) is the primary gate;
      // this is the runtime backstop. `env.version` may be absent on a stub.
      if (env.version && env.version !== TRANSFORMERS_JS_VERSION) {
        throw new Error(
          `Vendored transformers.js bundle is v${env.version} but the integrity ` +
            `lock + loader are pinned to v${TRANSFORMERS_JS_VERSION}. Re-vendor ` +
            `${TRANSFORMERS_BROWSER_MODULE} via scripts/vendor-ner-runtime.ts at the pinned version.`,
        );
      }

      // §1.6 / SCRUM-2503: SELF-HOST. Forbid the HF CDN and pin loading to the
      // Arkova app origin. `allowRemoteModels = false` is the equivalent of
      // `local_files_only=true`, so a missing local file throws instead of
      // silently hitting the network (which prod CSP would block anyway).
      // `allowLocalModels = true` is pinned explicitly (not trusted as a library
      // default) so remote-off + local-on is enforced in code and tested.
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = NER_LOCAL_MODEL_PATH;

      // §1.6 / WEBEXT-01 F-2: pin the onnxruntime WASM artifacts to the
      // same-origin vendor path BEFORE any session creation. Left unset,
      // onnxruntime-web defaults `wasmPaths` to a third-party-CDN URL that the
      // deployed CSP (`connect-src 'self'`) blocks — the model load would die
      // at the WASM fetch. If the runtime exposes no ort wasm env to pin,
      // FAIL CLOSED (typed) rather than create a session that would race the
      // CSP with that CDN default.
      const ortWasmEnv = env.backends?.onnx?.wasm;
      if (!ortWasmEnv) {
        throw new Error(
          'Vendored transformers.js runtime exposes no env.backends.onnx.wasm — ' +
            `cannot pin ort wasmPaths to '${ORT_WASM_VENDOR_PATH}'; refusing to ` +
            'create a session that would fall back to an off-origin WASM fetch.',
        );
      }
      ortWasmEnv.wasmPaths = ORT_WASM_VENDOR_PATH;

      // Configure backend
      if (backend === 'webgpu') {
        ortWasmEnv.numThreads = 1;
      }

      // Determine device based on backend
      const device = backend === 'webgpu' ? 'webgpu' : 'wasm';

      onProgress?.({ stage: 'loading', progress: 30, message: 'Loading model weights...' });

      const loaded = await pipeline('token-classification', NER_MODEL_ID, {
        device,
        dtype: 'q8', // 8-bit quantized — ~104MB vs ~420MB fp32
        // Pin the revision (not floating `main`). With allowRemoteModels=false
        // this never drives a network fetch, but it keeps the runtime contract
        // identical to the build-time vendoring (scripts/ner-weights.lock.json)
        // and stays correct if a future change ever re-enables remote loading.
        revision: NER_MODEL_REVISION,
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
 * Raw token-classification output item. WEBEXT-01 F-3: the transformers.js
 * 4.2.0 browser pipeline emits `{ entity, score, index, word }` — NO
 * start/end character offsets. They are typed optional so the merge logic
 * never trusts them blindly (the old code copied `undefined` through, and
 * `redactNEREntities` then sliced with `undefined`, duplicating the text
 * with ALL PII STILL PRESENT — a §1.6 leak the browser-real probe caught).
 */
interface RawNERToken {
  entity: string;
  score: number;
  word: string;
  start?: number | null;
  end?: number | null;
}

function isValidSpan(start: unknown, end: unknown, textLength: number): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (start as number) >= 0 &&
    (end as number) > (start as number) &&
    (end as number) <= textLength
  );
}

/**
 * Locate a merged entity's character span in the source text.
 *
 * Strategy (deterministic):
 *   1. exact match of the reconstructed entity text from the search cursor;
 *   2. exact match from the beginning (defensive — cursor drift);
 *   3. token-by-token walk from the cursor (handles source texts where the
 *      inter-word whitespace differs from the single-space reconstruction).
 * Returns null when the entity cannot be located — the redactor then falls
 * back to literal-text redaction or fails CLOSED (never silently skips).
 */
/**
 * indexOf anchored at word boundaries where the needle's edges are
 * alphanumeric — so "John" is not located inside "Johnson". Returns -1 when
 * absent. Unicode-aware; falls back to a plain indexOf only for needles with
 * non-alphanumeric edges (punctuation/space) where boundaries don't apply.
 */
function indexOfWordBoundary(haystack: string, needle: string, from: number): number {
  if (!needle) return -1;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^[\p{L}\p{N}]/u.test(needle) ? '(?<![\\p{L}\\p{N}_])' : '';
  const right = /[\p{L}\p{N}]$/u.test(needle) ? '(?![\\p{L}\\p{N}_])' : '';
  const re = new RegExp(`${left}${esc}${right}`, 'gu');
  re.lastIndex = Math.max(0, from);
  const m = re.exec(haystack);
  return m ? m.index : -1;
}

function locateSpan(
  sourceText: string,
  entityText: string,
  tokens: readonly string[],
  from: number,
): { start: number; end: number } | null {
  let idx = indexOfWordBoundary(sourceText, entityText, from);
  if (idx < 0) idx = indexOfWordBoundary(sourceText, entityText, 0);
  if (idx >= 0) return { start: idx, end: idx + entityText.length };

  let cursor = from;
  let start = -1;
  let end = -1;
  for (const rawWord of tokens) {
    const word = rawWord.replace(/^##/, '');
    if (!word || word === '[UNK]') continue;
    let i = indexOfWordBoundary(sourceText, word, cursor);
    if (i < 0) i = indexOfWordBoundary(sourceText, word, 0);
    if (i < 0) return null;
    if (start < 0) start = i;
    cursor = i + word.length;
    end = cursor;
  }
  return start >= 0 ? { start, end } : null;
}

/**
 * Merge subword tokens into complete entity spans.
 *
 * BERT NER uses BIO tagging: B-PER starts an entity, I-PER continues it.
 * Adjacent I-tokens of the same type without a B- prefix also get merged.
 *
 * Span source of truth (F-3): pipeline-provided offsets are used when they
 * are structurally valid; otherwise the span is COMPUTED against
 * `sourceText` via {@link locateSpan} with a monotonically advancing cursor
 * (so repeated entity texts map to successive occurrences). An entity that
 * cannot be located gets `start = end = -1`, which `redactNEREntities`
 * treats as "redact by literal text or fail closed".
 */
function mergeEntities(rawEntities: RawNERToken[], sourceText: string): NEREntity[] {
  const merged: NEREntity[] = [];
  let current: NEREntity | null = null;
  let currentTokens: string[] = [];
  let searchCursor = 0;

  const flush = (): void => {
    if (!current || current.score < NER_CONFIDENCE_THRESHOLD) {
      current = null;
      currentTokens = [];
      return;
    }
    if (!isValidSpan(current.start, current.end, sourceText.length)) {
      const span = locateSpan(sourceText, current.text, currentTokens, searchCursor);
      if (span) {
        current.start = span.start;
        current.end = span.end;
      } else {
        current.start = -1;
        current.end = -1;
      }
    }
    if (current.end > 0) searchCursor = Math.max(searchCursor, current.end);
    merged.push(current);
    current = null;
    currentTokens = [];
  };

  for (const raw of rawEntities) {
    const entityType = mapNERLabel(raw.entity);
    if (!entityType) {
      // O label — flush current entity
      flush();
      continue;
    }

    const isBegin = raw.entity.startsWith('B-');

    const bareWord = raw.word.replace(/^##/, '');
    const isUnk = bareWord === '[UNK]';

    if (isBegin || !current || current.type !== entityType) {
      // Start new entity. An [UNK] leading token contributes no representable
      // text but still marks the entity as OOV so the redactor fails closed.
      flush();
      current = {
        text: isUnk ? '' : bareWord,
        type: entityType,
        score: raw.score,
        start: raw.start ?? -1,
        end: raw.end ?? -1,
        hasUnknownToken: isUnk,
      };
      currentTokens = [raw.word];
    } else {
      // Continue current entity (I- token). Skip [UNK] in the reconstructed
      // text (it cannot represent the original characters) but record it.
      if (isUnk) {
        current.hasUnknownToken = true;
      } else {
        const wordPart = raw.word.startsWith('##')
          ? raw.word.slice(2) // Subword continuation
          : (current.text ? ` ${bareWord}` : bareWord); // New word in same entity
        current.text += wordPart;
      }
      current.end = raw.end ?? -1;
      current.score = Math.min(current.score, raw.score); // Conservative: use min score
      currentTokens.push(raw.word);
    }
  }

  // Flush last entity
  flush();

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
    const rawResults = await (_pipeline as any)(inputText) as RawNERToken[];

    const inferenceTimeMs = Date.now() - inferenceStart;

    // Merge subword tokens into complete entities, computing character spans
    // against the input text (the 4.2.0 pipeline emits no offsets — F-3).
    const entities = mergeEntities(rawResults, inputText);

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
 * Entities with a structurally valid span are redacted positionally (reverse
 * order to preserve offsets). WEBEXT-01 F-3: entities WITHOUT a valid span
 * (the 4.2.0 pipeline provides no offsets; locateSpan can rarely fail on
 * tokenizer-normalized text) are redacted by LITERAL text — every occurrence
 * — and if the entity text cannot be found at all, this function THROWS
 * rather than silently returning text that still contains PII the model
 * detected (§1.6 fail-closed; the stripper maps the throw to its typed
 * fail-closed error before any egress). The thrown message never contains
 * the entity text — it IS the PII.
 */
/**
 * Replace every occurrence of `needle` in `haystack` with `token`, anchored at
 * word boundaries where the needle's edges are alphanumeric. This avoids
 * garbling a longer word that merely CONTAINS the needle ("John" must not match
 * inside "Johnson") while still redacting every standalone occurrence.
 * Unicode-aware (`\p{L}\p{N}` under the `u` flag) so accented letters count as
 * word characters. Over-matching (redacting too much) is the acceptable failure
 * mode here; under-matching (leaving PII) is not.
 */
function redactAllOccurrences(haystack: string, needle: string, token: string): string {
  if (!needle) return haystack;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^[\p{L}\p{N}]/u.test(needle) ? '(?<![\\p{L}\\p{N}_])' : '';
  const right = /[\p{L}\p{N}]$/u.test(needle) ? '(?![\\p{L}\\p{N}_])' : '';
  return haystack.replace(new RegExp(`${left}${esc}${right}`, 'gu'), token);
}

export function redactNEREntities(text: string, entities: NEREntity[]): string {
  // OOV-token entities cannot be represented by `text` (the [UNK] characters are
  // lost), so neither positional nor literal redaction can guarantee coverage —
  // fail CLOSED before releasing anything. (Message carries only the type; the
  // entity text IS the PII.)
  const unknown = entities.find((e) => e.hasUnknownToken);
  if (unknown) {
    throw new Error(
      `NER detected a ${unknown.type} entity containing out-of-vocabulary characters ` +
        'that cannot be reliably redacted — refusing to release text (fail-closed).',
    );
  }

  // A structurally valid span is only trusted when the text it covers actually
  // matches the detected entity (whitespace-normalised — the merge step collapses
  // inter-token whitespace to single spaces). Guards against a wrong upstream
  // offset (F-3): a mismatching span is demoted to the literal/sweep path rather
  // than redacting the wrong characters.
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const positional = entities.filter(
    (e) => isValidSpan(e.start, e.end, text.length) && norm(text.slice(e.start, e.end)) === norm(e.text),
  );
  const positionalSet = new Set(positional);
  const textual = entities.filter((e) => !positionalSet.has(e));

  // Sort by start position descending to preserve offsets
  const sorted = [...positional].sort((a, b) => b.start - a.start);
  let result = text;

  for (const entity of sorted) {
    result = result.slice(0, entity.start) + getRedactionToken(entity.type) + result.slice(entity.end);
  }

  for (const entity of textual) {
    const token = getRedactionToken(entity.type);
    if (entity.text && result.includes(entity.text)) {
      result = redactAllOccurrences(result, entity.text, token);
      continue;
    }
    if (entity.text && text.includes(entity.text)) {
      // Present in the input but already removed by an earlier (overlapping)
      // redaction — nothing left to redact.
      continue;
    }
    // The model detected PII we cannot locate in the text — refusing to
    // release the text is the only §1.6-safe outcome. (No entity text in the
    // message: it is the PII.)
    throw new Error(
      `NER detected a ${entity.type} entity that could not be located for redaction — ` +
        'refusing to release text (fail-closed).',
    );
  }

  // Defense-in-depth guarantee (WEBEXT-01 F-3 review-hardening): after the
  // positional + literal passes, NO detected entity's text may survive in the
  // output. A positional span can bind to the WRONG occurrence when spans drift
  // (dropped low-confidence tokens don't advance the merge cursor; substring
  // locates bind inside longer words), so sweep every detected entity and redact
  // any remaining word-boundary occurrence by literal text. Over-redaction is
  // acceptable; a surviving detected entity is a §1.6 breach.
  for (const entity of entities) {
    if (entity.text && result.includes(entity.text)) {
      result = redactAllOccurrences(result, entity.text, getRedactionToken(entity.type));
    }
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
