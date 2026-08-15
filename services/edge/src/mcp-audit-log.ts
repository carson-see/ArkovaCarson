/**
 * MCP Tool-Call Audit Logging (SCRUM-924 MCP-SEC-06)
 *
 * Fire-and-forget insert into `audit_events` for every MCP tool invocation.
 * No raw PII: args are SHA-256 hashed and the caller IP is HMAC-SHA256 keyed
 * with `MCP_IP_HASH_PEPPER` before writing (see `pseudonymizeIp` below for why
 * the IP needs a key and the args digest does not).
 *
 * The log is what makes every other security control investigable — without
 * it a compromised API key is a black hole. Insert failures do NOT fail the
 * tool call (see "Why this does not fail the request" below) but they MUST
 * be loud: a silent audit control is indistinguishable from no control.
 *
 * BUG-2026-08-13-016 (P0). This module shipped 2026-05-26 emitting
 * `event_category: 'security'` — lowercase — against a CHECK constraint that
 * accepts uppercase only. Every insert since has returned HTTP 400 and the
 * production `audit_events` table holds ZERO `MCP_TOOL_CALL` rows out of
 * 409,885. Two things had to be true for that to survive 2.5 months:
 *
 *   1. Nothing pinned the category to the DB contract. Fixed by typing it as
 *      `AuditEventCategory` (./audit-event-category.ts), so a lowercase
 *      literal is now a compile error, plus a test that re-derives the
 *      allowed set from the migration itself.
 *   2. The failure was indistinguishable from silence. The pre-existing
 *      `console.error` fired on all ~N calls, but as unclassified prose with
 *      no status semantics — a permanent schema-contract rejection looked
 *      exactly like a transient blip, and neither looked like anything at
 *      all in a system where nobody tails a Cloudflare Worker. Fixed by
 *      emitting a structured, greppable `MCP_AUDIT_WRITE_FAILED` record that
 *      distinguishes permanent (4xx — will NEVER self-heal, a deploy is
 *      required) from credential and transient failure, and by keeping a
 *      process-lifetime counter that a probe or test can assert on.
 *
 * Why this does not fail the request
 * ----------------------------------
 * `fireAndForgetAudit` is invoked from `withTelemetry` in mcp-server.ts AFTER
 * the tool result exists, and the promise is handed to `ctx.waitUntil()` — it
 * completes after the response has already left the Worker. There is no
 * request left to fail. Making the write blocking would (a) add a Supabase
 * round-trip to the latency of every MCP tool call and (b) convert any audit
 * -store outage into a total MCP outage, trading an availability incident for
 * a logging incident. SOC 2 CC7.2 asks that a control failure be *detected*,
 * not that the service stop; detection is what was missing here, so detection
 * is what this fixes. If a future control requires hard write-or-refuse
 * semantics, that is a different design (synchronous pre-flight write before
 * dispatch), not a tweak to this catch block.
 */

import type { Env } from './env';
import { sha256Hex, hmacSha256Hex } from './mcp-crypto-utils';
import type { AuditEventCategory } from './audit-event-category';

/** One-time warning latch — a per-request log line would flood Logpush. */
let warnedMissingIpPepper = false;

/**
 * Keyed digest of the caller IP, or null.
 *
 * NEVER a bare sha256: the DPA warrants "hashed IP addresses", and an unsalted
 * SHA-256 of an IPv4 is reversible by enumerating the ~4.3e9 address space, so
 * it is an encoding rather than a pseudonymisation control. Without the pepper
 * the honest record is "no caller identifier" (null), not a digest that only
 * looks protective.
 */
async function pseudonymizeIp(env: Env, clientIp: string | null): Promise<string | null> {
  if (!clientIp) return null;
  const pepper = env.MCP_IP_HASH_PEPPER;
  if (!pepper) {
    if (!warnedMissingIpPepper) {
      warnedMissingIpPepper = true;
      console.warn(
        '[mcp-audit-log] MCP_IP_HASH_PEPPER unset — recording ip_hash=null. '
          + 'Provision it with `wrangler secret put MCP_IP_HASH_PEPPER --name arkova-edge`.',
      );
    }
    return null;
  }
  return hmacSha256Hex(clientIp, pepper);
}

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
 * Stable token for the audit-write failure record.
 *
 * Alerting binds to this exact string. Do not reword it; a log-based alert
 * that stops matching is the same defect this bug was.
 */
export const AUDIT_WRITE_FAILED = 'MCP_AUDIT_WRITE_FAILED';

/**
 * `permanent`  — 4xx other than auth. The request shape violates the DB
 *                contract (bad column, bad enum, RLS/CHECK rejection). It
 *                will NEVER succeed on retry; only a code change fixes it.
 *                This is the class BUG-2026-08-13-016 was in.
 * `credential` — 401/403. Service-role key rotated, revoked, or unset.
 * `transient`  — 5xx, network failure, timeout. Retry may succeed.
 */
export type AuditFailureClass = 'permanent' | 'credential' | 'transient';

function classifyStatus(status: number): AuditFailureClass {
  if (status === 401 || status === 403) return 'credential';
  if (status >= 400 && status < 500) return 'permanent';
  return 'transient';
}

/**
 * Extract ONLY the PostgREST/Postgres SQLSTATE from an error body.
 *
 * The body is otherwise untrusted for logging: PostgREST returns
 * `{code, message, details, hint}` and for a CHECK violation `details` is
 * "Failing row contains (...)" — i.e. the audit row itself, including
 * `actor_id`. The whitelist regex means that even if PostgREST changes its
 * error shape, nothing but a short SQLSTATE-like token can ever escape.
 * `23514` (check_violation) is the code that would have named this bug on
 * day one.
 */
function postgrestErrorCode(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { code?: unknown };
    const code = parsed?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{1,10}$/.test(code)) return code;
  } catch {
    // Non-JSON body (HTML error page, empty). Nothing safe to extract.
  }
  return null;
}

/** Process-lifetime count of audit rows we failed to persist. */
let auditWriteFailures = 0;

/**
 * Number of audit writes that did not persist since this isolate started.
 *
 * Non-zero means the audit trail has holes. Exposed so a health probe or a
 * test can assert on the control instead of trusting that it ran.
 */
export function getAuditWriteFailureCount(): number {
  return auditWriteFailures;
}

/** Test seam — resets the process-lifetime counter. */
export function __resetAuditWriteFailureCountForTests(): void {
  auditWriteFailures = 0;
}

/**
 * Emit the loud, structured failure record.
 *
 * JSON (not prose) so a Logpush consumer can filter on `event` and alert on
 * `failure_class === "permanent"` without regex-matching a sentence.
 */
function reportAuditWriteFailure(fields: {
  toolName: string;
  failureClass: AuditFailureClass;
  httpStatus: number | null;
  pgCode: string | null;
  detail: string | null;
}): void {
  auditWriteFailures += 1;
  console.error(JSON.stringify({
    event: AUDIT_WRITE_FAILED,
    severity: fields.failureClass === 'transient' ? 'error' : 'critical',
    failure_class: fields.failureClass,
    http_status: fields.httpStatus,
    pg_code: fields.pgCode,
    tool: fields.toolName,
    detail: fields.detail,
    failures_this_isolate: auditWriteFailures,
    impact: 'MCP tool-call audit row NOT persisted — audit trail has a hole.',
    action: fields.failureClass === 'permanent'
      ? 'PERMANENT: the row violates the audit_events contract and will never '
        + 'persist on retry. Requires a code fix + redeploy, not an ops retry.'
      : fields.failureClass === 'credential'
        ? 'Check SUPABASE_SERVICE_ROLE_KEY on the arkova-edge Worker.'
        : 'Transient — check Supabase/PostgREST availability.',
  }));
}

/**
 * Log an MCP tool invocation. Callers should hand the returned promise to
 * `ctx.waitUntil()` (via `fireAndForgetAudit` below) so the response latency
 * doesn't depend on the audit-log round-trip.
 */
export async function logMcpToolCall(env: Env, entry: McpAuditEntry): Promise<void> {
  try {
    const argsHash = await sha256Hex(entry.argsJson);
    const ipHash = await pseudonymizeIp(env, entry.clientIp);

    // BUG-2026-08-13-016: MUST be uppercase. The `AuditEventCategory`
    // annotation is the guard — a lowercase literal here is a type error,
    // which is the only reason this cannot silently regress.
    const eventCategory: AuditEventCategory = 'SECURITY';

    const body = {
      event_type: 'MCP_TOOL_CALL',
      event_category: eventCategory,
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
      // Drain the body so the socket can be reused. Only the SQLSTATE is
      // extracted from it — see `postgrestErrorCode` for why the rest of the
      // body must never reach a log.
      const rawBody = await response.text().catch(() => '');
      reportAuditWriteFailure({
        toolName: entry.toolName,
        failureClass: classifyStatus(response.status),
        httpStatus: response.status,
        pgCode: postgrestErrorCode(rawBody),
        detail: null,
      });
    }
  } catch (err) {
    reportAuditWriteFailure({
      toolName: entry.toolName,
      failureClass: 'transient',
      httpStatus: null,
      pgCode: null,
      detail: safeErrLine(err),
    });
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
