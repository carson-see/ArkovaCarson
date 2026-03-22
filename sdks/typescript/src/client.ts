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

import type { AnchorReceipt, VerificationResult, ArkovaConfig } from './types.js';

const DEFAULT_BASE_URL = 'https://arkova-worker-270018525501.us-central1.run.app';

export class ArkovaError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ArkovaError';
    this.statusCode = statusCode;
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
