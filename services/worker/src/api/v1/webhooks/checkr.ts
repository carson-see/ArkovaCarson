/**
 * Checkr webhook handler (SCRUM-1030 / SCRUM-1151).
 *
 * Checkr signs Webhook v1 deliveries with HMAC-SHA256-hex over the raw body
 * via the `X-Checkr-Signature` header. Account routing is via the
 * `X-Checkr-Account-Id` header (Checkr partner accounts can multiplex
 * multiple sub-accounts; we map account_id → org_integrations.account_id).
 *
 * In scope for SCRUM-1030/1151:
 *   - HMAC verification (hex encoding, vs DocuSign/Adobe base64)
 *   - `report.completed` is the only supported event for now; other events
 *     are 200-OK acked + ignored.
 *   - Replay protection via `checkr_webhook_nonces` table.
 *   - Failures land in `webhook_dlq` (introduced in batch 2's migration 0258).
 *
 * Per [SCRUM-1151 spike doc](docs/integrations/background-checks-spike.md):
 * Checkr Webhook v1 is the documented contract; v2 (signed JWTs) is not yet
 * GA. Veremark stays gated until vendor docs are confirmed.
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { adaptCheckr } from '../../../integrations/connectors/adapters.js';
import { CheckrReportCompleted } from '../../../integrations/connectors/schemas.js';
import { verifyHmacSha256Hex } from '../../../integrations/oauth/hmac.js';

export const checkrWebhookRouter = Router();

interface CheckrIntegrationRow {
  id: string;
  org_id: string;
  account_id: string | null;
}

const RawCheckrPayload = z
  .object({
    type: z.string().trim().min(1),
    data: z
      .object({
        object: z.object({ id: z.string().trim().min(1) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

function getRawBody(req: Request): Buffer | null {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? req.body;
  return Buffer.isBuffer(rawBody) ? rawBody : null;
}

function signatureHeader(req: Request): string | undefined {
  const sig = req.headers['x-checkr-signature'];
  return Array.isArray(sig) ? sig[0] : sig;
}

function accountHeader(req: Request): string | undefined {
  const v = req.headers['x-checkr-account-id'];
  return Array.isArray(v) ? v[0] : v;
}

async function findIntegration(accountId: string | undefined): Promise<CheckrIntegrationRow | null> {
  if (!accountId) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- webhook ingress: resolving org from external provider ID
  const { data, error } = await (db as any)
    .from('org_integrations')
    .select('id, org_id, account_id')
    .eq('provider', 'checkr')
    .eq('account_id', accountId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) {
    logger.error({ error, accountId }, 'Checkr webhook integration lookup failed');
    throw new Error('integration_lookup_failed');
  }
  return (data as CheckrIntegrationRow | null) ?? null;
}

async function dlqInsert(args: {
  reason: string;
  externalId: string | null;
  payloadHash: string;
}): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).from('webhook_dlq').insert({
      provider: 'checkr',
      reason: args.reason.slice(0, 500),
      external_id: args.externalId,
      payload_hash: args.payloadHash,
    });
    if (error) {
      logger.warn({ error }, 'Checkr webhook: DLQ insert failed (non-fatal)');
    }
  } catch (err) {
    logger.warn({ error: err }, 'Checkr webhook: DLQ insert threw (non-fatal)');
  }
}

checkrWebhookRouter.post('/', async (req: Request, res: Response) => {
  const secret = process.env.CHECKR_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('CHECKR_WEBHOOK_SECRET not set — webhook rejected');
    res.status(503).json({ error: { code: 'webhook_unconfigured' } });
    return;
  }

  const rawBody = getRawBody(req);
  if (!rawBody) {
    logger.error({ path: req.path }, 'Checkr webhook: rawBody missing — raw parser must be mounted');
    res.status(500).json({ error: { code: 'misconfigured_raw_body' } });
    return;
  }

  if (!verifyHmacSha256Hex({ rawBody, signature: signatureHeader(req), secret })) {
    res.status(401).json({ error: { code: 'invalid_signature' } });
    return;
  }

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  let parsed: z.infer<typeof RawCheckrPayload>;
  try {
    parsed = RawCheckrPayload.parse(JSON.parse(rawBody.toString('utf8')));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid_body';
    logger.warn({ err: message }, 'Checkr webhook: malformed body');
    await dlqInsert({ reason: message, externalId: null, payloadHash });
    res.status(400).json({ error: { code: 'invalid_body' } });
    return;
  }

  // Only `report.completed` enters the rules engine. Other events (created,
  // suspended, etc.) get 200-OK so Checkr stops retrying.
  if (parsed.type !== 'report.completed') {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  // Strict validation of the completed-report shape — guards against schema
  // drift between Checkr API versions.
  let completed: z.infer<typeof CheckrReportCompleted>;
  try {
    completed = CheckrReportCompleted.parse(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid_completed_report';
    await dlqInsert({
      reason: `report.completed shape failed validation: ${message}`,
      externalId: parsed.data.object.id ?? null,
      payloadHash,
    });
    res.status(400).json({ error: { code: 'invalid_body' } });
    return;
  }

  /**
   * AUDIT-0424-10 / SCRUM-3479 — release the replay nonce before returning any
   * post-nonce 5xx.
   *
   * The nonce row is committed BEFORE `enqueue_rule_event` runs, so without
   * this compensation a transient enqueue failure is unrecoverable rather than
   * retryable: Checkr re-presents the same delivery, the insert hits the
   * `(report_id, payload_hash)` UNIQUE violation, and the handler answers
   * `200 {duplicate:true}` — the completed background check is dropped AND the
   * vendor is told it succeeded. The `webhook_dlq` row written alongside is a
   * record of the loss, not a recovery path: nothing under `jobs/` drains it.
   *
   * Deleting the nonce restores exactly-once-on-success semantics — the row is
   * the claim on in-flight work, so it is released only when that work did not
   * happen. The success path never calls this, so replay protection for
   * genuinely duplicate deliveries is unchanged. Mirrors `middesk.ts`'s
   * `releaseNonce` and the `webhook_event_claims` release in
   * `stripe/handlers.ts`.
   *
   * RESIDUAL RISK — this is a deliberate at-least-once trade, not a free win.
   * If the RPC *throws* after Postgres already committed the insert (e.g. the
   * connection drops while awaiting the response), we cannot tell "enqueue
   * happened" from "enqueue did not", and releasing the nonce lets the retry
   * enqueue a SECOND `organization_rule_events` row. Nothing de-dupes that:
   * `enqueue_rule_event` is a bare INSERT with no `ON CONFLICT`, and the
   * executions idempotency index is `UNIQUE(rule_id, trigger_event_id)` where
   * `trigger_event_id` is the rule-event id — freshly minted per enqueue, so
   * two enqueues are two distinct keys. We accept a rare duplicate execution
   * over the guaranteed silent loss this replaces; a background check that
   * runs twice is recoverable, one that vanishes while the vendor is told
   * `200` is not. Narrowing the window needs an idempotency key carried into
   * `enqueue_rule_event` itself — out of scope here, tracked separately.
   */
  let nonceCommitted = false;
  async function releaseNonce(reason: string): Promise<void> {
    // Only compensate a nonce THIS delivery committed. The insert below fails
    // open on non-23505 errors, and the enclosing try also covers work that
    // runs before the insert — in both cases a row matching this key could
    // only belong to an EARLIER delivery, and deleting it would re-open that
    // delivery to replay.
    if (!nonceCommitted) return;
    try {
      // Filter on BOTH columns of the UNIQUE key
      // (`checkr_webhook_nonces_report_id_payload_hash_key`). Deleting by
      // `report_id` alone would drop the nonce for a different payload
      // revision of the same report, disarming its replay protection.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: releaseErr } = await (db as any)
        .from('checkr_webhook_nonces')
        .delete()
        .eq('report_id', completed.data.object.id)
        .eq('payload_hash', payloadHash);
      if (releaseErr) {
        // Nothing further we can do — log loudly. The event is now stuck and
        // needs a manual replay from the Checkr dashboard.
        logger.error(
          { error: releaseErr, reason },
          'Failed to release Checkr webhook nonce — event will not be reprocessed on retry',
        );
        return;
      }
      nonceCommitted = false;
      logger.warn({ reason }, 'Released Checkr webhook nonce so retry can reprocess');
    } catch (releaseThrew) {
      // Best-effort: never let the compensation mask the original failure.
      logger.error(
        { error: releaseThrew, reason },
        'Checkr webhook nonce release threw — event will not be reprocessed on retry',
      );
    }
  }

  try {
    const integration = await findIntegration(accountHeader(req));
    if (!integration) {
      logger.warn({ accountId: accountHeader(req) }, 'Checkr webhook: unknown account');
      res.status(200).json({ ok: true, orphaned: true });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: nonceErr } = await (db as any)
      .from('checkr_webhook_nonces')
      .insert({
        report_id: completed.data.object.id,
        payload_hash: payloadHash,
      });
    if (nonceErr) {
      if ((nonceErr as { code?: string }).code === '23505') {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      logger.error({ error: nonceErr }, 'Checkr webhook: nonce insert failed');
      // Fail open on the nonce write: prefer processing the event to dropping
      // it. No row was committed, so `releaseNonce` must stay disarmed for
      // this delivery.
      //
      // NOTE: the older comment here claimed "the executions table's
      // idempotency index still de-dupes downstream side effects". That is
      // not true for THIS path and was removed rather than left as false
      // comfort — the index is `UNIQUE(rule_id, trigger_event_id)` and
      // `trigger_event_id` is the per-enqueue rule-event id, so a
      // re-delivery that enqueues again produces a different key and is not
      // de-duped. Failing open here can therefore double-process; that is an
      // accepted trade against losing the event, not a guarded no-op.
    } else {
      nonceCommitted = true;
    }

    const canonical = adaptCheckr(completed, { org_id: integration.org_id });
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
      p_payload: {
        source: 'checkr_webhook',
        integration_id: integration.id,
        report_id: completed.data.object.id,
        candidate_id: completed.data.object.candidate_id,
        payload_hash: payloadHash,
      },
    });
    if (error || !data) {
      logger.error({ error, integrationId: integration.id }, 'Checkr rule-event enqueue failed');
      await dlqInsert({
        reason: 'rule_event_enqueue_failed',
        externalId: completed.data.object.id,
        payloadHash,
      });
      await releaseNonce('rule_event_enqueue_failed');
      res.status(500).json({ error: { code: 'webhook_processing_failed' } });
      return;
    }

    res.status(202).json({ ok: true, rule_event_id: String(data) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unexpected';
    logger.error({ error: err }, 'Checkr webhook processing failed');
    await dlqInsert({ reason: message, externalId: completed.data.object.id, payloadHash });
    await releaseNonce(message);
    res.status(500).json({ error: { code: 'webhook_processing_failed' } });
  }
});
