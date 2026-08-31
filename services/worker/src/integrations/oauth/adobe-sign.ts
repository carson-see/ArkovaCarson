/**
 * Adobe Sign webhook helpers (SCRUM-1148).
 *
 * Adobe Sign sends agreement-event notifications signed with a per-webhook
 * client-secret HMAC over the exact raw body, using SHA-256 and Base64.
 * Reference: https://opensource.adobe.com/acrobat-sign/developer_guide/webhooks.html
 *
 * Header carrying the signature is `X-AdobeSign-ClientId-Authentication-Sha256`
 * (mirrored alongside the older `X-AdobeSign-ClientId` proof header). Adobe
 * documents the canonicalization as raw HTTP body bytes — same as DocuSign,
 * different header.
 */
import { z } from 'zod';
import { boundedErrorDetail } from '../../utils/byte-safety.js';
import { verifyHmacSha256Base64 } from './hmac.js';

const RawAdobeWebhookPayload = z
  .object({
    event: z.string().trim().min(1),
    eventDate: z.string().optional(),
    agreement: z
      .object({
        id: z.string().trim().min(1),
        name: z.string().trim().max(500).optional(),
        senderInfo: z
          .object({ email: z.string().email().optional() })
          .partial()
          .optional(),
        // Adobe sends the SHA256 of each constituent document if requested.
        documents: z
          .array(
            z.object({
              id: z.string().trim().min(1),
              name: z.string().trim().max(500).optional(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
            }),
          )
          .max(100)
          .optional(),
      })
      .passthrough(),
    webhookId: z.string().trim().min(1).optional(),
    webhookName: z.string().trim().max(200).optional(),
  })
  .passthrough();

export interface AdobeAgreementCompletedEvent {
  event: 'AGREEMENT_WORKFLOW_COMPLETED';
  agreementId: string;
  agreementName: string | null;
  senderEmail: string | null;
  documents: Array<{ id: string; name: string | null; sha256: string | null }>;
  webhookId: string | null;
}

export function verifyAdobeSignHmac(args: {
  rawBody: Buffer | string;
  signature: string | undefined;
  clientSecret: string;
}): boolean {
  return verifyHmacSha256Base64({
    rawBody: args.rawBody,
    signature: args.signature,
    secret: args.clientSecret,
  });
}

export function parseAdobeSignPayload(rawBody: Buffer | string): AdobeAgreementCompletedEvent {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const json = JSON.parse(text);
  const parsed = RawAdobeWebhookPayload.parse(json);

  // Only AGREEMENT_WORKFLOW_COMPLETED is in scope for the rules engine —
  // any other event type (CREATED, RECALLED, REJECTED) is still a 200-OK
  // ack but the caller will skip it; we throw so the route can return 200
  // with a clear "ignored" body. Treat case-insensitively per Adobe docs.
  if (parsed.event.toUpperCase() !== 'AGREEMENT_WORKFLOW_COMPLETED') {
    throw new Error(`Unsupported Adobe Sign event: ${parsed.event}`);
  }
  if (!parsed.agreement?.id) {
    throw new Error('Adobe Sign payload missing agreement.id');
  }

  return {
    event: 'AGREEMENT_WORKFLOW_COMPLETED',
    agreementId: parsed.agreement.id,
    agreementName: parsed.agreement.name ?? null,
    senderEmail: parsed.agreement.senderInfo?.email ?? null,
    documents: (parsed.agreement.documents ?? []).map((d) => ({
      id: d.id,
      name: d.name ?? null,
      sha256: d.sha256 ?? null,
    })),
    webhookId: parsed.webhookId ?? null,
  };
}

/* ─── OAuth + webhook provisioning (SCRUM-1148 follow-up) ─────────────
 *
 * Adobe Acrobat Sign OAuth v2 + the REST v6 webhook resource. This is the half
 * that never existed: the handler above has always resolved an integration by
 * Adobe `webhookId`, but nothing ever OBTAINED one, so `org_integrations.
 * webhook_id` was null in every environment and every delivery fell through to
 * the orphan branch. `createAdobeSignWebhook` is what mints that id.
 *
 * Contract verified against Adobe's own documentation (2026-08-30):
 *   - authorize   GET  {oauthBase}/public/oauth/v2?response_type=code&...
 *   - token       POST {oauthBase}/oauth/v2/token         (form-urlencoded)
 *   - refresh     POST {oauthBase}/oauth/v2/refresh       (form-urlencoded)
 *   - revoke      POST {oauthBase}/oauth/v2/revoke        (form-urlencoded)
 *   - webhooks    POST/DELETE {apiAccessPoint}api/rest/v6/webhooks[/{id}]
 *   - scopes      webhook_read (GET) / webhook_write (POST,PUT) /
 *                 webhook_retention (DELETE), each with a :account modifier
 *
 * SHARDING IS NOT OPTIONAL. Adobe accounts live on regional shards (na1, na2,
 * eu1, jp1, …). The token response carries `api_access_point`; every later REST
 * call MUST target it. Hardcoding a shard host works for exactly one account
 * and 404s/401s for the rest, so `apiAccessPoint` is a required argument on
 * every REST helper here rather than something read from env.
 *
 * The authorize/token HOST, by contrast, is genuinely environment-shaped (the
 * app's own registered region) and Adobe's docs are not fully consistent about
 * `secure.` vs `api.` for the v2 OAuth paths — so it is configurable via
 * `ADOBE_SIGN_OAUTH_BASE_URL` with a documented default, to be confirmed
 * against the real application when one is finally registered.
 */

const ADOBE_SIGN_DEFAULT_OAUTH_BASE = 'https://secure.na1.adobesign.com';
const ADOBE_SIGN_API_TIMEOUT_MS = 10_000;

/**
 * Scopes requested at authorization time. Adobe grants ONLY what was asked for
 * at consent, so a scope missing here cannot be recovered later without sending
 * the admin back through the whole flow:
 *   - `webhook_write`     — POST /webhooks (mints the id this connector needs)
 *   - `webhook_read`      — GET  /webhooks (verify/reconcile an existing hook)
 *   - `webhook_retention` — DELETE /webhooks/{id}; disconnect leaves a live
 *                           webhook pointing at us forever without it
 *   - `agreement_read`    — read agreement metadata for the completed event
 *   - `user_login`        — /users/me, for the account label on the org card
 */
export const ADOBE_SIGN_DEFAULT_SCOPES = [
  'user_login:self',
  'agreement_read:account',
  'webhook_read:account',
  'webhook_write:account',
  'webhook_retention:account',
];

const AdobeSignTokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  expires_in: z.number(),
  scope: z.string().optional(),
  // Shard discovery — see the sharding note above.
  api_access_point: z.string().url().optional(),
  web_access_point: z.string().url().optional(),
});

const AdobeSignUserInfo = z.object({
  id: z.string().min(1).optional(),
  email: z.string().email().optional(),
  company: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  accountId: z.string().optional(),
}).passthrough();

const AdobeSignWebhookCreateResponse = z.object({
  id: z.string().min(1).optional(),
}).passthrough();

export type AdobeSignTokenResponseT = z.infer<typeof AdobeSignTokenResponse>;
export type AdobeSignUserInfoT = z.infer<typeof AdobeSignUserInfo>;

export interface AdobeSignClientDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export class AdobeSignConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdobeSignConfigError';
  }
}

/**
 * Adobe Sign API error.
 *
 * Mirrors `DocusignApiError` deliberately, including the §1.6A shape: there is
 * NO `body` field, so a raw response can never be captured on the error and
 * leak through a logger / Sentry / `job_queue.last_error`. `detail` is bounded
 * and PII-scrubbed BY CONSTRUCTION via {@link boundedErrorDetail}.
 *
 * Every path in this module is a non-document path (OAuth + webhook metadata),
 * so attaching a bounded detail is safe and is what makes a missing
 * `webhook_write` scope diagnosable instead of a mystery 403.
 */
export class AdobeSignApiError extends Error {
  status: number;
  /** Bounded (~500 char), byte-safe, PII-scrubbed. Never a document body. */
  detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'AdobeSignApiError';
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

function adobeOAuthBase(env: NodeJS.ProcessEnv): string {
  return trimTrailingSlashesAdobe(env.ADOBE_SIGN_OAUTH_BASE_URL?.trim() || ADOBE_SIGN_DEFAULT_OAUTH_BASE);
}

/** Linear trailing-slash trim — no `/+$/` (Sonar S5852 super-linear backtracking). */
function trimTrailingSlashesAdobe(value: string): string {
  let trimmed = value;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

function requireAdobeClient(env: NodeJS.ProcessEnv): { clientId: string; clientSecret: string } {
  const clientId = env.ADOBE_SIGN_CLIENT_ID;
  const clientSecret = env.ADOBE_SIGN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AdobeSignConfigError(
      'ADOBE_SIGN_CLIENT_ID / ADOBE_SIGN_CLIENT_SECRET not set — register an Adobe Acrobat Sign application and provision both in Secret Manager before connecting Adobe Sign.',
    );
  }
  return { clientId, clientSecret };
}

function requireAdobeClientId(env: NodeJS.ProcessEnv): string {
  const clientId = env.ADOBE_SIGN_CLIENT_ID;
  if (!clientId) {
    throw new AdobeSignConfigError(
      'ADOBE_SIGN_CLIENT_ID not set — register an Adobe Acrobat Sign application before starting the connect flow.',
    );
  }
  return clientId;
}

async function parseAdobeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function adobeFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ADOBE_SIGN_API_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (
      (error instanceof DOMException && error.name === 'AbortError') ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw new AdobeSignApiError(
        `${label} timed out after ${ADOBE_SIGN_API_TIMEOUT_MS / 1000}s`,
        408,
        boundedErrorDetail('AbortError: request exceeded the Adobe Sign API timeout'),
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Join an `api_access_point` (which Adobe returns WITH a trailing slash) to a REST path. */
function adobeApiUrl(apiAccessPoint: string, path: string): string {
  return `${trimTrailingSlashesAdobe(apiAccessPoint)}/${path}`;
}

export function buildAdobeSignAuthorizationUrl(args: {
  redirectUri: string;
  state: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
}): string {
  const env = args.env ?? process.env;
  // Only the client ID is needed to BUILD the consent URL. Requiring the secret
  // here too would 500 the start endpoint on a half-provisioned deploy at the
  // point where a clear "not configured" is more useful.
  const clientId = requireAdobeClientId(env);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: args.redirectUri,
    scope: (args.scopes ?? ADOBE_SIGN_DEFAULT_SCOPES).join(' '),
    state: args.state,
  });
  return `${adobeOAuthBase(env)}/public/oauth/v2?${params.toString()}`;
}

async function adobeTokenCall(args: {
  path: 'token' | 'refresh';
  body: URLSearchParams;
  deps?: AdobeSignClientDeps;
  label: string;
}): Promise<AdobeSignTokenResponseT> {
  const env = args.deps?.env ?? process.env;
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const { clientId, clientSecret } = requireAdobeClient(env);
  // Adobe's OAuth v2 endpoints take the credentials as FORM FIELDS, not as a
  // Basic auth header (this is where it differs from DocuSign).
  args.body.set('client_id', clientId);
  args.body.set('client_secret', clientSecret);

  const res = await adobeFetch(
    fetchImpl,
    `${adobeOAuthBase(env)}/oauth/v2/${args.path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: args.body.toString(),
    },
    args.label,
  );
  const json = await parseAdobeJson(res);
  if (!res.ok) {
    throw new AdobeSignApiError(args.label, res.status, boundedErrorDetail(json));
  }
  return AdobeSignTokenResponse.parse(json);
}

export async function exchangeAdobeSignCode(args: {
  code: string;
  redirectUri: string;
  deps?: AdobeSignClientDeps;
}): Promise<AdobeSignTokenResponseT> {
  return adobeTokenCall({
    path: 'token',
    label: 'Adobe Sign token exchange failed',
    deps: args.deps,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });
}

export async function refreshAdobeSignAccessToken(args: {
  refreshToken: string;
  deps?: AdobeSignClientDeps;
}): Promise<AdobeSignTokenResponseT> {
  return adobeTokenCall({
    path: 'refresh',
    label: 'Adobe Sign token refresh failed',
    deps: args.deps,
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: args.refreshToken,
    }),
  });
}

/**
 * Revoke an access or refresh token.
 *
 * Idempotent by design: disconnect calls this, and a token Adobe already
 * considers dead must not strand the org in a connected state. Only
 * `invalid_token`-shaped 4xx are swallowed; a 5xx or a permission failure still
 * throws so disconnect can report it.
 */
export async function revokeAdobeSignToken(args: {
  token: string;
  deps?: AdobeSignClientDeps;
}): Promise<void> {
  const env = args.deps?.env ?? process.env;
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const { clientId, clientSecret } = requireAdobeClient(env);
  const body = new URLSearchParams({
    token: args.token,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await adobeFetch(
    fetchImpl,
    `${adobeOAuthBase(env)}/oauth/v2/revoke`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    'Adobe Sign token revoke failed',
  );
  if (res.ok) return;
  // An already-dead token is the desired end state, not an error.
  if (res.status === 400 || res.status === 401 || res.status === 404) return;
  throw new AdobeSignApiError(
    'Adobe Sign token revoke failed',
    res.status,
    boundedErrorDetail(await parseAdobeJson(res)),
  );
}

export async function fetchAdobeSignUserInfo(args: {
  apiAccessPoint: string;
  accessToken: string;
  deps?: AdobeSignClientDeps;
}): Promise<AdobeSignUserInfoT> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const res = await adobeFetch(
    fetchImpl,
    adobeApiUrl(args.apiAccessPoint, 'api/rest/v6/users/me'),
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
    'Adobe Sign userinfo failed',
  );
  const json = await parseAdobeJson(res);
  if (!res.ok) {
    throw new AdobeSignApiError('Adobe Sign userinfo failed', res.status, boundedErrorDetail(json));
  }
  return AdobeSignUserInfo.parse(json);
}

export interface AdobeSignWebhookConfig {
  name: string;
  scope: 'ACCOUNT';
  state: 'ACTIVE';
  webhookSubscriptionEvents: string[];
  webhookUrlInfo: { url: string };
  webhookConditionalParams: {
    webhookAgreementEvents: {
      includeDetailedInfo: boolean;
      includeDocumentsInfo: boolean;
      includeParticipantsInfo: boolean;
      includeSignedDocuments: boolean;
    };
  };
}

/**
 * The webhook Arkova registers on the connecting account.
 *
 * `includeSignedDocuments` / `includeDocumentsInfo` are deliberately FALSE.
 * §1.6A permits a server-side fingerprint of connector-fetched bytes on a
 * narrow, deliberate fetch path — it does not permit document bytes riding in
 * on an untrusted notification body, which would land them in every error,
 * log and DLQ surface that touches that body. The worker fetches and hashes on
 * its own terms or not at all.
 */
export function buildAdobeSignWebhookConfig(env: NodeJS.ProcessEnv = process.env): AdobeSignWebhookConfig {
  const workerPublicUrl = env.WORKER_PUBLIC_URL;
  if (!workerPublicUrl?.trim()) {
    throw new AdobeSignConfigError(
      'WORKER_PUBLIC_URL not set — cannot register an Adobe Sign webhook (Adobe must be given a reachable HTTPS URL).',
    );
  }
  return {
    name: 'Arkova',
    scope: 'ACCOUNT',
    state: 'ACTIVE',
    webhookSubscriptionEvents: ['AGREEMENT_WORKFLOW_COMPLETED'],
    webhookUrlInfo: { url: `${trimTrailingSlashesAdobe(workerPublicUrl.trim())}/webhooks/adobe-sign` },
    webhookConditionalParams: {
      webhookAgreementEvents: {
        includeDetailedInfo: true,
        includeDocumentsInfo: false,
        includeParticipantsInfo: false,
        includeSignedDocuments: false,
      },
    },
  };
}

/**
 * Extract the webhook id from a create response.
 *
 * Adobe documents BOTH a body carrying the identifier and a `Location` header
 * pointing at the created resource. Reading only one of them is how a create
 * that actually succeeded still yields a NULL `webhook_id` — the precise
 * failure mode this connector has been stuck in. Throw rather than return an
 * empty id: a silently-null webhook_id is worse than a loud failure, because
 * every later delivery orphans with no explanation.
 */
function extractWebhookId(json: unknown, res: Response): string {
  const parsed = AdobeSignWebhookCreateResponse.safeParse(json);
  const fromBody = parsed.success ? parsed.data.id?.trim() : undefined;
  if (fromBody) return fromBody;

  const location = res.headers.get('location');
  const fromHeader = location ? trimTrailingSlashesAdobe(location).split('/').pop()?.trim() : undefined;
  if (fromHeader) return fromHeader;

  throw new AdobeSignApiError(
    'Adobe Sign webhook create returned no id in the body or Location header',
    res.status,
    boundedErrorDetail(json),
  );
}

export interface CreateAdobeSignWebhookResult {
  webhookId: string;
  webhookUrl: string;
}

/**
 * Register the Arkova webhook on the connected account and return Adobe's id.
 *
 * This id is the ONLY thing `webhooks/adobe-sign.ts::findIntegration()` can
 * resolve a delivery by, so the caller must persist it to
 * `org_integrations.webhook_id` in the same upsert that stores the tokens.
 */
export async function createAdobeSignWebhook(args: {
  apiAccessPoint: string;
  accessToken: string;
  deps?: AdobeSignClientDeps;
}): Promise<CreateAdobeSignWebhookResult> {
  const env = args.deps?.env ?? process.env;
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const webhookConfig = buildAdobeSignWebhookConfig(env);

  const res = await adobeFetch(
    fetchImpl,
    adobeApiUrl(args.apiAccessPoint, 'api/rest/v6/webhooks'),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(webhookConfig),
    },
    'Adobe Sign webhook create failed',
  );
  const json = await parseAdobeJson(res);
  if (!res.ok) {
    throw new AdobeSignApiError('Adobe Sign webhook create failed', res.status, boundedErrorDetail(json));
  }
  return { webhookId: extractWebhookId(json, res), webhookUrl: webhookConfig.webhookUrlInfo.url };
}

/**
 * Delete a webhook Adobe-side. Requires the `webhook_retention` scope.
 *
 * 404 is success: the end state disconnect wants is "Adobe is no longer
 * delivering to us", and an already-deleted webhook satisfies that. Anything
 * else throws so disconnect can surface a webhook we failed to remove — one
 * left live keeps pushing a revoked org's agreements at our endpoint.
 */
export async function deleteAdobeSignWebhook(args: {
  apiAccessPoint: string;
  accessToken: string;
  webhookId: string;
  deps?: AdobeSignClientDeps;
}): Promise<void> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const res = await adobeFetch(
    fetchImpl,
    adobeApiUrl(args.apiAccessPoint, `api/rest/v6/webhooks/${encodeURIComponent(args.webhookId)}`),
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${args.accessToken}` },
    },
    'Adobe Sign webhook delete failed',
  );
  if (res.ok || res.status === 404) return;
  throw new AdobeSignApiError(
    'Adobe Sign webhook delete failed',
    res.status,
    boundedErrorDetail(await parseAdobeJson(res)),
  );
}
