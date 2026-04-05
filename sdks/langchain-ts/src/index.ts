/**
 * @arkova/langchain — LangChain Tool Wrappers for Arkova Verification API
 *
 * Provides LangChain-compatible tools for AI agents to verify credentials,
 * check anchor status, and create attestations via Arkova's API.
 *
 * Usage:
 *   import { ArkovaVerifyTool, ArkovaAnchorStatusTool } from '@arkova/langchain';
 *   const tools = [new ArkovaVerifyTool({ apiKey: 'ak_...' })];
 *
 * Story: PH2-AGENT-06 (SCRUM-403)
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

const DEFAULT_BASE_URL = 'https://arkova-worker-270018525501.us-central1.run.app';

// ─── HTTP Client ───────────────────────────────────────────────────────

async function arkovaFetch(
  config: ArkovaToolConfig,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  return fetch(`${baseUrl}${path}`, {
    ...options,
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
  name = 'arkova_verify_credential';
  description = 'Verify a credential\'s authenticity and anchor status on Arkova. Input should be a credential public ID (e.g., ARK-UMICH-DOC-A1B2C3) or a document fingerprint (sha256:...).';
  private config: ArkovaToolConfig;

  constructor(config: ArkovaToolConfig) {
    this.config = config;
  }

  async call(input: string): Promise<string> {
    try {
      const publicId = input.trim();
      const res = await arkovaFetch(this.config, `/api/v1/verify/${encodeURIComponent(publicId)}`);

      if (!res.ok) {
        if (res.status === 404) return JSON.stringify({ valid: false, error: 'Credential not found' });
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
  description = 'Check the Bitcoin anchor status of a credential. Returns whether the credential is PENDING, SUBMITTED, SECURED, or REVOKED. Input is a credential public ID.';
  private config: ArkovaToolConfig;

  constructor(config: ArkovaToolConfig) {
    this.config = config;
  }

  async call(input: string): Promise<string> {
    try {
      const publicId = input.trim();
      const res = await arkovaFetch(this.config, `/api/v1/verify/${encodeURIComponent(publicId)}`);

      if (!res.ok) {
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
  name = 'arkova_search_credentials';
  description = 'Search for verified credentials by name, institution, or credential type. Returns matching public records. Input is a search query string.';
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
  description = 'Create a third-party attestation on Arkova. Requires attestation_type, subject_identifier, and claims. Returns the attestation public ID.';
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
        const err = await res.json().catch(() => ({}));
        return JSON.stringify({ error: (err as any).error || `API returned ${res.status}` });
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

/**
 * Get all Arkova tools for use with a LangChain agent.
 */
export function getArkovaTools(config: ArkovaToolConfig) {
  return [
    new ArkovaVerifyTool(config),
    new ArkovaAnchorStatusTool(config),
    new ArkovaSearchTool(config),
    new ArkovaAttestTool(config),
  ];
}
