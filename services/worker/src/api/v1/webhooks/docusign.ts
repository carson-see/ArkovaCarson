/**
 * DocuSign Connect webhook handler (SCRUM-1101 / SCRUM-1872).
 *
 * Receives HMAC-verified `envelope-completed` events, resolves the connected
 * org integration by DocuSign account id, and queues both:
 *   1. a sanitized rules-engine event (`ESIGN_COMPLETED`)
 *   2. a retryable document-fetch job for the signed envelope
 *   3. (SCRUM-1872) if notary data is present, a `docusign.notarization_completed` job
 *
 * Raw Connect payloads and signed documents are never persisted here.
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { submitJob } from '../../../utils/jobQueue.js';
import { DOCUSIGN_ENVELOPE_COMPLETED_JOB_TYPE } from '../../../jobs/docusign-envelope-completed.js';
import { DOCUSIGN_NOTARIZATION_COMPLETED_JOB_TYPE } from '../../../jobs/docusign-notarization-completed.js';
import { adaptDocusign } from '../../../integrations/connectors/adapters.js';
import {
  parseDocusignConnectPayload,
  type DocusignCompletedEnvelope,
} from '../../../integrations/oauth/docusign.js';
import {
  verifyDocusignConnectHmacMultiKey,
  extractDocusignSignatures,
} from '../../../integrations/oauth/docusign-hmac.js';
import { resolveHmacKeys, type HmacKeyEntry } from './docusign-hmac-helpers.js';

export const docusignWebhookRouter = Router();

interface DocusignIntegrationRow {
  id: string;
  org_id: string;
  account_id: string | null;
  hmac_keys: HmacKeyEntry[] | null;
}

interface DocusignNonceKey {
  envelope_id: string;
  event_id: string;
  generated_at: string;
}

function getRawBody(req: Request): Buffer | null {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? req.body;
  return Buffer.isBuffer(rawBody) ? rawBody : null;
}

/**
 * SCRUM-2044: Dual-table integration lookup.
 *
 * Resolution order (per spec):
 *   1. org_integrations by account_id — org-level takes precedence
 *   2. member_integrations by account_id — fallback for personal accounts
 *
 * Same ambiguity guard applies to both tables: if the same account_id
 * appears in multiple orgs within a table, reject to prevent cross-tenant leak.
 */
async function findIntegration(accountId: string): Promise<DocusignIntegrationRow | null> {
  // Step 1: Check org_integrations first (existing behavior, org-level wins)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- webhook ingress: resolving org from external provider ID
  const { data: orgData, error: orgError } = await (db as any)
    .from('org_integrations')
    .select('id, org_id, account_id, hmac_keys')
    .eq('provider', 'docusign')
    .eq('account_id', accountId)
    .is('revoked_at', null);

  if (orgError) {
    logger.error({ error: orgError, accountId }, 'DocuSign webhook org integration lookup failed');
    throw new Error('integration_lookup_failed');
  }

  const orgRows = orgData as DocusignIntegrationRow[] | null;
  if (orgRows && orgRows.length > 1) {
    logger.error(
      { accountId, orgIds: orgRows.map(r => r.org_id) },
      'DocuSign webhook: ambiguous org lookup — same accountId connected to multiple orgs, rejecting to prevent cross-tenant leak',
    );
    throw new Error('ambiguous_integration_lookup');
  }

  if (orgRows && orgRows.length === 1) {
    return orgRows[0];
  }

  // Step 2: Fall back to member_integrations (SCRUM-2044)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webhook ingress: resolving org from external provider ID
  const { data: memberData, error: memberError } = await (db as any)
    .from('member_integrations')
    .select('id, org_id, account_id, hmac_keys')
    .eq('provider', 'docusign')
    .eq('account_id', accountId)
    .is('revoked_at', null);

  if (memberError) {
    logger.error({ error: memberError, accountId }, 'DocuSign webhook member integration lookup failed');
    throw new Error('integration_lookup_failed');
  }

  const memberRows = memberData as DocusignIntegrationRow[] | null;
  if (!memberRows || memberRows.length === 0) return null;

  if (memberRows.length > 1) {
    logger.error(
      { accountId, orgIds: memberRows.map(r => r.org_id) },
      'DocuSign webhook: ambiguous member lookup — same accountId connected across multiple orgs, rejecting to prevent cross-tenant leak',
    );
    throw new Error('ambiguous_integration_lookup');
  }

  return memberRows[0];
}

async function enqueueRuleEvent(args: {
  integration: DocusignIntegrationRow;
  event: DocusignCompletedEnvelope;
  payloadHash: string;
}): Promise<string> {
  const canonical = adaptDocusign(args.event, { org_id: args.integration.org_id });
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
      source: 'docusign_connect',
      integration_id: args.integration.id,
      account_id: args.event.accountId,
      envelope_id: args.event.envelopeId,
      document_ids: args.event.envelopeDocuments.map((doc) => doc.documentId),
      generated_at: args.event.generatedDateTime ?? null,
      payload_hash: args.payloadHash,
    },
  });

  if (error || !data) {
    logger.error({ error, integrationId: args.integration.id }, 'DocuSign rule-event enqueue failed');
    throw new Error('rule_event_enqueue_failed');
  }

  return String(data);
}

async function enqueueFetchJob(args: {
  integration: DocusignIntegrationRow;
  event: DocusignCompletedEnvelope;
  ruleEventId: string;
}): Promise<string> {
  const jobId = await submitJob({
    type: DOCUSIGN_ENVELOPE_COMPLETED_JOB_TYPE,
    max_attempts: 5,
    priority: 10,
    payload: {
      org_id: args.integration.org_id,
      integration_id: args.integration.id,
      account_id: args.event.accountId,
      envelope_id: args.event.envelopeId,
      rule_event_id: args.ruleEventId,
      document_ids: args.event.envelopeDocuments.map((doc) => doc.documentId),
    },
  });
  if (!jobId) {
    logger.error({ integrationId: args.integration.id }, 'DocuSign document-fetch job enqueue failed');
    throw new Error('document_job_enqueue_failed');
  }
  return jobId;
}

function nonceKeyForEvent(event: DocusignCompletedEnvelope, payloadHash: string): DocusignNonceKey {
  return {
    envelope_id: event.envelopeId,
    event_id: event.eventId ?? event.event,
    generated_at: event.generatedDateTime ?? payloadHash,
  };
}

async function rollbackNonceAfterEnqueueFailure(nonceKey: DocusignNonceKey): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- webhook replay marker rollback scoped by nonce unique key
  const { error } = await (db as any)
    .from('docusign_webhook_nonces')
    .delete()
    .match(nonceKey);

  if (error) {
    logger.error(
      { error, envelopeId: nonceKey.envelope_id, eventId: nonceKey.event_id },
      'DocuSign webhook: nonce rollback failed after enqueue failure',
    );
    throw new Error('nonce_rollback_failed');
  }
}

async function dlqInsert(args: {
  reason: string;
  externalId: string | null;
  payloadHash: string;
}): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webhook_dlq is migration-owned and not present in generated Supabase types yet
    const { error } = await (db as any).from('webhook_dlq').insert({
      provider: 'docusign',
      reason: args.reason.slice(0, 500),
      external_id: args.externalId,
      payload_hash: args.payloadHash,
    });
    if (error) {
      logger.warn({ error }, 'DocuSign webhook: DLQ insert failed (non-fatal)');
    }
  } catch (err) {
    logger.warn({ error: err }, 'DocuSign webhook: DLQ insert threw (non-fatal)');
  }
}

// ── SCRUM-1872: Notary data extraction ──────────────────────────────

export interface NotaryData {
  notary_name: string | null;
  notary_commission_state: string | null;
  notary_commission_number: string | null;
  notarization_completed_at: string;
}

/**
 * Extract notary metadata from a DocuSign Connect raw payload.
 *
 * DocuSign Notary embeds notary signer info in the envelope's recipients.
 * The notary appears as a recipient with `recipientType: 'notary'` or
 * `roleName` containing 'notary'. Returns null if no notary data found.
 */
export function extractNotaryData(rawBody: Buffer | string): NotaryData | null {
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const json = JSON.parse(text) as Record<string, unknown>;

    // Check for notary recipients in the envelope summary
    const summary = (json.envelopeSummary ?? json.data ?? json) as Record<string, unknown>;
    const recipients = summary.recipients as Record<string, unknown> | undefined;

    if (!recipients) return null;

    // DocuSign groups recipients by type: signers[], notaries[], inPersonSigners[], etc.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notaries = (recipients as any).notaries as Array<Record<string, unknown>> | undefined;
    // Also check signers for recipientType === 'notary'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signers = (recipients as any).signers as Array<Record<string, unknown>> | undefined;

    let notaryInfo: Record<string, unknown> | null = null;

    if (notaries && notaries.length > 0) {
      notaryInfo = notaries[0];
    } else if (signers) {
      const notarySigner = signers.find(
        (s) =>
          String(s.recipientType ?? '').toLowerCase() === 'notary' ||
          String(s.roleName ?? '').toLowerCase().includes('notary'),
      );
      if (notarySigner) notaryInfo = notarySigner;
    }

    if (!notaryInfo) return null;

    const name = typeof notaryInfo.name === 'string' ? notaryInfo.name.trim() : null;
    const commState =
      typeof notaryInfo.notaryCommissionState === 'string'
        ? notaryInfo.notaryCommissionState.trim()
        : typeof notaryInfo.jurisdiction === 'string'
          ? notaryInfo.jurisdiction.trim()
          : null;
    const commNumber =
      typeof notaryInfo.notaryCommissionNumber === 'string'
        ? notaryInfo.notaryCommissionNumber.trim()
        : typeof notaryInfo.commissionNumber === 'string'
          ? notaryInfo.commissionNumber.trim()
          : null;

    // Use completedDateTime from the notary or fall back to the envelope generatedDateTime
    const completedAt =
      typeof notaryInfo.completedDateTime === 'string'
        ? notaryInfo.completedDateTime
        : typeof (summary as Record<string, unknown>).completedDateTime === 'string'
          ? (summary as Record<string, unknown>).completedDateTime as string
          : new Date().toISOString();

    return {
      notary_name: name || null,
      notary_commission_state: commState || null,
      notary_commission_number: commNumber || null,
      notarization_completed_at: completedAt,
    };
  } catch {
    return null;
  }
}

/**
 * SCRUM-1872: Enqueue notarization job if notary data is present.
 * Non-fatal — failure here does not block the standard eSign flow.
 */
async function enqueueNotarizationJob(args: {
  integration: DocusignIntegrationRow;
  event: DocusignCompletedEnvelope;
  ruleEventId: string;
  notaryData: NotaryData;
}): Promise<string | null> {
  try {
    const jobId = await submitJob({
      type: DOCUSIGN_NOTARIZATION_COMPLETED_JOB_TYPE,
      max_attempts: 5,
      priority: 10,
      payload: {
        org_id: args.integration.org_id,
        integration_id: args.integration.id,
        account_id: args.event.accountId,
        envelope_id: args.event.envelopeId,
        rule_event_id: args.ruleEventId,
        notary_name: args.notaryData.notary_name,
        notary_commission_state: args.notaryData.notary_commission_state,
        notary_commission_number: args.notaryData.notary_commission_number,
        notarization_completed_at: args.notaryData.notarization_completed_at,
      },
    });
    if (jobId) {
      logger.info(
        { envelopeId: args.event.envelopeId, notarizationJobId: jobId },
        'DocuSign notarization job enqueued',
      );
    }
    return jobId;
  } catch (err) {
    logger.warn(
      { error: err, envelopeId: args.event.envelopeId },
      'DocuSign notarization job enqueue failed — non-fatal',
    );
    return null;
  }
}

docusignWebhookRouter.post('/', async (req: Request, res: Response) => {
  const rawBody = getRawBody(req);
  if (!rawBody) {
    logger.error({ path: req.path }, 'DocuSign webhook: rawBody missing — raw parser must be mounted');
    res.status(500).json({ error: { code: 'misconfigured_raw_body' } });
    return;
  }

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  // SCRUM-2043: lookup-first order — parse body to get accountId, then
  // resolve integration (+ per-org HMAC keys), then verify HMAC.
  let event: DocusignCompletedEnvelope;
  try {
    event = parseDocusignConnectPayload(rawBody);
  } catch (err) {
    // Return 401 (not 400) to prevent oracle: attackers must not distinguish
    // parse failure from HMAC failure (P0 review finding 2026-05-28).
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'DocuSign webhook: malformed body');
    res.status(401).json({ error: { code: 'invalid_signature' } });
    return;
  }

  try {
    const integration = await findIntegration(event.accountId);
    if (!integration) {
      // Unknown account — verify HMAC with env-var key before acking.
      // Without this, an attacker can probe which accounts are connected
      // by comparing response codes for known vs unknown account IDs.
      const envKey = process.env.DOCUSIGN_CONNECT_HMAC_SECRET;
      if (!envKey) {
        logger.error('DocuSign webhook: unknown account and no env HMAC key — cannot verify');
        res.status(503).json({ error: { code: 'webhook_unconfigured' } });
        return;
      }
      const orphanSigs = extractDocusignSignatures(req.headers as Record<string, string | string[] | undefined>);
      if (!verifyDocusignConnectHmacMultiKey({ rawBody, signatures: orphanSigs, keys: [envKey] })) {
        res.status(401).json({ error: { code: 'invalid_signature' } });
        return;
      }
      logger.warn({ accountId: event.accountId }, 'DocuSign webhook: unknown connected account');
      res.status(200).json({ ok: true, orphaned: true });
      return;
    }

    // SCRUM-2043: resolve HMAC keys — per-org keys take priority, env var is fallback
    const hmacKeys = resolveHmacKeys(
      integration.hmac_keys,
      process.env.DOCUSIGN_CONNECT_HMAC_SECRET,
    );
    if (hmacKeys.length === 0) {
      logger.error({ integrationId: integration.id }, 'No HMAC keys configured — webhook rejected');
      res.status(503).json({ error: { code: 'webhook_unconfigured' } });
      return;
    }

    const signatures = extractDocusignSignatures(req.headers as Record<string, string | string[] | undefined>);
    if (!verifyDocusignConnectHmacMultiKey({ rawBody, signatures, keys: hmacKeys })) {
      res.status(401).json({ error: { code: 'invalid_signature' } });
      return;
    }

    // Replay protection: dedupe on (envelope_id, event_id, generated_at).
    // DocuSign retries on any non-2xx response, so a duplicate must return
    // 200 to stop the retry loop. Migration 0256 creates the nonce table.
    const nonceKey = nonceKeyForEvent(event, payloadHash);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- webhook replay marker write has no tenant key; nonce tuple prevents duplicate provider delivery
    const { error: nonceErr } = await (db as any).from('docusign_webhook_nonces').insert(nonceKey);
    if (nonceErr) {
      // Postgres unique_violation — duplicate delivery, ack so retries stop.
      if ((nonceErr as { code?: string }).code === '23505') {
        logger.info(
          { envelopeId: event.envelopeId, eventId: event.eventId },
          'DocuSign webhook: duplicate delivery — returning 200',
        );
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      logger.error(
        { error: nonceErr, envelopeId: event.envelopeId },
        'DocuSign webhook: nonce insert failed',
      );
      res.status(500).json({ error: { code: 'nonce_insert_failed' } });
      return;
    }

    let ruleEventId: string | null = null;
    try {
      ruleEventId = await enqueueRuleEvent({ integration, event, payloadHash });
      await enqueueFetchJob({ integration, event, ruleEventId });

      // SCRUM-1872: Check for notary data and enqueue notarization job (non-fatal)
      const notaryData = extractNotaryData(rawBody);
      if (notaryData) {
        await enqueueNotarizationJob({
          integration,
          event,
          ruleEventId,
          notaryData,
        });
      }
    } catch (enqueueErr) {
      await rollbackNonceAfterEnqueueFailure(nonceKey);
      throw enqueueErr;
    }
    res.status(202).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unexpected';
    logger.error({ error: err, accountId: event.accountId }, 'DocuSign webhook processing failed');
    await dlqInsert({ reason: message, externalId: event.envelopeId, payloadHash });
    res.status(500).json({ error: { code: 'webhook_processing_failed' } });
  }
});
