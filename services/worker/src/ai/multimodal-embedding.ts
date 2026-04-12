/**
 * GME-12: Multimodal Embedding for Document Images
 *
 * Uses Gemini 3's multimodal embedding API (gemini-embedding-2-preview)
 * to embed document images directly alongside text metadata.
 * Enables visual similarity search: "find documents that look like this."
 *
 * Gated by ENABLE_MULTIMODAL_EMBEDDINGS switchboard flag (default: false).
 * When enabled, document screenshots/images are embedded into pgvector
 * alongside the text embeddings for hybrid text+visual search.
 */

import { GEMINI_EMBEDDING_MODEL } from './gemini-config.js';

/** Multimodal embedding configuration */
export const MULTIMODAL_EMBEDDING_CONFIG = {
  /** Model supporting multimodal embedding (images, text, PDF) */
  model: 'gemini-embedding-exp-03-07',
  /** Fallback to text-only embedding model */
  fallbackModel: GEMINI_EMBEDDING_MODEL,
  /** Supported MIME types for image embedding */
  supportedMimeTypes: [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
  ],
  /** Max image size for embedding (bytes) */
  maxImageSize: 20 * 1024 * 1024, // 20MB
};

/**
 * Check if multimodal embedding is enabled via switchboard.
 */
export function isMultimodalEmbeddingEnabled(): boolean {
  return process.env.ENABLE_MULTIMODAL_EMBEDDINGS === 'true';
}
