/**
 * Replicate QA Data Generator (INFRA-06)
 *
 * IAIProvider implementation using Replicate for generating synthetic
 * test data (fake credentials, edge-case documents) for QA pipelines.
 *
 * NEVER used in production request paths.
 * Gated by NODE_ENV=test OR ENABLE_SYNTHETIC_DATA=true.
 * Hard-blocked when NODE_ENV=production AND ENABLE_SYNTHETIC_DATA!==true.
 *
 * Constitution 1.1: replicate is QA/synthetic-data-only.
 */

import type {
  IAIProvider,
  ExtractionRequest,
  ExtractionResult,
  EmbeddingResult,
  ProviderHealth,
} from './types.js';

export class ReplicateProvider implements IAIProvider {
  readonly name = 'replicate-qa';
  private readonly apiToken: string;

  constructor(apiToken?: string) {
    // Hard production block
    if (
      process.env.NODE_ENV === 'production' &&
      process.env.ENABLE_SYNTHETIC_DATA !== 'true'
    ) {
      throw new Error(
        'ReplicateProvider is blocked in production. ' +
          'Set ENABLE_SYNTHETIC_DATA=true to override (QA only). ' +
          'Constitution 1.1: replicate is QA/synthetic-data-only.',
      );
    }

    this.apiToken = apiToken ?? process.env.REPLICATE_API_TOKEN ?? '';
    if (!this.apiToken) {
      throw new Error('REPLICATE_API_TOKEN is required for ReplicateProvider');
    }
  }

  async extractMetadata(request: ExtractionRequest): Promise<ExtractionResult> {
    // Generate synthetic metadata based on credential type
    return {
      fields: {
        credentialType: request.credentialType,
        issuerName: request.issuerHint ?? 'Test University',
        recipientIdentifier: `sha256:synthetic_${request.fingerprint.slice(0, 8)}`,
        issuedDate: '2024-06-15',
        expiryDate: '2028-06-15',
        fieldOfStudy: 'Computer Science',
        degreeLevel: 'Bachelor of Science',
      },
      confidence: 0.95,
      provider: this.name,
      tokensUsed: 0,
    };
  }

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    // Generate a deterministic pseudo-embedding for testing
    const seed = Array.from(text).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const embedding = Array.from({ length: 768 }, (_, i) =>
      Math.sin(seed * (i + 1) * 0.001) * 0.5,
    );
    return { embedding, model: 'replicate-qa-synthetic' };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    const healthy = !!this.apiToken;
    return {
      healthy,
      provider: this.name,
      latencyMs: Date.now() - start,
      mode: 'qa-synthetic',
    };
  }
}
