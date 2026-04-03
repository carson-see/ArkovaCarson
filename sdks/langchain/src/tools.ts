/**
 * Arkova LangChain Tools (PH2-AGENT-06)
 *
 * LangChain-compatible tool wrappers for Arkova's verification API.
 * These tools enable AI agents to verify credentials, query the oracle,
 * and search the Arkova registry as native LangChain tools.
 *
 * Usage:
 *   import { ArkovaVerifyTool, ArkovaOracleTool, ArkovaSearchTool } from '@arkova/langchain';
 *   const tools = [new ArkovaVerifyTool({ apiKey: 'ak_...' })];
 *   const agent = new AgentExecutor({ agent, tools });
 *
 * Requires: @langchain/core (peer dependency)
 */

export interface ArkovaToolConfig {
  /** Arkova API key (starts with ak_) */
  apiKey: string;
  /** Base URL for the Arkova API (default: https://app.arkova.ai/api/v1) */
  baseUrl?: string;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
}

const DEFAULT_BASE_URL = 'https://app.arkova.ai/api/v1';
const DEFAULT_TIMEOUT = 10_000;

async function arkovaFetch(
  config: ArkovaToolConfig,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const url = `${config.baseUrl ?? DEFAULT_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout ?? DEFAULT_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'arkova-langchain/1.0.0',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Arkova API error ${response.status}: ${error}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Verify Tool ─────────────────────────────────────────────────

export interface VerifyResult {
  verified: boolean;
  status?: string;
  issuer_name?: string;
  credential_type?: string;
  anchor_timestamp?: string;
  explorer_url?: string;
  error?: string;
}

/**
 * LangChain tool for verifying a single credential by its Arkova public ID.
 *
 * Input: Arkova public ID (e.g., "ARK-DEG-ABC123")
 * Output: Verification result with status, issuer, type, and chain proof
 */
export class ArkovaVerifyTool {
  name = 'arkova_verify_credential';
  description = 'Verify the authenticity of a credential or document by its Arkova public ID. Returns whether the record is verified, its status (ACTIVE/REVOKED/PENDING), the issuer name, credential type, and blockchain anchor timestamp. Use this when you need to confirm a credential is authentic.';
  config: ArkovaToolConfig;

  constructor(config: ArkovaToolConfig) {
    this.config = config;
  }

  async call(publicId: string): Promise<string> {
    try {
      const result = await arkovaFetch(this.config, `/verify/${encodeURIComponent(publicId)}`) as VerifyResult;
      return JSON.stringify(result, null, 2);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message, verified: false });
    }
  }
}

// ─── Oracle Tool (Batch) ─────────────────────────────────────────

export interface OracleResult {
  query_id: string;
  agent_key_id: string | null;
  queried_at: string;
  results: VerifyResult[];
  signature: string;
}

/**
 * LangChain tool for batch-verifying multiple credentials via the Arkova Oracle.
 *
 * Input: JSON array of Arkova public IDs (max 25)
 * Output: Signed batch verification result with HMAC signature
 */
export class ArkovaOracleTool {
  name = 'arkova_oracle_batch_verify';
  description = 'Batch-verify multiple credentials at once via the Arkova Oracle. Input should be a JSON array of Arkova public IDs (max 25). Returns signed verification results with HMAC signature for tamper detection. Use this for bulk verification workflows.';
  config: ArkovaToolConfig;

  constructor(config: ArkovaToolConfig) {
    this.config = config;
  }

  async call(input: string): Promise<string> {
    try {
      let publicIds: string[];
      try {
        publicIds = JSON.parse(input);
        if (!Array.isArray(publicIds)) throw new Error('Input must be a JSON array of public IDs');
      } catch {
        // If not JSON, treat as single comma-separated list
        publicIds = input.split(',').map((s) => s.trim()).filter(Boolean);
      }

      const result = await arkovaFetch(this.config, '/oracle/verify', {
        method: 'POST',
        body: { public_ids: publicIds },
      }) as OracleResult;

      return JSON.stringify(result, null, 2);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  }
}

// ─── Search Tool ─────────────────────────────────────────────────

/**
 * LangChain tool for searching Arkova's credential registry.
 *
 * Input: Search query (issuer name, person name, or credential type)
 * Output: Matching credentials and issuers
 */
export class ArkovaSearchTool {
  name = 'arkova_search_credentials';
  description = 'Search the Arkova credential verification registry by issuer name, person name, or credential type. Returns matching credentials with their verification status. Use this to find credentials before verifying them.';
  config: ArkovaToolConfig;

  constructor(config: ArkovaToolConfig) {
    this.config = config;
  }

  async call(query: string): Promise<string> {
    try {
      const params = new URLSearchParams({ q: query, limit: '10' });
      const result = await arkovaFetch(this.config, `/verify/search?${params}`);
      return JSON.stringify(result, null, 2);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  }
}

/**
 * Convenience function: get all Arkova tools for a LangChain agent.
 */
export function getArkovaTools(config: ArkovaToolConfig) {
  return [
    new ArkovaVerifyTool(config),
    new ArkovaOracleTool(config),
    new ArkovaSearchTool(config),
  ];
}
