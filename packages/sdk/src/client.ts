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
  BulkAnchorInput,
  AnchorBulkOptions,
  BulkAnchorResponse,
  BulkAnchorDuplicate,
  BulkAnchorRowError,
  BulkAnchorResultRow,
  AnchorInstantStatus,
  AnchorLifecycleStatus,
  OrganizationSummary,
  OrganizationDetails,
  RecordDetails,
  FingerprintDetails,
  DocumentDetails,
  AttestationDetails,
  AttestationEvidence,
  AttestorCredential,
  MerkleProofResponse,
  MerkleProofEntry,
  ProofBundle,
  ProofBundleSignature,
  AnchorImportRow,
  AnchorImportOptions,
  AnchorImportResponse,
  AnchorImportResultRow,
  Folder,
  CreateFolderInput,
  BulkFolderMoveResult,
  Agent,
  AgentKeyCreated,
  AgentKeySummary,
  AgentRevocation,
  CreateAgentInput,
  UpdateAgentInput,
  ComputeIdAdmissionInput,
  ComputeIdAdmissionResult,
} from './types';
import { BULK_ANCHOR_CREDENTIAL_TYPES } from './types';

const ANCHOR_LIFECYCLE_STATUSES = new Set<AnchorLifecycleStatus>([
  'PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'REVOKED', 'EXPIRED',
  'SUPERSEDED', 'PENDING_RESOLUTION',
]);
const ANCHOR_INSTANT_STATUSES = new Set<AnchorInstantStatus>([
  'QUEUED', 'PROCESSING', 'NEEDS_CREDIT', 'RETRYABLE', 'HELD', 'SUBMITTED', 'FAILED',
]);

function isAnchorLifecycleStatus(value: unknown): value is AnchorLifecycleStatus {
  return typeof value === 'string' && ANCHOR_LIFECYCLE_STATUSES.has(value as AnchorLifecycleStatus);
}

function isAnchorInstantStatus(value: unknown): value is AnchorInstantStatus {
  return typeof value === 'string' && ANCHOR_INSTANT_STATUSES.has(value as AnchorInstantStatus);
}

const DEFAULT_BASE_URL = 'https://api.arkova.ai';

/**
 * Maximum public IDs per `verifyBatch()` call. Mirrors the worker's
 * SYNC_THRESHOLD in `services/worker/src/api/v1/batch.ts` — larger batches
 * are turned into async jobs on the server side and are not supported by
 * this SDK method yet (follow-up: INT-01b).
 */
export const VERIFY_BATCH_SYNC_LIMIT = 20;

/**
 * Maximum rows per `anchorBulk()` call. Mirrors the worker's
 * `BulkAnchorRequestSchema.anchors` cap in
 * `services/worker/src/api/v1/anchor-bulk.ts` (`.max(1000)`), which bounds
 * validation cost (O(n²) intra-batch duplicate detection) server-side.
 *
 * The SDK throws client-side rather than auto-chunking: chunking would split
 * duplicate detection across requests (a fingerprint repeated across chunk
 * boundaries would only be caught by the slower DB-side check, not the
 * cheaper intra-batch check) and would deduct credits per chunk with no
 * atomicity across the whole logical batch. Same posture as `verifyBatch()`.
 */
export const BULK_ANCHOR_MAX_ROWS = 1000;
export const ANCHOR_IMPORT_MAX_ROWS = 100;

const DEFAULT_RETRY_CONFIG: Required<Omit<RetryConfig, 'sleep'>> = {
  retries: 2,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
};

type WireAgent = Record<string, unknown>;
const unexpectedAgentResponse = (): never => { throw new ArkovaError('Arkova API returned an unexpected response shape', 502, 'unexpected_response'); };
const stringArray = (value: unknown): string[] | null => Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null;
const recordValue = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const AGENT_TYPES = new Set(['llm_agent', 'ats_integration', 'hr_platform', 'compliance_tool', 'custom']);
const AGENT_SCOPES = new Set(['read:records', 'read:orgs', 'read:search', 'write:anchors', 'admin:rules', 'verify', 'verify:batch', 'usage:read', 'keys:manage', 'compliance:read', 'compliance:write', 'oracle:read', 'oracle:write', 'anchor:write', 'anchor:read', 'attestations:write', 'attestations:read', 'webhooks:manage', 'agents:manage', 'keys:read', 'orgs:manage']);
const COMPUTEID_SCOPES = new Set(['verify', 'verify:batch', 'anchor:write', 'write:anchors', 'anchor:read', 'read:records', 'read:search']);
const invalidAgentInput = (message: string): never => { throw new ArkovaError(message, 400, 'invalid_request'); };
function validateScopes(scopes: readonly unknown[] | undefined, allowed = AGENT_SCOPES): void {
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 32 || scopes.some((scope) => typeof scope !== 'string' || !allowed.has(scope)))) invalidAgentInput('Invalid agent scope');
}
function validateCallback(value: unknown): void {
  if (value === undefined || value === null) return;
  try {
    const parsed = new URL(typeof value === 'string' ? value : '');
    if (parsed.protocol !== 'https:' || !parsed.hostname) invalidAgentInput('Agent callback URL must use HTTPS');
  } catch { invalidAgentInput('Agent callback URL must be a valid HTTPS URL'); }
}
function validateReceipt(passportId: unknown, receipt: unknown): void {
  const value = recordValue(receipt);
  if (typeof passportId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(passportId)
      || !value || typeof value.passport_id !== 'string' || value.passport_id.toLowerCase() !== passportId.toLowerCase()
      || typeof value.status !== 'string' || value.status.length < 1 || value.status.length > 32
      || (value.signature_valid !== undefined && value.signature_valid !== null && typeof value.signature_valid !== 'boolean')
      || !['issued_at', 'expires_at'].every((key) => typeof value[key] === 'string' && (value[key] as string).length <= 64 && Number.isFinite(Date.parse(value[key] as string)))
      || typeof value.key_id !== 'string' || !/^[0-9a-f]{16}$/.test(value.key_id)
      || typeof value.receipt_signature !== 'string' || value.receipt_signature.length < 1 || value.receipt_signature.length > 4096
      || typeof value.receipt_algorithm !== 'string' || value.receipt_algorithm.length < 1 || value.receipt_algorithm.length > 32
      || typeof value.receipt_payload !== 'string' || value.receipt_payload.length < 2 || value.receipt_payload.length > 16_384) {
    invalidAgentInput('Invalid ComputeID admission receipt');
  }
}

function mapAgentKeySummary(value: Record<string, unknown>): AgentKeySummary {
  const scopes = stringArray(value.scopes);
  if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.key_prefix !== 'string'
      || !scopes || typeof value.is_active !== 'boolean' || typeof value.created_at !== 'string') unexpectedAgentResponse();
  return {
    id: value.id as string, name: value.name as string, keyPrefix: value.key_prefix as string, scopes: scopes!, isActive: value.is_active as boolean,
    lastUsedAt: typeof value.last_used_at === 'string' ? value.last_used_at : null,
    createdAt: value.created_at as string, expiresAt: typeof value.expires_at === 'string' ? value.expires_at : null,
  };
}

function mapAgent(value: WireAgent): Agent {
  if (!recordValue(value)) unexpectedAgentResponse();
  const scopes = stringArray(value.allowed_scopes);
  const metadata = value.metadata == null ? {} : recordValue(value.metadata);
  if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.agent_type !== 'string'
      || !['active', 'suspended', 'revoked'].includes(String(value.status)) || !scopes || !metadata) unexpectedAgentResponse();
  if (value.api_keys !== undefined && (!Array.isArray(value.api_keys) || value.api_keys.some((v) => !recordValue(v)))) unexpectedAgentResponse();
  return {
    id: value.id as string, name: value.name as string, description: typeof value.description === 'string' ? value.description : null,
    agentType: value.agent_type as string, status: value.status as Agent['status'],
    allowedScopes: scopes!, framework: typeof value.framework === 'string' ? value.framework : null,
    version: typeof value.version === 'string' ? value.version : null, callbackUrl: typeof value.callback_url === 'string' ? value.callback_url : null,
    metadata: metadata!,
    ...(Array.isArray(value.api_keys) ? { apiKeys: value.api_keys.map((v: unknown) => mapAgentKeySummary(v as Record<string, unknown>)) } : {}),
  };
}

function mapAgentKeyCreated(value: Record<string, unknown>): AgentKeyCreated {
  const scopes = stringArray(value.scopes);
  if (!recordValue(value) || typeof value.key !== 'string' || value.key.length === 0 || typeof value.key_id !== 'string' || value.key_id.length === 0 || typeof value.key_prefix !== 'string' || value.key_prefix.length === 0
      || typeof value.agent_id !== 'string' || typeof value.agent_name !== 'string' || !scopes
      || typeof value.created_at !== 'string' || typeof value.warning !== 'string') unexpectedAgentResponse();
  return {
    key: value.key as string, keyId: value.key_id as string, keyPrefix: value.key_prefix as string,
    agentId: value.agent_id as string, agentName: value.agent_name as string, scopes: scopes!,
    createdAt: value.created_at as string,
    warning: value.warning as string,
  };
}

export class Arkova {
  private readonly baseUrl: string;
  // ECMAScript private fields (not TS `private`): a `private` class member is
  // still an own, enumerable property at runtime, so `JSON.stringify(client)`
  // and `Object.keys(client)` would otherwise leak the raw API key and the
  // x402 payer address. `#`-fields are truly inaccessible outside the class
  // body and are never enumerated by either. Requires target >= ES2022
  // (packages/sdk/tsconfig.json already sets `"target": "ES2022"`).
  #apiKey?: string;
  #x402Config?: ArkovaConfig['x402'];
  private readonly retry: Required<Omit<RetryConfig, 'sleep'>>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: ArkovaConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#apiKey = config.apiKey;
    this.#x402Config = config.x402;
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
   * Call an Arkova API path with the client's authentication, retry policy,
   * and typed error handling. Paths must be root-relative so credentials can
   * never be redirected to another origin.
   */
  async request<T = unknown>(
    path: string,
    init?: RequestInit,
    options?: { idempotent?: boolean },
  ): Promise<T> {
    let decodedPath = '';
    try {
      decodedPath = decodeURIComponent(path);
    } catch {
      throw new ArkovaError('API request path must be root-relative', 400, 'invalid_request_path');
    }
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decodedPath)) {
      throw new ArkovaError('API request path must be root-relative', 400, 'invalid_request_path');
    }
    try {
      const configured = new URL(this.baseUrl);
      if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password) {
        throw new Error();
      }
      if (new URL(path, `${this.baseUrl}/`).origin !== configured.origin) throw new Error();
    } catch {
      throw new ArkovaError('API request path must stay on the configured origin', 400, 'invalid_request_path');
    }
    const response = await this.fetch(path, { ...init, redirect: 'error' }, options);
    return jsonOrThrow<T>(response, 'API request failed');
  }

  /**
   * Anchor data — compute fingerprint and submit for network anchoring.
   * Returns a receipt that can be used later for verification.
   */
  async anchor(data: string | ArrayBuffer, options: import('./types').AnchorSubmitOptions = {}): Promise<AnchorReceipt> {
    const fp = await this.fingerprint(data);

    // Idempotent server-side: the same fingerprint returns the same publicId
    // (README "Idempotency"), so a transient 429/5xx is safe to retry.
    const response = await this.fetch('/api/v1/anchor', {
      method: 'POST',
      body: JSON.stringify({
        fingerprint: fp,
        ...(options.description ? { description: options.description } : {}),
        ...(options.action ? { action: options.action } : {}),
        ...(options.privateTags ? { private_tags: options.privateTags } : {}),
      }),
    }, { idempotent: true });

    const result = await jsonOrThrow<{
      public_id: string;
      fingerprint: string;
      status: string;
      created_at: string;
      chain_tx_id?: string;
      action?: 'queue' | 'instant';
      credit_state?: 'pending' | 'spent' | 'refunded' | null;
      instant_status?: string | null;
      idempotent?: boolean;
    }>(response, 'Anchor request failed');

    if (!isAnchorLifecycleStatus(result.status)) {
      throw new ArkovaError('Anchor response was malformed', 502, 'invalid_response');
    }

    return {
      publicId: result.public_id,
      fingerprint: result.fingerprint,
      status: result.status,
      createdAt: result.created_at,
      networkReceiptId: result.chain_tx_id,
      action: result.action,
      creditState: result.credit_state,
      instantStatus: result.instant_status,
      idempotent: result.idempotent,
    };
  }

  /** Read the caller-scoped durable queue/instant submission state. */
  async getAnchorSubmissionStatus(publicId: string): Promise<import('./types').AnchorSubmissionStatus> {
    const response = await this.fetch(`/api/v1/anchor/${encodeURIComponent(publicId)}/submission-status`);
    const result = await jsonOrThrow<{
      public_id: string;
      action: 'queue' | 'instant';
      anchor_status: unknown;
      credit_state: 'pending' | 'spent' | 'refunded' | null;
      instant_status: unknown;
      retryable: boolean;
      updated_at: string;
    }>(response, 'Submission status request failed');
    if (!isAnchorLifecycleStatus(result.anchor_status)
      || (result.instant_status !== null && !isAnchorInstantStatus(result.instant_status))) {
      throw new ArkovaError('Submission status response was malformed', 502, 'invalid_response');
    }
    return {
      publicId: result.public_id,
      action: result.action,
      anchorStatus: result.anchor_status,
      creditState: result.credit_state,
      instantStatus: result.instant_status,
      retryable: result.retryable,
      updatedAt: result.updated_at,
    };
  }

  /**
   * Bulk-anchor up to {@link BULK_ANCHOR_MAX_ROWS} (1000) documents in a
   * single request (HAKI-REQ-02 / SCRUM-1171).
   *
   * Each row must provide exactly one of:
   *   - `fingerprint` — a pre-computed 64-char hex SHA-256 you already have
   *     (e.g. from a batch job that hashed files independently), or
   *   - `data` — raw string/binary content the SDK fingerprints client-side
   *     via the same {@link Arkova.fingerprint} helper `anchor()` uses, so
   *     the document body never leaves this process for that row.
   *
   * Mixing both forms in one call is supported (see example below).
   *
   * @example
   *   const result = await arkova.anchorBulk([
   *     { fingerprint: 'abc123...64hex', externalId: 'invoice-001' },
   *     { data: fileBytes, documentType: 'contract', matterOrCaseRef: 'CASE-42' },
   *   ], { duplicateStrategy: 'skip', batchId: 'nightly-2026-07-28' });
   *
   *   console.log(result.queued, result.duplicates, result.errors);
   *
   * @param options.dryRun Validate every row (including dedup checks) without
   *   queuing or deducting credits. `result.anchors` is omitted on dry runs.
   * @param options.duplicateStrategy How to handle a fingerprint that already
   *   exists in-batch or in the org. Server default: `'fail'` (409s the
   *   whole batch on any duplicate) — pass `'skip' | 'supersede' | 'link'`
   *   to proceed instead.
   * @throws {ArkovaError} `code: 'batch_too_large'` if more than
   *   {@link BULK_ANCHOR_MAX_ROWS} rows are supplied (no network call made).
   * @throws {ArkovaError} `code: 'invalid_request'` if a row supplies neither
   *   `fingerprint` nor `data`, or supplies both (no network call made).
   * @throws {ArkovaError} `code: 'duplicate_fingerprints'` (HTTP 409) if
   *   `duplicateStrategy` is `'fail'` (or omitted) and the batch contains
   *   duplicates — `err.problem` is undefined here; inspect the thrown
   *   error's `message`, or pre-check with `{ dryRun: true }`.
   */
  async anchorBulk(
    inputs: BulkAnchorInput[],
    options: AnchorBulkOptions = {},
  ): Promise<BulkAnchorResponse> {
    if (inputs.length === 0) {
      return {
        batchId: options.batchId ?? null,
        validated: 0,
        queued: 0,
        duplicates: [],
        errors: [],
        dryRun: options.dryRun ?? false,
        anchors: [],
      };
    }

    if (inputs.length > BULK_ANCHOR_MAX_ROWS) {
      throw new ArkovaError(
        `anchorBulk accepts at most ${BULK_ANCHOR_MAX_ROWS} rows per call. ` +
          'Split into multiple calls (each with its own or a shared batchId to correlate them in audit events).',
        400,
        'batch_too_large',
      );
    }

    const rows = await Promise.all(inputs.map((input, i) => this.buildBulkAnchorRow(input, i)));

    // Idempotent server-side on fingerprint (same rule as `anchor`), so a
    // transient 429/5xx is safe to retry.
    const response = await this.fetch('/api/v1/anchor/bulk', {
      method: 'POST',
      body: JSON.stringify({
        anchors: rows,
        dry_run: options.dryRun,
        duplicate_strategy: options.duplicateStrategy,
        batch_id: options.batchId,
      }),
    }, { idempotent: true });

    const result = await jsonOrThrow<{
      batch_id: string | null;
      validated: number;
      queued: number;
      duplicates: Array<Record<string, unknown>>;
      errors: Array<Record<string, unknown>>;
      dry_run: boolean;
      anchors?: Array<Record<string, unknown>>;
    }>(response, 'Bulk anchor request failed');

    return mapBulkAnchorResponse(result);
  }

  /** Import 1–100 already-fingerprinted spreadsheet rows through the canonical submission contract. */
  async anchorImport(rows: AnchorImportRow[], options: AnchorImportOptions): Promise<AnchorImportResponse> {
    if (rows.length < 1 || rows.length > ANCHOR_IMPORT_MAX_ROWS) {
      throw new ArkovaError(`anchorImport accepts 1–${ANCHOR_IMPORT_MAX_ROWS} rows`, 400, 'invalid_request');
    }
    if (options.description !== undefined && options.description.length > 1000) {
      throw new ArkovaError('anchorImport description exceeds 1000 characters', 400, 'invalid_request');
    }
    if (options.action !== 'queue' && options.action !== 'instant') throw new ArkovaError('anchorImport action must be queue or instant', 400, 'invalid_request');
    const credentialTypes = new Set<string>(BULK_ANCHOR_CREDENTIAL_TYPES);
    const wireRows = rows.map((row, index) => {
      // The worker requires a POSITIVE file_size, so a 0 used to pass here and
      // then fail server-side for the WHOLE request (#3034 review).
      if (row.fileSize !== undefined && (!Number.isInteger(row.fileSize) || row.fileSize < 1)) {
        throw new ArkovaError(`anchorImport row ${index}: file_size must be a positive integer`, 400, 'invalid_request');
      }
      if (!/^[a-fA-F0-9]{64}$/.test(row.fingerprint) || row.filename.length < 1 || row.filename.length > 255
        || typeof row.fingerprintProvided !== 'boolean'
        || (row.credentialType !== undefined && !credentialTypes.has(row.credentialType))) {
        throw new ArkovaError(`anchorImport row ${index} is invalid`, 400, 'invalid_request');
      }
      return {
        fingerprint: row.fingerprint.toLowerCase(), filename: row.filename,
        fingerprint_provided: row.fingerprintProvided,
        ...(row.fileSize === undefined ? {} : { file_size: row.fileSize }),
        ...(row.credentialType === undefined ? {} : { credential_type: row.credentialType }),
        ...(row.metadata === undefined ? {} : { metadata: row.metadata }),
        ...(row.recipientEmail === undefined ? {} : { recipient_email: row.recipientEmail }),
        ...(row.recipientName === undefined ? {} : { recipient_name: row.recipientName }),
      };
    });
    // Write retries are intentionally disabled: a lost response may contain durable per-row receipts.
    const response = await this.fetch('/api/v1/anchor/import', {
      method: 'POST',
      body: JSON.stringify({
        action: options.action,
        rows: wireRows,
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.privateTags === undefined ? {} : { private_tags: options.privateTags }),
      }),
    });
    const result = await jsonOrThrow<{
      total: number; created: number; skipped: number; failed: number;
      recipient_link_failed?: number;
      results: Array<{ fingerprint: string; status: AnchorImportResultRow['status']; public_id?: string; instant_status?: AnchorInstantStatus | null; reason?: string }>;
    }>(response, 'Anchor import failed');
    // Mapped explicitly rather than spread so the snake_case counter never
    // leaks onto the typed surface alongside its camelCase twin. Older workers
    // omit it; absent means no row hit a recipient-link failure.
    return {
      total: result.total,
      created: result.created,
      skipped: result.skipped,
      failed: result.failed,
      recipientLinkFailed: result.recipient_link_failed ?? 0,
      results: result.results.map((row) => ({
        fingerprint: row.fingerprint, status: row.status, publicId: row.public_id,
        instantStatus: row.instant_status, reason: row.reason,
      })),
    };
  }

  /** Shape one `anchorBulk()` input into the wire (snake_case) row shape, fingerprinting `data` rows client-side. */
  private async buildBulkAnchorRow(input: BulkAnchorInput, index: number): Promise<Record<string, unknown>> {
    const hasFingerprint = input.fingerprint !== undefined;
    const hasData = input.data !== undefined;
    if (hasFingerprint === hasData) {
      throw new ArkovaError(
        `anchorBulk row ${index}: provide exactly one of "fingerprint" or "data"${hasFingerprint ? ' (both were given)' : ' (neither was given)'}.`,
        400,
        'invalid_request',
      );
    }

    const fingerprint = hasFingerprint ? (input.fingerprint as string) : await this.fingerprint(input.data as string | ArrayBuffer);

    const row: Record<string, unknown> = { fingerprint };
    if (input.credentialType !== undefined) row.credential_type = input.credentialType;
    if (input.description !== undefined) row.description = input.description;
    if (input.originalDocumentDate !== undefined) row.original_document_date = input.originalDocumentDate;
    if (input.documentType !== undefined) row.document_type = input.documentType;
    if (input.matterOrCaseRef !== undefined) row.matter_or_case_ref = input.matterOrCaseRef;
    if (input.externalId !== undefined) row.external_id = input.externalId;
    return row;
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
          anchorTimestamp: null,
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

    // A read expressed as POST (the body carries the ID list) and served on
    // the 10 req/min batch tier — retrying a 429/5xx creates nothing.
    const response = await this.fetch('/api/v1/verify/batch', {
      method: 'POST',
      body: JSON.stringify({ public_ids: publicIds }),
    }, { idempotent: true });

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
   * PROOF-05 (SCRUM-2338): fetch the Merkle inclusion proof for a batch-anchored
   * document, including the additive nullable {@link ProofBundle} — the
   * self-contained, independently-checkable two-layer proof. `proofBundle` is
   * `null` when the proof is incomplete (e.g. not yet block-confirmed).
   *
   * Anonymous or `verify`-scoped.
   */
  async getMerkleProof(publicId: string): Promise<MerkleProofResponse> {
    const response = await this.fetch(`/api/v1/verify/${encodeURIComponent(publicId)}/proof`);
    const data = await jsonOrThrow<Record<string, unknown>>(response, 'Merkle proof lookup failed');
    return mapMerkleProofResponse(data);
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

  /** Nested personal and organization folder management (SCRUM-5142). */
  readonly folders = {
    list: async (options: {
      ownerScope?: 'USER' | 'ORG'; ownerUserId?: string; orgId?: string; contextOrgId?: string;
    } = {}): Promise<Folder[]> => {
      const params = new URLSearchParams({ owner_scope: options.ownerScope ?? 'ORG' });
      if (options.ownerUserId) params.set('owner_user_id', options.ownerUserId);
      if (options.orgId) params.set('org_id', options.orgId);
      if (options.contextOrgId) params.set('context_org_id', options.contextOrgId);
      const response = await this.fetch(`/api/v1/folders?${params}`);
      const body = await jsonOrThrow<{ folders: Array<Record<string, unknown>> }>(response, 'Folder list failed');
      return body.folders.map(mapFolder);
    },
    create: async (input: CreateFolderInput): Promise<Folder> => {
      const response = await this.fetch('/api/v1/folders', { method: 'POST', body: JSON.stringify({
        name: input.name, owner_scope: input.ownerScope, org_id: input.orgId,
        context_org_id: input.contextOrgId, parent_folder_id: input.parentFolderId,
      }) });
      const body = await jsonOrThrow<{ folder: Record<string, unknown> }>(response, 'Folder creation failed');
      return mapFolder(body.folder);
    },
    update: async (id: string, patch: { name?: string; parentFolderId?: string | null }): Promise<Folder> => {
      const response = await this.fetch(`/api/v1/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify({ name: patch.name, parent_folder_id: patch.parentFolderId }),
      });
      const body = await jsonOrThrow<{ folder: Record<string, unknown> }>(response, 'Folder update failed');
      return mapFolder(body.folder);
    },
    bindConnector: async (id: string, binding: {
      provider: 'google_drive' | 'docusign' | null; sourceId: string | null; connectionId: string | null;
    }): Promise<Folder> => {
      const response = await this.fetch(`/api/v1/folders/${encodeURIComponent(id)}/connector`, {
        method: 'PUT', body: JSON.stringify({ provider: binding.provider, source_id: binding.sourceId,
          connection_id: binding.connectionId }),
      });
      const body = await jsonOrThrow<{ folder: Record<string, unknown> }>(response, 'Connector binding failed');
      return mapFolder(body.folder);
    },
    delete: async (id: string): Promise<void> => {
      const response = await this.fetch(`/api/v1/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) await jsonOrThrow(response, 'Folder delete failed');
    },
    moveRecords: async (anchorIds: string[], folderId: string | null): Promise<BulkFolderMoveResult> => {
      const response = await this.fetch('/api/v1/folders/bulk-move', {
        method: 'POST', body: JSON.stringify({ anchor_ids: anchorIds, folder_id: folderId }),
      });
      const body = await jsonOrThrow<{ moved: string[]; failed: Array<{ anchor_id: string; code: string }> }>(
        response, 'Folder bulk move failed');
      return { moved: body.moved, failed: body.failed.map((row) => ({ anchorId: row.anchor_id, code: row.code })) };
    },
    moveRecordsByPublicId: async (recordPublicIds: string[], folderId: string | null): Promise<BulkFolderMoveResult> => {
      const response = await this.fetch('/api/v1/folders/bulk-move', {
        method: 'POST', body: JSON.stringify({ record_public_ids: recordPublicIds, folder_id: folderId }),
      });
      const body = await jsonOrThrow<{ moved: string[]; failed: Array<{ anchor_id: string; code: string }> }>(
        response, 'Folder bulk move failed');
      return { moved: body.moved, failed: body.failed.map((row) => ({ anchorId: row.anchor_id, code: row.code })) };
    },
  };

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
  /** Generic and ComputeID-bound agent lifecycle operations. */
  readonly agents = {
    register: async (input: CreateAgentInput): Promise<Agent> => {
      if (!input || typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 200 || (input.description !== undefined && input.description.length > 1000)
          || (input.framework !== undefined && input.framework.length > 100) || (input.version !== undefined && input.version.length > 50)
          || (input.agentType !== undefined && !AGENT_TYPES.has(input.agentType))) invalidAgentInput('Invalid agent registration input');
      validateScopes(input.allowedScopes); validateCallback(input.callbackUrl);
      if (input.metadata && Object.prototype.hasOwnProperty.call(input.metadata, 'computeid')) {
        throw new ArkovaError('metadata.computeid is provider-managed', 400, 'invalid_request');
      }
      const body = {
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.agentType !== undefined ? { agent_type: input.agentType } : {}),
        ...(input.allowedScopes !== undefined ? { allowed_scopes: input.allowedScopes } : {}),
        ...(input.framework !== undefined ? { framework: input.framework } : {}),
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.callbackUrl !== undefined ? { callback_url: input.callbackUrl } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      };
      const response = await this.fetch('/api/v1/agents', { method: 'POST', body: JSON.stringify(body) });
      return mapAgent(await jsonOrThrow<WireAgent>(response, 'Agent registration failed'));
    },
    list: async (): Promise<Agent[]> => {
      const response = await this.fetch('/api/v1/agents');
      const body = await jsonOrThrow<{ agents: WireAgent[] }>(response, 'Agent list failed');
      if (!recordValue(body) || !Array.isArray(body.agents) || body.agents.some((v) => !recordValue(v))) unexpectedAgentResponse();
      return body.agents.map(mapAgent);
    },
    get: async (agentId: string): Promise<Agent> => {
      const response = await this.fetch(`/api/v1/agents/${encodeURIComponent(agentId)}`);
      return mapAgent(await jsonOrThrow<WireAgent>(response, 'Agent lookup failed'));
    },
    update: async (agentId: string, input: UpdateAgentInput): Promise<Agent> => {
      if (Object.keys(input).length === 0) throw new ArkovaError('Agent update requires at least one field', 400, 'invalid_request');
      if (input.status !== undefined && !['active', 'suspended'].includes(input.status)) invalidAgentInput('Invalid agent status');
      if ((input.name !== undefined && (input.name.trim().length === 0 || input.name.length > 200)) || (input.description !== undefined && input.description.length > 1000)
          || (input.framework !== undefined && input.framework.length > 100) || (input.version !== undefined && input.version.length > 50)) invalidAgentInput('Invalid agent update input');
      validateScopes(input.allowedScopes); validateCallback(input.callbackUrl);
      const body = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.allowedScopes !== undefined ? { allowed_scopes: input.allowedScopes } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.framework !== undefined ? { framework: input.framework } : {}),
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.callbackUrl !== undefined ? { callback_url: input.callbackUrl } : {}),
      };
      const response = await this.fetch(`/api/v1/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body: JSON.stringify(body) });
      return mapAgent(await jsonOrThrow<WireAgent>(response, 'Agent update failed'));
    },
    revoke: async (agentId: string): Promise<AgentRevocation> => {
      const response = await this.fetch(`/api/v1/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
      const body = await jsonOrThrow<{ status: 'revoked'; agent_id: string }>(response, 'Agent revocation failed');
      if (!recordValue(body) || body.status !== 'revoked' || typeof body.agent_id !== 'string' || body.agent_id.length === 0) unexpectedAgentResponse();
      return { status: body.status, agentId: body.agent_id };
    },
    createKey: async (agentId: string): Promise<AgentKeyCreated> => {
      const response = await this.fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/key`, { method: 'POST' });
      return mapAgentKeyCreated(await jsonOrThrow<Record<string, unknown>>(response, 'Agent key creation failed'));
    },
    admitComputeId: async (input: ComputeIdAdmissionInput): Promise<ComputeIdAdmissionResult> => {
      validateReceipt(input?.passportId, input?.verificationReceipt);
      validateScopes(input.allowedScopes, COMPUTEID_SCOPES);
      if ((input.name !== undefined && (input.name.trim().length === 0 || input.name.length > 200)) || (input.description !== undefined && input.description.length > 1000)) invalidAgentInput('Invalid ComputeID admission input');
      const body = {
        passport_id: input.passportId,
        verification_receipt: input.verificationReceipt,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.allowedScopes !== undefined ? { allowed_scopes: input.allowedScopes } : {}),
      };
      const response = await this.fetch('/api/v1/agents/computeid/admit', { method: 'POST', body: JSON.stringify(body) });
      const value = await jsonOrThrow<Record<string, unknown> & { agent: WireAgent; binding: Record<string, unknown> }>(response, 'ComputeID admission failed');
      if (!recordValue(value)) unexpectedAgentResponse();
      const binding = recordValue(value.binding);
      const scopes = stringArray(value.scopes);
      if (!recordValue(value.agent) || !binding || binding.issuer !== 'computeid' || typeof binding.passport_id !== 'string'
          || typeof binding.bound_at !== 'string' || typeof binding.receipt_expires_at !== 'string'
          || typeof value.key !== 'string' || value.key.length === 0
          || typeof value.key_id !== 'string' || value.key_id.length === 0 || typeof value.key_prefix !== 'string' || value.key_prefix.length === 0
          || !scopes || typeof value.warning !== 'string') unexpectedAgentResponse();
      return {
        agent: mapAgent(value.agent), binding: binding as unknown as ComputeIdAdmissionResult['binding'], key: value.key as string,
        keyId: value.key_id as string, keyPrefix: value.key_prefix as string, scopes: scopes!, warning: value.warning as string,
      };
    },
  };
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
   *
   * DISABLED (CTO ruling R-1, 2026-08-12). Nessie is permanently disabled by
   * standing founder directive and the endpoint fails closed with
   * `503 {"code":"nessie_disabled","enabled":false}`, so this throws an
   * `ArkovaError` on every call. That throw does NOT mean "no matching
   * records" — no search is executed.
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
   *
   * DISABLED (CTO ruling R-1, 2026-08-12) — see `query()`. Throws on every
   * call; a throw is not an empty answer.
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

  /**
   * Internal fetch wrapper with retry handling.
   *
   * Retry rule: a request is retried on a transient response (429/500/502/
   * 503/504) or a network error when its method is safe (GET/HEAD/OPTIONS)
   * **or** the call site opts in with `{ idempotent: true }`. The opt-in
   * exists for reads and writes that are expressed as POST but are
   * idempotent server-side (`verifyBatch`, `anchor`, `anchorBulk`).
   * Non-idempotent writes (webhook create/update/delete/test) never retry.
   */
  private async fetch(
    path: string,
    init?: RequestInit,
    options?: { idempotent?: boolean },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> ?? {}),
    };

    if (this.#apiKey) {
      headers['X-API-Key'] = this.#apiKey;
    }

    const requestInit = { ...init, redirect: 'error' as const, headers };
    const method = (requestInit.method ?? 'GET').toUpperCase();
    const retryable = isSafeRetryMethod(method) || options?.idempotent === true;
    let attempt = 0;

    while (true) {
      try {
        const response = await globalThis.fetch(url, requestInit);
        if (!retryable || !shouldRetryResponse(response) || attempt >= this.retry.retries) {
          return response;
        }
        // The retried response is discarded — release its body so the
        // connection is not held open until GC.
        await response.body?.cancel().catch(() => {});
        await this.sleep(retryDelayMs(response, attempt, this.retry));
        attempt += 1;
      } catch (err) {
        if (!retryable || attempt >= this.retry.retries) {
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
  const decoded: unknown = await response.json().catch(() => ({}));
  const json = (decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : {}) as {
    message?: string;
    error?: string | { code?: string; message?: string; [key: string]: unknown };
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
    const nestedRaw = typeof json.error === 'object' && json.error !== null ? json.error : undefined;
    const nestedError: Record<string, unknown> | undefined = nestedRaw ? {
      ...(typeof nestedRaw.code === 'string' ? { code: nestedRaw.code } : {}),
      ...(typeof nestedRaw.message === 'string' ? { message: nestedRaw.message } : {}),
      ...(typeof nestedRaw.reason === 'string' ? { reason: nestedRaw.reason } : {}),
      ...(typeof nestedRaw.agent_id === 'string' ? { agent_id: nestedRaw.agent_id } : {}),
      ...(Array.isArray(nestedRaw.permitted) && nestedRaw.permitted.every((v) => typeof v === 'string')
        ? { permitted: nestedRaw.permitted } : {}),
    } : undefined;
    const legacyError = typeof json.error === 'string' ? json.error : undefined;
    throw new ArkovaError(
      problem?.detail ?? (typeof nestedError?.message === 'string' ? nestedError.message : undefined) ?? json.message ?? legacyError ?? `${failureLabel}: HTTP ${response.status}`,
      response.status,
      (typeof nestedError?.code === 'string' ? nestedError.code : undefined) ?? legacyError ?? (problem ? problem.type.split('/').pop() : undefined),
      problem,
      retryAfter !== undefined ? Math.ceil(retryAfter / 1000) : undefined,
      nestedError,
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

/**
 * SCRUM-2227: `compliance_controls` is emitted by the API as an ARRAY of
 * control-ID strings. `nullableRecord` explicitly rejects arrays, so routing
 * this field through it nulled it out for every real anchor. Non-arrays map to
 * `null` — the API does not emit them, and the worker now fails them closed
 * rather than surfacing an unfilterable control list.
 */
function nullableStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function mapRichVerificationFields(row: Record<string, unknown>): RichVerificationFields {
  return {
    description: nullableString(row.description),
    complianceControls: nullableStringArray(row.compliance_controls),
    // SCRUM-2227: a control list must never reach a consumer without the
    // statement of what it does NOT assert.
    complianceControlsNote: nullableString(row.compliance_controls_note),
    chainConfirmations: nullableNumber(row.chain_confirmations),
    parentPublicId: nullableString(row.parent_public_id),
    versionNumber: nullableNumber(row.version_number),
    revocationTxId: nullableString(row.revocation_tx_id),
    revocationBlockHeight: nullableNumber(row.revocation_block_height),
    fileMime: nullableString(row.file_mime),
    fileSize: nullableNumber(row.file_size),
    confidenceScores: nullableRecord(row.confidence_scores),
    subType: nullableString(row.sub_type),
    bitcoinBlock: nullableNumber(row.bitcoin_block),
    merkleProofHash: nullableString(row.merkle_proof_hash),
    fingerprintSource: row.fingerprint_source as RichVerificationFields['fingerprintSource'] ?? null,
    // proof_availability / fingerprint_rederivability (+ their notes) and the
    // FERPA fields are OMITTED by the worker rather than sent as `null` when
    // not applicable (see verify.ts field docs) — pass through as `undefined`
    // when absent instead of coercing to `null`, or the SDK would claim a
    // meaning ("unclassified") the server never asserted.
    proofAvailability: row.proof_availability as RichVerificationFields['proofAvailability'] | undefined,
    proofAvailabilityNote: row.proof_availability_note as string | undefined,
    fingerprintRederivability:
      row.fingerprint_rederivability as RichVerificationFields['fingerprintRederivability'] | undefined,
    fingerprintRederivabilityNote: row.fingerprint_rederivability_note as string | undefined,
    ferpaNotice: row.ferpa_notice as string | undefined,
    directoryInfoSuppressed: row.directory_info_suppressed as boolean | undefined,
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
    anchorTimestamp: nullableString(row.anchor_timestamp),
    networkReceiptId: (row.network_receipt_id as string | null) ?? null,
    recordUri: row.record_uri as string,
  };
}

function mapBulkAnchorDuplicate(row: Record<string, unknown>): BulkAnchorDuplicate {
  return {
    row: row.row as number,
    fingerprint: row.fingerprint as string,
    scope: row.scope as BulkAnchorDuplicate['scope'],
    decision: row.decision as BulkAnchorDuplicate['decision'],
  };
}

function mapBulkAnchorRowError(row: Record<string, unknown>): BulkAnchorRowError {
  return {
    row: row.row as number,
    field: row.field as string | undefined,
    code: row.code as string,
    message: row.message as string,
  };
}

function mapBulkAnchorResultRow(row: Record<string, unknown>): BulkAnchorResultRow {
  return {
    publicId: row.public_id as string,
    fingerprint: row.fingerprint as string,
    status: row.status as BulkAnchorResultRow['status'],
    originalDocumentDate: (row.original_document_date as string | null) ?? null,
    documentType: (row.document_type as string | null) ?? null,
    matterOrCaseRef: (row.matter_or_case_ref as string | null) ?? null,
    externalId: (row.external_id as string | null) ?? null,
    anchoredAt: row.anchored_at as string,
  };
}

function mapBulkAnchorResponse(data: {
  batch_id: string | null;
  validated: number;
  queued: number;
  duplicates: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
  dry_run: boolean;
  anchors?: Array<Record<string, unknown>>;
}): BulkAnchorResponse {
  return {
    batchId: data.batch_id,
    validated: data.validated,
    queued: data.queued,
    duplicates: data.duplicates.map(mapBulkAnchorDuplicate),
    errors: data.errors.map(mapBulkAnchorRowError),
    dryRun: data.dry_run,
    anchors: data.anchors?.map(mapBulkAnchorResultRow),
  };
}

function mapSearchResult(row: Record<string, unknown>): SearchResult {
  return {
    type: row.type as SearchResult['type'],
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

/**
 * PROOF-05 (SCRUM-2338): map the wire (snake_case) merkle proof entries with
 * STRICT validation. Returns `null` (not `[]`) when the value is not an array
 * or any entry is malformed — a non-array / malformed `merkle_proof` must not be
 * silently collapsed into an empty proof, which would manufacture a valid-looking
 * (but unverifiable) bundle from malformed JSON (CodeRabbit).
 */
function mapMerkleProofEntries(value: unknown): MerkleProofEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: MerkleProofEntry[] = [];
  for (const e of value) {
    if (
      typeof e !== 'object' ||
      e === null ||
      typeof (e as Record<string, unknown>).hash !== 'string' ||
      ((e as Record<string, unknown>).position !== 'left' &&
        (e as Record<string, unknown>).position !== 'right')
    ) {
      return null;
    }
    const entry = e as Record<string, unknown>;
    out.push({ hash: entry.hash as string, position: entry.position as 'left' | 'right' });
  }
  return out;
}

/** A 32-byte hash in display hex — the only shape a network-tree sibling takes. */
const SIBLING_HASH_HEX_RE = /^[0-9a-fA-F]{64}$/;

/**
 * B3 (migration 0427): map the layer-2 network-tree inclusion evidence as ONE
 * fact.
 *
 * `tx_inclusion_branch` + `tx_block_index` are what let a holder close the
 * receipt→block half of the proof LOCALLY instead of asking a network node
 * — the exact third-party dependency the self-contained bundle exists to
 * remove. `mapProofBundle` builds from a hard key allow-list, so until they
 * were named here the API emitted them and every SDK consumer silently
 * received a bundle with that half removed.
 *
 * The rules mirror the API reader exactly (two surfaces disagreeing about
 * whether a branch is usable is how a client ends up contradicting the server
 * about one record):
 *   - both halves present, or neither;
 *   - every sibling exactly 64 hex characters;
 *   - `0 <= index < 2^branch.length`;
 *   - each level's sibling side matches that level's bit of the index.
 *
 * Anything else ⇒ BOTH null. Unlike the bundle's required members this does
 * NOT fail the whole bundle closed: the fields are additive and nullable
 * (§1.8), so a record confirmed before 0427 must keep getting a bundle. An
 * EMPTY branch with index 0 is COMPLETE evidence (a single-receipt block
 * has no siblings), never missing.
 *
 * ORIENTATION: byte-reversed (display) hex under the network’s double-SHA256
 * positional rule — a DIFFERENT convention from `merkleProof`, the layer-1 app
 * tree. Not interchangeable, hence the distinct name.
 */
function mapTxInclusionEvidence(
  branchValue: unknown,
  indexValue: unknown,
): { branch: MerkleProofEntry[]; index: number } | null {
  const branch = mapMerkleProofEntries(branchValue);
  if (branch === null) return null;
  if (typeof indexValue !== 'number' || !Number.isInteger(indexValue) || indexValue < 0) return null;
  if (branch.length > 31) return null;
  if (indexValue >= 1 << branch.length) return null;
  for (let level = 0; level < branch.length; level++) {
    if (!SIBLING_HASH_HEX_RE.test(branch[level].hash)) return null;
    const expected = ((indexValue >> level) & 1) === 0 ? 'right' : 'left';
    if (branch[level].position !== expected) return null;
  }
  return { branch, index: indexValue };
}

/**
 * PROOF-05 (SCRUM-2338): map the nullable, snake_case proof_bundle — FAIL CLOSED.
 *
 * CodeRabbit: the SDK guarantees `proofBundle !== null ⇒ independently
 * verifiable`. Defaulting missing/wrong-typed required members to null/0/1 (and
 * collapsing a non-array merkle_proof to []) manufactures a valid-looking
 * ProofBundle from malformed JSON, breaking that guarantee. Instead, return
 * `null` if ANY required member is missing or the wrong type. Only `signature`
 * is legitimately nullable.
 */
function mapProofBundle(value: unknown): ProofBundle | null {
  if (typeof value !== 'object' || value === null) return null;
  const b = value as Record<string, unknown>;

  const merkleProof = mapMerkleProofEntries(b.merkle_proof);
  const coherentSingleton =
    merkleProof?.length === 0 &&
    b.leaf_count === 1 &&
    b.merkle_index === 0 &&
    typeof b.fingerprint === 'string' &&
    typeof b.merkle_root === 'string' &&
    SIBLING_HASH_HEX_RE.test(b.fingerprint) &&
    SIBLING_HASH_HEX_RE.test(b.merkle_root) &&
    b.fingerprint.toLowerCase() === b.merkle_root.toLowerCase();
  // Required members must all be present + correctly typed, else fail closed.
  if (
    typeof b.fingerprint !== 'string' ||
    typeof b.merkle_root !== 'string' ||
    merkleProof === null ||
    (merkleProof.length === 0 && !coherentSingleton) ||
    typeof b.merkle_index !== 'number' ||
    typeof b.leaf_count !== 'number' ||
    typeof b.tx_id !== 'string' ||
    typeof b.block_height !== 'number' ||
    typeof b.block_hash !== 'string' ||
    typeof b.block_header !== 'string' ||
    typeof b.op_return_payload !== 'string' ||
    typeof b.block_timestamp !== 'string' ||
    typeof b.proof_schema_version !== 'number'
  ) {
    return null;
  }

  // `signature` is the one legitimately nullable member. When present it must be
  // a well-formed envelope; a malformed signature object fails closed too.
  let signature: ProofBundleSignature | null = null;
  if (b.signature != null) {
    const sig = b.signature;
    if (
      typeof sig !== 'object' ||
      typeof (sig as Record<string, unknown>).alg !== 'string' ||
      typeof (sig as Record<string, unknown>).signing_key_id !== 'string'
    ) {
      return null;
    }
    const s = sig as Record<string, unknown>;
    signature = { alg: s.alg as string, signingKeyId: s.signing_key_id as string };
  }

  // B3 (0427): additive + nullable, so an unusable pair degrades to null on
  // both halves WITHOUT failing the whole bundle closed.
  const txInclusion = mapTxInclusionEvidence(b.tx_inclusion_branch, b.tx_block_index);

  return {
    fingerprint: b.fingerprint,
    merkleRoot: b.merkle_root,
    merkleProof,
    merkleIndex: b.merkle_index,
    leafCount: b.leaf_count,
    txId: b.tx_id,
    blockHeight: b.block_height,
    blockHash: b.block_hash,
    blockHeader: b.block_header,
    opReturnPayload: b.op_return_payload,
    blockTimestamp: b.block_timestamp,
    proofSchemaVersion: b.proof_schema_version,
    txInclusionBranch: txInclusion?.branch ?? null,
    txBlockIndex: txInclusion?.index ?? null,
    signature,
  };
}

/** PROOF-05 (SCRUM-2338): map the merkle proof response (frozen + additive bundle). */
function mapMerkleProofResponse(row: Record<string, unknown>): MerkleProofResponse {
  return {
    publicId: row.public_id as string,
    fingerprint: row.fingerprint as string,
    merkleRoot: row.merkle_root as string,
    // Top-level merkleProof is a frozen non-null field that may legitimately be
    // empty; a malformed/non-array value degrades to [] here (the strict,
    // fail-closed validation applies to the additive proof_bundle below).
    merkleProof: mapMerkleProofEntries(row.merkle_proof) ?? [],
    txId: (row.tx_id as string | null) ?? null,
    blockHeight: (row.block_height as number | null) ?? null,
    blockTimestamp: (row.block_timestamp as string | null) ?? null,
    batchId: (row.batch_id as string | null) ?? null,
    verified: row.verified as boolean,
    proofBundle: mapProofBundle(row.proof_bundle),
  };
}

function mapOrganizationSummary(row: Record<string, unknown>): OrganizationSummary {
  return {
    publicId: row.public_id as string,
    displayName: row.display_name as string,
    domain: (row.domain as string | null) ?? null,
    websiteUrl: (row.website_url as string | null) ?? null,
    verificationStatus: (row.verification_status as string | null) ?? null,
  };
}

function mapOrganizationDetails(row: Record<string, unknown>): OrganizationDetails {
  // `OrganizationDetails` deliberately does not include an `id` field —
  // the v2 endpoint never returns the internal UUID. Callers should
  // use `publicId` as the stable identifier.
  return {
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
  /** Safe structured fields from nested endpoint errors. */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    statusCode: number,
    code?: string,
    problem?: ProblemDetail,
    retryAfter?: number,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ArkovaError';
    this.statusCode = statusCode;
    this.code = code;
    this.problem = problem;
    this.retryAfter = retryAfter;
    this.details = details;
  }
}

// ─── Internal mappers (snake_case → camelCase) ──────────────────────────

function mapFolder(row: Record<string, unknown>): Folder {
  return {
    id: row.id as string, publicId: row.public_id as string, name: row.name as string,
    ownerScope: row.owner_scope as Folder['ownerScope'], userId: (row.user_id as string | null) ?? null,
    orgId: (row.org_id as string | null) ?? null, contextOrgId: (row.context_org_id as string | null) ?? null,
    parentFolderId: (row.parent_folder_id as string | null) ?? null,
    connectorProvider: (row.connector_provider as Folder['connectorProvider']) ?? null,
    connectorSourceId: (row.connector_source_id as string | null) ?? null,
    connectorConnectionId: (row.connector_connection_id as string | null) ?? null,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string,
  };
}

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
