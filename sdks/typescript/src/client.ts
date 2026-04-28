/**
 * Arkova SDK Client — Anchor and verify data integrity on Bitcoin.
 *
 * @example
 * ```typescript
 * import { ArkovaClient } from '@arkova/sdk';
 *
 * const client = new ArkovaClient({ apiKey: 'ak_your_key' });
 *
 * // Anchor data (hashes client-side, submits fingerprint)
 * const receipt = await client.anchor('my important data');
 * console.log(receipt.public_id); // ARK-2026-XXXX
 *
 * // Verify by public_id
 * const result = await client.verify(receipt.public_id);
 * console.log(result.verified); // true once anchored on-chain
 * ```
 */

import type {
  AnchorReceipt,
  ArkovaConfig,
  BatchJob,
  BatchVerificationResult,
  VerificationResult,
  WaitForBatchJobOptions,
} from './types.js';

const DEFAULT_BASE_URL = 'https://arkova-worker-270018525501.us-central1.run.app';

/**
 * Max public IDs per synchronous batch verify request.
 * The server returns sync results (200) at this size or below; above this
 * and up to VERIFY_BATCH_MAX_SIZE the server returns 202 with a job_id.
 */
export const VERIFY_BATCH_SYNC_LIMIT = 20;

/** Max public IDs the server accepts in a single batch (sync or async). */
export const VERIFY_BATCH_MAX_SIZE = 100;

export class ArkovaError extends Error {
  statusCode?: number;
  code?: string;

  constructor(message: string, statusCode?: number, code?: string) {
    super(message);
    this.name = 'ArkovaError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ArkovaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(config: ArkovaConfig) {
    if (!config.apiKey) {
      throw new ArkovaError('apiKey is required');
    }

    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeout = config.timeout ?? 30_000;
  }

  /**
   * Compute SHA-256 fingerprint of data.
   * Works in Node.js (crypto) and browsers (SubtleCrypto).
   */
  static async fingerprint(data: string | Uint8Array): Promise<string> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;

    // Node.js
    if (typeof globalThis.process !== 'undefined' && globalThis.process.versions?.node) {
      const { createHash } = await import('crypto');
      return createHash('sha256').update(bytes).digest('hex');
    }

    // Browser / Edge runtime
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Hash data client-side and submit the fingerprint for anchoring.
   * The data never leaves your machine — only the SHA-256 hash is sent.
   */
  async anchor(
    data: string | Uint8Array,
    options?: { credentialType?: string; description?: string },
  ): Promise<AnchorReceipt> {
    const fp = await ArkovaClient.fingerprint(data);
    return this.anchorFingerprint(fp, options);
  }

  /**
   * Submit a pre-computed fingerprint for anchoring.
   */
  async anchorFingerprint(
    fingerprint: string,
    options?: { credentialType?: string; description?: string },
  ): Promise<AnchorReceipt> {
    const body: Record<string, string> = { fingerprint };
    if (options?.credentialType) body.credential_type = options.credentialType;
    if (options?.description) body.description = options.description;

    const response = await this.fetch('/api/v1/anchor', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await this.parseError(response);
      throw new ArkovaError(error, response.status);
    }

    return (await response.json()) as AnchorReceipt;
  }

  /**
   * Verify an anchor by its public ID.
   */
  async verify(publicId: string): Promise<VerificationResult> {
    const response = await this.fetch(`/api/v1/verify/${encodeURIComponent(publicId)}`);

    if (response.status === 404) {
      return { verified: false, error: 'Record not found' };
    }

    if (!response.ok) {
      const error = await this.parseError(response);
      throw new ArkovaError(error, response.status);
    }

    return (await response.json()) as VerificationResult;
  }

  /**
   * Hash data and verify the fingerprint against the chain.
   */
  async verifyData(data: string | Uint8Array): Promise<VerificationResult> {
    const fp = await ArkovaClient.fingerprint(data);

    const response = await this.fetch('/api/verify-anchor', {
      method: 'POST',
      body: JSON.stringify({ fingerprint: fp }),
    });

    if (!response.ok) {
      return { verified: false, error: 'Verification failed' };
    }

    return (await response.json()) as VerificationResult;
  }

  /**
   * Verify multiple credentials synchronously. Accepts up to 20 public IDs.
   * For 21–100 IDs, use {@link verifyBatchAsync} which submits a job.
   */
  async verifyBatch(publicIds: string[]): Promise<BatchVerificationResult[]> {
    if (publicIds.length === 0) return [];

    if (publicIds.length > VERIFY_BATCH_SYNC_LIMIT) {
      throw new ArkovaError(
        `verifyBatch accepts at most ${VERIFY_BATCH_SYNC_LIMIT} public IDs ` +
          `per synchronous request. Got ${publicIds.length}. ` +
          `Use verifyBatchAsync for larger batches.`,
        400,
        'batch_too_large',
      );
    }

    const response = await this.fetch('/api/v1/verify/batch', {
      method: 'POST',
      body: JSON.stringify({ public_ids: publicIds }),
    });

    if (!response.ok) {
      const error = await this.parseError(response);
      throw new ArkovaError(error, response.status);
    }

    const data = (await response.json()) as { results?: BatchVerificationResult[] };
    return data.results ?? [];
  }

  /**
   * Submit an async batch verification job for 21–100 public IDs.
   *
   * The server returns 202 with a job_id; poll with {@link getBatchJob}
   * or block on {@link waitForBatchJob}. For ≤20 IDs use {@link verifyBatch}
   * — the server returns sync results at that size and will not create a job.
   */
  async verifyBatchAsync(publicIds: string[]): Promise<BatchJob> {
    if (publicIds.length <= VERIFY_BATCH_SYNC_LIMIT) {
      throw new ArkovaError(
        `verifyBatchAsync requires more than ${VERIFY_BATCH_SYNC_LIMIT} ` +
          `public IDs (the server returns sync results at or below that size). ` +
          `Use verifyBatch for ≤${VERIFY_BATCH_SYNC_LIMIT} IDs.`,
        400,
        'batch_too_small',
      );
    }
    if (publicIds.length > VERIFY_BATCH_MAX_SIZE) {
      throw new ArkovaError(
        `verifyBatchAsync accepts at most ${VERIFY_BATCH_MAX_SIZE} public IDs ` +
          `per request. Got ${publicIds.length}.`,
        400,
        'batch_too_large',
      );
    }

    const response = await this.fetch('/api/v1/verify/batch', {
      method: 'POST',
      body: JSON.stringify({ public_ids: publicIds }),
    });

    if (!response.ok) {
      const error = await this.parseError(response);
      throw new ArkovaError(error, response.status);
    }

    const data = (await response.json()) as {
      job_id?: string;
      total?: number;
      expires_at?: string;
    };

    if (!data.job_id) {
      throw new ArkovaError(
        'Server did not return a job_id for async batch submission',
        500,
        'unexpected_response',
      );
    }

    return {
      job_id: data.job_id,
      status: 'submitted',
      total: data.total ?? publicIds.length,
      created_at: '',
      expires_at: data.expires_at ?? '',
    };
  }

  /**
   * Fetch the current status (and results, if complete) of a batch job.
   */
  async getBatchJob(jobId: string): Promise<BatchJob> {
    const response = await this.fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`);

    if (!response.ok) {
      const error = await this.parseError(response);
      throw new ArkovaError(error, response.status);
    }

    return (await response.json()) as BatchJob;
  }

  /**
   * Block until a batch job reaches a terminal state (complete or failed).
   *
   * Throws ArkovaError with code 'batch_job_timeout' if the timeout is
   * reached before the job finishes.
   */
  async waitForBatchJob(
    jobId: string,
    options?: WaitForBatchJobOptions,
  ): Promise<BatchJob> {
    const timeoutMs = options?.timeoutMs ?? 300_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const job = await this.getBatchJob(jobId);
      if (job.status === 'complete' || job.status === 'failed') {
        return job;
      }
      if (Date.now() >= deadline) {
        throw new ArkovaError(
          `Batch job ${jobId} did not finish within ${timeoutMs}ms ` +
            `(last status: ${job.status})`,
          408,
          'batch_job_timeout',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'User-Agent': 'arkova-typescript/0.1.0',
          ...((init?.headers as Record<string, string>) ?? {}),
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseError(response: Response): Promise<string> {
    try {
      const data = await response.json();
      return (data as { error?: string }).error ?? `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }
}
