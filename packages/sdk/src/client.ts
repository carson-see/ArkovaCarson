/**
 * Arkova SDK Client (PH1-SDK-01 + INT-01)
 *
 * Main client class providing anchor, verify, batch verify, query, and
 * webhook management operations. Works in both Node.js and browser environments.
 */

import type {
  ArkovaConfig,
  AnchorReceipt,
  VerificationResult,
  NessieQueryResult,
  NessieContextResult,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  CreateWebhookInput,
  UpdateWebhookInput,
  PaginatedWebhooks,
  ProblemDetail,
  RetryConfig,
  RichVerificationFields,
  SearchOptions,
  SearchResponse,
  SearchResult,
  FingerprintVerification,
  AnchorDetails,
  OrganizationSummary,
  OrganizationDetails,
  RecordDetails,
  FingerprintDetails,
  DocumentDetails,
  AttestationDetails,
  AttestationEvidence,
  AttestorCredential,
} from './types';

const DEFAULT_BASE_URL = 'https://arkova-worker-270018525501.us-central1.run.app';

/**
 * Maximum public IDs per `verifyBatch()` call. Mirrors the worker's
 * SYNC_THRESHOLD in `services/worker/src/api/v1/batch.ts` — larger batches
 * are turned into async jobs on the server side and are not supported by
 * this SDK method yet (follow-up: INT-01b).
 */
export const VERIFY_BATCH_SYNC_LIMIT = 20;

const DEFAULT_RETRY_CONFIG: Required<Omit<RetryConfig, 'sleep'>> = {
  retries: 2,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
};

export class Arkova {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly x402Config?: ArkovaConfig['x402'];
  private readonly retry: Required<Omit<RetryConfig, 'sleep'>>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: ArkovaConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.x402Config = config.x402;
    this.retry = {
      retries: config.retry?.retries ?? DEFAULT_RETRY_CONFIG.retries,
      baseDelayMs: config.retry?.baseDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs,
      maxDelayMs: config.retry?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs,
    };
    this.sleep = config.retry?.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
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

    const result = await jsonOrThrow<{
      public_id: string;
      fingerprint: string;
      status: string;
      created_at: string;
      chain_tx_id?: string;
    }>(response, 'Anchor request failed');

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
    const result = await jsonOrThrow<Record<string, unknown>>(response, 'Verification failed');
    return mapVerificationResult(result);
  }

  /**
   * Verify multiple credentials in a single synchronous batch request (INT-01).
   *
   * Accepts up to {@link VERIFY_BATCH_SYNC_LIMIT} (20) public IDs per call.
   * Returns results in the same order as the input array. Each result has
   * the same shape as `verify()`.
   *
   * The worker switches to async job mode for requests larger than the
   * sync threshold and returns HTTP 202 with a `job_id` — the SDK does not
   * yet poll those jobs. For larger sets, split into chunks of 20 or track
   * async polling separately (tracked as INT-01b follow-up).
   *
   * Rate limit: 10 req/min per API key (batch tier).
   */
  async verifyBatch(publicIds: string[]): Promise<VerificationResult[]> {
    if (publicIds.length === 0) return [];
    if (publicIds.length > VERIFY_BATCH_SYNC_LIMIT) {
      throw new ArkovaError(
        `verifyBatch accepts at most ${VERIFY_BATCH_SYNC_LIMIT} public IDs per synchronous request. For larger batches, chunk the input or use the async /verify/batch job API directly.`,
        400,
        'batch_too_large',
      );
    }

    const response = await this.fetch('/api/v1/verify/batch', {
      method: 'POST',
      body: JSON.stringify({ public_ids: publicIds }),
    });

    // Server returns 202 with { job_id, total, expires_at } for async jobs.
    // This should not happen given the client-side cap above, but guard
    // defensively so the SDK never crashes on `.results.map()` of undefined.
    if (response.status === 202) {
      const job = await response.json().catch(() => ({})) as { job_id?: string };
      throw new ArkovaError(
        `verifyBatch received an async job response (job_id=${job.job_id ?? 'unknown'}). Reduce batch size to ${VERIFY_BATCH_SYNC_LIMIT} or fewer.`,
        202,
        'async_job_not_supported',
      );
    }

    const data = await jsonOrThrow<{ results: Array<Record<string, unknown>> }>(
      response,
      'Batch verification failed',
    );

    return data.results.map(mapVerificationResult);
  }

  /**
   * Search Arkova API v2 across organizations, records, fingerprints, and documents.
   * Requires a key with `read:search`.
   */
  async search(q: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const params = new URLSearchParams({ q });
    if (options.type) params.set('type', options.type);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.cursor) params.set('cursor', options.cursor);

    const response = await this.fetch(`/api/v2/search?${params.toString()}`);
    const data = await jsonOrThrow<{
      results: Array<Record<string, unknown>>;
      next_cursor: string | null;
    }>(response, 'Search failed');

    return {
      results: data.results.map(mapSearchResult),
      nextCursor: data.next_cursor,
    };
  }

  /**
   * Verify a SHA-256 document fingerprint through API v2.
   * Requires a key with `read:records`.
   */
  async verifyFingerprint(fingerprint: string): Promise<FingerprintVerification> {
    const response = await this.fetch(`/api/v2/verify/${encodeURIComponent(fingerprint)}`);
    const data = await jsonOrThrow<Record<string, unknown>>(response, 'Fingerprint verification failed');
    return mapFingerprintVerification(data);
  }

  /**
   * Fetch redacted public anchor metadata through API v2.
   * Requires a key with `read:records`.
   */
  async getAnchor(publicId: string): Promise<AnchorDetails> {
    const response = await this.fetch(`/api/v2/anchors/${encodeURIComponent(publicId)}`);
    const data = await jsonOrThrow<Record<string, unknown>>(response, 'Anchor lookup failed');
    return mapAnchorDetails(data);
  }

  /**
   * List the organization context attached to the current API key.
   * Requires a key with `read:orgs`.
   */
  async listOrgs(): Promise<OrganizationSummary[]> {
    const response = await this.fetch('/api/v2/orgs');
    const data = await jsonOrThrow<{ organizations: Array<Record<string, unknown>> }>(
      response,
      'Organization list failed',
    );
    return data.organizations.map(mapOrganizationSummary);
  }

  /**
   * Fetch a public attestation by public ID.
   *
   * By default this preserves the frozen v1 response shape. Pass
   * `{ includeCredentials: true }` to request the SCRUM-897 evidence array
   * plus the bounded attestor credential chain.
   */
  async getAttestation(
    publicId: string,
    options: { includeCredentials?: boolean } = {},
  ): Promise<AttestationDetails> {
    const suffix = options.includeCredentials ? '?include=credentials' : '';
    const response = await this.fetch(`/api/v1/attestations/${encodeURIComponent(publicId)}${suffix}`);
    const data = await jsonOrThrow<Record<string, unknown>>(response, 'Attestation lookup failed');
    return mapAttestationDetails(data);
  }

  /**
   * SCRUM-1584 — public-safe v2 detail surfaces.
   *
   * These call the `/api/v2/{organizations|records|fingerprints|documents}/{id}`
   * routes shipped by SCRUM-1132 (#672). Responses never carry the internal
   * `id`, `org_id`, `user_id`, or `record_id` columns.
   */

  /**
   * Fetch organization detail by public ID.
   * Requires a key with `read:orgs`.
   */
  async getOrganization(publicId: string): Promise<OrganizationDetails> {
    const response = await this.fetch(`/api/v2/organizations/${encodeURIComponent(publicId)}`);
    const data = await jsonOrThrow<Record<string, unknown>>(response, 'Organization lookup failed');
    return mapOrganizationDetails(data);
  }

  /**
   * Fetch record detail by Arkova public ID.
   * Requires a key with `read:records`.
   */
  async getRecord(publicId: string): Promise<RecordDetails> {
    const response = await this.fetch(`/api/v2/records/${encodeURIComponent(publicId)}`);
    const data = await jsonOrThrow<Record<string, unknown>>(response, 'Record lookup failed');
    return mapRecordDetails(data);
  }

  /**
   * Fetch fingerprint detail by exact SHA-256 fingerprint.
   * Requires a key with `read:records`.
   */
  async getFingerprint(fingerprint: string): Promise<FingerprintDetails> {
    const response = await this.fetch(`/api/v2/fingerprints/${encodeURIComponent(fingerprint)}`);
    const data = await jsonOrThrow<Record<string, unknown>>(response, 'Fingerprint lookup failed');
    return mapFingerprintDetails(data);
  }

  /**
   * Fetch document detail by Arkova public ID.
   * Requires a key with `read:records`.
   */
  async getDocument(publicId: string): Promise<DocumentDetails> {
    const response = await this.fetch(`/api/v2/documents/${encodeURIComponent(publicId)}`);
    const data = await jsonOrThrow<Record<string, unknown>>(response, 'Document lookup failed');
    return mapDocumentDetails(data);
  }

  /**
   * Webhook management namespace (INT-09).
   *
   * Programmable CRUD over webhook endpoints. Use these instead of the
   * Arkova web app to register, list, update, and delete webhook endpoints
   * for your organization.
   *
   * @example
   *   const arkova = new Arkova({ apiKey: 'ak_live_...' });
   *   const { id, secret } = await arkova.webhooks.create({
   *     url: 'https://api.example.com/hooks/arkova',
   *     events: ['anchor.secured', 'anchor.revoked'],
   *   });
   *   // Save `secret` immediately — it is shown only once.
   */
  readonly webhooks = {
    /**
     * Register a new webhook endpoint. Returns the signing secret ONCE.
     */
    create: async (input: CreateWebhookInput): Promise<WebhookEndpointWithSecret> => {
      const response = await this.fetch('/api/v1/webhooks', {
        method: 'POST',
        body: JSON.stringify({
          url: input.url,
          events: input.events,
          description: input.description,
          verify: input.verify,
        }),
      });
      const json = await jsonOrThrow<Record<string, unknown>>(response, 'Webhook creation failed');
      return mapWebhookWithSecret(json);
    },

    /**
     * List all webhook endpoints for the API key's organization.
     */
    list: async (options?: { limit?: number; offset?: number }): Promise<PaginatedWebhooks> => {
      const params = new URLSearchParams();
      if (options?.limit !== undefined) params.set('limit', String(options.limit));
      if (options?.offset !== undefined) params.set('offset', String(options.offset));
      const qs = params.toString();
      const response = await this.fetch(`/api/v1/webhooks${qs ? `?${qs}` : ''}`);
      const typed = await jsonOrThrow<{
        webhooks: Array<Record<string, unknown>>;
        total: number;
        limit: number;
        offset: number;
      }>(response, 'Webhook list failed');
      return {
        webhooks: typed.webhooks.map(mapWebhook),
        total: typed.total,
        limit: typed.limit,
        offset: typed.offset,
      };
    },

    /**
     * Get a single webhook endpoint by ID.
     */
    get: async (id: string): Promise<WebhookEndpoint> => {
      const response = await this.fetch(`/api/v1/webhooks/${encodeURIComponent(id)}`);
      const json = await jsonOrThrow<Record<string, unknown>>(response, 'Webhook get failed');
      return mapWebhook(json);
    },

    /**
     * Partially update a webhook endpoint. Provide any subset of
     * { url, events, description, isActive }.
     */
    update: async (id: string, input: UpdateWebhookInput): Promise<WebhookEndpoint> => {
      const body: Record<string, unknown> = {};
      if (input.url !== undefined) body.url = input.url;
      if (input.events !== undefined) body.events = input.events;
      if (input.description !== undefined) body.description = input.description;
      if (input.isActive !== undefined) body.is_active = input.isActive;

      const response = await this.fetch(`/api/v1/webhooks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const json = await jsonOrThrow<Record<string, unknown>>(response, 'Webhook update failed');
      return mapWebhook(json);
    },

    /**
     * Permanently delete a webhook endpoint. Cascades to its delivery logs.
     */
    delete: async (id: string): Promise<void> => {
      const response = await this.fetch(`/api/v1/webhooks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      // 204 has no body but Response.ok is true; jsonOrThrow handles the error case.
      if (!response.ok) {
        await jsonOrThrow(response, 'Webhook delete failed');
      }
    },

    /**
     * Send a synthetic test event to a registered endpoint to confirm
     * connectivity. Returns the delivery result.
     */
    test: async (endpointId: string): Promise<{ success: boolean; statusCode: number; eventId: string }> => {
      const response = await this.fetch('/api/v1/webhooks/test', {
        method: 'POST',
        body: JSON.stringify({ endpoint_id: endpointId }),
      });
      const typed = await jsonOrThrow<{ success: boolean; status_code: number; event_id: string }>(
        response,
        'Test webhook failed',
      );
      return { success: typed.success, statusCode: typed.status_code, eventId: typed.event_id };
    },
  };

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

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    const requestInit = { ...init, headers };
    const method = (requestInit.method ?? 'GET').toUpperCase();
    let attempt = 0;

    while (true) {
      try {
        const response = await globalThis.fetch(url, requestInit);
        if (!shouldRetryResponse(response) || attempt >= this.retry.retries) {
          return response;
        }
        await this.sleep(retryDelayMs(response, attempt, this.retry));
        attempt += 1;
      } catch (err) {
        if (!isSafeRetryMethod(method) || attempt >= this.retry.retries) {
          throw err;
        }
        await this.sleep(backoffDelayMs(attempt, this.retry));
        attempt += 1;
      }
    }
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────

function isSafeRetryMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function shouldRetryResponse(response: Response): boolean {
  return response.status === 429 || response.status === 500 || response.status === 502 ||
    response.status === 503 || response.status === 504;
}

function retryDelayMs(
  response: Response,
  attempt: number,
  retry: Required<Omit<RetryConfig, 'sleep'>>,
): number {
  const retryAfter = parseRetryAfter(getHeader(response, 'Retry-After'));
  return retryAfter ?? backoffDelayMs(attempt, retry);
}

function backoffDelayMs(attempt: number, retry: Required<Omit<RetryConfig, 'sleep'>>): number {
  return Math.min(retry.maxDelayMs, retry.baseDelayMs * (2 ** attempt));
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

function getHeader(response: Response, name: string): string | null {
  return typeof response.headers?.get === 'function'
    ? response.headers.get(name)
    : null;
}

/**
 * Parse a fetch Response as JSON; throw a typed ArkovaError with the
 * server's machine-readable `error` code if the status is not 2xx.
 */
async function jsonOrThrow<T>(response: Response, failureLabel: string): Promise<T> {
  const json = (await response.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
    type?: string;
    title?: string;
    status?: number;
    detail?: string;
    instance?: string;
  } & T;
  if (!response.ok) {
    const problem = isProblemDetail(json)
      ? {
          type: json.type,
          title: json.title,
          status: json.status,
          detail: json.detail,
          instance: json.instance,
        }
      : undefined;
    const retryAfter = parseRetryAfter(getHeader(response, 'Retry-After')) ?? undefined;
    // Prefer server `message`, fall back to legacy endpoints that only send `error`,
    // then to a generic label. Code field is carried on the error for programmatic checks.
    throw new ArkovaError(
      problem?.detail ?? json.message ?? json.error ?? `${failureLabel}: HTTP ${response.status}`,
      response.status,
      json.error ?? (problem ? problem.type.split('/').pop() : undefined),
      problem,
      retryAfter !== undefined ? Math.ceil(retryAfter / 1000) : undefined,
    );
  }
  return json as T;
}

function isProblemDetail(value: unknown): value is ProblemDetail {
  return typeof value === 'object' &&
    value !== null &&
    typeof (value as ProblemDetail).type === 'string' &&
    typeof (value as ProblemDetail).title === 'string' &&
    typeof (value as ProblemDetail).status === 'number';
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function nullableRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function mapRichVerificationFields(row: Record<string, unknown>): RichVerificationFields {
  return {
    description: nullableString(row.description),
    complianceControls: nullableRecord(row.compliance_controls),
    chainConfirmations: nullableNumber(row.chain_confirmations),
    parentPublicId: nullableString(row.parent_public_id),
    versionNumber: nullableNumber(row.version_number),
    revocationTxId: nullableString(row.revocation_tx_id),
    revocationBlockHeight: nullableNumber(row.revocation_block_height),
    fileMime: nullableString(row.file_mime),
    fileSize: nullableNumber(row.file_size),
    confidenceScores: nullableRecord(row.confidence_scores),
    subType: nullableString(row.sub_type),
  };
}

/** Shape a snake_case verification row from the REST API into camelCase. */
function mapVerificationResult(row: Record<string, unknown>): VerificationResult {
  return {
    ...mapRichVerificationFields(row),
    verified: row.verified as boolean,
    status: row.status as VerificationResult['status'],
    issuerName: row.issuer_name as string,
    credentialType: row.credential_type as string,
    issuedDate: (row.issued_date as string | null) ?? null,
    expiryDate: (row.expiry_date as string | null) ?? null,
    anchorTimestamp: row.anchor_timestamp as string,
    networkReceiptId: (row.network_receipt_id as string | null) ?? null,
    recordUri: row.record_uri as string,
  };
}

function mapSearchResult(row: Record<string, unknown>): SearchResult {
  return {
    type: row.type as SearchResult['type'],
    id: row.id as string,
    publicId: row.public_id as string,
    score: row.score as number,
    snippet: row.snippet as string,
    metadata: row.metadata as Record<string, unknown> | undefined,
  };
}

function mapFingerprintVerification(row: Record<string, unknown>): FingerprintVerification {
  return {
    ...mapRichVerificationFields(row),
    verified: row.verified as boolean,
    status: row.status as string,
    fingerprint: row.fingerprint as string,
    publicId: (row.public_id as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    anchorTimestamp: (row.anchor_timestamp as string | null) ?? null,
    networkReceiptId: (row.network_receipt_id as string | null) ?? null,
    recordUri: (row.record_uri as string | null) ?? null,
  };
}

function mapAnchorDetails(row: Record<string, unknown>): AnchorDetails {
  return {
    ...mapRichVerificationFields(row),
    publicId: row.public_id as string,
    verified: row.verified as boolean,
    status: row.status as string,
    issuerName: row.issuer_name as string,
    credentialType: row.credential_type as string,
    issuedDate: (row.issued_date as string | null) ?? null,
    expiryDate: (row.expiry_date as string | null) ?? null,
    anchorTimestamp: (row.anchor_timestamp as string | null) ?? null,
    networkReceiptId: (row.network_receipt_id as string | null) ?? null,
    recordUri: row.record_uri as string,
    jurisdiction: row.jurisdiction as string | null | undefined,
  };
}

function mapOrganizationSummary(row: Record<string, unknown>): OrganizationSummary {
  return {
    id: row.id as string,
    publicId: row.public_id as string,
    displayName: row.display_name as string,
    domain: (row.domain as string | null) ?? null,
    websiteUrl: (row.website_url as string | null) ?? null,
    verificationStatus: (row.verification_status as string | null) ?? null,
  };
}

function mapOrganizationDetails(row: Record<string, unknown>): OrganizationDetails {
  return {
    // The v2 detail endpoint never returns the internal `id` UUID; the field
    // is kept as an empty string for OrganizationSummary compatibility and
    // callers should use `publicId`.
    id: '',
    publicId: row.public_id as string,
    displayName: row.display_name as string,
    domain: (row.domain as string | null) ?? null,
    websiteUrl: (row.website_url as string | null) ?? null,
    verificationStatus: (row.verification_status as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    industryTag: (row.industry_tag as string | null) ?? null,
    orgType: (row.org_type as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    logoUrl: (row.logo_url as string | null) ?? null,
  };
}

function mapRecordDetails(row: Record<string, unknown>): RecordDetails {
  return {
    publicId: (row.public_id as string | null) ?? null,
    verified: row.verified as boolean,
    status: row.status as string,
    fingerprint: (row.fingerprint as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    issuerName: (row.issuer_name as string | null) ?? null,
    credentialType: (row.credential_type as string | null) ?? null,
    subType: (row.sub_type as string | null) ?? null,
    issuedDate: (row.issued_date as string | null) ?? null,
    expiryDate: (row.expiry_date as string | null) ?? null,
    anchorTimestamp: (row.anchor_timestamp as string | null) ?? null,
    networkReceiptId: (row.network_receipt_id as string | null) ?? null,
    recordUri: (row.record_uri as string | null) ?? null,
  };
}

function mapFingerprintDetails(row: Record<string, unknown>): FingerprintDetails {
  return {
    ...mapRecordDetails(row),
    fingerprint: row.fingerprint as string,
  };
}

function mapDocumentDetails(row: Record<string, unknown>): DocumentDetails {
  return mapRecordDetails(row);
}

function mapAttestationEvidence(row: Record<string, unknown>): AttestationEvidence {
  return {
    publicId: row.public_id as string,
    evidenceType: row.evidence_type as string,
    description: (row.description as string | null) ?? null,
    fingerprint: row.fingerprint as string,
    mime: (row.mime as string | null) ?? null,
    size: (row.size as number | null) ?? null,
    createdAt: row.created_at as string,
  };
}

function mapAttestorCredential(row: Record<string, unknown>): AttestorCredential {
  const proof = row.chain_proof as Record<string, unknown> | null | undefined;
  return {
    publicId: row.public_id as string,
    credentialType: (row.credential_type as string | null) ?? null,
    status: row.status as string,
    fingerprint: (row.fingerprint as string | null) ?? null,
    versionNumber: (row.version_number as number | null) ?? null,
    parentPublicId: (row.parent_public_id as string | null) ?? null,
    isCurrent: Boolean(row.is_current),
    chainProof: proof ? {
      txId: proof.tx_id as string,
      blockHeight: (proof.block_height as number | null) ?? null,
      timestamp: (proof.timestamp as string | null) ?? null,
      explorerUrl: (proof.explorer_url as string | null) ?? null,
    } : null,
    recordUri: row.record_uri as string,
  };
}

function mapAttestationDetails(row: Record<string, unknown>): AttestationDetails {
  const linked = row.linked_credential as Record<string, unknown> | null | undefined;
  const attestorCredentials = row.attestor_credentials as Array<Record<string, unknown>> | undefined;
  const details: AttestationDetails = {
    publicId: row.public_id as string,
    attestationType: row.attestation_type as string,
    status: row.status as string,
    subjectType: row.subject_type as string,
    subjectIdentifier: row.subject_identifier as string,
    attester: row.attester as AttestationDetails['attester'],
    claims: row.claims as AttestationDetails['claims'],
    summary: (row.summary as string | null) ?? null,
    fingerprint: (row.fingerprint as string | null) ?? null,
    evidenceFingerprint: (row.evidence_fingerprint as string | null) ?? null,
    evidence: ((row.evidence as Array<Record<string, unknown>> | undefined) ?? []).map(mapAttestationEvidence),
    evidenceCount: row.evidence_count as number,
    linkedCredential: linked ? {
      publicId: linked.public_id as string,
      credentialType: (linked.credential_type as string | null) ?? null,
      verificationStatus: linked.verification_status as string,
      verifyUrl: linked.verify_url as string,
    } : null,
    attestorCredentials: attestorCredentials?.map(mapAttestorCredential),
    issuedAt: row.issued_at as string,
    expiresAt: (row.expires_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
    revocationReason: (row.revocation_reason as string | null) ?? null,
    createdAt: row.created_at as string,
    verifyUrl: row.verify_url as string,
  };

  if ('jurisdiction' in row) {
    details.jurisdiction = (row.jurisdiction as string | null) ?? null;
  }

  return details;
}

/**
 * SDK error with HTTP status code and machine-readable error code.
 *
 * @example
 *   try {
 *     await arkova.webhooks.create({ url: 'http://insecure.example.com' });
 *   } catch (err) {
 *     if (err instanceof ArkovaError && err.code === 'invalid_url') {
 *       // handle the specific failure
 *     }
 *   }
 */
export class ArkovaError extends Error {
  /** HTTP status code returned by the API */
  readonly statusCode: number;
  /** Machine-readable error code (e.g., 'validation_error', 'not_found', 'invalid_url') */
  readonly code?: string;
  /** RFC 7807 problem payload when returned by API v2 */
  readonly problem?: ProblemDetail;
  /** Retry-After value in seconds when the server asks the client to back off */
  readonly retryAfter?: number;

  constructor(
    message: string,
    statusCode: number,
    code?: string,
    problem?: ProblemDetail,
    retryAfter?: number,
  ) {
    super(message);
    this.name = 'ArkovaError';
    this.statusCode = statusCode;
    this.code = code;
    this.problem = problem;
    this.retryAfter = retryAfter;
  }
}

// ─── Internal mappers (snake_case → camelCase) ──────────────────────────

function mapWebhook(row: Record<string, unknown>): WebhookEndpoint {
  return {
    id: row.id as string,
    url: row.url as string,
    events: row.events as WebhookEndpoint['events'],
    isActive: row.is_active as boolean,
    description: (row.description as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapWebhookWithSecret(row: Record<string, unknown>): WebhookEndpointWithSecret {
  return {
    ...mapWebhook(row),
    secret: row.secret as string,
    warning: row.warning as string,
  };
}
