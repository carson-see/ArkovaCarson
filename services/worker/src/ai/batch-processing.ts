/**
 * GME-17: Batch Processing Optimization
 *
 * Concurrent batch extraction processor. Respects concurrency limits
 * and handles individual failures without failing the entire batch.
 *
 * When Gemini 3 adds a native batch API, this can be swapped to use
 * that instead of client-side concurrency.
 */

import type {
  IAIProvider,
  ExtractionRequest,
  ExtractionResult,
} from './types.js';

export interface BatchProcessorOptions {
  /** Max concurrent extraction requests (default: AI_BATCH_CONCURRENCY env or 3) */
  concurrency?: number;
}

export interface BatchResult {
  success: boolean;
  result?: ExtractionResult;
  error?: string;
  index: number;
  latencyMs: number;
}

export class BatchProcessor {
  private readonly concurrency: number;

  constructor(
    private readonly provider: IAIProvider,
    options?: BatchProcessorOptions,
  ) {
    this.concurrency = options?.concurrency
      ?? parseInt(process.env.AI_BATCH_CONCURRENCY ?? '3', 10);
  }

  /**
   * Process multiple extraction requests with concurrency control.
   * Individual failures don't fail the batch.
   */
  async extractBatch(requests: ExtractionRequest[]): Promise<BatchResult[]> {
    const results: BatchResult[] = new Array(requests.length);
    let cursor = 0;

    const worker = async () => {
      while (cursor < requests.length) {
        const index = cursor++;
        const request = requests[index];
        const start = Date.now();

        try {
          const result = await this.provider.extractMetadata(request);
          results[index] = {
            success: true,
            result,
            index,
            latencyMs: Date.now() - start,
          };
        } catch (err) {
          results[index] = {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            index,
            latencyMs: Date.now() - start,
          };
        }
      }
    };

    // Launch concurrent workers
    const workers = Array.from(
      { length: Math.min(this.concurrency, requests.length) },
      () => worker(),
    );
    await Promise.all(workers);

    return results;
  }
}
