/**
 * Gemini Model Configuration (GME-01)
 *
 * Single source of truth for all Gemini model references.
 * Migration to a new model version is a one-line change here
 * instead of a 14+ file hunt.
 *
 * GAP-5: Pin to specific model versions to prevent silent quality drift.
 * Before upgrading: run eval suite, compare F1, document delta, update pin.
 *
 * Deprecation timeline:
 *   - gemini-2.0-flash: shut down June 1, 2026
 *   - gemini-2.5-flash: shuts down June 17, 2026
 *   - Migrated to: gemini-3-flash-preview (GME-02, 2026-04-12)
 */

// ─── Default model versions ────────────────────────────────────────
// GME-02: Migrated from gemini-2.5-flash to gemini-3-flash-preview (2026-04-12)
// Previous: gemini-2.5-flash (deprecated June 17, 2026)
const DEFAULT_GENERATION_MODEL = 'gemini-3-flash-preview';
// GME-03: Migrated from gemini-embedding-001 (deprecated July 14, 2026) to text-embedding-004
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-004';
const DEFAULT_VISION_MODEL = 'gemini-3-flash-preview';
// Distillation also migrated to Gemini 3 (was gemini-2.0-flash, shut down June 1):
const DEFAULT_DISTILLATION_MODEL = 'gemini-3-flash-preview';

// ─── Resolved model names (env overrides) ──────────────────────────
/** Primary text generation model — extraction, tags, templates, fraud */
export const GEMINI_GENERATION_MODEL =
  process.env.GEMINI_MODEL ?? DEFAULT_GENERATION_MODEL;

/** Vector embedding model — public records, search */
export const GEMINI_EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;

/** Vision model — multimodal fraud detection */
export const GEMINI_VISION_MODEL =
  process.env.GEMINI_VISION_MODEL ?? DEFAULT_VISION_MODEL;

/** Vertex AI fine-tuned model resource path (null if not configured) */
export const GEMINI_TUNED_MODEL =
  process.env.GEMINI_TUNED_MODEL ?? null;

/** Model used for Nessie distillation / training pipelines */
export const GEMINI_DISTILLATION_MODEL =
  process.env.GEMINI_DISTILLATION_MODEL ?? DEFAULT_DISTILLATION_MODEL;

// ─── Structured config getter ──────────────────────────────────────
export interface GeminiModelConfig {
  generationModel: string;
  embeddingModel: string;
  visionModel: string;
  tunedModel: string | null;
}

/** Returns a snapshot of all resolved Gemini model references */
export function getGeminiConfig(): GeminiModelConfig {
  return {
    generationModel: process.env.GEMINI_MODEL ?? DEFAULT_GENERATION_MODEL,
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    visionModel: process.env.GEMINI_VISION_MODEL ?? DEFAULT_VISION_MODEL,
    tunedModel: process.env.GEMINI_TUNED_MODEL ?? null,
  };
}
