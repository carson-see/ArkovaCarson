/**
 * Adobe Sign webhook handler (SCRUM-1148).
 *
 * Receives HMAC-verified `AGREEMENT_WORKFLOW_COMPLETED` events, resolves the
 * connected org integration by Adobe webhookId or accountId, and queues a
 * sanitized `ESIGN_COMPLETED` rules-engine event. Raw payloads are NEVER
 * persisted; only canonical sanitized metadata reaches the database.
 *
 * Hardening (per AC):
 *   - HMAC verify against raw body using per-webhook client secret.
 *   - Canonical event normalization via existing `adaptAdobeSign` adapter.
 *   - Idempotent duplicate deliveries (nonce table, same as DocuSign).
 *   - Failures land in a dead-letter row on the queue with status='FAILED'.
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { adaptAdobeSign } from '../../../integrations/connectors/adapters.js';
import {
  parseAdobeSignPayload,
  verifyAdobeSignHmac,
  type AdobeAgreementCompletedEvent,
} from '../../../integrations/oauth/adobe-sign.js';

export const adobeSignWebhookRouter = Router();

interface AdobeIntegrationRow {
  id: string;
  org_id: string;
}

function getRawBody(req: Request): Buffer | null {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? req.body;
  return Buffer.isBuffer(rawBody) ? rawBody : null;
}

function signatureHeader(req: Request): string | undefined {
  // Adobe documents both the SHA256 header and the older base ClientId proof.
  const sha = req.headers['x-adobesign-clientid-authentication-sha256'];
  if (sha) return Array.isArray(sha) ? sha[0] : sha;
  const legacy = req.headers['x-adobesign-clientid'];
  return Array.isArray(legacy) ? legacy[0] : legacy;
}

async function findIntegration(
  webhookId: string | null,
): Promise<AdobeIntegrationRow | null> {
  if (!webhookId) return null;
  // Provider webhook registrations use the shared subscription_id column.
  // org_integrations has no webhook_id column; a typed query catches that drift.
  // eslint-disable-next-line arkova/missing-org-filter -- resolve tenant from authenticated provider webhook ID
  const { data, error } = await db
    .from('org_integrations')
    .select('id, org_id')
    .eq('provider', 'adobe_sign')
    .eq('subscription_id', webhookId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) {
    logger.error({ error, webhookId }, 'Adobe Sign webhook integration lookup failed');
    throw new Error('integration_lookup_failed');
  }
  return data ?? null;
}

/**
 * Build the sanitized rule-event payload for the `enqueue_rule_event` RPC.
 *
 * `organization_rule_events.payload` carries a hard DB CHECK
 * (`organization_rule_events_payload_size`): `pg_column_size(payload) <= 16384`.
 * The payload is derived from EVERY agreement document, so it must stay bounded
 * regardless of document cardinality or document-id length.
 *
 * We record `document_count` — a fixed-size integer — rather than the full
 * `document_ids` array. Adobe's `documents` array is `.max(100)` and each
 * document `id` is `z.string().trim().min(1)` with NO `.max()` length cap, so
 * the former array was even less bounded than the DocuSign case (which had a
 * 100-char documentId gate): at max cardinality with long ids it overflowed the
 * 16KB budget (measured ~50KB at 100 × 500-char ids). The RPC would then raise a
 * check_violation, `enqueueRuleEvent` would throw, and the handler would DLQ +
 * 500 — after which the event is not retried forever, it is LOST: Adobe's retry
 * carries the identical body, hits the nonce's `(agreement_id, payload_hash)`
 * UNIQUE violation and is answered `200 {duplicate:true}`. See `releaseNonce`
 * below, which compensates that; the agreement's ESIGN_COMPLETED event and
 * every downstream step (anchoring) are otherwise dropped silently.
 *
 * The `documents` leg is only half of it. `agreement.id` also lands on this
 * payload, and its only bound was a late `.max(500)` throw inside
 * `adaptAdobeSign` — a bound by accident, taken AFTER the nonce is committed,
 * so it produced a 500 and a silently-lost event rather than a rejection. And
 * `senderInfo.email` (-> `sender_email`, CHECK <= 320) had no bound at all.
 * Both are now bounded at the parse layer in `integrations/oauth/adobe-sign.ts`,
 * which is what makes this payload's size an actual invariant instead of a
 * consequence of where something happens to throw.
 *
 * Dropping `document_ids` here is safe because it is write-only on THIS payload:
 * the rules engine's `sanitizeExecutionProviderPayload` allowlist
 * (`jobs/rules-engine.ts`) and the action dispatcher (`jobs/rule-action-dispatcher.ts`)
 * read only `document_hashes` / `document_sha256` (which this handler does not
 * even set), and there is no Adobe fetch/materialization job that references it.
 * Mirrors `buildDocusignRuleEventPayload` (DocuSign bilateral 2026-08, Finding 7;
 * PR #2485). If a per-document-id consumer is ever added, carry the ids on the
 * UNCAPPED `job_queue` payload of that job, never back onto this capped payload.
 */
export function buildAdobeSignRuleEventPayload(args: {
  integrationId: string;
  event: AdobeAgreementCompletedEvent;
  payloadHash: string;
}): Record<string, unknown> {
  return {
    source: 'adobe_sign_webhook',
    integration_id: args.integrationId,
    agreement_id: args.event.agreementId,
    document_count: args.event.documents.length,
    payload_hash: args.payloadHash,
  };
}

async function enqueueRuleEvent(args: {
  integration: AdobeIntegrationRow;
  event: AdobeAgreementCompletedEvent;
  payloadHash: string;
}): Promise<string> {
  const canonical = adaptAdobeSign(
    {
      event: 'AGREEMENT_WORKFLOW_COMPLETED' as const,
      agreement: {
        id: args.event.agreementId,
        name: args.event.agreementName ?? undefined,
        senderInfo: args.event.senderEmail ? { email: args.event.senderEmail } : undefined,
      },
    },
    { org_id: args.integration.org_id },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db.rpc as any)('enqueue_rule_event', {
    p_org_id: canonical.org_id,
    p_trigger_type: canonical.trigger_type,
    p_vendor: canonical.vendor,
    p_external_file_id: canonical.external_file_id,
    p_filename: canonical.filename ?? null,
    p_folder_path: canonical.folder_path ?? null,
    p_sender_email: canonical.sender_email ?? null,
    p_subject: canonical.subject ?? null,
    p_payload: buildAdobeSignRuleEventPayload({
      integrationId: args.integration.id,
      event: args.event,
      payloadHash: args.payloadHash,
    }),
  });
  if (error || !data) {
    logger.error({ error, integrationId: args.integration.id }, 'Adobe Sign rule-event enqueue failed');
    throw new Error('rule_event_enqueue_failed');
  }
  return String(data);
}

async function dlqInsert(args: {
  webhookId: string | null;
  agreementId: string | null;
  reason: string;
  payloadHash: string;
}): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).from('webhook_dlq').insert({
      provider: 'adobe_sign',
      reason: args.reason.slice(0, 500),
      external_id: args.agreementId,
      webhook_id: args.webhookId,
      payload_hash: args.payloadHash,
    });
    if (error) {
      logger.warn({ error }, 'Adobe Sign webhook: DLQ insert failed (non-fatal)');
    }
  } catch (err) {
    logger.warn({ error: err }, 'Adobe Sign webhook: DLQ insert threw (non-fatal)');
  }
}

adobeSignWebhookRouter.post('/', async (req: Request, res: Response) => {
  const secret = process.env.ADOBE_SIGN_CLIENT_SECRET;
  if (!secret) {
    logger.error('ADOBE_SIGN_CLIENT_SECRET not set — webhook rejected');
    res.status(503).json({ error: { code: 'webhook_unconfigured' } });
    return;
  }

  const rawBody = getRawBody(req);
  if (!rawBody) {
    logger.error({ path: req.path }, 'Adobe Sign webhook: rawBody missing — raw parser must be mounted');
    res.status(500).json({ error: { code: 'misconfigured_raw_body' } });
    return;
  }

  if (!verifyAdobeSignHmac({ rawBody, signature: signatureHeader(req), clientSecret: secret })) {
    res.status(401).json({ error: { code: 'invalid_signature' } });
    return;
  }

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  let event: AdobeAgreementCompletedEvent;
  try {
    event = parseAdobeSignPayload(rawBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid_body';
    if (/Unsupported Adobe Sign event/.test(message)) {
      // Adobe also fires CREATED / RECALLED etc. on the same endpoint. Ack
      // them so Adobe stops retrying, but do not enqueue or DLQ.
      logger.info({ message }, 'Adobe Sign webhook: non-completed event — acked + ignored');
      res.status(200).json({ ok: true, ignored: true });
      return;
    }
    logger.warn({ err: message }, 'Adobe Sign webhook: malformed body');
    await dlqInsert({ webhookId: null, agreementId: null, reason: message, payloadHash });
    res.status(400).json({ error: { code: 'invalid_body' } });
    return;
  }

  /**
   * AUDIT-0424-10 / SCRUM-3479 — release the replay nonce before returning any
   * post-nonce 5xx.
   *
   * The nonce row is committed BEFORE `enqueue_rule_event` runs, so without
   * this compensation a transient enqueue failure is unrecoverable rather than
   * retryable — and the loss is faster than it looks. Adobe's retry carries the
   * identical body, so it hashes to the identical `payload_hash`, hits the
   * `(agreement_id, payload_hash)` UNIQUE violation, and is answered
   * `200 {duplicate:true}`: the ESIGN_COMPLETED event is dropped after ONE
   * retry AND the vendor is told it succeeded. The `webhook_dlq` row written
   * alongside is a record of the loss, not a recovery path — nothing under
   * `jobs/` drains that table.
   *
   * Deleting the nonce permits retry after a reported failure. Commit outcome
   * can be ambiguous, so this is at-least-once recovery. The success
   * path never calls this, so replay protection for genuinely duplicate
   * deliveries is unchanged. Mirrors `checkr.ts` / `middesk.ts::releaseNonce`.
   *
   * RESIDUAL RISK — a deliberate at-least-once trade, identical to `checkr.ts`.
   * If the RPC throws after Postgres already committed the insert (connection
   * dropped while awaiting the response) we cannot tell "enqueued" from "not
   * enqueued", and releasing lets the retry enqueue a SECOND
   * `organization_rule_events` row: `enqueue_rule_event` is a bare INSERT with
   * no `ON CONFLICT`, and the executions idempotency index is
   * `UNIQUE(rule_id, trigger_event_id)` keyed on the per-enqueue rule-event id,
   * so two enqueues are two distinct keys. A rare duplicate execution is
   * recoverable; a guaranteed silent loss while the vendor is told `200` is not.
   */
  let nonceCommitted = false;
  async function releaseNonce(reason: string): Promise<void> {
    // Only compensate a nonce THIS delivery committed. The insert below fails
    // open on non-23505 errors, and the enclosing try also covers work that
    // runs before the insert — in both cases a row matching this key could only
    // belong to an EARLIER delivery, and deleting it would re-open that
    // delivery to replay.
    if (!nonceCommitted) return;
    try {
      // Filter on BOTH columns of the UNIQUE key
      // (`adobe_sign_webhook_nonces_agreement_id_payload_hash_key`). Deleting by
      // `agreement_id` alone would drop the nonce for a different payload
      // revision of the same agreement, disarming its replay protection.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webhook replay marker rollback scoped by nonce unique key
      const { error: releaseErr } = await (db as any)
        .from('adobe_sign_webhook_nonces')
        .delete()
        .eq('agreement_id', event.agreementId)
        .eq('payload_hash', payloadHash);
      if (releaseErr) {
        // Nothing further we can do — log loudly. The event is now stuck and
        // needs a manual replay from the Adobe Sign console.
        logger.error(
          { error: releaseErr, reason },
          'Failed to release Adobe Sign webhook nonce — event will not be reprocessed on retry',
        );
        return;
      }
      nonceCommitted = false;
      logger.warn({ reason }, 'Released Adobe Sign webhook nonce so retry can reprocess');
    } catch (releaseThrew) {
      // Best-effort: never let the compensation mask the original failure.
      logger.error({ error: releaseThrew, reason }, 'Adobe Sign nonce release threw');
    }
  }

  try {
    const integration = await findIntegration(event.webhookId);
    if (!integration) {
      logger.warn({ webhookId: event.webhookId }, 'Adobe Sign webhook: unknown connected webhook');
      res.status(200).json({ ok: true, orphaned: true });
      return;
    }

    // Replay protection: dedupe by (agreement_id, webhook_id). Reuses the
    // generic `webhook_nonces` table when available; fall back to ack-on-
    // duplicate-key if the Postgres unique index complains.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: nonceErr } = await (db as any)
      .from('adobe_sign_webhook_nonces')
      .insert({
        agreement_id: event.agreementId,
        webhook_id: event.webhookId,
        payload_hash: payloadHash,
      });
    if (nonceErr) {
      if ((nonceErr as { code?: string }).code === '23505') {
        logger.info(
          { agreementId: event.agreementId },
          'Adobe Sign webhook: duplicate delivery — returning 200',
        );
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      logger.error(
        { error: nonceErr, agreementId: event.agreementId },
        'Adobe Sign webhook: nonce insert failed',
      );
      // Fail open: we still try to enqueue rather than reject — losing the
      // event is worse than double-processing it. No row was committed, so
      // `releaseNonce` must stay disarmed for this delivery.
      //
      // NOTE: the older comment here claimed the executions idempotency key
      // de-dupes a re-delivery. It does not on this path — the index is
      // `UNIQUE(rule_id, trigger_event_id)` and `trigger_event_id` is the
      // per-enqueue rule-event id, so a re-delivery that enqueues again
      // produces a different key. Failing open can therefore double-process;
      // that is an accepted trade, not a guarded no-op.
    } else {
      nonceCommitted = true;
    }

    const ruleEventId = await enqueueRuleEvent({ integration, event, payloadHash });
    res.status(202).json({ ok: true, rule_event_id: ruleEventId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unexpected';
    logger.error({ error: err, webhookId: event.webhookId }, 'Adobe Sign webhook processing failed');
    await dlqInsert({
      webhookId: event.webhookId,
      agreementId: event.agreementId,
      reason: message,
      payloadHash,
    });
    await releaseNonce(message);
    res.status(500).json({ error: { code: 'webhook_processing_failed' } });
  }
});
