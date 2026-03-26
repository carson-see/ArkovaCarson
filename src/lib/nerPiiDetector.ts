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

// Singleton pipeline — loaded once, reused across calls
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipeline: any = null;
let _pipelinePromise: Promise<void> | null = null;
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
    await _pipelinePromise;
    return { pipeline: _pipeline, loadTimeMs: _loadTimeMs };
  }

  const start = Date.now();
  onProgress?.({ stage: 'loading', progress: 0, message: 'Loading NER model...' });

  _pipelinePromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');

    // Configure backend
    if (backend === 'webgpu' && env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
    }

    // Determine device based on backend
    const device = backend === 'webgpu' ? 'webgpu' : 'wasm';

    onProgress?.({ stage: 'loading', progress: 30, message: 'Downloading model weights...' });

    _pipeline = await pipeline('token-classification', NER_MODEL_ID, {
      device,
      dtype: 'q8', // 8-bit quantized — ~130MB vs ~420MB fp32
    });

    _loadTimeMs = Date.now() - start;
    onProgress?.({ stage: 'loading', progress: 100, message: 'Model loaded' });
  })();

  await _pipelinePromise;
  return { pipeline: _pipeline, loadTimeMs: _loadTimeMs };
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
