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

export interface DocusignCompletedEnvelope {
  event: 'envelope-completed';
  eventId?: string;
  envelopeId: string;
  accountId: string;
  status: 'completed';
  sender?: { email?: string };
  envelopeDocuments: Array<z.infer<typeof EnvelopeDocument>>;
  generatedDateTime?: string;
}

export class DocusignConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocusignConfigError';
  }
}

export class DocusignApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'DocusignApiError';
    this.status = status;
    this.body = body;
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
  if (!res.ok) throw new DocusignApiError('DocuSign token exchange failed', res.status, json);
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
  if (!res.ok) throw new DocusignApiError('DocuSign token refresh failed', res.status, json);
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
  if (!res.ok) throw new DocusignApiError('DocuSign userinfo failed', res.status, json);
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
    const body = await parseJsonResponse(res);
    throw new DocusignApiError('DocuSign completed document fetch failed', res.status, body);
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

/** Parse and validate a Connect API response, throwing DocusignApiError on mismatch. */
function parseConnectConfigResponse(
  json: unknown,
  status: number,
  operation: string,
): z.infer<typeof ConnectConfigurationResponse> {
  try {
    return ConnectConfigurationResponse.parse(json);
  } catch (e) {
    throw new DocusignApiError(
      `DocuSign Connect ${operation} response schema mismatch: ${e instanceof Error ? e.message : 'unknown'}`,
      status,
      json,
    );
  }
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
  // Strip trailing slashes without regex (avoids SonarCloud S5852 false positive)
  let trimmedUrl = workerPublicUrl;
  while (trimmedUrl.endsWith('/')) trimmedUrl = trimmedUrl.slice(0, -1);
  const webhookUrl = `${trimmedUrl}/webhooks/docusign`;
  let base = args.baseUri;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const connectBase = `${base}/restapi/v2.1/accounts/${encodeURIComponent(args.accountId)}/connect`;
  const authHeaders = { Authorization: `Bearer ${args.accessToken}` };

  // List existing listeners to find one with matching URL
  const listController = new AbortController();
  const listTimeout = setTimeout(() => listController.abort(), 10_000);
  let listRes: Response;
  let listJson: unknown;
  try {
    listRes = await fetchImpl(connectBase, { headers: authHeaders, signal: listController.signal });
    listJson = await parseJsonResponse(listRes);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new DocusignApiError('DocuSign Connect API request timed out after 10s', 408, undefined);
    }
    throw err;
  } finally {
    clearTimeout(listTimeout);
  }
  if (!listRes.ok) {
    throw new DocusignApiError('DocuSign Connect list failed', listRes.status, listJson);
  }

  // DocuSign may return null or empty body — treat as no existing listeners
  const listData = (() => {
    if (listJson === null || listJson === undefined) return { configurations: [] };
    try { return ConnectListResponse.parse(listJson); }
    catch (e) {
      throw new DocusignApiError(
        `DocuSign Connect list response schema mismatch: ${e instanceof Error ? e.message : 'unknown'}`,
        listRes.status, listJson,
      );
    }
  })();

  const existing = listData.configurations.find((cfg) => cfg.urlToPublishTo === webhookUrl);

  const payload: Record<string, unknown> = {
    urlToPublishTo: webhookUrl,
    name: 'Arkova Connect',
    configurationType: 'custom',
    allowEnvelopePublish: 'true',
    enableLog: 'true',
    allUsers: 'true',
    includeHMAC: 'true',
    includeDocumentFields: 'true',
    requiresAcknowledgement: 'true',
    envelopeEvents: ['Completed'],
    events: ['envelope-completed'],
    eventData: { format: 'json', version: 'restv2.1' },
  };

  const method = existing ? 'PUT' : 'POST';
  const action: 'updated' | 'created' = existing ? 'updated' : 'created';
  if (existing) payload.connectId = existing.connectId;

  const mutateController = new AbortController();
  const mutateTimeout = setTimeout(() => mutateController.abort(), 10_000);
  let res: Response;
  let resJson: unknown;
  try {
    res = await fetchImpl(connectBase, {
      method,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: mutateController.signal,
    });
    resJson = await parseJsonResponse(res);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new DocusignApiError('DocuSign Connect API request timed out after 10s', 408, undefined);
    }
    throw err;
  } finally {
    clearTimeout(mutateTimeout);
  }
  if (!res.ok) {
    throw new DocusignApiError(`DocuSign Connect ${action === 'updated' ? 'update' : 'create'} failed`, res.status, resJson);
  }

  const result = parseConnectConfigResponse(resJson, res.status, action === 'updated' ? 'update' : 'create');
  return { connectId: result.connectId, action };
}

export function parseDocusignConnectPayload(rawBody: Buffer | string): DocusignCompletedEnvelope {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const json = JSON.parse(text);
  const parsed = RawConnectPayload.parse(json);

  const envelopeId = parsed.envelopeId ?? parsed.data?.envelopeId ?? parsed.envelopeSummary?.envelopeId;
  const accountId = parsed.accountId ?? parsed.data?.accountId ?? parsed.envelopeSummary?.accountId;
  const status = (parsed.status ?? parsed.data?.status ?? parsed.envelopeSummary?.status ?? '').toLowerCase();
  const event = parsed.event.toLowerCase();
  if (event !== 'envelope-completed' || status !== 'completed' || !envelopeId || !accountId) {
    throw new Error('DocuSign Connect payload is not a completed envelope event');
  }

  return {
    event: 'envelope-completed',
    eventId: parsed.eventId,
    envelopeId,
    accountId,
    status: 'completed',
    sender: parsed.sender ?? parsed.envelopeSummary?.sender,
    envelopeDocuments: parsed.envelopeDocuments ?? parsed.envelopeSummary?.envelopeDocuments ?? [],
    generatedDateTime: parsed.generatedDateTime,
  };
}
