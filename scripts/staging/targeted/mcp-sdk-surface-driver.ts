#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/targeted/mcp-sdk-surface-driver.ts  (PR #2589 / SCRUM-3797)
 *
 * TARGETED soak driver for Arkova's MCP + SDK surfaces. Unlike
 * `load-harness --mode mixed` (which only proves the worker is up), this
 * drives the EXACT tool-naming-collision fix (fix/mcp-tool-naming-collision,
 * plus the coordinator's D3/D4/D5 follow-ups: OAuth discovery, hosted
 * arkova_-prefixed tool names, and the stdio package's closed 6-tool set)
 * across FOUR independently-shipped surfaces and captures the response
 * bodies that prove each branch was reached:
 *
 *   A) HOSTED MCP over streamable HTTP (services/edge/, a Cloudflare Worker,
 *      `STAGING_EDGE_MCP_BASE`) — initialize, tools/list (asserts no
 *      "credential"-named tool, EVERY tool name is `arkova_`- or
 *      `nessie_`-prefixed [D4], `arkova_verify_anchor` +
 *      `arkova_search_anchors` present, both descriptions carry the "does
 *      NOT read local files" note), tools/call for every READ tool incl.
 *      the deliberately-disabled `nessie_query`, FIVE negatives (no auth,
 *      bogus key, unknown tool, the REMOVED `search_credentials` name, and
 *      the REMOVED pre-D4 unprefixed `search_anchors` name), the
 *      `.well-known/oauth-protected-resource` discovery document (D3: it
 *      must NOT advertise `authorization_servers` — asserted unconditionally,
 *      since that is the only shape this PR ships), and an `audit_events`
 *      `MCP_TOOL_CALL` row-count control (before/after the tools/call batch).
 *
 *   B) LOCAL stdio MCP package (`sdks/mcp-server`, unscoped npm name
 *      `arkova-mcp-server`) — `npm pack` + install into a temp dir ONCE at
 *      driver start, then per cycle spawn a fresh `dist/cli.js` child,
 *      speak JSON-RPC over stdio (initialize, notifications/initialized,
 *      tools/list — asserting the EXACT closed 6-tool set post-D5, the
 *      four `nessie_*` capability tools having been removed — then four
 *      `arkova_*` READ tool calls), and assert stdio hygiene: every stdout
 *      line must be valid JSON-RPC (logs belong on stderr).
 *
 *   C) SDK contract smoke (`--with-sdks`, optional and thin) — `npm pack`
 *      the TypeScript SDK (`packages/sdk`, `arkova`) and install the Python sdist
 *      using an absolute Python executable (both SDK legs are required)
 *      (`packages/arkova-py`, unscoped `arkova`) into a venv, then call
 *      `verify()` / `verifyBatch()` against the isolated rig through a tiny
 *      loopback proxy that injects the Cloud Run IAM header (neither SDK
 *      has a custom-header hook — see `startIamLoopbackProxy`).
 *
 *   D) BEARER-JWT section (coordinator follow-up, hosted surface only) —
 *      obtains a real Supabase session JWT via GoTrue password grant
 *      (`STAGING_JWT_EMAIL`/`STAGING_JWT_PASSWORD`/`STAGING_SUPABASE_ANON_KEY`)
 *      and asserts initialize + tools/list succeed over Bearer auth (not
 *      just X-API-Key), captures the session token's header `alg` into
 *      evidence (expected `ES256` — the edge verifier was HS256-only before
 *      this fix), and asserts a SIGNATURE-tampered copy of the same token is
 *      rejected (401). Skips cleanly (no failing outcome) when its env is
 *      absent — this login fixture is a heavier precondition than the rest
 *      of the driver's env contract and may not exist on every rig.
 *
 * Every request is READ-ONLY. No SDK write method (anchor / bulk-anchor /
 * attest) is ever called, and `arkova_create_attestation` (advertised by the
 * stdio package but never invoked here) is likewise never called (§1.11A —
 * a rig fixture is never mutated by a soak driver beyond what the changed
 * surface itself performs).
 *
 * Env:
 *   STAGING_API_BASE                     REQUIRED worker rig tag URL
 *                                         (resolveStagingApiBase) — used for
 *                                         the audit-control REST reads and,
 *                                         under --with-sdks, as the SDKs'
 *                                         base URL via the IAM loopback proxy.
 *   STAGING_EDGE_MCP_BASE                REQUIRED hosted MCP Worker URL
 *                                         (e.g. https://arkova-edge-mcp-sdk-
 *                                         3894.<acct>.workers.dev)
 *   STAGING_API_KEY                      REQUIRED X-API-Key for the hosted
 *                                         MCP surface + the SDK smoke calls
 *   STAGING_SUPABASE_URL                 REQUIRED for the audit_events count
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY    REQUIRED for the audit_events count
 *   STAGING_FIXTURE_PUBLIC_ID            REQUIRED existing anchor public_id
 *   STAGING_FIXTURE_FINGERPRINT          REQUIRED 64-hex fingerprint on the rig
 *   STAGING_FIXTURE_SEARCH_TERM          REQUIRED free-text search term
 *   STAGING_GCP_IDENTITY                 optional pre-fetched Cloud Run IAM
 *                                         token (reused via runtime.iamAuthHeaders)
 *   STAGING_JWT_EMAIL                    optional — enables §D (Bearer-JWT);
 *                                         a GoTrue-loginable rig user's email
 *   STAGING_JWT_PASSWORD                 optional — required alongside _EMAIL
 *   STAGING_SUPABASE_ANON_KEY            optional — required alongside _EMAIL
 *   MCP_PACKAGE_DIR                      optional, default `sdks/mcp-server`
 *   STAGING_NPM_CLI                       optional absolute npm-cli.js path;
 *                                         defaults to the current Node installation
 *   STAGING_PYTHON_BIN                    optional absolute Python 3 executable;
 *                                         never resolved through PATH
 *
 * `--dry-run` prints the plan (with placeholder fixtures) without packing,
 * spawning, or firing anything.
 */

import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { resolveStagingApiBase } from '../load-harness-env';
import {
  newDriverStats,
  recordOutcome,
  summarizeEvidence,
  bodySnippet,
  type DriverStats,
  type JsonBody,
  type DriverEvidence,
} from './driver-core';
import { iamAuthHeaders, requireEnv, writeEvidenceFile } from './runtime';

const execFileAsync = promisify(execFile);

export const MCP_SDK_DRIVER = { driver: 'mcp-sdk-surface', pr: '#2589' } as const;

// ─── entry-point detection (path comparison, not a string compare — see
// public-projection-driver.ts / agents.md: the soak supervisor launches this
// driver via `npm exec tsx scripts/staging/...`, which hands argv[1] as a
// RELATIVE path, so a bare `import.meta.url === file://${argv[1]}` compare
// silently never matches under the real launch path) ─────────────────────
export function isDirectRun(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const canonical = (p: string): string => {
    try {
      return realpathSync(resolve(p));
    } catch {
      return resolve(p);
    }
  };
  return canonical(fileURLToPath(moduleUrl)) === canonical(argv1);
}

// ─── env resolution (pure) ──────────────────────────────────────────────

const PROD_EDGE_MCP_HOST = 'edge.arkova.ai';

/**
 * Resolve + validate `STAGING_EDGE_MCP_BASE`. Mirrors the shape of
 * `../load-harness-env.resolveStagingApiBase` (https-only, refuses
 * production) for the hosted-MCP Cloudflare Worker surface, which does not
 * live on the `arkova-worker-*.run.app` tag-routing scheme that
 * `resolveStagingApiBase` enforces, so it needs its own (lighter) check.
 */
export function resolveEdgeMcpBase(env: { STAGING_EDGE_MCP_BASE?: string }): string {
  const raw = env.STAGING_EDGE_MCP_BASE?.trim();
  if (!raw) {
    throw new Error(
      'STAGING_EDGE_MCP_BASE is required for the mcp-sdk-surface driver. Set it to the ' +
        'per-soak hosted MCP Worker URL (e.g. https://arkova-edge-mcp-<tag>.<acct>.workers.dev).',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`STAGING_EDGE_MCP_BASE must be an absolute URL; received \`${raw}\`.`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`STAGING_EDGE_MCP_BASE must use https; received \`${url.protocol}\`.`);
  }
  if (url.hostname === PROD_EDGE_MCP_HOST) {
    throw new Error(`STAGING_EDGE_MCP_BASE must not point at production (${PROD_EDGE_MCP_HOST}).`);
  }
  url.search = '';
  url.hash = '';
  let out = url.toString();
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

// ─── JSON-RPC helpers (pure) ────────────────────────────────────────────

export interface JsonRpcRequestBody {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotificationBody {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export function buildJsonRpcRequest(method: string, params: unknown, id: number): JsonRpcRequestBody {
  return params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
}

export function buildJsonRpcNotification(method: string, params?: unknown): JsonRpcNotificationBody {
  return params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
}

export type McpOutcomeKind = 'jsonrpc-result' | 'jsonrpc-error' | 'unparseable';

/** Classify a parsed JSON-RPC response body at the PROTOCOL level. */
export function classifyMcpOutcome(body: JsonBody): McpOutcomeKind {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unparseable';
  const b = body as Record<string, unknown>;
  if ('error' in b) return 'jsonrpc-error';
  if ('result' in b) return 'jsonrpc-result';
  return 'unparseable';
}

/**
 * True when a `jsonrpc-result` carries `result.isError === true` — the MCP
 * convention for an APPLICATION-level tool failure (e.g. `nessie_query`'s
 * deliberately-disabled response) that is still a successful JSON-RPC call.
 */
export function isToolResultError(body: JsonBody): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const result = (body as Record<string, unknown>).result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  return (result as Record<string, unknown>).isError === true;
}

// ─── tools/list assertions (pure) ───────────────────────────────────────

export interface McpToolSummary {
  name: string;
  description: string;
}

/** Pull `result.tools[]` out of a tools/list response body. Null on any shape miss. */
export function extractToolList(body: JsonBody): McpToolSummary[] | null {
  if (classifyMcpOutcome(body) !== 'jsonrpc-result') return null;
  const result = (body as Record<string, unknown>).result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return null;
  return tools
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      name: typeof t.name === 'string' ? t.name : '',
      description: typeof t.description === 'string' ? t.description : '',
    }));
}

const API_ONLY_PHRASE = 'does NOT read local files';

/** SCRUM-2589's core assertion: no tool name contains "credential" (case-insensitive). */
export function assertNoCredentialNamedTools(tools: readonly McpToolSummary[]): string | null {
  const offenders = tools.filter((t) => t.name.toLowerCase().includes('credential')).map((t) => t.name);
  return offenders.length ? `tool name(s) still contain "credential": ${offenders.join(', ')}` : null;
}

export function assertRequiredToolsPresent(
  tools: readonly McpToolSummary[],
  required: readonly string[],
): string | null {
  const names = new Set(tools.map((t) => t.name));
  const missing = required.filter((n) => !names.has(n));
  return missing.length ? `required tool(s) missing: ${missing.join(', ')}` : null;
}

/** Every named tool's description must carry the belt-and-braces API-only note. */
export function assertApiOnlyNotePresent(
  tools: readonly McpToolSummary[],
  toolNames: readonly string[],
): string | null {
  const missing = toolNames.filter((name) => {
    const tool = tools.find((t) => t.name === name);
    return !tool || !tool.description.includes(API_ONLY_PHRASE);
  });
  return missing.length ? `tool(s) missing the "${API_ONLY_PHRASE}" note: ${missing.join(', ')}` : null;
}

/**
 * D4: every HOSTED tool name must be `arkova_`-prefixed, with the sole
 * documented exception of the `nessie_`-prefixed capability tool(s) — the
 * hosted surface's tool namespace now matches the npm/stdio package's.
 */
export function assertToolNamePrefixes(
  tools: readonly McpToolSummary[],
  allowedPrefixes: readonly string[],
): string | null {
  const offenders = tools.filter((t) => !allowedPrefixes.some((p) => t.name.startsWith(p))).map((t) => t.name);
  return offenders.length
    ? `tool name(s) missing an allowed prefix (${allowedPrefixes.join('/')}): ${offenders.join(', ')}`
    : null;
}

/**
 * D5: the stdio surface now advertises an EXACT, closed tool set (the four
 * `nessie_*` capability tools were removed from the npm package). Flags both
 * missing tools AND unexpected extras — a tool count match alone would miss
 * a same-count substitution.
 */
export function assertExactToolSet(tools: readonly McpToolSummary[], expectedNames: readonly string[]): string | null {
  const actual = tools.map((t) => t.name).sort((a, b) => a.localeCompare(b));
  const expected = [...expectedNames].sort((a, b) => a.localeCompare(b));
  if (actual.length !== expected.length) {
    return `expected exactly ${expected.length} tools, got ${actual.length}: [${actual.join(', ')}]`;
  }
  const missing = expected.filter((n) => !actual.includes(n));
  const extra = actual.filter((n) => !expected.includes(n));
  return missing.length || extra.length
    ? `tool set mismatch — missing: [${missing.join(', ')}], unexpected: [${extra.join(', ')}]`
    : null;
}

export interface ToolsListAssertion {
  errors: string[];
  tools: McpToolSummary[];
  credentialNamedCount: number;
  apiOnlyNotePresent: boolean;
}

/**
 * Combined tools/list assertion shared by BOTH the hosted and stdio
 * surfaces. `requiredNamePrefixes`, when given, additionally asserts EVERY
 * tool name carries one of the allowed prefixes (D4, hosted-only).
 * `expectedExactNames`, when given, additionally asserts the tool set is
 * EXACTLY that closed list — no more, no fewer (D5, stdio-only).
 */
export function assertToolsList(
  body: JsonBody,
  requiredTools: readonly string[],
  noteTools: readonly string[],
  requiredNamePrefixes?: readonly string[],
  expectedExactNames?: readonly string[],
): ToolsListAssertion {
  const tools = extractToolList(body) ?? [];
  const errors: string[] = [];
  const credErr = assertNoCredentialNamedTools(tools);
  if (credErr) errors.push(credErr);
  const reqErr = assertRequiredToolsPresent(tools, requiredTools);
  if (reqErr) errors.push(reqErr);
  const noteErr = assertApiOnlyNotePresent(tools, noteTools);
  if (noteErr) errors.push(noteErr);
  if (requiredNamePrefixes) {
    const prefixErr = assertToolNamePrefixes(tools, requiredNamePrefixes);
    if (prefixErr) errors.push(prefixErr);
  }
  if (expectedExactNames) {
    const exactErr = assertExactToolSet(tools, expectedExactNames);
    if (exactErr) errors.push(exactErr);
  }
  return {
    errors,
    tools,
    credentialNamedCount: tools.filter((t) => t.name.toLowerCase().includes('credential')).length,
    apiOnlyNotePresent: noteErr === null,
  };
}

// D4: hosted tool names now match the npm/stdio package's arkova_-prefixed
// namespace (nessie_-prefixed capability tools are the sole exception).
export const HOSTED_REQUIRED_TOOLS = ['arkova_verify_anchor', 'arkova_search_anchors'] as const;
export const HOSTED_NOTE_TOOLS = ['arkova_verify_anchor', 'arkova_search_anchors'] as const;
export const HOSTED_ALLOWED_NAME_PREFIXES = ['arkova_', 'nessie_'] as const;

export const STDIO_REQUIRED_TOOLS = ['arkova_verify_anchor', 'arkova_search_anchors'] as const;
export const STDIO_NOTE_TOOLS = ['arkova_verify_anchor', 'arkova_search_anchors'] as const;
export const STDIO_ALLOWED_NAME_PREFIXES = ['arkova_'] as const;
// D5: the four nessie_* tools were removed from the npm package — an EXACT,
// closed 6-tool set (arkova_create_attestation + arkova_verify_signature are
// advertised but never CALLED by this driver — the former is a write, the
// latter was simply not in the original READ-tool call plan).
export const STDIO_EXPECTED_TOOL_NAMES = [
  'arkova_verify_anchor',
  'arkova_anchor_status',
  'arkova_search_anchors',
  'arkova_create_attestation',
  'arkova_batch_verify',
  'arkova_verify_signature',
] as const;
export const STDIO_EXPECTED_TOOL_COUNT = STDIO_EXPECTED_TOOL_NAMES.length;

// ─── OAuth discovery assertion (pure) ───────────────────────────────────

/**
 * D3: the hosted MCP `.well-known/oauth-protected-resource` document must NOT
 * advertise `authorization_servers`. Asserted UNCONDITIONALLY — the absent-key
 * shape is the only one this PR ships, so a switch to "expect it present"
 * could only ever make a CORRECT build fail. Key PRESENCE is the test: an
 * empty `authorization_servers: []` still advertises an authorization-server
 * list to a discovering client.
 */
export function assertOauthNotAdvertised(body: JsonBody): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'discovery body is not an object';
  if ('authorization_servers' in (body as Record<string, unknown>)) {
    return 'authorization_servers key PRESENT (D3: OAuth must no longer be advertised post-fix)';
  }
  return null;
}

// ─── negative-case assertion (pure) ─────────────────────────────────────

/**
 * A removed/unknown tool name must be rejected. The MCP SDK's normal path is
 * a protocol-level JSON-RPC error (`error` key) from the `tools/call`
 * dispatcher, so that is the primary expectation — but a `result.isError`
 * tool-level rejection is accepted too so this assertion does not become a
 * false failure if a future revision surfaces the rejection at that layer
 * instead (both shapes equally prove the name is gone).
 */
export function assertUnknownToolRejected(body: JsonBody): string | null {
  const kind = classifyMcpOutcome(body);
  if (kind === 'jsonrpc-error') return null;
  if (kind === 'jsonrpc-result' && isToolResultError(body)) return null;
  return `expected a JSON-RPC error for an unknown/removed tool name; got ${JSON.stringify(body).slice(0, 200)}`;
}

// ─── read-tool call plans (pure) ─────────────────────────────────────────

export interface HostedFixtures {
  publicId: string;
  fingerprint: string;
  searchTerm: string;
}

export type ReadToolExpectation = 'result' | 'either';

export interface ToolCallPlanEntry {
  label: string;
  toolName: string;
  args: Record<string, unknown>;
  expect: ReadToolExpectation;
  request: JsonRpcRequestBody;
}

// D4: the hosted surface's tool NAMES are now arkova_-prefixed (identical to
// the npm/stdio namespace); labels stay short/unprefixed purely for readable
// evidence keys (`hosted:call:verify_anchor`, not `hosted:call:arkova_verify_anchor`)
// and to keep them visually distinct from the `stdio:call:arkova_*` labels.
function toolCallSpecs(fx: HostedFixtures): Array<Omit<ToolCallPlanEntry, 'request'>> {
  return [
    { label: 'verify_anchor', toolName: 'arkova_verify_anchor', args: { public_id: fx.publicId }, expect: 'result' },
    { label: 'search_anchors', toolName: 'arkova_search_anchors', args: { query: fx.searchTerm }, expect: 'result' },
    {
      label: 'verify_document',
      toolName: 'arkova_verify_document',
      args: { content_hash: fx.fingerprint },
      expect: 'result',
    },
    { label: 'get_anchor', toolName: 'arkova_get_anchor', args: { public_id: fx.publicId }, expect: 'result' },
    {
      label: 'verify_batch',
      toolName: 'arkova_verify_batch',
      args: { public_ids: [fx.publicId, 'ARK-NOPE-000000'] },
      expect: 'result',
    },
    { label: 'search', toolName: 'arkova_search', args: { q: fx.searchTerm }, expect: 'result' },
    { label: 'verify', toolName: 'arkova_verify', args: { fingerprint: fx.fingerprint }, expect: 'result' },
    // nessie_query keeps its OWN prefix — the sole documented exception to D4.
    // It is also DELIBERATELY DISABLED — an EXPECTED error result, not a soak failure.
    { label: 'nessie_query', toolName: 'nessie_query', args: { query: fx.searchTerm }, expect: 'either' },
  ];
}

/** The 8 hosted `tools/call` READ probes (§A3), each carrying a deterministic request id. */
export function planHostedReadToolCalls(fx: HostedFixtures, idStart = 10): ToolCallPlanEntry[] {
  return toolCallSpecs(fx).map((s, i) => ({
    ...s,
    request: buildJsonRpcRequest('tools/call', { name: s.toolName, arguments: s.args }, idStart + i),
  }));
}

function stdioToolCallSpecs(fx: HostedFixtures): Array<Omit<ToolCallPlanEntry, 'request'>> {
  return [
    { label: 'arkova_verify_anchor', toolName: 'arkova_verify_anchor', args: { public_id: fx.publicId }, expect: 'result' },
    { label: 'arkova_anchor_status', toolName: 'arkova_anchor_status', args: { public_id: fx.publicId }, expect: 'result' },
    { label: 'arkova_search_anchors', toolName: 'arkova_search_anchors', args: { query: fx.searchTerm }, expect: 'result' },
    // arkova_batch_verify's inputSchema declares public_ids as a STRING (a
    // JSON-array-encoded string, capped at 20 ids per the 3.0.0 wire shape),
    // not a native array — see sdks/mcp-server/src/index.ts.
    {
      label: 'arkova_batch_verify',
      toolName: 'arkova_batch_verify',
      args: { public_ids: JSON.stringify([fx.publicId]) },
      expect: 'result',
    },
  ];
}

/** The 4 stdio `tools/call` READ probes (§B). */
export function planStdioReadToolCalls(fx: HostedFixtures, idStart = 3): ToolCallPlanEntry[] {
  return stdioToolCallSpecs(fx).map((s, i) => ({
    ...s,
    request: buildJsonRpcRequest('tools/call', { name: s.toolName, arguments: s.args }, idStart + i),
  }));
}

/**
 * Assert a single tool/call outcome. `expect: 'result'` requires a genuine
 * jsonrpc-result; `expect: 'either'` (nessie_query only) accepts either a
 * protocol error OR a result-level `isError: true` — both equally prove the
 * capability is gated off, which IS the documented branch under test.
 */
export function assertReadToolOutcome(body: JsonBody, expect: ReadToolExpectation): string | null {
  const kind = classifyMcpOutcome(body);
  if (expect === 'result') {
    return kind === 'jsonrpc-result'
      ? null
      : `expected a JSON-RPC result; got ${JSON.stringify(body).slice(0, 200)}`;
  }
  if (kind === 'jsonrpc-error') return null;
  if (kind === 'jsonrpc-result' && isToolResultError(body)) return null;
  return `expected an EXPECTED-error outcome (disabled capability); got ${JSON.stringify(body).slice(0, 200)}`;
}

// ─── hosted negative-case plan (pure) ────────────────────────────────────

export type HostedAuthMode = 'valid' | 'missing' | 'bogus';

export interface HostedNegativeCase {
  label: string;
  authMode: HostedAuthMode;
  request: JsonRpcRequestBody;
  okStatuses: readonly number[];
  assert?: (b: JsonBody) => string | null;
}

/**
 * The hosted negatives (§A4). Two of the four target REMOVED/OLD tool names —
 * `search_credentials` (the pre-rename name from the original naming-collision
 * fix) and the unprefixed `search_anchors` (D4's own OLD hosted name, before
 * the surface adopted the arkova_-prefixed namespace) — both must resolve as
 * unknown tools now that the live name is `arkova_search_anchors`.
 */
export function planHostedNegatives(idStart = 900): HostedNegativeCase[] {
  return [
    {
      label: 'no-auth',
      authMode: 'missing',
      request: buildJsonRpcRequest('tools/list', undefined, idStart),
      okStatuses: [401],
    },
    {
      label: 'bogus-key',
      authMode: 'bogus',
      request: buildJsonRpcRequest('tools/list', undefined, idStart + 1),
      okStatuses: [401],
    },
    {
      label: 'unknown-tool',
      authMode: 'valid',
      request: buildJsonRpcRequest('tools/call', { name: 'definitely_not_a_real_tool', arguments: {} }, idStart + 2),
      okStatuses: [200],
      assert: assertUnknownToolRejected,
    },
    {
      label: 'search_credentials-removed',
      authMode: 'valid',
      request: buildJsonRpcRequest(
        'tools/call',
        { name: 'search_credentials', arguments: { query: 'renamed-away' } },
        idStart + 3,
      ),
      okStatuses: [200],
      assert: assertUnknownToolRejected,
    },
    {
      label: 'search_anchors-unprefixed-removed',
      authMode: 'valid',
      request: buildJsonRpcRequest(
        'tools/call',
        { name: 'search_anchors', arguments: { query: 'pre-D4-unprefixed' } },
        idStart + 4,
      ),
      okStatuses: [200],
      assert: assertUnknownToolRejected,
    },
  ];
}

// ─── stdio hygiene (pure) ────────────────────────────────────────────────

export interface StdioClassification {
  jsonLines: unknown[];
  nonJsonLines: string[];
}

/**
 * Split raw stdio stdout into JSON-RPC lines vs everything else. ANY
 * non-empty, non-JSON stdout line is a stdio-hygiene failure — logs / banners
 * belong on stderr, never stdout, when a process is itself the JSON-RPC wire.
 */
export function classifyStdioOutput(raw: string): StdioClassification {
  const jsonLines: unknown[] = [];
  const nonJsonLines: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      jsonLines.push(JSON.parse(trimmed));
    } catch {
      nonJsonLines.push(trimmed);
    }
  }
  return { jsonLines, nonJsonLines };
}

/** Find the JSON-RPC response matching `id` among classified stdout lines. */
export function findJsonRpcResponseById(jsonLines: readonly unknown[], id: number): JsonBody | null {
  for (const line of jsonLines) {
    if (line && typeof line === 'object' && !Array.isArray(line) && (line as Record<string, unknown>).id === id) {
      return line as JsonBody;
    }
  }
  return null;
}

// ─── Bearer-JWT helpers (pure) ───────────────────────────────────────────

/**
 * Read the `alg` field out of a JWT's header segment (base64url JSON), with
 * no signature verification and no logging of the token itself — this exists
 * only to capture evidence of which algorithm the rig's GoTrue session used
 * (the edge verifier was HS256-only before this fix; ES256 is the expected
 * post-fix algorithm). Returns null on any malformed input.
 */
export function decodeJwtHeaderAlg(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const headerJson = Buffer.from(parts[0], 'base64url').toString('utf8');
    const header = JSON.parse(headerJson) as { alg?: unknown };
    return typeof header.alg === 'string' ? header.alg : null;
  } catch {
    return null;
  }
}

/**
 * Flip one base64url character in a JWT's signature segment so the token
 * fails signature verification while staying syntactically well-formed
 * (three dot-separated segments) — used only for the tampered-signature
 * negative. Never logs the original or tampered token.
 */
export function tamperJwtSignature(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[2].length === 0) return `${token}x`;
  const sig = parts[2];
  const lastChar = sig[sig.length - 1];
  const replacement = lastChar === 'A' ? 'B' : 'A';
  return `${parts[0]}.${parts[1]}.${sig.slice(0, -1)}${replacement}`;
}

// ─── audit-control helpers (pure) ────────────────────────────────────────

/** PostgREST count-only URL for `audit_events` rows of the given `event_type`. */
export function buildAuditCountUrl(supabaseUrl: string, eventType: string): string {
  const base = supabaseUrl.replace(/\/+$/, '');
  return `${base}/rest/v1/audit_events?select=id&event_type=eq.${encodeURIComponent(eventType)}&limit=1`;
}

/**
 * Parse the total row count out of a PostgREST `Content-Range` response
 * header (`Prefer: count=exact`), e.g. `0-0/117`, or the no-rows-returned
 * form with a `*` numerator (`*` over `0`). Returns -1 when the header is
 * absent or unparseable so callers never mistake "unknown" for zero.
 */
export function parseCountFromContentRange(header: string | null): number {
  if (!header) return -1;
  const match = /\/(\d+|\*)$/.exec(header.trim());
  if (!match) return -1;
  return match[1] === '*' ? 0 : Number.parseInt(match[1], 10);
}

// ─── arg parsing (pure) ──────────────────────────────────────────────────

export interface McpSdkDriverArgs {
  durationMin?: number;
  cycles?: number;
  evidenceOut?: string;
  dryRun: boolean;
  withSdks: boolean;
}

/**
 * `--duration <min>` (default 15, matching the shared targeted-driver
 * default) OR `--cycles <n>` as an alternative fixed-count mode — mutually
 * exclusive in intent, but `--cycles` simply takes priority when both are
 * given, and duration is left undefined so the runtime loop knows which mode
 * governs.
 */
export function parseMcpSdkDriverArgs(argv: string[]): McpSdkDriverArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      duration: { type: 'string' },
      cycles: { type: 'string' },
      'evidence-out': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'with-sdks': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  let cycles: number | undefined;
  if (values.cycles !== undefined) {
    const n = Number.parseInt(values.cycles, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--cycles=${values.cycles} must be a positive integer.`);
    }
    cycles = n;
  }

  let durationMin: number | undefined;
  if (values.duration !== undefined) {
    const n = Number.parseInt(values.duration, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--duration=${values.duration} must be a positive integer (minutes).`);
    }
    durationMin = n;
  }
  // Same 15-minute floor as driver-core's own (private) DEFAULT_DURATION_MIN.
  // This driver parses its own args only because of --cycles, not to differ here.
  if (cycles === undefined && durationMin === undefined) durationMin = 15;

  return {
    durationMin: cycles === undefined ? durationMin : undefined,
    cycles,
    evidenceOut: values['evidence-out'],
    dryRun: Boolean(values['dry-run']),
    withSdks: Boolean(values['with-sdks']),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Runtime (thin; NOT unit-tested — needs a live rig, npm, and a filesystem).
// Every helper below is exercised only against a real isolated rig during
// an actual soak, mirroring runtime.ts's own documented split.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Dynamic `import()` of a runtime-resolved absolute path (into a temp-dir
 * npm install of the packed SDK — never a literal specifier a bundler could
 * analyze). Routed through `new Function` so the token `import(` never
 * appears literally in this file's own AST: Vite's SSR import-analysis pass
 * (which vitest also runs this file through, for its unit tests, since it
 * imports the pure exports below) rewrites an ordinary dynamic `import()`
 * call and can inject a `/@vite/client` reference ahead of this file's `#!`
 * shebang line, which is a syntax error. This indirection is a build-time
 * concern only — Node itself does not care.
 */
const dynamicImportRuntimePath = new Function('specifier', 'return import(specifier);') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

export interface McpEvidenceExtension {
  hostedToolNames: string[];
  stdioToolNames: string[];
  credentialNamedTools: number;
  apiOnlyNotePresent: boolean;
  oauthAdvertised: boolean;
  auditRowsBefore: number;
  auditRowsAfter: number;
  stdioNonJsonLines: string[];
  stdioStderrTail: string;
  /** JWT header `alg` of the GoTrue session token used for the Bearer-JWT
   * probe (expected `ES256` on the rig — the edge verifier was HS256-only
   * before this fix). Null when the section was skipped or auth failed. */
  bearerAlg: string | null;
  /** Non-null reason string when the Bearer-JWT section (§A, coordinator
   * follow-up) was skipped — env absent or the GoTrue password grant failed.
   * Null once the section ran. */
  bearerSkipped: string | null;
}

function newMcpEvidence(): McpEvidenceExtension {
  return {
    hostedToolNames: [],
    stdioToolNames: [],
    credentialNamedTools: 0,
    apiOnlyNotePresent: false,
    oauthAdvertised: false,
    auditRowsBefore: -1,
    auditRowsAfter: -1,
    stdioNonJsonLines: [],
    stdioStderrTail: '',
    bearerAlg: null,
    bearerSkipped: null,
  };
}

// ─── hosted MCP HTTP fire (mirrors public-projection-driver's call()) ────

interface HostedCallOpts {
  stats: DriverStats;
  label: string;
  url: string;
  endpoint: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
  okStatuses: readonly number[];
  assert?: (b: JsonBody) => string | null;
}

interface HostedCallResult {
  status: number;
  body: JsonBody;
  headers: Headers | null;
  expected: boolean;
}

async function callHosted(o: HostedCallOpts): Promise<HostedCallResult> {
  const start = Date.now();
  let status = 0;
  let parsed: JsonBody = null;
  let headers: Headers | null = null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(o.url, { method: o.method ?? 'POST', headers: o.headers, body: o.body, signal: ctrl.signal });
    status = res.status;
    headers = res.headers;
    parsed = bodySnippet(await res.text());
  } catch {
    status = 0;
  } finally {
    clearTimeout(t);
  }
  let semanticFailure: string | null = null;
  const httpOk = status !== 0 && o.okStatuses.includes(status);
  if (httpOk && o.assert) semanticFailure = o.assert(parsed);
  const expected = httpOk && semanticFailure === null;
  recordOutcome(o.stats, {
    label: o.label,
    endpoint: o.endpoint,
    method: o.method ?? 'POST',
    status,
    latencyMs: Date.now() - start,
    expected,
    ...(expected ? {} : { capturedBody: parsed }),
  });
  return { status, body: parsed, headers, expected };
}

async function fetchAuditCount(supabaseUrl: string, supabaseKey: string, eventType: string): Promise<number> {
  const url = buildAuditCountUrl(supabaseUrl, eventType);
  const res = await fetch(url, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'count=exact' },
  });
  await res.text(); // drain — we only need the Content-Range header
  if (!res.ok) throw new Error(`audit_events count query failed: HTTP ${res.status}`);
  return parseCountFromContentRange(res.headers.get('content-range'));
}

// ─── Bearer-JWT section (coordinator follow-up) ─────────────────────────

/**
 * GoTrue password-grant login. Used ONLY to obtain a real Supabase session
 * JWT for the Bearer-auth probe against the hosted MCP surface — never
 * logged, never persisted, discarded at the end of the cycle.
 */
async function fetchGoTrueAccessToken(
  supabaseUrl: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<string> {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !body?.access_token) {
    throw new Error(`GoTrue password grant failed: HTTP ${res.status}`);
  }
  return body.access_token;
}

/**
 * Coordinator follow-up: the hosted MCP surface must accept a real Supabase
 * Bearer JWT (not just X-API-Key) — initialize + tools/list succeed, and a
 * SIGNATURE-tampered copy of the same token is rejected. Captures the
 * session token's header `alg` into evidence (expected ES256; the edge
 * verifier was HS256-only before this fix). Skips cleanly — no failing
 * outcome recorded — when the env this needs is absent, since a login
 * fixture is a heavier precondition than the rest of this driver's env
 * contract and may not exist on every rig.
 */
async function runHostedBearerSection(ctx: {
  stats: DriverStats;
  edgeBase: string;
  evidence: McpEvidenceExtension;
  log: (m: string) => void;
}): Promise<void> {
  const email = process.env.STAGING_JWT_EMAIL;
  const password = process.env.STAGING_JWT_PASSWORD;
  const anonKey = process.env.STAGING_SUPABASE_ANON_KEY;
  const supabaseUrl = process.env.STAGING_SUPABASE_URL;
  if (!email || !password || !anonKey || !supabaseUrl) {
    ctx.evidence.bearerSkipped = 'no STAGING_JWT_EMAIL';
    ctx.log('bearer-jwt section skipped: STAGING_JWT_EMAIL/STAGING_JWT_PASSWORD/STAGING_SUPABASE_ANON_KEY not fully set.');
    return;
  }

  let accessToken: string;
  try {
    accessToken = await fetchGoTrueAccessToken(supabaseUrl, anonKey, email, password);
  } catch (err) {
    ctx.evidence.bearerSkipped = 'gotrue-auth-failed';
    ctx.log(`bearer-jwt: GoTrue password grant failed (non-fatal, section skipped): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  ctx.evidence.bearerAlg = decodeJwtHeaderAlg(accessToken);
  ctx.evidence.bearerSkipped = null;
  ctx.log(`bearer-jwt: obtained GoTrue session, header alg=${ctx.evidence.bearerAlg}`);

  const mcpUrl = `${ctx.edgeBase}/mcp`;
  const bearerHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${accessToken}`,
  };

  const initReq = buildJsonRpcRequest(
    'initialize',
    { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'arkova-targeted-soak-bearer', version: '1.0.0' } },
    500,
  );
  await callHosted({
    stats: ctx.stats,
    label: 'hosted:bearer:initialize',
    url: mcpUrl,
    endpoint: '/mcp',
    headers: bearerHeaders,
    body: JSON.stringify(initReq),
    okStatuses: [200],
    assert: (b) => (classifyMcpOutcome(b) === 'jsonrpc-result' ? null : `unexpected bearer-initialize outcome: ${JSON.stringify(b).slice(0, 200)}`),
  });

  const listReq = buildJsonRpcRequest('tools/list', undefined, 501);
  await callHosted({
    stats: ctx.stats,
    label: 'hosted:bearer:tools/list',
    url: mcpUrl,
    endpoint: '/mcp',
    headers: bearerHeaders,
    body: JSON.stringify(listReq),
    okStatuses: [200],
    assert: (b) => (classifyMcpOutcome(b) === 'jsonrpc-result' ? null : `unexpected bearer tools/list outcome: ${JSON.stringify(b).slice(0, 200)}`),
  });

  const tamperedReq = buildJsonRpcRequest('tools/list', undefined, 502);
  await callHosted({
    stats: ctx.stats,
    label: 'hosted:bearer:tampered-signature',
    url: mcpUrl,
    endpoint: '/mcp',
    headers: { ...bearerHeaders, Authorization: `Bearer ${tamperJwtSignature(accessToken)}` },
    body: JSON.stringify(tamperedReq),
    okStatuses: [401],
  });
  ctx.log('bearer-jwt: initialize + tools/list ok with a real session JWT; tampered-signature copy rejected.');
}

async function runHostedCycle(ctx: {
  stats: DriverStats;
  edgeBase: string;
  apiKey: string;
  fx: HostedFixtures;
  supabaseUrl: string;
  supabaseKey: string;
  evidence: McpEvidenceExtension;
  log: (m: string) => void;
}): Promise<void> {
  const mcpUrl = `${ctx.edgeBase}/mcp`;
  const baseHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const validHeaders = { ...baseHeaders, 'X-API-Key': ctx.apiKey };

  // A1 — initialize
  const initReq = buildJsonRpcRequest(
    'initialize',
    { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'arkova-targeted-soak', version: '1.0.0' } },
    1,
  );
  const initResult = await callHosted({
    stats: ctx.stats,
    label: 'hosted:initialize',
    url: mcpUrl,
    endpoint: '/mcp',
    headers: validHeaders,
    body: JSON.stringify(initReq),
    okStatuses: [200],
    assert: (b) => (classifyMcpOutcome(b) === 'jsonrpc-result' ? null : `unexpected initialize outcome: ${JSON.stringify(b).slice(0, 200)}`),
  });
  const sessionId = initResult.headers?.get('mcp-session-id') ?? undefined;
  const sessionHeaders = sessionId ? { ...validHeaders, 'Mcp-Session-Id': sessionId } : validHeaders;
  if (sessionId) ctx.log(`captured Mcp-Session-Id=${sessionId}`);

  // A2 — tools/list
  const listReq = buildJsonRpcRequest('tools/list', undefined, 2);
  const listResult = await callHosted({
    stats: ctx.stats,
    label: 'hosted:tools/list',
    url: mcpUrl,
    endpoint: '/mcp',
    headers: sessionHeaders,
    body: JSON.stringify(listReq),
    okStatuses: [200],
    assert: (b) => {
      const a = assertToolsList(b, HOSTED_REQUIRED_TOOLS, HOSTED_NOTE_TOOLS, HOSTED_ALLOWED_NAME_PREFIXES);
      return a.errors.length ? a.errors.join('; ') : null;
    },
  });
  const listAssertion = assertToolsList(
    listResult.body,
    HOSTED_REQUIRED_TOOLS,
    HOSTED_NOTE_TOOLS,
    HOSTED_ALLOWED_NAME_PREFIXES,
  );
  ctx.evidence.hostedToolNames = listAssertion.tools.map((t) => t.name);
  ctx.evidence.credentialNamedTools = listAssertion.credentialNamedCount;
  ctx.evidence.apiOnlyNotePresent = listAssertion.apiOnlyNotePresent;
  ctx.log(`hosted tools/list: ${listAssertion.tools.length} tools, credential-named=${listAssertion.credentialNamedCount}`);

  // A6 (before half) — audit_events MCP_TOOL_CALL count BEFORE the tools/call batch
  let before = -1;
  try {
    before = await fetchAuditCount(ctx.supabaseUrl, ctx.supabaseKey, 'MCP_TOOL_CALL');
  } catch (err) {
    ctx.log(`audit-count (before) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // A3 — tools/call for every READ tool
  for (const spec of planHostedReadToolCalls(ctx.fx)) {
    const r = await callHosted({
      stats: ctx.stats,
      label: `hosted:call:${spec.label}`,
      url: mcpUrl,
      endpoint: '/mcp',
      headers: sessionHeaders,
      body: JSON.stringify(spec.request),
      okStatuses: [200],
      assert: (b) => assertReadToolOutcome(b, spec.expect),
    });
    ctx.log(`hosted:call:${spec.label} status=${r.status} kind=${classifyMcpOutcome(r.body)}`);
  }

  // A6 (after half)
  let after = -1;
  try {
    after = await fetchAuditCount(ctx.supabaseUrl, ctx.supabaseKey, 'MCP_TOOL_CALL');
  } catch (err) {
    ctx.log(`audit-count (after) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  ctx.evidence.auditRowsBefore = before;
  ctx.evidence.auditRowsAfter = after;
  recordOutcome(ctx.stats, {
    label: 'hosted:audit-control',
    endpoint: '/rest/v1/audit_events (count)',
    method: 'GET',
    status: before >= 0 && after >= 0 ? 200 : 0,
    latencyMs: 0,
    expected: before >= 0 && after > before,
    ...(before >= 0 && after > before ? {} : { capturedBody: { before, after } }),
  });
  ctx.log(`audit_events MCP_TOOL_CALL count: before=${before} after=${after}`);

  // A4 — negatives
  for (const neg of planHostedNegatives()) {
    const headers =
      neg.authMode === 'missing'
        ? baseHeaders
        : neg.authMode === 'bogus'
          ? { ...baseHeaders, 'X-API-Key': 'ak_live_bogus' }
          : sessionHeaders;
    const r = await callHosted({
      stats: ctx.stats,
      label: `hosted:neg:${neg.label}`,
      url: mcpUrl,
      endpoint: '/mcp',
      headers,
      body: JSON.stringify(neg.request),
      okStatuses: neg.okStatuses,
      assert: neg.assert,
    });
    ctx.log(`hosted:neg:${neg.label} status=${r.status}`);
  }

  // A5 — discovery
  const discoUrl = `${ctx.edgeBase}/mcp/.well-known/oauth-protected-resource`;
  const discoResult = await callHosted({
    stats: ctx.stats,
    label: 'hosted:discovery:oauth',
    url: discoUrl,
    endpoint: '/mcp/.well-known/oauth-protected-resource',
    method: 'GET',
    headers: { Accept: 'application/json' },
    okStatuses: [200],
    assert: assertOauthNotAdvertised,
  });
  ctx.evidence.oauthAdvertised =
    !!discoResult.body &&
    typeof discoResult.body === 'object' &&
    !Array.isArray(discoResult.body) &&
    'authorization_servers' in (discoResult.body as Record<string, unknown>);
  ctx.log(`discovery: oauthAdvertised=${ctx.evidence.oauthAdvertised} (expected=false)`);

  // Bearer-JWT section (coordinator follow-up) — skips cleanly if its env is absent.
  await runHostedBearerSection({ stats: ctx.stats, edgeBase: ctx.edgeBase, evidence: ctx.evidence, log: ctx.log });
}

// ─── stdio MCP package (npm pack + spawn) ────────────────────────────────

function resolvePackageJson(pkgDir: string): { name: string; bin?: Record<string, string> | string; main?: string; module?: string } {
  const absDir = isAbsolute(pkgDir) ? pkgDir : resolve(process.cwd(), pkgDir);
  return JSON.parse(readFileSync(join(absDir, 'package.json'), 'utf8'));
}

export function resolveInstalledTool(configured: string | undefined, candidates: readonly string[], label: string, mode = constants.R_OK): string {
  for (const candidate of configured === undefined ? candidates : [configured]) {
    if (!isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
    try {
      const actual = realpathSync(candidate);
      if (!statSync(actual).isFile()) throw new Error('not a file');
      accessSync(actual, mode);
      return actual;
    } catch {
      if (configured !== undefined) throw new Error(`${label} is not an accessible file`);
    }
  }
  throw new Error(`${label} requires an installed tool at an explicit absolute path`);
}

function resolveNpmCli(): string {
  return resolveInstalledTool(process.env.STAGING_NPM_CLI, [
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    '/usr/share/nodejs/npm/bin/npm-cli.js',
  ], 'STAGING_NPM_CLI');
}

function resolvePythonBin(): string {
  return resolveInstalledTool(process.env.STAGING_PYTHON_BIN, [
    '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3',
  ], 'STAGING_PYTHON_BIN', constants.X_OK);
}

/**
 * Require a fresh successful build, then `npm pack` into `installDir` and install the tarball
 * there with `--ignore-scripts` (soak driver, not a build pipeline — we do
 * not want the installed package's own postinstall hooks running against an
 * unrelated tmp tree).
 */
export function npmPackAndInstall(pkgDir: string, installDir: string, log: (m: string) => void): { installDir: string; pkgName: string } {
  const absPkgDir = isAbsolute(pkgDir) ? pkgDir : resolve(process.cwd(), pkgDir);
  const pkgJson = resolvePackageJson(pkgDir);
  const npmCli = resolveNpmCli();
  execFileSync(process.execPath, [npmCli, 'run', 'build'], { cwd: absPkgDir, stdio: 'pipe' });
  mkdirSync(installDir, { recursive: true });
  // These packages' prepack hooks repeat the build and pollute --json stdout.
  // The explicit build above already succeeded; pack those fresh artifacts once.
  const packOut = execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', `--pack-destination=${installDir}`], {
    cwd: absPkgDir,
    encoding: 'utf8',
  });
  const packInfo = JSON.parse(packOut) as Array<{ filename: string }>;
  if (packInfo.length !== 1 || !packInfo[0].filename?.endsWith('.tgz') || basename(packInfo[0].filename) !== packInfo[0].filename) {
    throw new Error('npm pack must return exactly one tarball filename');
  }
  const tgzPath = join(installDir, packInfo[0].filename);
  execFileSync(process.execPath, [npmCli, 'install', tgzPath, '--no-save', '--no-audit', '--no-fund', '--ignore-scripts'], {
    cwd: installDir,
    stdio: 'pipe',
  });
  log(`installed ${pkgJson.name} from ${packInfo[0].filename} -> ${installDir}`);
  return { installDir, pkgName: pkgJson.name };
}

function resolveCliPath(installDir: string, pkgName: string): string {
  const pkgRoot = join(installDir, 'node_modules', pkgName);
  const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { bin?: Record<string, string> | string };
  const binField = pkgJson.bin;
  const rel =
    typeof binField === 'string'
      ? binField
      : binField && typeof binField === 'object'
        ? Object.values(binField)[0]
        : 'dist/cli.js';
  return join(pkgRoot, rel ?? 'dist/cli.js');
}

function spawnStdioMcp(cliPath: string, apiUrl: string, apiKey: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [cliPath], {
    env: { ...process.env, ARKOVA_API_URL: apiUrl, ARKOVA_API_KEY: apiKey },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Write one JSON-RPC request to stdin and poll accumulated stdout for its response. */
async function stdioRequest(
  child: ChildProcessWithoutNullStreams,
  buf: { stdout: string },
  req: JsonRpcRequestBody,
  timeoutMs = 15_000,
): Promise<JsonBody | null> {
  child.stdin.write(JSON.stringify(req) + '\n');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { jsonLines } = classifyStdioOutput(buf.stdout);
    const match = findJsonRpcResponseById(jsonLines, req.id);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function runStdioCycle(ctx: {
  stats: DriverStats;
  cliPath: string;
  apiBase: string;
  apiKey: string;
  fx: HostedFixtures;
  evidence: McpEvidenceExtension;
  log: (m: string) => void;
}): Promise<void> {
  const buf = { stdout: '', stderr: '' };
  const child = spawnStdioMcp(ctx.cliPath, ctx.apiBase, ctx.apiKey);
  child.stdout.on('data', (d: Buffer) => {
    buf.stdout += d.toString('utf8');
  });
  child.stderr.on('data', (d: Buffer) => {
    buf.stderr += d.toString('utf8');
  });
  let spawnErr: Error | null = null;
  child.on('error', (err) => {
    spawnErr = err;
  });

  try {
    // initialize
    const initReq = buildJsonRpcRequest(
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'arkova-targeted-soak-stdio', version: '1.0.0' } },
      1,
    );
    const initBody = await stdioRequest(child, buf, initReq);
    recordOutcome(ctx.stats, {
      label: 'stdio:initialize',
      endpoint: 'stdio:initialize',
      method: 'STDIO',
      status: spawnErr ? 0 : initBody ? 200 : 0,
      latencyMs: 0,
      expected: !spawnErr && classifyMcpOutcome(initBody) === 'jsonrpc-result',
      ...(initBody ? {} : { capturedBody: { spawnErr: String(spawnErr ?? 'no response') } }),
    });

    // notifications/initialized — a notification, no response expected
    const notif = buildJsonRpcNotification('notifications/initialized');
    child.stdin.write(JSON.stringify(notif) + '\n');

    // tools/list
    const listReq = buildJsonRpcRequest('tools/list', undefined, 2);
    const listBody = await stdioRequest(child, buf, listReq);
    const listAssertion = assertToolsList(
      listBody,
      STDIO_REQUIRED_TOOLS,
      STDIO_NOTE_TOOLS,
      STDIO_ALLOWED_NAME_PREFIXES,
      STDIO_EXPECTED_TOOL_NAMES,
    );
    recordOutcome(ctx.stats, {
      label: 'stdio:tools/list',
      endpoint: 'stdio:tools/list',
      method: 'STDIO',
      status: listBody ? 200 : 0,
      latencyMs: 0,
      expected: listBody !== null && listAssertion.errors.length === 0,
      ...(listAssertion.errors.length ? { capturedBody: { errors: listAssertion.errors } } : {}),
    });
    ctx.evidence.stdioToolNames = listAssertion.tools.map((t) => t.name);
    ctx.evidence.credentialNamedTools = Math.max(ctx.evidence.credentialNamedTools, listAssertion.credentialNamedCount);
    ctx.log(`stdio tools/list: ${listAssertion.tools.length} tools, credential-named=${listAssertion.credentialNamedCount}`);

    // tools/call x4
    for (const spec of planStdioReadToolCalls(ctx.fx)) {
      const body = await stdioRequest(child, buf, spec.request);
      const semanticFailure = body === null ? 'no response' : assertReadToolOutcome(body, spec.expect);
      recordOutcome(ctx.stats, {
        label: `stdio:call:${spec.label}`,
        endpoint: `stdio:call:${spec.label}`,
        method: 'STDIO',
        status: body ? 200 : 0,
        latencyMs: 0,
        expected: semanticFailure === null,
        ...(semanticFailure ? { capturedBody: { error: semanticFailure } } : {}),
      });
      ctx.log(`stdio:call:${spec.label} -> ${semanticFailure ?? 'ok'}`);
    }

    // stdio hygiene — every stdout line must be JSON-RPC
    const { nonJsonLines } = classifyStdioOutput(buf.stdout);
    ctx.evidence.stdioNonJsonLines = nonJsonLines;
    ctx.evidence.stdioStderrTail = buf.stderr.slice(-2048);
    recordOutcome(ctx.stats, {
      label: 'stdio:hygiene',
      endpoint: 'stdio:stdout',
      method: 'STDIO',
      status: nonJsonLines.length === 0 ? 200 : 599,
      latencyMs: 0,
      expected: nonJsonLines.length === 0,
      ...(nonJsonLines.length ? { capturedBody: { nonJsonLines: nonJsonLines.slice(0, 20) } } : {}),
    });
    ctx.log(`stdio hygiene: ${nonJsonLines.length} non-JSON stdout line(s)`);
  } finally {
    child.kill('SIGTERM');
  }
}

// ─── SDK contract smoke (--with-sdks; thin, optional) ────────────────────

/**
 * Neither SDK exposes a custom-fetch/header hook, and the worker rig sits
 * behind Cloud Run `--no-allow-unauthenticated`, so a tiny loopback HTTP
 * proxy forwards to the rig and injects the IAM identity header — the same
 * technique `fullsoak-sdk-integration.sh` uses for the same reason. The SDK
 * is given the loopback base URL and is otherwise unmodified; the bytes it
 * sends are its own.
 */
async function startIamLoopbackProxy(targetBase: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    (async () => {
      const target = `${targetBase}${req.url ?? ''}`;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string' && k.toLowerCase() !== 'host' && k.toLowerCase() !== 'connection') headers[k] = v;
      }
      Object.assign(headers, iamAuthHeaders(headers));
      const upstream = await fetch(target, { method: req.method, headers, body });
      // fetch decodes upstream compression; forwarded framing must describe these decoded bytes.
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
      responseHeaders.delete('transfer-encoding');
      res.writeHead(upstream.status, Object.fromEntries(responseHeaders.entries()));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch((err) => {
      try {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy_failed', message: err instanceof Error ? err.message : String(err) }));
      } catch {
        res.destroy();
      }
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

async function runTsSdkSmoke(ctx: {
  stats: DriverStats;
  sdkInstall: { installDir: string; pkgName: string };
  apiKey: string;
  apiBase: string;
  fx: HostedFixtures;
  log: (m: string) => void;
}): Promise<void> {
  const proxy = await startIamLoopbackProxy(ctx.apiBase);
  try {
    const pkgRoot = join(ctx.sdkInstall.installDir, 'node_modules', ctx.sdkInstall.pkgName);
    const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { main?: string; module?: string };
    const entry = join(pkgRoot, pkgJson.module ?? pkgJson.main ?? 'dist/index.js');
    const mod = (await dynamicImportRuntimePath(pathToFileURL(entry).href)) as {
      Arkova: new (cfg: { apiKey?: string; baseUrl?: string }) => {
        verify: (id: string) => Promise<unknown>;
        verifyBatch: (ids: string[]) => Promise<unknown>;
      };
    };
    const client = new mod.Arkova({ apiKey: ctx.apiKey, baseUrl: proxy.url });

    for (const [label, fn] of [
      ['sdk:ts:verify', () => client.verify(ctx.fx.publicId)],
      ['sdk:ts:verifyBatch', () => client.verifyBatch([ctx.fx.publicId])],
    ] as const) {
      const start = Date.now();
      try {
        await fn();
        recordOutcome(ctx.stats, { label, endpoint: label, method: 'SDK', status: 200, latencyMs: Date.now() - start, expected: true });
      } catch (err) {
        recordOutcome(ctx.stats, {
          label,
          endpoint: label,
          method: 'SDK',
          status: 0,
          latencyMs: Date.now() - start,
          expected: false,
          capturedBody: String(err instanceof Error ? err.message : err),
        });
      }
      ctx.log(`${label} done`);
    }
  } finally {
    await proxy.close();
  }
}

export async function runPySdkSmoke(ctx: {
  stats: DriverStats;
  pyPkgDir: string;
  venvDir: string;
  apiKey: string;
  apiBase: string;
  fx: HostedFixtures;
  log: (m: string) => void;
}): Promise<void> {
  const proxy = await startIamLoopbackProxy(ctx.apiBase);
  const start = Date.now();
  try {
    const script = [
      'import json, os',
      'from arkova import Arkova',
      'client = Arkova(api_key=os.environ["ARKOVA_SMOKE_API_KEY"], base_url=os.environ["ARKOVA_SMOKE_BASE_URL"])',
      `result = client.verify(${JSON.stringify(ctx.fx.publicId)})`,
      'print(json.dumps({"ok": True}))',
    ].join('\n');
    const pythonBin = join(ctx.venvDir, 'bin', 'python3');
    // A synchronous child would block this process's loopback proxy until timeout.
    const { stdout: out } = await execFileAsync(pythonBin, ['-c', script], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ARKOVA_SMOKE_API_KEY: ctx.apiKey, ARKOVA_SMOKE_BASE_URL: proxy.url },
    });
    recordOutcome(ctx.stats, {
      label: 'sdk:py:verify',
      endpoint: 'sdk:py:verify',
      method: 'SDK',
      status: out.includes('"ok": true') ? 200 : 0,
      latencyMs: Date.now() - start,
      expected: out.includes('"ok": true'),
    });
  } catch (err) {
    recordOutcome(ctx.stats, {
      label: 'sdk:py:verify',
      endpoint: 'sdk:py:verify',
      method: 'SDK',
      status: 0,
      latencyMs: Date.now() - start,
      expected: false,
      capturedBody: String(err instanceof Error ? err.message : err),
    });
  } finally {
    await proxy.close();
  }
  ctx.log('sdk:py:verify done');
}

export function selectPythonSdist(venvDir: string): string {
  const artifacts = readdirSync(venvDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tar.gz'));
  if (artifacts.length !== 1) throw new Error('Python build must produce exactly one sdist');
  return join(venvDir, artifacts[0].name);
}

export function buildPySdist(pkgDir: string, venvDir: string, log: (m: string) => void): string {
  const absPkgDir = isAbsolute(pkgDir) ? pkgDir : resolve(process.cwd(), pkgDir);
  const pythonBin = resolvePythonBin();
  execFileSync(pythonBin, ['-m', 'venv', venvDir], { stdio: 'pipe' });
  const venvPython = join(venvDir, 'bin', 'python3');
  execFileSync(venvPython, ['-m', 'pip', 'install', '--quiet', 'build'], { stdio: 'pipe' });
  execFileSync(venvPython, ['-m', 'build', '--sdist', '--outdir', venvDir], {
    cwd: absPkgDir,
    stdio: 'pipe',
  });
  const sdist = selectPythonSdist(venvDir);
  execFileSync(venvPython, ['-m', 'pip', 'install', '--quiet', sdist], { stdio: 'pipe' });
  log(`python SDK installed from ${sdist} into ${venvDir}`);
  return venvDir;
}

// ─── main ─────────────────────────────────────────────────────────────────

// istanbul ignore next — exercised only against a live rig
async function main(): Promise<void> {
  const args = parseMcpSdkDriverArgs(process.argv.slice(2));
  const apiBase = resolveStagingApiBase(process.env);
  const edgeBase = resolveEdgeMcpBase(process.env);
  const log = (m: string) => console.log(`[mcp-sdk-surface] ${new Date().toISOString()} ${m}`);

  log(
    `api_base=${apiBase} edge_mcp_base=${edgeBase} with_sdks=${args.withSdks} dry_run=${args.dryRun}`,
  );

  if (args.dryRun) {
    const placeholderFx: HostedFixtures = {
      publicId: '<STAGING_FIXTURE_PUBLIC_ID>',
      fingerprint: '<STAGING_FIXTURE_FINGERPRINT>',
      searchTerm: '<STAGING_FIXTURE_SEARCH_TERM>',
    };
    log(`hosted read-tool calls: ${planHostedReadToolCalls(placeholderFx).map((p) => p.label).join(', ')}`);
    log(`hosted negatives: ${planHostedNegatives().map((p) => p.label).join(', ')}`);
    log(`stdio read-tool calls: ${planStdioReadToolCalls(placeholderFx).map((p) => p.label).join(', ')}`);
    log('--dry-run: skipping npm pack, spawn, and fire.');
    return;
  }

  const apiKey = requireEnv('STAGING_API_KEY', 'mcp-sdk-surface driver');
  const supabaseUrl = requireEnv('STAGING_SUPABASE_URL', 'mcp-sdk-surface driver (audit control)');
  const supabaseKey = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY', 'mcp-sdk-surface driver (audit control)');
  const fx: HostedFixtures = {
    publicId: requireEnv('STAGING_FIXTURE_PUBLIC_ID', 'mcp-sdk-surface driver'),
    fingerprint: requireEnv('STAGING_FIXTURE_FINGERPRINT', 'mcp-sdk-surface driver'),
    searchTerm: requireEnv('STAGING_FIXTURE_SEARCH_TERM', 'mcp-sdk-surface driver'),
  };
  const mcpPkgDir = process.env.MCP_PACKAGE_DIR ?? 'sdks/mcp-server';

  const tmpRoot = mkdtempSync(join(tmpdir(), 'arkova-mcp-soak-'));
  log(`workspace: ${tmpRoot}`);

  const stats = newDriverStats();
  const evidence = newMcpEvidence();
  let cycle = 0;

  try {
    log(`npm pack + install ${mcpPkgDir} (once)`);
    const mcpInstall = npmPackAndInstall(mcpPkgDir, join(tmpRoot, 'mcp-server'), log);
    const cliPath = resolveCliPath(mcpInstall.installDir, mcpInstall.pkgName);

    let sdkInstall: { installDir: string; pkgName: string } | null = null;
    let pyVenv: string | null = null;
    if (args.withSdks) {
      // Requested surfaces are mandatory: failed setup must never become a green partial soak.
      sdkInstall = npmPackAndInstall('packages/sdk', join(tmpRoot, 'sdk'), log);
      pyVenv = buildPySdist('packages/arkova-py', join(tmpRoot, 'py'), log);
    }

    const endAt = args.cycles === undefined ? Date.now() + (args.durationMin ?? 15) * 60_000 : undefined;
    const shouldContinue = () => (args.cycles !== undefined ? cycle < args.cycles : Date.now() < (endAt as number));

    while (shouldContinue()) {
      cycle++;
      log(`── cycle ${cycle} ──`);
      await runHostedCycle({
        stats,
        edgeBase,
        apiKey,
        fx,
        supabaseUrl,
        supabaseKey,
        evidence,
        log,
      });
      await runStdioCycle({ stats, cliPath, apiBase, apiKey, fx, evidence, log });
      if (args.withSdks && sdkInstall) {
        await runTsSdkSmoke({ stats, sdkInstall, apiKey, apiBase, fx, log });
      }
      if (args.withSdks && pyVenv) {
        await runPySdkSmoke({ stats, pyPkgDir: 'packages/arkova-py', venvDir: pyVenv, apiKey, apiBase, fx, log });
      }

      if (shouldContinue()) {
        const remaining = endAt !== undefined ? endAt - Date.now() : undefined;
        const sleepMs = remaining !== undefined ? Math.max(0, Math.min(30_000, remaining)) : 30_000;
        if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
      }
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  const base: DriverEvidence = summarizeEvidence(stats, { ...MCP_SDK_DRIVER, apiBase });
  const enriched = { ...base, mcp: evidence, edgeMcpBase: edgeBase, cycles: cycle };
  writeEvidenceFile(args.evidenceOut, enriched);
  if (!base.allExpected) process.exitCode = 1;
  log(`done: ${base.totalRequests} requests across ${cycle} cycle(s), allExpected=${base.allExpected}`);
  for (const [label, s] of Object.entries(base.byLabel)) {
    log(`  ${label}: ok=${s.expected} bad=${s.unexpected} p95=${s.p95Ms}ms`);
  }
}

// Only auto-run when invoked directly (not when imported by tests).
if (isDirectRun(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(`::error::mcp-sdk-surface driver failed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
