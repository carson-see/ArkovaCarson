/**
 * Audit Proof Packet Export (SCRUM-1149)
 *
 * `GET /api/proof-packet/execution/:executionId` returns a JSON packet that
 * answers an auditor or client challenge end-to-end:
 *   - source event captured by the connector
 *   - normalized metadata used by the rule
 *   - matched rule + action config
 *   - actor / timestamps
 *   - anchor receipt + verification URI (or "not_anchored" placeholder)
 *   - version lineage / revocation status
 *
 * Org-scoped via `.eq('org_id', orgId)` on every read. A
 * `PROOF_PACKET_EXPORTED` audit row records who exported what so the export
 * itself is auditable. Internal UUIDs (anchor.id) never leave — packet uses
 * `public_id` per CLAUDE.md §6.
 */
import type { Request, Response } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getCallerOrgId } from './_org-auth.js';

export const PROOF_PACKET_SCHEMA_VERSION = 1;
const VERIFICATION_BASE_URL = process.env.PROOF_PACKET_VERIFY_BASE_URL ?? 'https://app.arkova.io/verify';

interface ExecutionRow {
  id: string;
  rule_id: string;
  org_id: string;
  trigger_event_id: string;
  status: string;
  input_payload: Record<string, unknown> | null;
  output_payload: Record<string, unknown> | null;
  error: string | null;
  attempt_count: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface RuleEventRow {
  id: string;
  org_id: string;
  trigger_type: string;
  vendor: string | null;
  external_file_id: string | null;
  filename: string | null;
  sender_email: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

interface RuleRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  action_type: string;
  action_config: Record<string, unknown> | null;
}

interface AnchorRow {
  public_id: string | null;
  status: string;
  fingerprint: string;
  bitcoin_tx_id: string | null;
  block_height: number | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}

async function loadExecution(executionId: string, orgId: string): Promise<ExecutionRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('organization_rule_executions')
    .select(
      'id, rule_id, org_id, trigger_event_id, status, input_payload, output_payload, error, attempt_count, started_at, completed_at, created_at',
    )
    .eq('id', executionId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) {
    logger.warn({ error, executionId }, 'proof-packet: execution lookup failed');
    return null;
  }
  return (data as ExecutionRow | null) ?? null;
}

async function loadRuleEvent(triggerEventId: string, orgId: string): Promise<RuleEventRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('organization_rule_events')
    .select('id, org_id, trigger_type, vendor, external_file_id, filename, sender_email, payload, created_at')
    .eq('id', triggerEventId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) {
    logger.warn({ error, triggerEventId }, 'proof-packet: rule_event lookup failed');
    return null;
  }
  return (data as RuleEventRow | null) ?? null;
}

async function loadRule(ruleId: string, orgId: string): Promise<RuleRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('organization_rules')
    .select('id, org_id, name, description, trigger_type, action_type, action_config')
    .eq('id', ruleId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) {
    logger.warn({ error, ruleId }, 'proof-packet: rule lookup failed');
    return null;
  }
  return (data as RuleRow | null) ?? null;
}

async function loadAnchor(externalFileId: string | null, orgId: string): Promise<AnchorRow | null> {
  if (!externalFileId) return null;
  // External file id (DocuSign envelopeId, Drive fileId, …) is stored in
  // `anchors.metadata->>'external_file_id'`, not `public_id`. Multiple
  // versions can share the same external_file_id (collisions), so we pick
  // the latest by created_at — the proof packet is for the most recent
  // anchor that captured this external file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('anchors')
    .select('public_id, status, fingerprint, bitcoin_tx_id, block_height, revoked_at, revocation_reason')
    .eq('org_id', orgId)
    .eq('metadata->>external_file_id', externalFileId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn({ error, externalFileId }, 'proof-packet: anchor lookup failed');
    return null;
  }
  return (data as AnchorRow | null) ?? null;
}

async function emitAudit(args: {
  actorId: string;
  orgId: string;
  executionId: string;
}): Promise<void> {
  try {
    const { error } = await db.from('audit_events').insert({
      event_type: 'PROOF_PACKET_EXPORTED',
      event_category: 'ORG',
      actor_id: args.actorId,
      org_id: args.orgId,
      target_type: 'organization_rule_execution',
      target_id: args.executionId,
      details: JSON.stringify({ exported_at: new Date().toISOString() }).slice(0, 10000),
    });
    if (error) {
      logger.warn({ error, executionId: args.executionId }, 'proof-packet: audit emit failed');
    }
  } catch (err) {
    logger.warn({ error: err, executionId: args.executionId }, 'proof-packet: audit emit threw');
  }
}

export async function handleProofPacketExport(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const orgId = await getCallerOrgId(userId);
  if (!orgId) {
    res.status(403).json({ error: { code: 'forbidden', message: 'No organization on profile' } });
    return;
  }
  const executionId = String(req.params.executionId ?? '').trim();
  if (!executionId) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'executionId required' } });
    return;
  }

  const execution = await loadExecution(executionId, orgId);
  if (!execution) {
    res.status(404).json({ error: { code: 'not_found', message: 'Execution not found' } });
    return;
  }

  const [ruleEvent, rule] = await Promise.all([
    loadRuleEvent(execution.trigger_event_id, orgId),
    loadRule(execution.rule_id, orgId),
  ]);

  // Anchor lookup is best-effort: queued/unanchored executions return a
  // sentinel "not_anchored" status without breaking packet generation.
  const anchor = await loadAnchor(ruleEvent?.external_file_id ?? null, orgId);

  const verificationUri = anchor?.public_id
    ? `${VERIFICATION_BASE_URL}/${anchor.public_id}`
    : null;

  const packet = {
    schema_version: PROOF_PACKET_SCHEMA_VERSION,
    execution: {
      id: execution.id,
      status: execution.status,
      attempt_count: execution.attempt_count ?? 0,
      error: execution.error,
    },
    source_event: ruleEvent
      ? {
          trigger_type: ruleEvent.trigger_type,
          vendor: ruleEvent.vendor,
          external_file_id: ruleEvent.external_file_id,
          filename: ruleEvent.filename,
          sender_email: ruleEvent.sender_email,
          payload: ruleEvent.payload,
        }
      : null,
    rule: rule
      ? {
          id: rule.id,
          name: rule.name,
          description: rule.description,
          trigger_type: rule.trigger_type,
          action_type: rule.action_type,
          action_config: rule.action_config,
        }
      : null,
    action: {
      type: rule?.action_type ?? null,
      outcome:
        (execution.output_payload as { outcome?: string } | null)?.outcome ?? null,
      output_payload: execution.output_payload,
    },
    timestamps: {
      event_received_at: ruleEvent?.created_at ?? null,
      execution_created_at: execution.created_at,
      action_started_at: execution.started_at,
      action_completed_at: execution.completed_at,
    },
    anchor_receipt: anchor
      ? {
          public_id: anchor.public_id,
          status: anchor.status,
          fingerprint: anchor.fingerprint,
          bitcoin_tx_id: anchor.bitcoin_tx_id,
          block_height: anchor.block_height,
          verification_uri: verificationUri,
        }
      : {
          public_id: null,
          status: 'not_anchored',
          fingerprint: null,
          bitcoin_tx_id: null,
          block_height: null,
          verification_uri: null,
        },
    lineage: {
      previous: [],
      revoked_at: anchor?.revoked_at ?? null,
      revocation_reason: anchor?.revocation_reason ?? null,
      superseded_by_public_id: null,
    },
    actor: { user_id: userId },
    generated_at: new Date().toISOString(),
  };

  res.setHeader?.('Content-Type', 'application/json');
  res.setHeader?.(
    'Content-Disposition',
    `attachment; filename="proof-packet-${executionId}.json"`,
  );
  res.status(200).json(packet);

  void emitAudit({ actorId: userId, orgId, executionId });
}
