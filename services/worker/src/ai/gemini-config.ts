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
// GME-03: text-embedding-004 does NOT exist in Gemini API (was hallucinated model name).
// Available: gemini-embedding-001 (GA), gemini-embedding-2-preview (preview).
// Using gemini-embedding-001 (stable GA) as default.
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';
const DEFAULT_VISION_MODEL = 'gemini-3-flash-preview';
// Distillation also migrated to Gemini 3 (was gemini-2.0-flash, shut down June 1):
const DEFAULT_DISTILLATION_MODEL = 'gemini-3-flash-preview';
// GME-18: Lighter model for low-stakes tasks (tags, classification)
const DEFAULT_LITE_MODEL = 'gemini-3-flash-lite-preview';
// GEMB2-01 (SCRUM-1050): Vertex AI Gemini Embedding 2 — the next-gen embedding
// model. NOT wired into the production hot path yet — lives only in
// `services/worker/src/ai/embeddings/gemini2.ts` as a reference client.
// Registered here so the deprecation monitor (GME-05) can see the model ID,
// and so the GEMB2-02 switch-over (SCRUM-1051) has a single slot to flip.
const DEFAULT_EMBEDDING_V2_MODEL = 'gemini-embedding-2@001';

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

/** GME-18: Lighter model for low-stakes tasks (tag generation, classification) */
export const GEMINI_LITE_MODEL =
  process.env.GEMINI_LITE_MODEL ?? DEFAULT_LITE_MODEL;

/**
 * GEMB2-01 (SCRUM-1050): Vertex AI Gemini Embedding 2 model ID. Not active on
 * the production hot path — use `GEMINI_EMBEDDING_MODEL` for that. This
 * constant is the single source of truth referenced by
 * `services/worker/src/ai/embeddings/gemini2.ts` so a future rotation is a
 * one-line change.
 */
export const GEMINI_EMBEDDING_V2_MODEL =
  process.env.GEMINI_EMBEDDING_V2_MODEL ?? DEFAULT_EMBEDDING_V2_MODEL;

// ─── GME-20: Version Pin Metadata ─────────────────────────────────
// Track when each model version was pinned and last verified.
// Before upgrading: run eval suite, compare F1, document delta, update pin.

export interface ModelVersionPin {
  modelId: string;
  pinnedAt: string;   // ISO date when this version was pinned
  verifiedAt: string; // ISO date when eval last confirmed quality
  notes?: string;
}

/** Auditable record of all active model version pins */
export const MODEL_VERSION_PINS: Record<string, ModelVersionPin> = {
  generation: {
    modelId: DEFAULT_GENERATION_MODEL,
    pinnedAt: '2026-04-12',
    verifiedAt: '2026-04-12',
    notes: 'GME-02: migrated from gemini-2.5-flash; preview until GA release',
  },
  embedding: {
    modelId: DEFAULT_EMBEDDING_MODEL,
    pinnedAt: '2026-04-12',
    verifiedAt: '2026-04-12',
    notes: 'GME-03: migrated from gemini-embedding-001; stable GA model',
  },
  vision: {
    modelId: DEFAULT_VISION_MODEL,
    pinnedAt: '2026-04-12',
    verifiedAt: '2026-04-12',
    notes: 'Shares generation model; multimodal fraud detection',
  },
  distillation: {
    modelId: DEFAULT_DISTILLATION_MODEL,
    pinnedAt: '2026-04-12',
    verifiedAt: '2026-04-12',
    notes: 'Teacher model for Nessie training pipelines',
  },
  lite: {
    modelId: DEFAULT_LITE_MODEL,
    pinnedAt: '2026-04-12',
    verifiedAt: '2026-04-12',
    notes: 'GME-18: cheaper/faster model for tags, classification',
  },
  embedding_v2: {
    modelId: DEFAULT_EMBEDDING_V2_MODEL,
    pinnedAt: '2026-04-23',
    verifiedAt: '2026-04-23',
    notes:
      'GEMB2-01 (SCRUM-1050): reference implementation only. Not on the production hot path until GEMB2-02 ships with ENABLE_GEMB2_RAG=true.',
  },
};

export interface ActiveModelVersion {
  role: string;
  modelId: string;
  pinnedAt: string;
  verifiedAt: string;
}

/** Returns all active model versions with their roles (deduplicated by role) */
export function getActiveModelVersions(): ActiveModelVersion[] {
  return Object.entries(MODEL_VERSION_PINS).map(([role, pin]) => ({
    role,
    modelId: pin.modelId,
    pinnedAt: pin.pinnedAt,
    verifiedAt: pin.verifiedAt,
  }));
}

export interface VersionPinValidation {
  valid: boolean;
  mismatches: Array<{
    role: string;
    expected: string;
    actual: string;
  }>;
}

/**
 * Validate that resolved model names match their version pins.
 * Detects env var overrides that diverge from the pinned versions.
 */
export function validateVersionPins(): VersionPinValidation {
  const config = getGeminiConfig();
  const mismatches: VersionPinValidation['mismatches'] = [];

  const checks: Array<{ role: string; actual: string; expected: string }> = [
    { role: 'generation', actual: config.generationModel, expected: MODEL_VERSION_PINS.generation.modelId },
    { role: 'embedding', actual: config.embeddingModel, expected: MODEL_VERSION_PINS.embedding.modelId },
    { role: 'vision', actual: config.visionModel, expected: MODEL_VERSION_PINS.vision.modelId },
  ];

  for (const check of checks) {
    if (check.actual !== check.expected) {
      mismatches.push(check);
    }
  }

  return { valid: mismatches.length === 0, mismatches };
}

// ─── Structured config getter ──────────────────────────────────────
export interface GeminiModelConfig {
  generationModel: string;
  embeddingModel: string;
  visionModel: string;
  tunedModel: string | null;
  liteModel: string;
}

/** Returns a snapshot of all resolved Gemini model references */
export function getGeminiConfig(): GeminiModelConfig {
  return {
    generationModel: process.env.GEMINI_MODEL ?? DEFAULT_GENERATION_MODEL,
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    visionModel: process.env.GEMINI_VISION_MODEL ?? DEFAULT_VISION_MODEL,
    tunedModel: process.env.GEMINI_TUNED_MODEL ?? null,
    liteModel: process.env.GEMINI_LITE_MODEL ?? DEFAULT_LITE_MODEL,
  };
}
