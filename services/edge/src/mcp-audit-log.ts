/**
 * MCP Tool-Call Audit Logging (SCRUM-924 MCP-SEC-06)
 *
 * Fire-and-forget insert into `audit_events` for every MCP tool invocation.
 * The audit trail is what makes every other security control investigable —
 * without it a compromised API key is a black hole.
 *
 * Schema reuses the existing audit_events table (id, event_type,
 * event_category, actor_id, target_type, target_id, org_id, details,
 * created_at). The `event_type` is always `'MCP_TOOL_CALL'` and
 * `event_category` is `'security'` so audit queries can filter by category.
 *
 * Design rules:
 * 1. Fire-and-forget: never await this in the tool's request path. Latency
 *    must not depend on audit-log availability.
 * 2. No PII in `details`: args are SHA-256 hashed. IP is hashed to stable
 *    token. No raw emails, fingerprints, or public IDs go to the log.
 * 3. Network failures swallowed: Cloudflare Worker console.error carries
 *    the detail for post-incident forensics, but a log failure never
 *    surfaces to the MCP client.
 */

import type { Env } from './env';

export interface McpAuditEntry {
  apiKeyId: string | null;  // null for OAuth bearer; apiKeyId for X-API-Key
  userId: string;
  toolName: string;
  argsJson: string;         // raw JSON of the tool args; this function hashes it
  outcome: 'success' | 'rate_limited' | 'validation_error' | 'tool_error' | 'unauthorized';
  latencyMs: number;
  clientIp: string | null;  // null if the Worker can't determine it
}

/** SHA-256 hex of an arbitrary string, using Web Crypto (CF Workers native). */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Log an MCP tool invocation. Fire-and-forget: pass the returned promise to
 * `ctx.waitUntil()` or ignore it; never block the tool response on this.
 */
export async function logMcpToolCall(env: Env, entry: McpAuditEntry): Promise<void> {
  try {
    // Hash args so the log never contains raw PII (public_ids, fingerprints, etc).
    const argsHash = await sha256Hex(entry.argsJson);
    // Hash IP for privacy-preserving per-actor correlation (CF Workers doesn't
    // forward a raw IP by default; when present we hash it rather than store).
    const ipHash = entry.clientIp ? await sha256Hex(entry.clientIp) : null;

    const body = {
      event_type: 'MCP_TOOL_CALL',
      event_category: 'security',
      actor_id: entry.userId,
      target_type: 'mcp_tool',
      target_id: entry.toolName,
      // org_id is omitted — requires a join to org_members to resolve from
      // userId; the audit query side can do that lookup on read.
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
      const status = response.status;
      // Drain the body so the socket can be reused, but don't surface the
      // content to callers.
      await response.text().catch(() => '');
      console.error(`[mcp-audit-log] insert failed (HTTP ${status}) for tool=${entry.toolName}`);
    }
  } catch (err) {
    // Fire-and-forget never throws out. Error detail goes to CF logs only.
    console.error('[mcp-audit-log] unexpected error:', err);
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
