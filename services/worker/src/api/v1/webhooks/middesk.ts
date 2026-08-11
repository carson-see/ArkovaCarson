/**
 * Middesk webhook handler (SCRUM-1162)
 *
 * Receives `business.updated` / `business.verified` / `business.rejected` /
 * `business.requires_review` events from Middesk and transitions
 * `organizations.verification_status` accordingly.
 *
 * Security:
 *   - HMAC-SHA256 verification on the raw body using `MIDDESK_WEBHOOK_SECRET`.
 *   - Replay protection via `kyb_webhook_nonces` (provider/id unique).
 *   - Event body is NEVER logged (could contain EIN / address).
 *
 * Constitution refs:
 *   - 1.4: webhook secret from Secret Manager.
 *   - 1.4: no raw payload persisted; `payload_hash` only.
 *   - 1.2: every write validated via Zod (Middesk envelope).
 */
import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import {
  verifyMiddeskSignature,
  parseMiddeskWebhookPayload,
  mapMiddeskEventToStatus,
} from '../../../integrations/kyb/middesk.js';
import type { MiddeskWebhookEventT } from '../../../integrations/kyb/middesk.js';

export const middeskWebhookRouter = Router();

middeskWebhookRouter.post('/', async (req: Request, res: Response) => {
  const secret = process.env.MIDDESK_WEBHOOK_SECRET;
  if (!secret) {
    // Match the signup-side 503 for visibility. Middesk will retry, so this
    // is recoverable as soon as the secret is provisioned.
    logger.error('MIDDESK_WEBHOOK_SECRET not set — webhook rejected');
    res.status(503).json({ error: { code: 'webhook_unconfigured' } });
    return;
  }

  // Caller mounts express.raw({ type: 'application/json' }) upstream so we
  // have the exact bytes Middesk signed. webhookHmac.ts uses the same
  // convention; we replicate it directly since Middesk's header format is
  // different (single signature hex, no timestamp).
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? (req.body as Buffer);
  if (!rawBody || !(rawBody instanceof Buffer)) {
    logger.error({ path: req.path }, 'Middesk webhook: rawBody missing — raw parser must be mounted');
    res.status(500).json({ error: { code: 'misconfigured_raw_body' } });
    return;
  }

  const signature = req.headers['x-middesk-signature'];
  const sigStr = Array.isArray(signature) ? signature[0] : signature;

  if (!verifyMiddeskSignature({ rawBody, signature: sigStr, secret })) {
    // Generic message; don't leak which check failed.
    res.status(401).json({ error: { code: 'invalid_signature' } });
    return;
  }

  // Parse + validate the envelope. Explicitly typed rather than left to
  // control-flow inference: `releaseNonce` below closes over `event`, and an
  // untyped `let` widens to `any` inside a closure (TS7034/TS7005).
  let event: MiddeskWebhookEventT;
  try {
    event = parseMiddeskWebhookPayload(rawBody);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Middesk webhook: malformed body');
    res.status(400).json({ error: { code: 'invalid_body' } });
    return;
  }

  // Replay protection. Cast until database.types.ts is regenerated post-0250.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbUntyped = db as any;
  // eslint-disable-next-line arkova/missing-org-filter -- webhook ingress: resolving org from external provider ID
  const { error: nonceErr } = await dbUntyped.from('kyb_webhook_nonces').insert({
    provider: 'middesk',
    nonce: event.id,
  });
  if (nonceErr) {
    // Unique violation → already delivered. 200 so Middesk stops retrying.
    if (nonceErr.code === '23505') {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    logger.error({ nonceErr }, 'Failed to record Middesk webhook nonce');
    res.status(500).json({ error: { code: 'nonce_store_failed' } });
    return;
  }

  /**
   * AUDIT-0424-10 — release the replay nonce before returning any post-nonce
   * 5xx.
   *
   * The nonce row is committed above, before the kyb_events insert and the
   * organizations update. Without this compensation a downstream failure is
   * unrecoverable rather than retryable: Middesk re-presents the same
   * `event.id`, the insert hits the UNIQUE violation, and the handler answers
   * `200 {duplicate:true}` — so the KYB outcome is dropped AND the provider is
   * told it succeeded. That is why the un-widened CHECK constraint lost
   * rejections silently instead of retrying loudly.
   *
   * Deleting the nonce restores exactly-once-on-success semantics: the row is
   * the claim on in-flight work, so it is released only when that work did not
   * happen. The success path never calls this, so replay protection for
   * genuinely duplicate deliveries is unchanged. Mirrors the
   * `webhook_event_claims` compensating delete in stripe/handlers.ts.
   */
  async function releaseNonce(reason: string): Promise<void> {
    // eslint-disable-next-line arkova/missing-org-filter -- webhook ingress: nonce is provider-scoped, not org-scoped
    const { error: releaseErr } = await dbUntyped
      .from('kyb_webhook_nonces')
      .delete()
      .eq('nonce', event.id);
    if (releaseErr) {
      // Nothing further we can do — log loudly. The event is now stuck and
      // needs manual replay from the Middesk dashboard.
      logger.error(
        { releaseErr, reason, nonce: event.id },
        'Failed to release Middesk webhook nonce — event will not be reprocessed on retry',
      );
      return;
    }
    logger.warn({ reason, nonce: event.id }, 'Released Middesk webhook nonce so retry can reprocess');
  }

  // Never use PostgREST `.or()` with payload-derived strings — even though
  // the envelope is HMAC-verified, `external_id` is attacker-influenced
  // (we set it when registering the business and Middesk echoes it back).
  // Two separate `.eq()` lookups also mean each query has a single,
  // indexable filter.
  const vendorBusinessId = event.data.object.id;
  const externalId = event.data.object.external_id ?? null;

  const findOrg = (field: 'id' | 'kyb_reference_id', value: string) =>
    dbUntyped.from('organizations').select('id').eq(field, value).maybeSingle();

  const byId = externalId ? await findOrg('id', externalId) : null;
  const byRef = byId?.data ? null : await findOrg('kyb_reference_id', vendorBusinessId);
  const orgErr = byId?.error ?? byRef?.error ?? null;
  const org = (byId?.data ?? byRef?.data) as { id: string } | null;

  if (orgErr) {
    logger.error({ orgErr }, 'Middesk webhook: org lookup failed');
    await releaseNonce('org_lookup_failed');
    res.status(500).json({ error: { code: 'org_lookup_failed' } });
    return;
  }
  if (!org) {
    // Vendor sent an event for a business Arkova doesn't know about. Still
    // record the event at org-null? No — FK forbids. Log and 200 so Middesk
    // doesn't hammer us; ops can investigate via Middesk dashboard.
    logger.warn({ vendorBusinessId, externalId }, 'Middesk webhook: unknown business');
    res.status(200).json({ ok: true, orphaned: true });
    return;
  }

  const status = mapMiddeskEventToStatus(event.type);
  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  const { error: eventErr } = await dbUntyped.from('kyb_events').insert({
    org_id: org.id,
    provider: 'middesk',
    event_type: event.type,
    status,
    provider_event_id: event.id,
    payload_hash: payloadHash,
    details: {},
  });

  if (eventErr) {
    logger.error({ eventErr }, 'Failed to insert kyb_events row');
    // Middesk will retry — return 5xx intentionally. The nonce must be released
    // first or that retry is answered as a duplicate and the event is lost.
    await releaseNonce('event_insert_failed');
    res.status(500).json({ error: { code: 'event_insert_failed' } });
    return;
  }

  // If the event is terminal, flip verification_status + stamp completed_at.
  if (status === 'verified' || status === 'rejected' || status === 'requires_input') {
    const verificationStatus =
      status === 'verified'
        ? 'VERIFIED'
        : status === 'rejected'
          ? 'REJECTED'
          : 'REQUIRES_INPUT';
    const { error: updErr } = await dbUntyped
      .from('organizations')
      .update({
        verification_status: verificationStatus,
        kyb_completed_at: new Date().toISOString(),
      })
      .eq('id', org.id);
    if (updErr) {
      logger.error({ updErr }, 'Failed to update org verification status');
      // A KYB outcome that cannot be written must stay retryable — releasing
      // the nonce is what makes the next delivery reprocess instead of being
      // dismissed as a duplicate. The kyb_events row already inserted above is
      // the durable record that the event arrived; the retry re-inserts it,
      // which is acceptable (append-only provider log, distinct row per
      // delivery) and strictly better than losing the transition.
      await releaseNonce('org_update_failed');
      res.status(500).json({ error: { code: 'org_update_failed' } });
      return;
    }
  }

  res.status(200).json({ ok: true });
});
