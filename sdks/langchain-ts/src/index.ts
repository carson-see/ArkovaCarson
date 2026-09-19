/**
 * @arkova/langchain — LangChain Tool Wrappers for Arkova Verification API
 *
 * Provides LangChain-compatible tools for AI agents to verify anchored
 * records, check anchor status, and create attestations via Arkova's API.
 *
 * Usage:
 *   import { ArkovaVerifyTool, ArkovaAnchorStatusTool } from '@arkova/langchain';
 *   const tools = [new ArkovaVerifyTool({ apiKey: 'ak_...' })];
 *
 * Story: PH2-AGENT-06 (SCRUM-403)
 *
 * Kept in tool-name parity with sdks/mcp-server/src/index.ts (6
 * arkova_-prefixed tools) — see agents.md for the 2026-09-02 parity pass.
 */

// ─── Types ─────────────────────────────────────────────────────────────

export interface ArkovaToolConfig {
  /** Arkova API key (ak_live_... or ak_test_...) */
  apiKey: string;
  /** Base URL for Arkova API. Defaults to production. */
  baseUrl?: string;
  /** Request timeout in ms. Defaults to 10000. */
  timeoutMs?: number;
}

interface VerifyResult {
  valid: boolean;
  public_id: string;
  status: string;
  issuer?: string;
  credential_type?: string;
  anchored_at?: string;
  tx_id?: string;
}

interface AnchorStatusResult {
  public_id: string;
  status: string;
  fingerprint: string;
  anchored_at?: string;
  tx_id?: string;
}

interface AttestationResult {
  public_id: string;
  status: string;
  attestation_type: string;
  subject_identifier: string;
}

const DEFAULT_BASE_URL = 'https://api.arkova.ai';

/**
 * Appended to every tool description — parity with sdks/mcp-server/src/index.ts's
 * API_ONLY_NOTE. States plainly, in the surface the model actually reads,
 * that these tools are a remote HTTPS call and never a local secrets/file
 * lookup.
 */
const API_ONLY_NOTE =
  'Queries the Arkova verification API over HTTPS; it does NOT read local files, environment variables, or stored secrets.';

/**
 * Maximum public IDs the verification API answers **synchronously**.
 *
 * Mirrors two upstream sources, neither importable from this standalone
 * package: `packages/sdk/src/client.ts` `VERIFY_BATCH_SYNC_LIMIT` and
 * `services/worker/src/api/v1/batch.ts` `SYNC_THRESHOLD`. Above this the
 * worker answers `202 {job_id,…}` with no results and this package has no
 * way to fetch them later. Keep the three in step; `index.test.ts` pins it.
 */
export const VERIFY_BATCH_SYNC_LIMIT = 20;

/**
 * The one sentence every tool uses to disclose a 503 — parity with
 * `sdks/mcp-server/src/index.ts`.
 *
 * A disabled capability answered with a bare status number reads to an agent
 * as a completed request that found nothing. It is not: nothing ran. Stated
 * identically on every tool so the disclosure cannot drift tool-to-tool (it
 * previously existed on 2 of 6, with two different body-field fallbacks).
 */
export const DISABLED_CAPABILITY_PHRASE =
  'is disabled in this environment and no request ran. This is NOT an empty result, ' +
  'NOT a "not found" or negative verification result, and does not mean no matching records exist.';

/** Shape of the error bodies the worker returns; fields are all optional. */
interface ErrorBody {
  message?: string;
  error?: string;
  code?: string;
}

/**
 * Parse an error response body once; null when there is no readable JSON.
 * `try`, not `.catch()`: a `json()` that throws synchronously (or is absent)
 * must not escape as a tool crash.
 */
async function readErrorBody(res: Response): Promise<ErrorBody | null> {
  try {
    return (await res.json()) as ErrorBody | null;
  } catch {
    return null;
  }
}

/**
 * Build the 503 disclosure for `subject`, or null when the status is not a
 * 503 (so a caller falls through to its ordinary error text).
 * Server detail resolves `message ?? error ?? code`.
 */
function disabledCapabilityMessage(
  status: number,
  body: ErrorBody | null,
  subject: string,
): string | null {
  if (status !== 503) return null;
  const detail = body?.message ?? body?.error ?? body?.code ?? 'service_unavailable';
  return `${subject} ${DISABLED_CAPABILITY_PHRASE} Server detail: ${detail}`;
}

// ─── HTTP Client ───────────────────────────────────────────────────────

async function arkovaFetch(
  config: ArkovaToolConfig,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  return fetch(`${baseUrl}${path}`, {
    ...options,
    // Never follow redirects while carrying the caller's custom API-key
    // header. Keep this after `options` so no tool can opt back into follow.
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.apiKey,
      ...options.headers,
    },
    signal: AbortSignal.timeout(config.timeoutMs || 10000),
  });
}

// ─── LangChain Tool Interface ──────────────────────────────────────────
// These tools implement the LangChain BaseTool interface pattern.
// They can be used with any LangChain-compatible agent framework.

export class ArkovaVerifyTool {
  name = 'arkova_verify_anchor';
  description = `Verify an anchored record's authenticity and anchor status on Arkova. Input should be the record's public ID (e.g., ARK-UMICH-DOC-A1B2C3). ${API_ONLY_NOTE}`;
  private config: ArkovaToolConfig;

  constructor(config: ArkovaToolConfig) {
    this.config = config;
  }

  async call(input: string): Promise<string> {
    try {
      const publicId = input.trim();
      const res = await arkovaFetch(this.config, `/api/v1/verify/${encodeURIComponent(publicId)}`);

      if (!res.ok) {
        if (res.status === 404) return JSON.stringify({ valid: false, error: 'Record not found' });
        const disabled = disabledCapabilityMessage(res.status, await readErrorBody(res), 'Record verification');
        if (disabled) return JSON.stringify({ valid: false, error: disabled });
        return JSON.stringify({ valid: false, error: `API returned ${res.status}` });
      }

      const data = await res.json() as VerifyResult;
      return JSON.stringify({
        valid: data.status === 'SECURED' || data.status === 'SUBMITTED',
        public_id: data.public_id,
        status: data.status,
        issuer: data.issuer,
        credential_type: data.credential_type,
        anchored_at: data.anchored_at,
      });
    } catch (err) {
      return JSON.stringify({ valid: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }
}

export class ArkovaAnchorStatusTool {
  name = 'arkova_anchor_status';
  description = `Check the network anchor status of a record. Returns whether the record is PENDING, SUBMITTED, SECURED, or REVOKED. Input is the record's public ID. ${API_ONLY_NOTE}`;
  private config: ArkovaToolConfig;

  constructor(config: ArkovaToolConfig) {
    this.config = config;
  }

  async call(input: string): Promise<string> {
    try {
      const publicId = input.trim();
      const res = await arkovaFetch(this.config, `/api/v1/verify/${encodeURIComponent(publicId)}`);

      if (!res.ok) {
        const disabled = disabledCapabilityMessage(res.status, await readErrorBody(res), 'Anchor status lookup');
        if (disabled) return JSON.stringify({ error: disabled });
        return JSON.stringify({ error: `API returned ${res.status}` });
      }

      const data = await res.json() as AnchorStatusResult;
      return JSON.stringify({
        public_id: data.public_id,
        status: data.status,
        fingerprint: data.fingerprint,
        anchored_at: data.anchored_at,
        tx_id: data.tx_id,
      });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }
}

export class ArkovaSearchTool {
  name = 'arkova_search_anchors';
  description = `Search for verified anchored records by name, institution, or record type. Returns matching public records. Input is a search query string. ${API_ONLY_NOTE}`;
  private config: ArkovaToolConfig;

  constructor(config: ArkovaToolConfig) {
    this.config = config;
  }

  async call(input: string): Promise<string> {
    try {
      const query = input.trim();
      const res = await arkovaFetch(
        this.config,
        `/api/v1/verify/search?q=${encodeURIComponent(query)}&limit=5`,
      );

      if (!res.ok) {
        const disabled = disabledCapabilityMessage(res.status, await readErrorBody(res), 'Search');
        if (disabled) return JSON.stringify({ results: [], error: disabled });
        return JSON.stringify({ results: [], error: `API returned ${res.status}` });
      }

      const data = await res.json();
      return JSON.stringify(data);
    } catch (err) {
      return JSON.stringify({ results: [], error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }
}

export class ArkovaAttestTool {
  name = 'arkova_create_attestation';
  description = `Create a third-party attestation that a record or entity has been verified. Requires attestation_type, subject_identifier, attester_name, and a non-empty claims array (each a {claim, evidence?} object). Any authenticated API key may create one — this does not require organization admin privileges. Returns the attestation public ID. ${API_ONLY_NOTE}`;
  private config: ArkovaToolConfig;

  constructor(config: ArkovaToolConfig) {
    this.config = config;
  }

  async call(input: string): Promise<string> {
    try {
      const body = JSON.parse(input);
      const res = await arkovaFetch(this.config, '/api/v1/attestations', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await readErrorBody(res);
        const disabled = disabledCapabilityMessage(res.status, err, 'Attestation creation');
        if (disabled) return JSON.stringify({ error: disabled });
        return JSON.stringify({ error: err?.error || `API returned ${res.status}` });
      }

      const data = await res.json() as AttestationResult;
      return JSON.stringify({
        public_id: data.public_id,
        status: data.status,
        attestation_type: data.attestation_type,
      });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }
}

export class ArkovaBatchVerifyTool {
  name = 'arkova_batch_verify';
  description = `Verify up to ${VERIFY_BATCH_SYNC_LIMIT} public IDs at once; results returned inline. Input should be a JSON array of public IDs (e.g., ["ARK-X-DOC-1", "ARK-Y-DOC-2"]). ${API_ONLY_NOTE}`;
  private config: ArkovaToolConfig;

  constructor(config: ArkovaToolConfig) {
    this.config = config;
  }

  async call(input: string): Promise<string> {
    try {
      const publicIds: string[] = JSON.parse(input);
      if (!Array.isArray(publicIds) || publicIds.length === 0) {
        return JSON.stringify({ error: 'Input must be a JSON array of public IDs' });
      }
      if (publicIds.length > VERIFY_BATCH_SYNC_LIMIT) {
        return JSON.stringify({
          error:
            `Maximum ${VERIFY_BATCH_SYNC_LIMIT} public IDs per batch. The Arkova API processes larger batches ` +
            'asynchronously (202 + job_id) and this tool has no way to fetch results from that job — split into ' +
            `batches of ${VERIFY_BATCH_SYNC_LIMIT} or fewer.`,
        });
      }

      const res = await arkovaFetch(this.config, '/api/v1/verify/batch', {
        method: 'POST',
        body: JSON.stringify({ public_ids: publicIds }),
      });

      if (!res.ok) {
        const disabled = disabledCapabilityMessage(res.status, await readErrorBody(res), 'Batch verification');
        if (disabled) return JSON.stringify({ error: disabled });
        return JSON.stringify({ error: `API returned ${res.status}` });
      }

      const data = await res.json();
      return JSON.stringify(data);
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }
}

export class ArkovaVerifySignatureTool {
  name = 'arkova_verify_signature';
  description = `Verify an AdES electronic signature's validity, certificate chain, timestamp token, and eIDAS compliance. Input is a signature public ID (e.g., ARK-ACME-SIG-X7Y8Z9). ${API_ONLY_NOTE}`;
  private config: ArkovaToolConfig;

  constructor(config: ArkovaToolConfig) {
    this.config = config;
  }

  async call(input: string): Promise<string> {
    try {
      const signatureId = input.trim();
      const res = await arkovaFetch(this.config, '/api/v1/verify-signature', {
        method: 'POST',
        body: JSON.stringify({ signature_id: signatureId }),
      });

      if (!res.ok) {
        if (res.status === 404) return JSON.stringify({ valid: false, error: 'Signature not found' });
        const disabled = disabledCapabilityMessage(res.status, await readErrorBody(res), 'Signature verification');
        if (disabled) return JSON.stringify({ valid: false, error: disabled });
        return JSON.stringify({ valid: false, error: `API returned ${res.status}` });
      }

      const data = await res.json();
      return JSON.stringify(data);
    } catch (err) {
      return JSON.stringify({ valid: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }
}

/**
 * Get all Arkova tools for use with a LangChain agent.
 */
export function getArkovaTools(config: ArkovaToolConfig) {
  return [
    new ArkovaVerifyTool(config),
    new ArkovaAnchorStatusTool(config),
    new ArkovaSearchTool(config),
    new ArkovaAttestTool(config),
    new ArkovaBatchVerifyTool(config),
    new ArkovaVerifySignatureTool(config),
  ];
}
