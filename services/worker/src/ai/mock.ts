/**
 * Mock AI Provider — for tests and development.
 *
 * Returns deterministic results without calling any external API.
 */

import type { IAIProvider, ExtractionRequest, ExtractionResult, EmbeddingResult, ProviderHealth } from './types.js';

export class MockAIProvider implements IAIProvider {
  readonly name = 'mock';

  async extractMetadata(request: ExtractionRequest): Promise<ExtractionResult> {
    return {
      fields: {
        credentialType: request.credentialType,
        issuerName: request.issuerHint ?? 'Unknown Institution',
        issuedDate: '2025-01-01',
      },
      confidence: 0.85,
      provider: this.name,
      tokensUsed: 100,
    };
  }

  async generateEmbedding(text: string, _taskType?: import('./types.js').EmbeddingTaskType): Promise<EmbeddingResult> {
    // Deterministic 768-dim embedding from text hash
    const embedding = new Array(768).fill(0).map((_, i) => {
      const charCode = text.charCodeAt(i % text.length) || 0;
      return (charCode % 100) / 100;
    });

    return {
      embedding,
      model: 'mock-embedding-v1',
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      healthy: true,
      provider: this.name,
      latencyMs: 1,
      mode: 'mock',
    };
  }
}
