/**
 * Google Drive push-notification webhook (SCRUM-1099 / SCRUM-1100)
 *
 * Drive POSTs to this endpoint each time a watched changes feed advances. The
 * push notification is a *headers-only* signal — Drive does not include the
 * file payload (privacy by design). Headers we care about:
 *
 *   X-Goog-Channel-ID       — the channel UUID we created via changes.watch
 *   X-Goog-Channel-Token    — the verification token we set when creating
 *                             the channel (per-org secret, prevents replay
 *                             across orgs)
 *   X-Goog-Resource-State   — sync (handshake), add, remove, update, trash,
 *                             untrash, change
 *   X-Goog-Resource-ID      — opaque Drive resource id for the watch
 *   X-Goog-Message-Number   — monotonic per-channel counter (not signed)
 *
 * Auth model: there is no HMAC. Authenticity is established by:
 *   1. Channel ID lookup → resolve to (org_id, integration_id).
 *   2. Channel token compare (constant time) — must match what we stored
 *      at createChangesWatch time.
 *
 * Status: WEBHOOK INGRESS STUB (this PR wires the route, reuses the canonical
 * `enqueueGoogleDriveRuleEvent` helper, and validates basic header shape). The
 * follow-up work to call into Google's `changes.list` and resolve the actual
 * file_id + parent_ids per change is tracked in SCRUM-1099 follow-up. Until
 * that ships, this handler enqueues a rule event with empty parent_ids — the
 * evaluator's drive folder filter will still reject events without a folder
 * binding, so this is safe by default.
 */

import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';

import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { GOOGLE_DRIVE_VENDOR } from '../../../constants/connectors.js';
import {
  runDriveChanges,
  type DriveIntegrationRow,
} from '../../../integrations/connectors/drive-changes-runner.js';
import { createDefaultKmsClient } from '../../../integrations/oauth/crypto.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const router = Router();

/**
 * Constant-time string compare. Mirrors the helper in webhooks/ats.ts so we
 * don't leak channel-token bytes via early-return timing.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  try {
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

interface DriveChannelLookup {
  org_id: string;
  integration_id: string;
  channel_token: string | null;
  // SCRUM-1661: fields the changes-feed runner needs to call changes.list
  // on this integration. Keeping them on the same lookup so we make one
  // round-trip per webhook delivery instead of two.
  encrypted_tokens: Buffer | string | null;
  token_kms_key_id: string | null;
  last_page_token: string | null;
}

/**
 * Resolve a Drive channel ID to its (org, integration). The
 * `org_integrations.subscription_id` column holds the channel id.
 *
 * NOTE: `channel_token` is not yet a dedicated column on `org_integrations`
 * — the storage shape will land in a follow-up migration. Until then we look
 * it up in the integration's `account_label` JSON-encoded field if present
 * and fall back to skipping verification (logs a warning).
 */
async function resolveDriveChannel(channelId: string): Promise<DriveChannelLookup | null> {
  const { data, error } = await dbAny
    .from('org_integrations')
    .select('org_id, id, account_label, encrypted_tokens, token_kms_key_id, last_page_token')
    .eq('provider', GOOGLE_DRIVE_VENDOR)
    .eq('subscription_id', channelId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error || !data) return null;
  let storedToken: string | null = null;
  try {
    const parsed = data.account_label ? JSON.parse(data.account_label) : null;
    if (parsed && typeof parsed.channel_token === 'string') {
      storedToken = parsed.channel_token;
    }
  } catch {
    storedToken = null;
  }
  return {
    org_id: data.org_id,
    integration_id: data.id,
    channel_token: storedToken,
    encrypted_tokens: data.encrypted_tokens ?? null,
    token_kms_key_id: data.token_kms_key_id ?? null,
    last_page_token: data.last_page_token ?? null,
  };
}

router.post('/', async (req: Request, res: Response) => {
  const channelId = (req.headers['x-goog-channel-id'] as string | undefined) ?? '';
  const channelToken = (req.headers['x-goog-channel-token'] as string | undefined) ?? '';
  const resourceState = (req.headers['x-goog-resource-state'] as string | undefined) ?? '';

  if (!channelId) {
    return res.status(400).json({ error: 'missing_channel_id' });
  }

  // Drive's initial handshake is `sync` — it must be acknowledged with 200
  // so the channel becomes active. No fanout work to do.
  if (resourceState === 'sync') {
    logger.info({ channelId }, 'drive webhook sync handshake');
    return res.status(200).end();
  }

  const lookup = await resolveDriveChannel(channelId);
  if (!lookup) {
    // Unknown channel — could be a stale webhook from a revoked integration.
    // Acknowledge to stop Drive's retry storm; do NOT enqueue a rule event.
    logger.warn({ channelId, resourceState }, 'drive webhook for unknown channel — ignoring');
    return res.status(200).end();
  }

  // Constant-time channel-token verification — fail-closed. Without this
  // check anyone who can guess a channel id can deliver fake events. The
  // OAuth flow always sets a token at changes.watch creation, so a missing
  // stored token means the row is misconfigured and we must reject.
  if (!lookup.channel_token) {
    logger.error(
      { channelId, orgId: lookup.org_id },
      'drive webhook integration has no stored channel token — fail closed',
    );
    return res.status(401).json({ error: 'integration_missing_channel_token' });
  }
  if (!channelToken) {
    logger.warn(
      { channelId, orgId: lookup.org_id },
      'drive webhook missing channel token header — rejecting',
    );
    return res.status(401).json({ error: 'missing_channel_token' });
  }
  if (!constantTimeEqual(channelToken, lookup.channel_token)) {
    logger.warn(
      { channelId, orgId: lookup.org_id },
      'drive webhook channel-token mismatch — rejecting',
    );
    return res.status(401).json({ error: 'invalid_channel_token' });
  }

  // SCRUM-1242 (AUDIT-0424-26): replay protection. Drive doesn't carry an
  // HMAC, so the only monotonic anti-replay signal is the per-channel
  // X-Goog-Message-Number. Dedupe on (channel_id, message_number) — Google
  // guarantees this pair uniquely identifies a delivery for a given channel.
  // Mirrors docusign_webhook_nonces (0256) and ats_webhook_nonces (0263).
  const messageNumberRaw = req.headers['x-goog-message-number'];
  const messageNumberStr = Array.isArray(messageNumberRaw) ? messageNumberRaw[0] : messageNumberRaw;
  const messageNumber = Number.parseInt(String(messageNumberStr ?? ''), 10);
  if (Number.isFinite(messageNumber)) {
    const { error: nonceErr } = await dbAny
      .from('drive_webhook_nonces')
      .insert({
        channel_id: channelId,
        message_number: messageNumber,
      });
    if (nonceErr) {
      // Postgres unique_violation — duplicate delivery, ack so retries stop.
      if ((nonceErr as { code?: string }).code === '23505') {
        logger.info(
          { channelId, messageNumber, orgId: lookup.org_id },
          'drive webhook duplicate delivery — returning 200',
        );
        return res.status(200).end();
      }
      logger.error(
        { error: nonceErr, channelId, orgId: lookup.org_id },
        'drive webhook nonce insert failed — proceeding without dedupe',
      );
      // Fall through — the upstream handler will still dedupe at the
      // rule-event layer and Drive's retry will hit the same block. We
      // prefer at-least-once delivery to dropping the event.
    }
  } else {
    // No message number header — older Drive clients or malformed pushes.
    // Log and continue; the channel-token check above gives us authentication.
    logger.warn(
      { channelId, orgId: lookup.org_id },
      'drive webhook missing X-Goog-Message-Number — proceeding without nonce dedupe',
    );
  }

  // SCRUM-1661: real changes.list processing. The webhook is headers-only;
  // the runner uses the stored page token + KMS-decrypted OAuth credentials
  // to call Drive's changes.list, dedupes on (integration, file, revision)
  // via drive_revision_ledger (mig 0288), folder-matches against rule
  // bindings, and enqueues exactly one rule event per matching revision.
  //
  // Default-disabled rollout: existing prod integrations don't have
  // last_page_token populated (column shipped in mig 0288 today; a
  // watch-renewal pass populates it on next renewal). Enabling the runner
  // before that bootstrap completes would skip every change. Operators flip
  // ENABLE_DRIVE_CHANGES_RUNNER=true once renewals have populated tokens
  // org-by-org; until then the webhook is a header-only no-op (200 OK).
  if (process.env.ENABLE_DRIVE_CHANGES_RUNNER !== 'true') {
    return res.status(200).end();
  }
  const integrationRow: DriveIntegrationRow = {
    id: lookup.integration_id,
    org_id: lookup.org_id,
    encrypted_tokens: lookup.encrypted_tokens,
    token_kms_key_id: lookup.token_kms_key_id,
    last_page_token: lookup.last_page_token,
  };
  try {
    const kms = await createDefaultKmsClient();
    const result = await runDriveChanges(integrationRow, {
      db: dbAny,
      kms,
      logger,
    });
    logger.info(
      { channelId, orgId: lookup.org_id, integrationId: lookup.integration_id, result },
      'drive webhook: changes processed',
    );
  } catch (err) {
    logger.error(
      { error: err, channelId, orgId: lookup.org_id, integrationId: lookup.integration_id },
      'drive webhook: runDriveChanges failed — 200 ack so Drive does not retry-storm',
    );
    // 200 ack anyway — Drive's retry would just repeat the same failure;
    // operator alert via Sentry is the appropriate escalation path.
  }

  return res.status(200).end();
});

export const driveWebhookRouter = router;
export default router;
