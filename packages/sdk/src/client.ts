/**
 * Arkova SDK Client (PH1-SDK-01)
 *
 * Main client class providing anchor, verify, and query operations.
 * Works in both Node.js and browser environments.
 */

import type {
  ArkovaConfig,
  AnchorReceipt,
  VerificationResult,
  NessieQueryResult,
  NessieContextResult,
} from './types';

const DEFAULT_BASE_URL = 'https://arkova-worker-270018525501.us-central1.run.app';

export class Arkova {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly x402Config?: ArkovaConfig['x402'];

  constructor(config: ArkovaConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.x402Config = config.x402;
  }

  /**
   * Generate a SHA-256 fingerprint of data.
   * Runs client-side (browser or Node.js).
   */
  async fingerprint(data: string | ArrayBuffer): Promise<string> {
    const encoder = new TextEncoder();
    const buffer = typeof data === 'string' ? encoder.encode(data) : data;
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Anchor data — compute fingerprint and submit for network anchoring.
   * Returns a receipt that can be used later for verification.
   */
  async anchor(data: string | ArrayBuffer): Promise<AnchorReceipt> {
    const fp = await this.fingerprint(data);

    const response = await this.fetch('/api/v1/anchor', {
      method: 'POST',
      body: JSON.stringify({ fingerprint: fp }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Anchor request failed' }));
      throw new ArkovaError(
        (error as { error?: string }).error ?? `HTTP ${response.status}`,
        response.status,
      );
    }

    const result = await response.json() as {
      public_id: string;
      fingerprint: string;
      status: string;
      created_at: string;
      chain_tx_id?: string;
    };

    return {
      publicId: result.public_id,
      fingerprint: result.fingerprint,
      status: result.status as AnchorReceipt['status'],
      createdAt: result.created_at,
      networkReceiptId: result.chain_tx_id,
    };
  }

  /**
   * Verify data against an anchor receipt.
   * Recomputes the fingerprint and checks it against the anchored record.
   */
  async verify(data: string | ArrayBuffer, receipt: AnchorReceipt): Promise<VerificationResult>;
  async verify(publicId: string): Promise<VerificationResult>;
  async verify(
    dataOrPublicId: string | ArrayBuffer,
    receipt?: AnchorReceipt,
  ): Promise<VerificationResult> {
    const publicId = receipt
      ? receipt.publicId
      : (dataOrPublicId as string);

    // If data + receipt provided, verify fingerprint matches first
    if (receipt && typeof dataOrPublicId !== 'string') {
      const fp = await this.fingerprint(dataOrPublicId);
      if (fp !== receipt.fingerprint) {
        return {
          verified: false,
          status: 'UNKNOWN',
          issuerName: 'Unknown',
          credentialType: 'UNKNOWN',
          issuedDate: null,
          expiryDate: null,
          anchorTimestamp: '',
          networkReceiptId: null,
          recordUri: '',
        };
      }
    }

    const response = await this.fetch(`/api/v1/verify/${encodeURIComponent(publicId)}`);

    if (!response.ok) {
      throw new ArkovaError(`Verification failed: HTTP ${response.status}`, response.status);
    }

    const result = await response.json() as {
      verified: boolean;
      status: string;
      issuer_name: string;
      credential_type: string;
      issued_date: string | null;
      expiry_date: string | null;
      anchor_timestamp: string;
      network_receipt_id: string | null;
      record_uri: string;
    };

    return {
      verified: result.verified,
      status: result.status as VerificationResult['status'],
      issuerName: result.issuer_name,
      credentialType: result.credential_type,
      issuedDate: result.issued_date,
      expiryDate: result.expiry_date,
      anchorTimestamp: result.anchor_timestamp,
      networkReceiptId: result.network_receipt_id,
      recordUri: result.record_uri,
    };
  }

  /**
   * Query Nessie — semantic search over verified public records.
   */
  async query(q: string, options?: { limit?: number }): Promise<NessieQueryResult> {
    const params = new URLSearchParams({ q, mode: 'retrieval' });
    if (options?.limit) params.set('limit', String(options.limit));

    const response = await this.fetch(`/api/v1/nessie/query?${params}`);

    if (!response.ok) {
      throw new ArkovaError(`Query failed: HTTP ${response.status}`, response.status);
    }

    const data = await response.json() as {
      results: Array<{
        record_id: string;
        source: string;
        source_url: string;
        record_type: string;
        title: string | null;
        relevance_score: number;
        anchor_proof: { chain_tx_id: string | null; content_hash: string } | null;
      }>;
      count: number;
      query: string;
    };

    return {
      results: data.results.map((r) => ({
        recordId: r.record_id,
        source: r.source,
        sourceUrl: r.source_url,
        recordType: r.record_type,
        title: r.title,
        relevanceScore: r.relevance_score,
        anchorProof: r.anchor_proof
          ? { chainTxId: r.anchor_proof.chain_tx_id, contentHash: r.anchor_proof.content_hash }
          : null,
      })),
      count: data.count,
      query: data.query,
    };
  }

  /**
   * Query Nessie in verified context mode — synthesized answer with citations.
   */
  async ask(q: string, options?: { limit?: number }): Promise<NessieContextResult> {
    const params = new URLSearchParams({ q, mode: 'context' });
    if (options?.limit) params.set('limit', String(options.limit));

    const response = await this.fetch(`/api/v1/nessie/query?${params}`);

    if (!response.ok) {
      throw new ArkovaError(`Query failed: HTTP ${response.status}`, response.status);
    }

    const data = await response.json() as {
      answer: string;
      citations: Array<{
        record_id: string;
        source: string;
        source_url: string;
        title: string | null;
        relevance_score: number;
        excerpt: string;
        anchor_proof: { chain_tx_id: string | null; content_hash: string } | null;
      }>;
      confidence: number;
      model: string;
      query: string;
    };

    return {
      answer: data.answer,
      citations: (data.citations ?? []).map((c) => ({
        recordId: c.record_id,
        source: c.source,
        sourceUrl: c.source_url,
        title: c.title,
        relevanceScore: c.relevance_score,
        excerpt: c.excerpt,
        anchorProof: c.anchor_proof
          ? { chainTxId: c.anchor_proof.chain_tx_id, contentHash: c.anchor_proof.content_hash }
          : null,
      })),
      confidence: data.confidence,
      model: data.model,
      query: data.query,
    };
  }

  // ── Internal fetch wrapper ──────────────────────────────────────────

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> ?? {}),
    };

    // Auth: API key
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    return globalThis.fetch(url, {
      ...init,
      headers,
    });
  }
}

/** SDK error with HTTP status code */
export class ArkovaError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'ArkovaError';
    this.statusCode = statusCode;
  }
}
