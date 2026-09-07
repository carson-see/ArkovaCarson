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
 *   - Keys are enforced BEFORE the row flips (deactivate) / AFTER (reactivate),
 *     and re-asserted on repeat events, because the auth path checks only
 *     api_keys.is_active, never agents.status.
 *   - The agents write is a compare-and-set on (status, last_event_at); a lost
 *     race answers 409 so the sender redelivers against fresh state.
 *   - No nonce table (would need a migration — PR-B). Replay safety is the
 *     ordering guard on the SIGNED timestamp (`integrations/computeid/binding.ts`).
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
import { Router, type Request, type Response } from 'express';
import { config } from '../../../config.js';
import { db } from '../../../utils/db.js';
import { truncateUtf16Safe } from '../../../utils/utf16-truncate.js';
import { logger } from '../../../utils/logger.js';
import { recordAuditEvent } from '../../../utils/auditEvent.js';
import { verifyHmacSha256Hex } from '../../../integrations/oauth/hmac.js';
import {
  COMPUTEID_PASSPORT_EVENTS,
  COMPUTEID_TEST_EVENT,
  ComputeIdPassportEventPayload,
  ComputeIdWebhookEnvelope,
  type ComputeIdPassportEvent,
} from '../../../integrations/computeid/schemas.js';
import { applyPassportEvent, readBinding, type AgentStatus } from '../../../integrations/computeid/binding.js';
import { parseSecretList } from '../../../integrations/computeid/secrets.js';

export const computeidWebhookRouter = Router();

export const COMPUTEID_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const SIGNATURE_HEADER = 'x-computeid-signature';
const SIGNATURE_PREFIX = 'sha256=';
const PROVIDER = 'computeid';

const AUDIT_EVENT_BY_ACTION = {
  revoke: 'AGENT_PASSPORT_REVOKED',
  suspend: 'AGENT_PASSPORT_SUSPENDED',
  reinstate: 'AGENT_PASSPORT_REINSTATED',
} as const;

interface BoundAgentRow {
  id: string;
  org_id: string;
  name: string;
  status: AgentStatus;
  metadata: unknown;
}

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

async function dlqInsert(args: { reason: string; externalId: string | null; payloadHash: string }): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).from('webhook_dlq').insert({
      provider: PROVIDER,
      reason: truncateUtf16Safe(args.reason, 500),
      external_id: args.externalId,
      payload_hash: args.payloadHash,
    });
    if (error) logger.warn({ error }, 'ComputeID webhook: DLQ insert failed (non-fatal)');
  } catch (err) {
    logger.warn({ error: err }, 'ComputeID webhook: DLQ insert threw (non-fatal)');
  }
}

async function findBoundAgents(passportId: string): Promise<BoundAgentRow[]> {
  // Cross-org by design: one passport may be admitted into several orgs, and
  // the org is only knowable from the binding itself. `agents` is not a
  // tenant-isolation-listed table; every write below re-scopes by org_id.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('agents')
    .select('id, org_id, name, status, metadata')
    .contains('metadata', { computeid: { passport_id: passportId } });
  if (error) {
    logger.error({ error }, 'ComputeID webhook: bound-agent lookup failed');
    throw new Error('agent_lookup_failed');
  }
  return (data as BoundAgentRow[] | null) ?? [];
}

computeidWebhookRouter.post('/', async (req: Request, res: Response) => {
  if (!config.enableComputeidIntegration) {
    res.status(503).json({
      error: {
        code: 'vendor_gated',
        message: 'ComputeID integration is not enabled in this environment (ENABLE_COMPUTEID_INTEGRATION).',
      },
    });
    return;
  }

  const secrets = configuredSecrets();
  if (secrets.length === 0) {
    logger.error('COMPUTEID_WEBHOOK_SECRET not set — webhook rejected');
    res.status(503).json({ error: { code: 'webhook_unconfigured' } });
    return;
  }

  const rawBody = getRawBody(req);
  if (!rawBody) {
    logger.error({ path: req.path }, 'ComputeID webhook: rawBody missing — raw parser must be mounted');
    res.status(500).json({ error: { code: 'misconfigured_raw_body' } });
    return;
  }
  if (rawBody.length > COMPUTEID_WEBHOOK_MAX_BODY_BYTES) {
    res.status(413).json({ error: { code: 'payload_too_large' } });
    return;
  }

  const signature = signatureHex(req);
  const signed = secrets.some((secret) => verifyHmacSha256Hex({ rawBody, signature, secret }));
  if (!signed) {
    res.status(401).json({ error: { code: 'invalid_signature' } });
    return;
  }

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // Fixed reason strings only: a JSON parse error message echoes body bytes.
    await dlqInsert({ reason: 'invalid_body:json_parse', externalId: null, payloadHash });
    res.status(400).json({ error: { code: 'invalid_body' } });
    return;
  }
  const envelope = ComputeIdWebhookEnvelope.safeParse(parsedJson);
  if (!envelope.success) {
    await dlqInsert({ reason: 'invalid_body:envelope', externalId: null, payloadHash });
    res.status(400).json({ error: { code: 'invalid_body' } });
    return;
  }

  const { event } = envelope.data;
  if (event === COMPUTEID_TEST_EVENT) {
    logger.info({ provider: PROVIDER, event }, 'ComputeID webhook: test delivery acknowledged');
    res.status(200).json({ ok: true, ignored: true, event });
    return;
  }
  if (!isPassportEvent(event)) {
    logger.info({ provider: PROVIDER, event }, 'ComputeID webhook: unrecognized event acknowledged');
    res.status(200).json({ ok: true, ignored: true, event });
    return;
  }

  const passportEvent = ComputeIdPassportEventPayload.safeParse(parsedJson);
  if (!passportEvent.success) {
    const maybeId = (parsedJson as { passport_id?: unknown }).passport_id;
    await dlqInsert({
      reason: `passport_event_shape_invalid:${event}`,
      externalId: typeof maybeId === 'string' ? truncateUtf16Safe(maybeId, 64) : null,
      payloadHash,
    });
    res.status(400).json({ error: { code: 'invalid_body' } });
    return;
  }
  const { passport_id: passportId, timestamp, reason } = passportEvent.data;
  const withheldReasonChars = typeof reason === 'string' ? reason.length : reason == null ? 0 : JSON.stringify(reason).length;

  let agents: BoundAgentRow[];
  try {
    agents = await findBoundAgents(passportId);
  } catch {
    await dlqInsert({ reason: 'agent_lookup_failed', externalId: passportId, payloadHash });
    res.status(500).json({ error: { code: 'webhook_processing_failed' } });
    return;
  }
  if (agents.length === 0) {
    logger.warn({ provider: PROVIDER, event, passportId }, 'ComputeID webhook: passport not bound to any agent');
    await dlqInsert({ reason: 'unbound_passport', externalId: passportId, payloadHash });
    res.status(200).json({ ok: true, orphaned: true, event });
    return;
  }

  let applied = 0;
  let skipped = 0;
  for (const agent of agents) {
    const { decision, update, keyEnforcement } = applyPassportEvent(
      { status: agent.status, metadata: agent.metadata },
      { event, timestamp },
    );
    if (!update) {
      skipped += 1;
      continue;
    }

    // Keys FIRST for deactivation. The auth path reads only api_keys.is_active,
    // so if the agent row were flipped first and this write failed, a retry
    // would see the terminal status and never come back for the keys.
    if (keyEnforcement === 'deactivate') {
      const revocation_reason = `computeid:${event}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: keysErr } = await (db as any)
        .from('api_keys')
        .update({ is_active: false, revoked_at: timestamp, revocation_reason })
        .eq('org_id', agent.org_id)
        .eq('agent_id', agent.id)
        .eq('is_active', true);
      if (keysErr) {
        logger.error({ error: keysErr, agentId: agent.id, event }, 'ComputeID webhook: agent key deactivation failed');
        await dlqInsert({ reason: `agent_keys_deactivate_failed:${event}`, externalId: passportId, payloadHash });
        res.status(500).json({ error: { code: 'webhook_processing_failed' } });
        return;
      }
    }

    // Compare-and-set on the row we decided from. Two concurrent deliveries
    // both read the same snapshot; only the first write lands, the second sees
    // zero rows and answers 409 so the sender re-delivers against fresh state.
    const prevLastEventAt = readBinding(agent.metadata)?.last_event_at ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cas = (db as any).from('agents').update(update).eq('org_id', agent.org_id).eq('id', agent.id).eq('status', agent.status);
    cas = prevLastEventAt === null
      ? cas.is('metadata->computeid->>last_event_at', null)
      : cas.eq('metadata->computeid->>last_event_at', prevLastEventAt);
    const { data: casRows, error: updateErr } = await cas.select('id');
    if (updateErr) {
      logger.error({ error: updateErr, agentId: agent.id, event }, 'ComputeID webhook: agent update failed');
      await dlqInsert({ reason: `agent_update_failed:${event}`, externalId: passportId, payloadHash });
      res.status(500).json({ error: { code: 'webhook_processing_failed' } });
      return;
    }
    if (!Array.isArray(casRows) || casRows.length === 0) {
      logger.warn({ agentId: agent.id, event }, 'ComputeID webhook: agent row changed underneath us — asking for redelivery');
      await dlqInsert({ reason: `agent_update_conflict:${event}`, externalId: passportId, payloadHash });
      res.status(409).json({ error: { code: 'conflict_retry', message: 'Agent state changed concurrently; redeliver.' } });
      return;
    }

    // Reactivation AFTER the row is active, restoring only the keys WE
    // deactivated for a suspension — never keys revoked for any other reason.
    if (keyEnforcement === 'reactivate') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: keysErr } = await (db as any)
        .from('api_keys')
        .update({ is_active: true, revoked_at: null, revocation_reason: null })
        .eq('org_id', agent.org_id)
        .eq('agent_id', agent.id)
        .eq('is_active', false)
        .eq('revocation_reason', 'computeid:passport.suspended');
      if (keysErr) {
        logger.error({ error: keysErr, agentId: agent.id }, 'ComputeID webhook: agent key reinstatement failed');
        await dlqInsert({ reason: 'agent_keys_reinstate_failed', externalId: passportId, payloadHash });
        res.status(500).json({ error: { code: 'webhook_processing_failed' } });
        return;
      }
    }

    if (decision.action === 'noop') {
      skipped += 1;
      continue;
    }
    applied += 1;

    void recordAuditEvent({
      actor_id: null,
      event_type: AUDIT_EVENT_BY_ACTION[decision.action],
      event_category: 'SECURITY',
      target_type: 'agent',
      target_id: agent.id,
      org_id: agent.org_id,
      details:
        `ComputeID passport ${passportId} ${event.replace('passport.', '')} at ${timestamp}; ` +
        `agent "${agent.name}" → ${String(update.status ?? agent.status)}. ` +
        `Partner-supplied reason withheld (${withheldReasonChars} chars).`,
    });
  }

  logger.info({ provider: PROVIDER, event, passportId, applied, skipped }, 'ComputeID webhook: passport event processed');
  res.status(200).json({ ok: true, event, applied, skipped });
});
