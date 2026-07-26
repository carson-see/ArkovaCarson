/**
 * DocuSign OAuth + Connect helpers (SCRUM-1101)
 *
 * Minimal dependency-free client for the Arkova DocuSign connector:
 *   1. Authorization Code Grant consent URLs + token refresh
 *   2. UserInfo account/base_uri discovery
 *   3. eSignature REST API completed-envelope document fetch
 *   4. DocuSign Connect HMAC verification over the exact raw body
 *
 * Secrets come from Secret Manager-backed env vars. Tokens are returned to
 * the caller for KMS encryption; never log response bodies from this module.
 */
import { z } from 'zod';
import { DocusignEnvelopeCompleted as DocusignEnvelopeCompletedSchema } from '../connectors/schemas.js';
import { boundedErrorDetail } from '../../utils/byte-safety.js';
import { verifyHmacSha256Base64 } from './hmac.js';

const DOCUSIGN_DEMO_AUTH_BASE = 'https://account-d.docusign.com';
const DOCUSIGN_PROD_AUTH_BASE = 'https://account.docusign.com';

export const DOCUSIGN_DEFAULT_SCOPES = [
  'signature',
  'extended',
  'openid',
  'email',
];

const DocusignTokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

const DocusignUserInfo = z.object({
  sub: z.string().optional(),
  email: z.string().email().optional(),
  accounts: z.array(
    z.object({
      account_id: z.string().min(1),
      account_name: z.string().optional(),
      base_uri: z.string().url(),
      is_default: z.boolean().optional(),
    }).passthrough(),
  ).default([]),
}).passthrough();

const EnvelopeDocument = z.object({
  documentId: z.string().trim().min(1).max(100),
  name: z.string().trim().max(500).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});

const RawConnectPayload = z.object({
  event: z.string().trim().min(1),
  eventId: z.string().trim().min(1).optional(),
  envelopeId: z.string().trim().min(1).optional(),
  accountId: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
  generatedDateTime: z.string().optional(),
  data: z.object({
    envelopeId: z.string().trim().min(1).optional(),
    accountId: z.string().trim().min(1).optional(),
    status: z.string().trim().min(1).optional(),
    // REST v2.1 SIM deliveries nest the envelope summary here — the shape the
    // production account actually sends (first live delivery 2026-07-26).
    envelopeSummary: z.object({
      envelopeId: z.string().trim().min(1).optional(),
      accountId: z.string().trim().min(1).optional(),
      status: z.string().trim().min(1).optional(),
      sender: z.object({ email: z.string().email().optional() }).passthrough().optional(),
      envelopeDocuments: z.array(EnvelopeDocument).max(100).optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
  envelopeSummary: z.object({
    envelopeId: z.string().trim().min(1).optional(),
    accountId: z.string().trim().min(1).optional(),
    status: z.string().trim().min(1).optional(),
    sender: z.object({ email: z.string().email().optional() }).passthrough().optional(),
    envelopeDocuments: z.array(EnvelopeDocument).max(100).optional(),
  }).passthrough().optional(),
  sender: z.object({ email: z.string().email().optional() }).passthrough().optional(),
  envelopeDocuments: z.array(EnvelopeDocument).max(100).optional(),
}).passthrough();

export interface DocusignClientDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export type DocusignTokenResponseT = z.infer<typeof DocusignTokenResponse>;
export type DocusignUserInfoT = z.infer<typeof DocusignUserInfo>;

export type DocusignCompletedEnvelope = z.infer<typeof DocusignEnvelopeCompletedSchema>;

export class DocusignConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocusignConfigError';
  }
}

/**
 * DocuSign API error.
 *
 * SCRUM-2492 (§1.6A): this error never carries a raw response BODY — it deliberately
 * has NO `body` field, so a raw (potentially document-bearing) response can never
 * be captured on the error and leak through a logger / Sentry / `last_error`.
 *
 * The optional `detail` is a BOUNDED, byte-safe, PII-scrubbed string built BY
 * CONSTRUCTION via {@link boundedErrorDetail} — capped at ~500 chars, byte-runs
 * and binary containers collapse to a redaction token, and email/UUID/JWT/token
 * PII is scrubbed. It exists to restore connector-ops debuggability on the
 * NON-document paths (token exchange/refresh, userinfo, Connect) whose error
 * body is safe OAuth/API error JSON (e.g. `{ "error": "invalid_grant" }`).
 * `detail` is NEVER the raw document-fetch response: `fetchDocusignCombinedDocument`
 * constructs this error with status + message only (no detail).
 */
export class DocusignApiError extends Error {
  status: number;
  /** Bounded (~500 char), byte-safe, PII-scrubbed; never the raw document-fetch body. */
  detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'DocusignApiError';
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

function getAuthBase(env: NodeJS.ProcessEnv): string {
  const demo = (env.DOCUSIGN_DEMO ?? 'true').toLowerCase() !== 'false';
  return demo ? DOCUSIGN_DEMO_AUTH_BASE : DOCUSIGN_PROD_AUTH_BASE;
}

function requireClient(env: NodeJS.ProcessEnv): { integrationKey: string; clientSecret: string } {
  const integrationKey = env.DOCUSIGN_INTEGRATION_KEY;
  const clientSecret = env.DOCUSIGN_CLIENT_SECRET;
  if (!integrationKey || !clientSecret) {
    throw new DocusignConfigError(
      'DOCUSIGN_INTEGRATION_KEY / DOCUSIGN_CLIENT_SECRET not set — provision in Secret Manager before connecting DocuSign.',
    );
  }
  return { integrationKey, clientSecret };
}

function basicAuth(integrationKey: string, clientSecret: string): string {
  return Buffer.from(`${integrationKey}:${clientSecret}`, 'utf8').toString('base64');
}

async function parseJsonResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function buildDocusignAuthorizationUrl(args: {
  redirectUri: string;
  state: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
}): string {
  const env = args.env ?? process.env;
  const { integrationKey } = requireClient(env);
  const params = new URLSearchParams({
    response_type: 'code',
    scope: (args.scopes ?? DOCUSIGN_DEFAULT_SCOPES).join(' '),
    client_id: integrationKey,
    redirect_uri: args.redirectUri,
    state: args.state,
  });
  return `${getAuthBase(env)}/oauth/auth?${params.toString()}`;
}

export async function exchangeDocusignCode(args: {
  code: string;
  redirectUri: string;
  deps?: DocusignClientDeps;
}): Promise<DocusignTokenResponseT> {
  const env = args.deps?.env ?? process.env;
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const { integrationKey, clientSecret } = requireClient(env);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.redirectUri,
  });

  const res = await fetchImpl(`${getAuthBase(env)}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(integrationKey, clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const json = await parseJsonResponse(res);
  if (!res.ok) {
    // Non-document path: token endpoint returns safe OAuth error JSON
    // (e.g. `{ "error":"invalid_grant" }`) — surface a bounded, scrubbed detail.
    throw new DocusignApiError('DocuSign token exchange failed', res.status, boundedErrorDetail(json));
  }
  return DocusignTokenResponse.parse(json);
}

export async function refreshDocusignAccessToken(args: {
  refreshToken: string;
  deps?: DocusignClientDeps;
}): Promise<DocusignTokenResponseT> {
  const env = args.deps?.env ?? process.env;
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const { integrationKey, clientSecret } = requireClient(env);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
  });

  const res = await fetchImpl(`${getAuthBase(env)}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(integrationKey, clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const json = await parseJsonResponse(res);
  if (!res.ok) {
    // Non-document path: refresh endpoint returns safe OAuth error JSON.
    throw new DocusignApiError('DocuSign token refresh failed', res.status, boundedErrorDetail(json));
  }
  return DocusignTokenResponse.parse(json);
}

export async function getDocusignUserInfo(args: {
  accessToken: string;
  deps?: DocusignClientDeps;
}): Promise<DocusignUserInfoT> {
  const env = args.deps?.env ?? process.env;
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const res = await fetchImpl(`${getAuthBase(env)}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  const json = await parseJsonResponse(res);
  if (!res.ok) {
    // Non-document path: userinfo returns safe account/profile error JSON.
    throw new DocusignApiError('DocuSign userinfo failed', res.status, boundedErrorDetail(json));
  }
  return DocusignUserInfo.parse(json);
}

export async function fetchDocusignCombinedDocument(args: {
  baseUri: string;
  accountId: string;
  envelopeId: string;
  accessToken: string;
  deps?: DocusignClientDeps;
}): Promise<{ bytes: Buffer; contentType: string | null }> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const base = args.baseUri.replace(/\/+$/, '');
  const url = `${base}/restapi/v2.1/accounts/${encodeURIComponent(args.accountId)}/envelopes/${encodeURIComponent(args.envelopeId)}/documents/combined`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    // §1.6A: do NOT read/attach the response body on the document-fetch path —
    // an error response here can carry document bytes. Status + message only.
    throw new DocusignApiError('DocuSign completed document fetch failed', res.status);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get('content-type') };
}

export function verifyDocusignConnectHmac(args: {
  rawBody: Buffer | string;
  signature: string | undefined;
  secret: string;
}): boolean {
  return verifyHmacSha256Base64(args);
}

/* ─── Connect Listener Auto-Provisioning (SCRUM-1718) ─────────────── */

const ConnectConfigurationResponse = z.object({
  connectId: z.string().or(z.number()).transform(String),
  name: z.string().optional(),
}).passthrough();

const ConnectListResponse = z.object({
  configurations: z.array(
    z.object({
      connectId: z.string().or(z.number()).transform(String),
      urlToPublishTo: z.string().optional(),
      name: z.string().optional(),
    }).passthrough(),
  ).default([]),
}).passthrough();

export interface ProvisionConnectResult {
  connectId: string;
  action: 'created' | 'updated';
}

export interface ArkovaConnectConfig {
  urlToPublishTo: string;
  name: string;
  configurationType: 'custom';
  allowEnvelopePublish: 'true';
  enableLog: 'true';
  allUsers: 'true';
  includeHMAC: 'true';
  hmacEnabled: true;
  hmacSecret: string;
  includeDocumentFields: 'true';
  requiresAcknowledgement: 'true';
  envelopeEvents: string[];
  events: string[];
  // DocuSign rejects the modern `events` field with 400 INVALID_REQUEST_PARAMETER
  // unless deliveryMode "SIM" accompanies it (prod failure 2026-07-25, org-connect
  // provisioning never succeeded on the production account without this).
  deliveryMode: 'SIM';
  payloadFormat: 'json';
  payloadVersion: 'restv2.1';
  eventData: { format: 'json'; version: 'restv2.1' };
}

/** Parse and validate a Connect API response, throwing DocusignApiError on mismatch. */
function parseConnectConfigResponse(
  json: unknown,
  status: number,
  operation: string,
): z.infer<typeof ConnectConfigurationResponse> {
  try {
    return ConnectConfigurationResponse.parse(json);
  } catch (e) {
    // Non-document path: the Connect config response is small JSON; a bounded,
    // scrubbed detail of the actual body aids diagnosing the schema mismatch.
    throw new DocusignApiError(
      `DocuSign Connect ${operation} response schema mismatch: ${e instanceof Error ? e.message : 'unknown'}`,
      status,
      boundedErrorDetail(json),
    );
  }
}

function trimTrailingSlashes(value: string): string {
  let trimmed = value;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

function requireConnectConfig(env: NodeJS.ProcessEnv): {
  connectHmacSecret: string;
  workerPublicUrl: string;
} {
  const workerPublicUrl = env.WORKER_PUBLIC_URL;
  if (!workerPublicUrl) {
    throw new DocusignConfigError(
      'WORKER_PUBLIC_URL not set — cannot provision DocuSign Connect listener.',
    );
  }

  const connectHmacSecret = env.DOCUSIGN_CONNECT_HMAC_SECRET ?? '';
  if (!connectHmacSecret) {
    throw new DocusignConfigError(
      'DOCUSIGN_CONNECT_HMAC_SECRET is required to provision a secure Connect listener',
    );
  }

  return { connectHmacSecret, workerPublicUrl };
}

export function buildArkovaConnectConfig(env: NodeJS.ProcessEnv = process.env): ArkovaConnectConfig {
  const { connectHmacSecret, workerPublicUrl } = requireConnectConfig(env);
  const webhookUrl = `${trimTrailingSlashes(workerPublicUrl)}/webhooks/docusign`;

  return {
    urlToPublishTo: webhookUrl,
    name: 'Arkova Connect',
    configurationType: 'custom',
    allowEnvelopePublish: 'true',
    enableLog: 'true',
    allUsers: 'true',
    includeHMAC: 'true',
    hmacEnabled: true,
    hmacSecret: connectHmacSecret,
    includeDocumentFields: 'true',
    requiresAcknowledgement: 'true',
    envelopeEvents: ['Completed'],
    events: ['envelope-completed'],
    deliveryMode: 'SIM',
    payloadFormat: 'json',
    payloadVersion: 'restv2.1',
    eventData: { format: 'json', version: 'restv2.1' },
  };
}

async function fetchConnectJson(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<{ json: unknown; response: Response }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    return { json: await parseJsonResponse(response), response };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Non-document path: no response body here — surface the abort reason as a
      // bounded, scrubbed detail (it is a fixed string, byte-free by construction).
      throw new DocusignApiError(
        'DocuSign Connect API request timed out after 10s',
        408,
        boundedErrorDetail('AbortError: request exceeded 10s timeout'),
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function parseConnectList(json: unknown, status: number): z.infer<typeof ConnectListResponse> {
  if (json === null || json === undefined) return { configurations: [] };
  try {
    return ConnectListResponse.parse(json);
  } catch (e) {
    // Non-document path: Connect list response is small JSON; bounded+scrubbed detail.
    throw new DocusignApiError(
      `DocuSign Connect list response schema mismatch: ${e instanceof Error ? e.message : 'unknown'}`,
      status,
      boundedErrorDetail(json),
    );
  }
}

function buildConnectPayload(args: {
  config: ArkovaConnectConfig;
  existingConnectId?: string;
}): Record<string, unknown> {
  return {
    urlToPublishTo: args.config.urlToPublishTo,
    name: args.config.name,
    configurationType: args.config.configurationType,
    allowEnvelopePublish: args.config.allowEnvelopePublish,
    enableLog: args.config.enableLog,
    allUsers: args.config.allUsers,
    includeHMAC: args.config.includeHMAC,
    // DocuSign must sign deliveries with the same key the webhook verifier uses.
    // Never log this Connect payload.
    hmacSecret: args.config.hmacSecret, // NOSONAR
    includeDocumentFields: args.config.includeDocumentFields,
    requiresAcknowledgement: args.config.requiresAcknowledgement,
    envelopeEvents: args.config.envelopeEvents,
    events: args.config.events,
    // DocuSign 400-rejects the `events` field unless deliveryMode SIM rides with it.
    deliveryMode: args.config.deliveryMode,
    eventData: args.config.eventData,
    ...(args.existingConnectId ? { connectId: args.existingConnectId } : {}),
  };
}

/**
 * Provisions (or updates) a DocuSign Connect listener for this account.
 * Idempotent: if a listener with the matching webhook URL already exists, it is updated.
 */
export async function provisionConnectListener(args: {
  accessToken: string;
  baseUri: string;
  accountId: string;
  deps?: DocusignClientDeps;
}): Promise<ProvisionConnectResult> {
  const env = args.deps?.env ?? process.env;
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const config = buildArkovaConnectConfig(env);

  const base = trimTrailingSlashes(args.baseUri);
  const connectBase = `${base}/restapi/v2.1/accounts/${encodeURIComponent(args.accountId)}/connect`;
  const authHeaders = { Authorization: `Bearer ${args.accessToken}` };

  const list = await fetchConnectJson(fetchImpl, connectBase, { headers: authHeaders });
  if (!list.response.ok) {
    // Non-document path: Connect list error body is safe API JSON.
    throw new DocusignApiError(
      'DocuSign Connect list failed',
      list.response.status,
      boundedErrorDetail(list.json),
    );
  }

  // DocuSign may return null or empty body — treat as no existing listeners
  const listData = parseConnectList(list.json, list.response.status);
  const existing = listData.configurations.find((cfg) => cfg.urlToPublishTo === config.urlToPublishTo);
  const method = existing ? 'PUT' : 'POST';
  const action: 'updated' | 'created' = existing ? 'updated' : 'created';
  const payload = buildConnectPayload({
    config,
    existingConnectId: existing?.connectId,
  });

  const mutation = await fetchConnectJson(fetchImpl, connectBase, {
    method,
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!mutation.response.ok) {
    const operation = action === 'updated' ? 'update' : 'create';
    // Non-document path: Connect create/update error body is safe API JSON.
    throw new DocusignApiError(
      `DocuSign Connect ${operation} failed`,
      mutation.response.status,
      boundedErrorDetail(mutation.json),
    );
  }

  const operation = action === 'updated' ? 'update' : 'create';
  const result = parseConnectConfigResponse(mutation.json, mutation.response.status, operation);
  return { connectId: result.connectId, action };
}

export function parseDocusignConnectPayload(rawBody: Buffer | string): DocusignCompletedEnvelope {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const json = JSON.parse(text);
  const parsed = RawConnectPayload.parse(json);

  const nested = parsed.data?.envelopeSummary;
  const envelopeId = parsed.envelopeId ?? parsed.data?.envelopeId ?? parsed.envelopeSummary?.envelopeId ?? nested?.envelopeId;
  const accountId = parsed.accountId ?? parsed.data?.accountId ?? parsed.envelopeSummary?.accountId ?? nested?.accountId;
  const status = (parsed.status ?? parsed.data?.status ?? parsed.envelopeSummary?.status ?? nested?.status ?? '').toLowerCase();
  const event = parsed.event.toLowerCase();
  if (event !== 'envelope-completed' || status !== 'completed' || !envelopeId || !accountId) {
    throw new Error('DocuSign Connect payload is not a completed envelope event');
  }

  return DocusignEnvelopeCompletedSchema.parse({
    event: 'envelope-completed',
    eventId: parsed.eventId,
    envelopeId,
    accountId,
    status: 'completed',
    sender: parsed.sender ?? parsed.envelopeSummary?.sender ?? nested?.sender,
    envelopeDocuments: parsed.envelopeDocuments ?? parsed.envelopeSummary?.envelopeDocuments ?? nested?.envelopeDocuments ?? [],
    generatedDateTime: parsed.generatedDateTime,
  });
}
