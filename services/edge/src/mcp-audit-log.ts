/**
 * MCP Tool-Call Audit Logging (SCRUM-924 MCP-SEC-06)
 *
 * Fire-and-forget insert into `audit_events` for every MCP tool invocation.
 * No raw PII: args + IP are SHA-256 hashed before writing.
 *
 * The log is what makes every other security control investigable — without
 * it a compromised API key is a black hole. Insert failures are swallowed
 * so a log outage can't impact tool responses.
 */

import type { Env } from './env';
import { sha256Hex } from './mcp-crypto-utils';

export type McpOutcome = 'success' | 'rate_limited' | 'tool_error' | 'auth_failed';

export interface McpAuditEntry {
  apiKeyId: string | null;  // null for OAuth bearer; apiKeyId for X-API-Key
  userId: string;
  toolName: string;
  argsJson: string;
  outcome: McpOutcome;
  latencyMs: number;
  clientIp: string | null;
}

/** Shorten an unknown error to a safe log line. `String(err)` can include a
 *  PostgREST response body which in turn can echo the request we just sent —
 *  that risks leaking authorization headers or user data through CF Logpush. */
function safeErrLine(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 200);
  return String(err).slice(0, 200);
}

/**
 * Log an MCP tool invocation. Callers should hand the returned promise to
 * `ctx.waitUntil()` (via `fireAndForgetAudit` below) so the response latency
 * doesn't depend on the audit-log round-trip.
 */
export async function logMcpToolCall(env: Env, entry: McpAuditEntry): Promise<void> {
  try {
    const argsHash = await sha256Hex(entry.argsJson);
    const ipHash = entry.clientIp ? await sha256Hex(entry.clientIp) : null;

    const body = {
      event_type: 'MCP_TOOL_CALL',
      event_category: 'security',
      actor_id: entry.userId,
      target_type: 'mcp_tool',
      target_id: entry.toolName,
      // org_id left null — resolving from userId requires an org_members
      // join, which the audit query side can do on read.
      details: JSON.stringify({
        api_key_id: entry.apiKeyId,
        args_hash: argsHash,
        outcome: entry.outcome,
        latency_ms: entry.latencyMs,
        ip_hash: ipHash,
      }),
    };

    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/audit_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Drain the body so the socket can be reused; content never surfaces.
      await response.text().catch(() => '');
      console.error(`[mcp-audit-log] insert failed (HTTP ${response.status}) for tool=${entry.toolName}`);
    }
  } catch (err) {
    console.error(`[mcp-audit-log] unexpected: ${safeErrLine(err)}`);
  }
}

/** Fire-and-forget wrapper tied to a waitUntil-style executor. */
export function fireAndForgetAudit(
  env: Env,
  entry: McpAuditEntry,
  ctx?: { waitUntil?: (p: Promise<unknown>) => void },
): void {
  const p = logMcpToolCall(env, entry);
  if (ctx?.waitUntil) {
    ctx.waitUntil(p);
  } else {
    // Outside a request lifecycle (shouldn't happen in normal flow) —
    // swallow the promise so no unhandled-rejection warning fires.
    p.catch(() => undefined);
  }
}
