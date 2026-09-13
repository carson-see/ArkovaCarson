/**
 * ComputeID AgentPassport revocation webhook (SCRUM-4493).
 *
 * ComputeID POSTs `passport.revoked` / `passport.suspended` /
 * `passport.reinstated` (plus a bare `test` event) signed with
 * `X-ComputeID-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`.
 * Contract verified live 2026-09-07; the golden fixture in
 * `integrations/computeid/__fixtures__` replays a real delivery.
 *
 * Differences from the Checkr template this is forked from:
 *   - One Arkova-global registration, not per-org: the org is resolved from
 *     the passport → agent binding, so there is no account-id header lookup.
 *   - Agent state and key enforcement commit in one locked transaction, because
 *     the auth path checks api_keys.is_active, never agents.status.
 *   - The RPC compares the complete status/metadata snapshot under the row lock;
 *     a lost race answers 409 so the sender redelivers against fresh state.
 *   - Service-owned terminal passport authority blocks readmission across
 *     organizations. Every retry still enforces agents after partial delivery.
 *     Suspension/reinstatement obey signed timestamp ordering.
 *   - Secrets may be a comma-separated list so rotation is register-new →
 *     retire-old with no window where deliveries fail.
 *
 * Privacy: the partner-supplied free-text `reason` and the raw body never
 * reach the logger, Sentry, `audit_events.details`, or `webhook_dlq`.
 * Gate: `ENABLE_COMPUTEID_INTEGRATION=true` (default off → 503 vendor_gated).
 * Flag and secret are read through the typed `config` export, never
 * `process.env` (SCRUM-1258 ratchet: a Cloud Run typo must fail loudly at boot).
 */
import crypto from 'node:crypto';
import express, { Router, type Request, type Response, type RequestHandler } from 'express';
import { config } from '../../../config.js';
import { truncateUtf16Safe } from '../../../utils/utf16-truncate.js';
import { logger } from '../../../utils/logger.js';
import { verifyHmacSha256Hex } from '../../../integrations/oauth/hmac.js';
import {
  COMPUTEID_PASSPORT_EVENTS,
  COMPUTEID_TEST_EVENT,
  ComputeIdPassportEventPayload,
  ComputeIdWebhookEnvelope,
  type ComputeIdPassportEvent,
} from '../../../integrations/computeid/schemas.js';
import { MAX_PROVIDER_EVENT_CLOCK_SKEW_MS } from '../../../integrations/computeid/binding.js';
import {
  applyPassportEventToAgent,
  findBoundAgents,
  recordPassportFailure,
  recordPassportRevocationAuthority,
  type BoundAgentRow,
  type PassportDelivery,
} from '../../../integrations/computeid/passport-transition.js';
import { parseSecretList } from '../../../integrations/computeid/secrets.js';

export const computeidWebhookRouter = Router();

export const COMPUTEID_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const SIGNATURE_HEADER = 'x-computeid-signature';
const SIGNATURE_PREFIX = 'sha256=';
const PROVIDER = 'computeid';

const rawParser = express.raw({ type: () => true, limit: COMPUTEID_WEBHOOK_MAX_BODY_BYTES + 1024 });
/** Shared production/test mount: reject suffix paths before allocating raw body. */
export const computeidWebhookBody: RequestHandler = (req, res, next) => {
  if (req.path !== '/') {
    res.status(404).json({ error: { code: 'not_found' } });
    return;
  }
  rawParser(req, res, (err?: unknown) => {
    if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'payload_too_large' } });
      return;
    }
    if (err) { next(err); return; }
    (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
    next();
  });
};

function getRawBody(req: Request): Buffer | null {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? req.body;
  return Buffer.isBuffer(rawBody) ? rawBody : null;
}

function signatureHex(req: Request): string | undefined {
  const raw = req.headers[SIGNATURE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(SIGNATURE_PREFIX)) return undefined;
  return trimmed.slice(SIGNATURE_PREFIX.length);
}

function configuredSecrets(): string[] {
  return parseSecretList(config.computeidWebhookSecret);
}

function isPassportEvent(event: string): event is ComputeIdPassportEvent {
  return (COMPUTEID_PASSPORT_EVENTS as readonly string[]).includes(event);
}

const dlqInsert = recordPassportFailure;

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const reply = (status: number, body: Record<string, unknown>): Reply => ({ status, body });
const INVALID_BODY = { error: { code: 'invalid_body' } };
const PROCESSING_FAILED = { error: { code: 'webhook_processing_failed' } };

function send(res: Response, r: Reply): void {
  res.status(r.status).json(r.body);
}

/** Flag gate, secret presence, raw-body presence, size cap, HMAC — in that order. */
function authenticateDelivery(req: Request): { ok: true; rawBody: Buffer } | { ok: false; reply: Reply } {
  if (!config.enableComputeidIntegration) {
    return {
      ok: false,
      reply: reply(503, {
        error: {
          code: 'vendor_gated',
          message: 'ComputeID integration is not enabled in this environment (ENABLE_COMPUTEID_INTEGRATION).',
        },
      }),
    };
  }
  const secrets = configuredSecrets();
  if (secrets.length === 0) {
    logger.error('COMPUTEID_WEBHOOK_SECRET not set — webhook rejected');
    return { ok: false, reply: reply(503, { error: { code: 'webhook_unconfigured' } }) };
  }
  const rawBody = getRawBody(req);
  if (!rawBody) {
    logger.error({ path: req.path }, 'ComputeID webhook: rawBody missing — raw parser must be mounted');
    return { ok: false, reply: reply(500, { error: { code: 'misconfigured_raw_body' } }) };
  }
  if (rawBody.length > COMPUTEID_WEBHOOK_MAX_BODY_BYTES) {
    return { ok: false, reply: reply(413, { error: { code: 'payload_too_large' } }) };
  }
  const signature = signatureHex(req);
  if (!secrets.some((secret) => verifyHmacSha256Hex({ rawBody, signature, secret }))) {
    return { ok: false, reply: reply(401, { error: { code: 'invalid_signature' } }) };
  }
  return { ok: true, rawBody };
}

type ParsedDelivery = { kind: 'reply'; reply: Reply } | { kind: 'passport'; delivery: PassportDelivery };

/** JSON → envelope → (test / unknown event acknowledged) → passport.* payload. */
async function parseDelivery(rawBody: Buffer, payloadHash: string): Promise<ParsedDelivery> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // Fixed reason strings only: a JSON parse error message echoes body bytes.
    await dlqInsert({ reason: 'invalid_body:json_parse', externalId: null, payloadHash });
    return { kind: 'reply', reply: reply(400, INVALID_BODY) };
  }
  const envelope = ComputeIdWebhookEnvelope.safeParse(parsedJson);
  if (!envelope.success) {
    await dlqInsert({ reason: 'invalid_body:envelope', externalId: null, payloadHash });
    return { kind: 'reply', reply: reply(400, INVALID_BODY) };
  }
  const { event } = envelope.data;
  if (!isPassportEvent(event)) {
    const what = event === COMPUTEID_TEST_EVENT ? 'test delivery' : 'unrecognized event';
    logger.info({ provider: PROVIDER, event }, `ComputeID webhook: ${what} acknowledged`);
    return { kind: 'reply', reply: reply(200, { ok: true, ignored: true, event }) };
  }
  const passportEvent = ComputeIdPassportEventPayload.safeParse(parsedJson);
  if (!passportEvent.success) {
    const maybeId = (parsedJson as { passport_id?: unknown }).passport_id;
    await dlqInsert({
      reason: `passport_event_shape_invalid:${event}`,
      externalId: typeof maybeId === 'string' ? truncateUtf16Safe(maybeId, 64) : null,
      payloadHash,
    });
    return { kind: 'reply', reply: reply(400, INVALID_BODY) };
  }
  const { passport_id: passportId, timestamp: rawTimestamp } = passportEvent.data;
  const now = Date.now();
  const eventTime = Date.parse(rawTimestamp);
  if (eventTime > now + MAX_PROVIDER_EVENT_CLOCK_SKEW_MS) {
    await dlqInsert({ reason: 'future_event_timestamp', externalId: passportId, payloadHash });
    return { kind: 'reply', reply: reply(400, { error: { code: 'future_event_timestamp' } }) };
  }
  const timestamp = new Date(Math.min(eventTime, now)).toISOString();
  return {
    kind: 'passport',
    delivery: { event, passportId, timestamp, payloadHash },
  };
}

type AgentOutcome = { outcome: 'applied' | 'skipped' } | { outcome: 'failed'; reply: Reply };

/**
 * One bound agent, through the SHARED transition path
 * (`integrations/computeid/passport-transition.ts`) that the scheduled
 * re-check also uses. Only the HTTP mapping lives here: a lost compare-and-set
 * race answers 409 so ComputeID redelivers against fresh state.
 */
async function processBoundAgent(agent: BoundAgentRow, d: PassportDelivery): Promise<AgentOutcome> {
  const result = await applyPassportEventToAgent(agent, d);
  switch (result.outcome) {
    case 'conflict':
      return { outcome: 'failed', reply: reply(409, { error: { code: 'conflict_retry', message: 'Agent state changed concurrently; redeliver.' } }) };
    case 'failed':
      return { outcome: 'failed', reply: reply(500, PROCESSING_FAILED) };
    default:
      return { outcome: result.outcome };
  }
}

computeidWebhookRouter.post('/', async (req: Request, res: Response) => {
  const auth = authenticateDelivery(req);
  if (!auth.ok) {
    send(res, auth.reply);
    return;
  }
  const payloadHash = crypto.createHash('sha256').update(auth.rawBody).digest('hex');
  const parsed = await parseDelivery(auth.rawBody, payloadHash);
  if (parsed.kind === 'reply') {
    send(res, parsed.reply);
    return;
  }
  const d = parsed.delivery;

  if (d.event === 'passport.revoked' && !(await recordPassportRevocationAuthority(d))) {
    send(res, reply(500, PROCESSING_FAILED));
    return;
  }

  let applied = 0;
  let skipped = 0;
  try {
    for await (const agent of findBoundAgents(d.passportId)) {
      const result = await processBoundAgent(agent, d);
      if (result.outcome === 'failed') {
        send(res, result.reply);
        return;
      }
      if (result.outcome === 'applied') applied += 1;
      else skipped += 1;
    }
  } catch {
    await dlqInsert({ reason: 'agent_lookup_failed', externalId: d.passportId, payloadHash });
    send(res, reply(500, PROCESSING_FAILED));
    return;
  }
  if (applied + skipped === 0) {
    logger.warn({ provider: PROVIDER, event: d.event, passportId: d.passportId }, 'ComputeID webhook: passport not bound to any agent');
    await dlqInsert({ reason: 'unbound_passport', externalId: d.passportId, payloadHash });
    send(res, reply(200, { ok: true, orphaned: true, event: d.event }));
    return;
  }

  logger.info({ provider: PROVIDER, event: d.event, passportId: d.passportId, applied, skipped }, 'ComputeID webhook: passport event processed');
  res.status(200).json({ ok: true, event: d.event, applied, skipped });
});
