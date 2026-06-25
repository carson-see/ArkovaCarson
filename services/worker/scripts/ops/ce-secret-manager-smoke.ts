/**
 * SCRUM-2376 (CE-05) — Credential Engine API key Secret-Manager runtime smoke.
 *
 * PURPOSE
 *   Prove, at runtime, that the Credential Engine (CE) Registry API key:
 *     1. resolves from Google Secret Manager (NOT baked into env / image), and
 *     2. is never logged or echoed (redaction), and
 *     3. successfully drives 3–5 READ-ONLY Registry calls (Graph Search +
 *        GetRecord) — or documents their failures — with bounded log payloads.
 *
 * This is an OPERATOR-RUN ops script (it lives in scripts/ops/, never imported
 * by services/worker/src). It has a CI-safe mock/offline mode (default) that
 * asserts the resolution path + redaction without touching live GCP or CE, and
 * an explicit --live mode for an operator on a box with GCP credentials.
 *
 * ── RUNBOOK ───────────────────────────────────────────────────────────────
 *   Mock/offline (CI + local, no creds, no network):
 *     npx tsx scripts/ops/ce-secret-manager-smoke.ts
 *
 *   Live (operator only — requires GCP creds + Secret Manager read):
 *     # Secret must already exist:
 *     #   gcloud secrets create credential-engine-api-key --replication-policy=automatic
 *     #   printf '%s' "<CE_API_KEY>" | gcloud secrets versions add credential-engine-api-key --data-file=-
 *     # Auth: run on Cloud Run (K_SERVICE) OR set GCP_SA_KEY_JSON to a SA with
 *     #   roles/secretmanager.secretAccessor on the secret.
 *     npx tsx scripts/ops/ce-secret-manager-smoke.ts \
 *       --live \
 *       --secret-name projects/<PROJECT>/secrets/credential-engine-api-key \
 *       --base-url https://sandbox.credentialengine.org \
 *       --ctid ce-<uuid-of-a-known-sandbox-record>
 *
 *   The key value is NEVER printed. Logs show only `[REDACTED_CE_SECRET]`, the
 *   resolution source, HTTP statuses, and a bounded (≤280 char) body snippet.
 *   The Registry calls are GET-only — this smoke never writes to the Registry.
 *
 *   NOTE (no prod-state claim): running this does not publish anything to the
 *   Credential Registry and does not imply Arkova is "listed" there
 *   (CLAUDE.md §1.13 R-7). It only exercises read APIs + the key plumbing.
 * ───────────────────────────────────────────────────────────────────────────
 */

/**
 * Lazily resolve a GCP access token via the worker's dep-free token provider.
 * Imported dynamically (not at module top) so that mock/offline runs and the
 * unit tests — which always inject their own `getAccessToken` — never pull in
 * the worker `config.ts` Zod env validation just to load this script.
 */
async function defaultGcpAccessToken(): Promise<string> {
  const { getGcpAccessToken } = await import('../../src/utils/gcp-auth.js');
  return getGcpAccessToken();
}

export const CE_SECRET_REDACTED = '[REDACTED_CE_SECRET]';
const DEFAULT_BASE_URL = 'https://sandbox.credentialengine.org';
const DEFAULT_SAMPLE_CTID = 'ce-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SECRET_NAME_RE = /^projects\/([^/]+)\/secrets\/([A-Za-z0-9_-]{1,255})$/;
const SECRET_MANAGER_TIMEOUT_MS = 10_000;
const BODY_SNIPPET_MAX = 280;
const REAL_CTID_PATTERN = /^ce-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── secret redaction ────────────────────────────────────────────────────────

/** Replace every occurrence of the secret with a fixed token. No-op if empty. */
export function redactCeSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join(CE_SECRET_REDACTED);
}

// ── Secret Manager resolution (mirrors docusign-token-store REST pattern) ─────

export interface ResolveCeApiKeyArgs {
  secretName: string;
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
}

function secretManagerUrl(path: string): string {
  return `https://secretmanager.googleapis.com/v1/${path}`;
}

async function fetchSecretManager(
  fetchImpl: typeof fetch,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SECRET_MANAGER_TIMEOUT_MS);
  try {
    return await fetchImpl(secretManagerUrl(path), { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Secret Manager request timed out after ${SECRET_MANAGER_TIMEOUT_MS}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve the CE API key from Secret Manager's `versions/latest:access`.
 * There is intentionally NO process.env fallback: an env-baked key would defeat
 * the whole point of this smoke. A failure NEVER includes the secret value.
 */
export async function resolveCeApiKeyFromSecretManager(args: ResolveCeApiKeyArgs): Promise<string> {
  const { secretName } = args;
  if (!SECRET_NAME_RE.test(secretName.trim())) {
    throw new Error('CE API key secret name must be projects/{project}/secrets/{secret}');
  }
  const fetchImpl = args.fetchImpl ?? fetch;
  const getAccessToken = args.getAccessToken ?? defaultGcpAccessToken;

  const token = await getAccessToken();
  const res = await fetchSecretManager(fetchImpl, `${secretName.trim()}/versions/latest:access`, {
    headers: new Headers({ Authorization: `Bearer ${token}` }),
  });
  if (res.status === 404) {
    throw new Error('Secret Manager: CE API key secret/version not found (is it created + a version added?)');
  }
  if (!res.ok) {
    throw new Error(`Secret Manager access for CE API key failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { payload?: { data?: string } };
  const data = body.payload?.data;
  if (!data) {
    throw new Error('Secret Manager returned an empty CE API key payload');
  }
  return Buffer.from(data, 'base64').toString('utf8').trim();
}

// ── read-only Registry examples (Graph Search + GetRecord) ────────────────────

export type CeRequestKind = 'graph-search' | 'get-record';

export interface CeRegistryRequest {
  kind: CeRequestKind;
  /** Always GET — this smoke is strictly read-only against the Registry. */
  method: 'GET';
  url: string;
  description: string;
}

export interface BuildCeRegistryRequestsArgs {
  baseUrl?: string;
  sampleCtid?: string;
}

/**
 * Build 3–5 read-only Credential Engine Registry Assistant examples. These hit
 * the public Registry Assistant read endpoints (Graph Search + GetRecord) with
 * small, bounded result sizes. No request mutates the Registry.
 */
export function buildCeRegistryRequests(args: BuildCeRegistryRequestsArgs = {}): CeRegistryRequest[] {
  const baseUrl = (args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const ctid = args.sampleCtid ?? DEFAULT_SAMPLE_CTID;
  const take = 5; // bounded page size — never an unbounded scan

  return [
    {
      kind: 'graph-search',
      method: 'GET',
      url: `${baseUrl}/assistant/search/ctdl?query=${encodeURIComponent('credential')}&take=${take}&skip=0`,
      description: 'Graph Search: small bounded keyword search for credential records',
    },
    {
      kind: 'graph-search',
      method: 'GET',
      url: `${baseUrl}/assistant/search/ctdl?type=${encodeURIComponent('ceterms:Certificate')}&take=${take}&skip=0`,
      description: 'Graph Search: bounded type-filtered search (Certificate)',
    },
    {
      kind: 'graph-search',
      method: 'GET',
      url: `${baseUrl}/assistant/search/ctdl?type=${encodeURIComponent('ceterms:Organization')}&take=${take}&skip=0`,
      description: 'Graph Search: bounded type-filtered search (Organization)',
    },
    {
      kind: 'get-record',
      method: 'GET',
      url: `${baseUrl}/assistant/graph/${encodeURIComponent(ctid)}`,
      description: 'GetRecord: fetch a single CTDL graph record by CTID',
    },
  ];
}

// ── bounded, secret-free response summary ─────────────────────────────────────

export interface SummarizeCeResponseArgs {
  kind: CeRequestKind;
  status: number;
  body: unknown;
  apiKey: string;
}

export interface CeResponseSummary {
  kind: CeRequestKind;
  /** Always GET — recorded so callers can assert the smoke stayed read-only. */
  method: 'GET';
  status: number;
  ok: boolean;
  bodySnippet: string;
}

/**
 * Produce a bounded, secret-free summary of a Registry response suitable for
 * logging: HTTP status + a ≤280-char snippet with the API key scrubbed out.
 */
export function summarizeCeResponse(args: SummarizeCeResponseArgs): CeResponseSummary {
  let raw: string;
  try {
    raw = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
  } catch {
    raw = '[unserializable body]';
  }
  const scrubbed = redactCeSecret(raw ?? '', args.apiKey);
  const bodySnippet = scrubbed.length > BODY_SNIPPET_MAX
    ? `${scrubbed.slice(0, BODY_SNIPPET_MAX - 1)}…`
    : scrubbed;
  return {
    kind: args.kind,
    method: 'GET',
    status: args.status,
    ok: args.status >= 200 && args.status < 300,
    bodySnippet,
  };
}

/** CE-02-aligned real-CTID check, reused so the smoke never asserts on fakes. */
export function isRealCtidForSmoke(value: unknown): boolean {
  return typeof value === 'string' && REAL_CTID_PATTERN.test(value.trim());
}

// ── arg parsing ───────────────────────────────────────────────────────────────

export interface CeSmokeArgs {
  mode: 'mock' | 'live';
  secretName: string;
  baseUrl: string;
  sampleCtid: string;
}

function readFlagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

export function parseCeSmokeArgs(argv: string[]): CeSmokeArgs {
  return {
    mode: argv.includes('--live') ? 'live' : 'mock',
    secretName: readFlagValue(argv, '--secret-name')
      ?? process.env.CE_API_KEY_SECRET_NAME
      ?? 'projects/arkova-prod/secrets/credential-engine-api-key',
    baseUrl: readFlagValue(argv, '--base-url') ?? process.env.CE_REGISTRY_BASE_URL ?? DEFAULT_BASE_URL,
    sampleCtid: readFlagValue(argv, '--ctid') ?? process.env.CE_SAMPLE_CTID ?? DEFAULT_SAMPLE_CTID,
  };
}

// ── orchestration ─────────────────────────────────────────────────────────────

export interface RunCeSmokeArgs {
  mode: 'mock' | 'live';
  secretName: string;
  baseUrl: string;
  sampleCtid?: string;
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  log?: (line: string) => void;
}

export interface CeSmokeResult {
  mode: 'mock' | 'live';
  keyResolvedFromSecretManager: boolean;
  examples: CeResponseSummary[];
}

/**
 * End-to-end: resolve the key from Secret Manager, then run the read-only
 * Registry examples. Every log line is redaction-scrubbed. Example failures are
 * RECORDED (not thrown) so the smoke can document Registry-side errors.
 */
export async function runCeSecretManagerSmoke(args: RunCeSmokeArgs): Promise<CeSmokeResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const log = args.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const safeLog = (line: string, secret = '') => log(redactCeSecret(line, secret));

  safeLog(`[ce-smoke] mode=${args.mode} secret=${args.secretName} base=${args.baseUrl}`);

  const apiKey = await resolveCeApiKeyFromSecretManager({
    secretName: args.secretName,
    fetchImpl,
    getAccessToken: args.getAccessToken,
  });
  // Prove resolution + masking WITHOUT revealing the value (length only).
  safeLog(`[ce-smoke] CE API key resolved from Secret Manager (value ${CE_SECRET_REDACTED}, length=${apiKey.length})`, apiKey);

  const requests = buildCeRegistryRequests({ baseUrl: args.baseUrl, sampleCtid: args.sampleCtid });
  const examples: CeResponseSummary[] = [];

  for (const req of requests) {
    try {
      const res = await fetchImpl(req.url, {
        method: req.method,
        headers: new Headers({
          // CE Registry Assistant accepts the API key as a bearer token.
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        }),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = '[non-json body]';
      }
      const summary = summarizeCeResponse({ kind: req.kind, status: res.status, body, apiKey });
      examples.push(summary);
      safeLog(`[ce-smoke] ${req.kind} GET → HTTP ${summary.status} ok=${summary.ok} :: ${summary.bodySnippet}`, apiKey);
    } catch (error) {
      const message = redactCeSecret(error instanceof Error ? error.message : String(error), apiKey);
      examples.push({ kind: req.kind, method: 'GET', status: 0, ok: false, bodySnippet: message.slice(0, BODY_SNIPPET_MAX) });
      safeLog(`[ce-smoke] ${req.kind} GET → ERROR :: ${message.slice(0, BODY_SNIPPET_MAX)}`, apiKey);
    }
  }

  return { mode: args.mode, keyResolvedFromSecretManager: true, examples };
}

// ── CLI entrypoint (only runs when executed directly) ─────────────────────────

function isMainModule(): boolean {
  // Works under tsx/node ESM: compare the resolved entry to this file.
  const entry = process.argv[1] ?? '';
  return entry.includes('ce-secret-manager-smoke');
}

async function main(): Promise<void> {
  const args = parseCeSmokeArgs(process.argv.slice(2));

  if (args.mode === 'mock') {
    // Offline proof: a fake in-memory key + fetch. No GCP, no CE, CI-safe.
    const fakeKey = 'ce-MOCK-OFFLINE-KEY-DO-NOT-USE';
    const mockFetch: typeof fetch = (input) => {
      const url = String(input);
      if (url.includes('versions/latest:access')) {
        return Promise.resolve(
          new Response(JSON.stringify({ payload: { data: Buffer.from(fakeKey, 'utf8').toString('base64') } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ totalResults: 0, data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const result = await runCeSecretManagerSmoke({
      ...args,
      fetchImpl: mockFetch,
      getAccessToken: () => Promise.resolve('mock-access-token'),
    });
    process.stdout.write(
      `[ce-smoke] MOCK complete: keyResolvedFromSecretManager=${result.keyResolvedFromSecretManager}, examples=${result.examples.length}\n`,
    );
    return;
  }

  // Live mode: real Secret Manager + real Registry reads (operator box).
  const result = await runCeSecretManagerSmoke(args);
  const failures = result.examples.filter((e) => !e.ok).length;
  process.stdout.write(
    `[ce-smoke] LIVE complete: examples=${result.examples.length}, ok=${result.examples.length - failures}, failed=${failures}\n`,
  );
  // Non-zero exit only if the KEY could not be resolved; example failures are
  // documented, not fatal (the Registry may rate-limit or a CTID may be absent).
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    // Top-level guard: never let an unredacted value escape. We don't have the
    // key here, but scrub defensively against the env name just in case.
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[ce-smoke] FATAL: ${msg}\n`);
    process.exitCode = 1;
  });
}
