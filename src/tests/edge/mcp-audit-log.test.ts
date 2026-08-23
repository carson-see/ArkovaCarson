/**
 * BUG-2026-08-13-016 (P0) — the MCP tool-call audit log never wrote a row.
 *
 * @vitest-environment node
 *
 * `services/edge/src/mcp-audit-log.ts` shipped 2026-05-26 emitting
 * `event_category: 'security'` against a CHECK constraint that accepts
 * uppercase only. Every insert returned HTTP 400; the insert is
 * fire-and-forget so nothing surfaced. Production holds 409,885 audit rows
 * and ZERO `MCP_TOOL_CALL` — a SOC 2 audit-trail control that has never
 * operated once.
 *
 * The module had no dedicated test file. What coverage existed
 * (`mcp-security.test.ts`) asserted `event_category === 'security'`: it
 * pinned the defect in place, because the fetch mock returned 201
 * unconditionally and the constraint was never in the loop.
 *
 * So these tests do not compare strings against a constant copied from the
 * migration by hand. They:
 *   1. derive the allowed set from the migration that defines the CHECK, and
 *   2. put a constraint-enforcing PostgREST stub in front of the module,
 * so "the row would be rejected by the real database" is what fails, and a
 * future change to either side that breaks the contract fails here too.
 *
 * NOTE ON PLACEMENT: this lives in the ROOT vitest suite, not
 * `services/edge/src/`, because `.github/workflows/ci.yml` typechecks the
 * edge package but never runs its vitest suite — a test under
 * `services/edge/src/` would gate nothing.
 */

declare global {
  interface KVNamespace {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  }
  interface R2Bucket { readonly __brand: 'R2Bucket' }
  interface Queue<_T = unknown> { readonly __brand: 'Queue' }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Ai { readonly __brand: 'Ai'; run(model: string, inputs: any): Promise<any> }
  interface MessageBatch<_T = unknown> { readonly __brand: 'MessageBatch' }
}

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';

// The edge helpers use crypto.subtle.digest (args hash) AND importKey/sign
// (keyed IP hash). jsdom ships a partial subtle that has digest but not
// importKey, so probe for importKey specifically — probing digest silently
// leaves the HMAC path broken.
beforeAll(() => {
  if (!globalThis.crypto?.subtle?.importKey) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: true });
  }
});

import {
  logMcpToolCall,
  fireAndForgetAudit,
  getAuditWriteFailureCount,
  __resetAuditWriteFailureCountForTests,
  AUDIT_WRITE_FAILED,
} from '../../../services/edge/src/mcp-audit-log';
import { AUDIT_EVENT_CATEGORIES } from '../../../services/edge/src/audit-event-category';
import type { Env } from '../../../services/edge/src/env';

// ---------------------------------------------------------------------------
// Derive the CHECK constraint from the migrations — never hand-copied.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, '../../../supabase/migrations');

/** Strip `--` line comments so a ROLLBACK note is never mistaken for live DDL. */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

/**
 * The event_category values the database actually accepts, read from the
 * highest-numbered migration that (re)defines
 * `audit_events_event_category_valid`. Scanning all migrations rather than
 * pinning 0309 means a future migration that changes the set is picked up
 * automatically instead of silently diverging.
 */
function allowedCategoriesFromMigrations(): { file: string; categories: string[] } {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let found: { file: string; categories: string[] } | null = null;

  for (const file of files) {
    const sql = stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8'));
    const re = /CONSTRAINT\s+"?audit_events_event_category_valid"?\s+CHECK\s*\(+\s*"?event_category"?\s*=\s*ANY\s*\(\s*ARRAY\s*\[([\s\S]*?)\]/gi;
    for (const m of sql.matchAll(re)) {
      const categories = [...m[1].matchAll(/'([^']+)'/g)].map((c) => c[1]);
      if (categories.length) found = { file, categories };
    }
  }

  if (!found) throw new Error('No audit_events_event_category_valid CHECK found in supabase/migrations');
  return found;
}

const DB_CONSTRAINT = allowedCategoriesFromMigrations();

// ---------------------------------------------------------------------------
// A PostgREST stub that actually enforces the CHECK constraint.
// ---------------------------------------------------------------------------

interface CapturedInsert {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const captured: CapturedInsert[] = [];

/**
 * Stands in for Supabase. Rejects exactly as Postgres would: SQLSTATE 23514
 * (check_violation), and — critically — an error `details` payload that
 * echoes the failing row, which is what the module must never log.
 */
function constraintEnforcingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    captured.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body });

    const category = body.event_category;
    if (typeof category !== 'string' || !DB_CONSTRAINT.categories.includes(category)) {
      return new Response(
        JSON.stringify({
          code: '23514',
          message: 'new row for relation "audit_events" violates check constraint "audit_events_event_category_valid"',
          details: `Failing row contains (${body.actor_id}, MCP_TOOL_CALL, ${String(category)}, ...).`,
          hint: null,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(null, { status: 201 });
  });
}

const IP_PEPPER = 'test-edge-ip-pepper-0123456789ab';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: 'https://stub.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-do-not-log',
    MCP_IP_HASH_PEPPER: IP_PEPPER,
    ...overrides,
  } as unknown as Env;
}

const ENTRY = {
  apiKeyId: 'ak-1',
  userId: '11111111-2222-3333-4444-555555555555',
  toolName: 'verify_credential',
  argsJson: JSON.stringify({ public_id: 'ARK-DEG-ABC' }),
  outcome: 'success' as const,
  latencyMs: 42,
  clientIp: '203.0.113.7',
};

const origFetch = globalThis.fetch;

beforeEach(() => {
  captured.length = 0;
  __resetAuditWriteFailureCountForTests();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('BUG-2026-08-13-016 — the casing contract', () => {
  it('the migration-derived CHECK set is uppercase-only and contains SECURITY', () => {
    expect(DB_CONSTRAINT.categories).toContain('SECURITY');
    expect(DB_CONSTRAINT.categories).not.toContain('security');
    for (const c of DB_CONSTRAINT.categories) {
      expect(c).toBe(c.toUpperCase());
    }
  });

  it('the edge constant matches the database CHECK exactly (drift ratchet)', () => {
    // If a migration changes the constraint, this fails until
    // services/edge/src/audit-event-category.ts is updated to match — the
    // edge cannot import the worker's copy, so a detector replaces the
    // human promise to keep two lists in sync.
    expect([...AUDIT_EVENT_CATEGORIES].sort()).toEqual([...DB_CONSTRAINT.categories].sort());
  });

  it('THE BUG: the emitted event_category is a value the database accepts', async () => {
    // This is the assertion that was false in production for 2.5 months.
    globalThis.fetch = constraintEnforcingFetch() as unknown as typeof fetch;
    await logMcpToolCall(makeEnv(), ENTRY);

    expect(captured).toHaveLength(1);
    expect(captured[0].body.event_category).toBe('SECURITY');
    expect(captured[0].body.event_category).not.toBe('security');
    expect(DB_CONSTRAINT.categories).toContain(captured[0].body.event_category as string);
  });

  it('THE BUG, end to end: the row is PERSISTED by a constraint-enforcing store', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = constraintEnforcingFetch() as unknown as typeof fetch;

    await logMcpToolCall(makeEnv(), ENTRY);

    // The stub rejects anything the real CHECK would reject, and the module
    // reports every rejection. No failure record + a zero counter therefore
    // means the row was accepted — the direct negation of the production
    // finding "409,885 audit rows, ZERO MCP_TOOL_CALL".
    expect(err).not.toHaveBeenCalled();
    expect(getAuditWriteFailureCount()).toBe(0);
    expect(captured).toHaveLength(1);
  });
});

describe('successful insert shape', () => {
  beforeEach(() => {
    globalThis.fetch = constraintEnforcingFetch() as unknown as typeof fetch;
  });

  it('posts the full MCP_TOOL_CALL row to audit_events with service-role auth', async () => {
    await logMcpToolCall(makeEnv(), ENTRY);

    const { url, headers, body } = captured[0];
    expect(url).toBe('https://stub.supabase.co/rest/v1/audit_events');
    expect(headers.apikey).toBe('service-role-key-do-not-log');
    expect(headers.Authorization).toBe('Bearer service-role-key-do-not-log');
    expect(headers.Prefer).toBe('return=minimal');

    expect(body.event_type).toBe('MCP_TOOL_CALL');
    expect(body.event_category).toBe('SECURITY');
    expect(body.actor_id).toBe(ENTRY.userId);
    expect(body.target_type).toBe('mcp_tool');
    expect(body.target_id).toBe('verify_credential');
  });

  it('carries hashed args + keyed ip in details, never raw values', async () => {
    await logMcpToolCall(makeEnv(), ENTRY);

    const details = JSON.parse(captured[0].body.details as string) as Record<string, unknown>;
    expect(details.api_key_id).toBe('ak-1');
    expect(details.outcome).toBe('success');
    expect(details.latency_ms).toBe(42);
    expect(details.args_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(details.ip_hash).toMatch(/^[0-9a-f]{64}$/);

    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain('ARK-DEG-ABC');
    expect(serialized).not.toContain('203.0.113.7');
  });
});

describe('the loud-failure path (an audit control that fails silently is the defect)', () => {
  it('classifies a CHECK-constraint rejection as PERMANENT and names the SQLSTATE', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Force the exact production failure: a category the constraint rejects.
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        code: '23514',
        message: 'violates check constraint "audit_events_event_category_valid"',
        details: 'Failing row contains (11111111-2222-3333-4444-555555555555, ...).',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    await logMcpToolCall(makeEnv(), ENTRY);

    expect(err).toHaveBeenCalledTimes(1);
    const record = JSON.parse(err.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record.event).toBe(AUDIT_WRITE_FAILED);
    expect(record.failure_class).toBe('permanent');
    expect(record.severity).toBe('critical');
    expect(record.http_status).toBe(400);
    expect(record.pg_code).toBe('23514');
    expect(record.tool).toBe('verify_credential');
    expect(String(record.action)).toContain('PERMANENT');
  });

  it('counts every non-persisted row so the hole in the trail is measurable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;

    expect(getAuditWriteFailureCount()).toBe(0);
    await logMcpToolCall(makeEnv(), ENTRY);
    await logMcpToolCall(makeEnv(), ENTRY);
    expect(getAuditWriteFailureCount()).toBe(2);
  });

  it('NEVER leaks the failing-row body, the raw IP, or the service-role key', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        code: '23514',
        message: 'violates check constraint',
        details: 'Failing row contains (11111111-2222-3333-4444-555555555555, secret-payload).',
        hint: 'do not log me',
      }),
      { status: 400 },
    )) as unknown as typeof fetch;

    await logMcpToolCall(makeEnv(), ENTRY);

    const line = err.mock.calls[0][0] as string;
    expect(line).not.toContain('Failing row contains');
    expect(line).not.toContain('secret-payload');
    expect(line).not.toContain('do not log me');
    expect(line).not.toContain('service-role-key-do-not-log');
    expect(line).not.toContain('203.0.113.7');
    expect(line).not.toContain('ARK-DEG-ABC');
  });

  it('refuses to echo a non-SQLSTATE-shaped code (whitelist, not blocklist)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ code: 'sensitive free text that is not a sqlstate' }),
      { status: 400 },
    )) as unknown as typeof fetch;

    await logMcpToolCall(makeEnv(), ENTRY);

    const record = JSON.parse(err.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record.pg_code).toBeNull();
    expect(err.mock.calls[0][0]).not.toContain('sensitive free text');
  });

  it('classifies 401/403 as credential and 5xx as transient', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (const [status, expected, severity] of [
      [401, 'credential', 'critical'],
      [403, 'credential', 'critical'],
      [503, 'transient', 'error'],
    ] as const) {
      err.mockClear();
      globalThis.fetch = vi.fn(async () => new Response('{}', { status })) as unknown as typeof fetch;
      await logMcpToolCall(makeEnv(), ENTRY);
      const record = JSON.parse(err.mock.calls[0][0] as string) as Record<string, unknown>;
      expect(record.failure_class).toBe(expected);
      expect(record.severity).toBe(severity);
    }
  });

  it('reports a thrown network error as transient without leaking the request', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connection reset');
    }) as unknown as typeof fetch;

    await expect(logMcpToolCall(makeEnv(), ENTRY)).resolves.toBeUndefined();

    const record = JSON.parse(err.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record.event).toBe(AUDIT_WRITE_FAILED);
    expect(record.failure_class).toBe('transient');
    expect(record.http_status).toBeNull();
    expect(String(record.detail)).toContain('connection reset');
    expect(getAuditWriteFailureCount()).toBe(1);
  });
});

describe('deliberate fail-open contract (documented, not accidental)', () => {
  it('a failed audit write never throws into the tool response path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;

    await expect(logMcpToolCall(makeEnv(), ENTRY)).resolves.toBeUndefined();
  });

  it('fireAndForgetAudit hands the promise to waitUntil — the write outlives the response', async () => {
    globalThis.fetch = constraintEnforcingFetch() as unknown as typeof fetch;
    const pending: Promise<unknown>[] = [];

    fireAndForgetAudit(makeEnv(), ENTRY, { waitUntil: (p) => { pending.push(p); } });

    // The audit write is scheduled, not awaited, by the caller. This is why
    // failing the request on audit failure is not available at this seam:
    // by the time the write resolves the response has already been returned.
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(captured).toHaveLength(1);
  });

  it('does not reject when no waitUntil executor is supplied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;

    expect(() => fireAndForgetAudit(makeEnv(), ENTRY)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
