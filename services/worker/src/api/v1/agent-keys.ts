/**
 * One place that mints an agent-scoped API key (SCRUM-4494).
 *
 * `POST /agents/:agentId/key` (agents.ts) and ComputeID passport admission
 * both need the same sequence: generate → persist the HMAC hash only → audit
 * `AGENT_KEY_CREATED` → hand the raw key back exactly once. Keeping it here
 * means key-issuance audits by `event_type = 'AGENT_KEY_CREATED'` /
 * `target_type = 'api_key'` count passport-minted keys too.
 */
import { db } from '../../utils/db.js';
import { generateApiKey } from '../../middleware/apiKeyAuth.js';
import { recordAuditEvent } from '../../utils/auditEvent.js';

export interface MintAgentKeyArgs {
  hmacSecret: string;
  orgId: string;
  agentId: string;
  agentName: string;
  scopes: readonly string[];
  /** Human-readable key name shown in the dashboard. */
  keyName: string;
  /** `api_keys.created_by` (NOT NULL) and the audit actor — the authorizing principal. */
  createdBy: string;
  /** Extra sentence for the audit row (e.g. the passport that authorized the mint). */
  auditContext?: string;
}

export interface MintedAgentKey {
  raw: string;
  id: string;
  key_prefix: string;
  scopes: string[];
  created_at: string;
}

export async function mintAgentKey(args: MintAgentKeyArgs): Promise<{ key: MintedAgentKey } | { error: unknown }> {
  const { raw, hash, prefix } = generateApiKey(args.hmacSecret);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: key, error } = await (db as any)
    .from('api_keys')
    .insert({
      org_id: args.orgId,
      key_prefix: prefix,
      key_hash: hash,
      name: args.keyName,
      scopes: [...args.scopes],
      agent_id: args.agentId,
      created_by: args.createdBy,
    })
    .select('id, key_prefix, scopes, created_at')
    .single();
  if (error || !key) return { error: error ?? new Error('api_keys insert returned no row') };

  void recordAuditEvent({
    actor_id: args.createdBy,
    event_type: 'AGENT_KEY_CREATED',
    event_category: 'SYSTEM',
    target_type: 'api_key',
    target_id: key.id,
    org_id: args.orgId,
    details:
      `API key created for agent "${args.agentName}" with scopes: ${[...args.scopes].join(', ')}`
      + (args.auditContext ? `. ${args.auditContext}` : ''),
  });

  return { key: { raw, id: key.id, key_prefix: key.key_prefix, scopes: key.scopes, created_at: key.created_at } };
}
