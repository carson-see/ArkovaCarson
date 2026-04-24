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
import crypto from 'node:crypto';
import { z } from 'zod';

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
  if (!args.signature || !args.secret) return false;
  const body = Buffer.isBuffer(args.rawBody) ? args.rawBody : Buffer.from(args.rawBody);
  const expected = crypto.createHmac('sha256', args.secret).update(body).digest('base64');
  const received = args.signature.trim();
  const a = Buffer.from(expected, 'base64');
  let b: Buffer;
  try {
    b = Buffer.from(received, 'base64');
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
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
    envelopeId,
    accountId,
    status: 'completed',
    sender: parsed.sender ?? parsed.envelopeSummary?.sender,
    envelopeDocuments: parsed.envelopeDocuments ?? parsed.envelopeSummary?.envelopeDocuments ?? [],
    generatedDateTime: parsed.generatedDateTime,
  };
}
