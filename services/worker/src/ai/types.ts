/**
 * AI Provider Types (P8-S17)
 *
 * IAIProvider is the core abstraction for all AI providers.
 * All providers (Gemini, OpenAI, Anthropic, Cloudflare fallback) implement this.
 *
 * Constitution 4A: Only PII-stripped metadata flows to providers.
 * Constitution 1.6: Document bytes never reach any provider.
 */

/** Request to extract structured fields from PII-stripped credential text. */
export interface ExtractionRequest {
  /** PII-stripped text (client-side stripping already applied) */
  strippedText: string;
  /** Credential type hint (DEGREE, CERTIFICATE, LICENSE, etc.) */
  credentialType: string;
  /** Document fingerprint (SHA-256 hash — not the document itself) */
  fingerprint: string;
  /** Optional: issuer name hint from user input */
  issuerHint?: string;
}

/** Structured fields extracted from a credential. */
export interface ExtractedFields {
  credentialType?: string;
  issuerName?: string;
  recipientIdentifier?: string; // hashed, never raw PII
  issuedDate?: string;
  expiryDate?: string;
  fieldOfStudy?: string;
  degreeLevel?: string;
  licenseNumber?: string;
  accreditingBody?: string;
  jurisdiction?: string;
  // CLE-specific fields
  creditHours?: number;
  creditType?: string;
  barNumber?: string;
  activityNumber?: string;
  providerName?: string;
  approvedBy?: string;
  // Fraud signals
  fraudSignals?: string[];
  [key: string]: string | number | string[] | undefined;
}

/** Result of a metadata extraction call. */
export interface ExtractionResult {
  fields: ExtractedFields;
  confidence: number; // 0.0–1.0
  provider: string;
  tokensUsed?: number;
  /** VAI-01: Model version identifier for extraction manifest provenance. */
  modelVersion?: string;
}

/** Gemini embedding task types — optimizes the embedding space for the use case. */
export type EmbeddingTaskType =
  | 'RETRIEVAL_DOCUMENT'
  | 'RETRIEVAL_QUERY'
  | 'SEMANTIC_SIMILARITY'
  | 'CLASSIFICATION'
  | 'CLUSTERING'
  | 'QUESTION_ANSWERING'
  | 'FACT_VERIFICATION';

/** Result of an embedding generation call. */
export interface EmbeddingResult {
  embedding: number[]; // 768-dimensional vector
  model: string;
}

/** Provider health status. */
export interface ProviderHealth {
  healthy: boolean;
  provider: string;
  latencyMs: number;
  mode?: string; // e.g., 'adk' | 'direct' | 'fallback'
}

/**
 * Core AI provider interface.
 *
 * Every AI provider (Gemini, OpenAI, Anthropic, Cloudflare Workers AI)
 * implements this interface. The factory selects the active provider
 * based on AI_PROVIDER env var.
 */
export interface IAIProvider {
  /** Provider identifier (e.g., 'gemini', 'openai', 'cloudflare-workers-ai') */
  readonly name: string;

  /**
   * Extract structured metadata fields from PII-stripped credential text.
   * Input MUST be PII-stripped — providers never receive raw document text.
   */
  extractMetadata(request: ExtractionRequest): Promise<ExtractionResult>;

  /**
   * Generate a 768-dimensional embedding vector for semantic search.
   * Used for institution ground truth matching and credential similarity.
   * Optional taskType optimizes the embedding space for the specific use case.
   */
  generateEmbedding(text: string, taskType?: EmbeddingTaskType): Promise<EmbeddingResult>;

  /** Check provider availability and latency. */
  healthCheck(): Promise<ProviderHealth>;
}
