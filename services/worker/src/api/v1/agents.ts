/**
 * Agent Identity & Delegation API (PH2-AGENT-05)
 *
 * POST   /api/v1/agents              — Register a new agent
 * GET    /api/v1/agents              — List org's agents
 * GET    /api/v1/agents/:agentId     — Get agent details
 * PATCH  /api/v1/agents/:agentId     — Update agent (name, status, scopes)
 * DELETE /api/v1/agents/:agentId     — Revoke and delete agent
 * POST   /api/v1/agents/:agentId/key — Generate API key scoped to this agent
 *
 * Agents are organizational entities that represent AI systems, integrations,
 * or automated workflows that interact with Arkova's verification API.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { generateApiKey } from '../../middleware/apiKeyAuth.js';
import { API_KEY_SCOPES, scopeSatisfies } from '../apiScopes.js';
import { recordAuditEvent } from '../../utils/auditEvent.js';
import { PASSPORT_AGENT_SCOPE_ALLOWLIST } from './agentScopePolicy.js';

// agents table not yet in database.types.ts — use untyped client
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

/**
 * SCRUM-1271-A — strip internal-actor UUIDs from outbound responses.
 *
 * `registered_by` is a `auth.users(id)` FK; `org_id` is `organizations(id)`.
 * Both are CLAUDE.md §6 banned in customer-facing payloads. The agent row's
 * own `id` is retained because v1 is frozen per §1.8 and the rename to
 * `public_id` is being staged in v2 under SCRUM-1271-B. Adding the column
 * itself is also tracked there so the migration ships once.
 */
export function toPublicAgent<T extends Record<string, unknown>>(row: T | null | undefined): Partial<T> {
  if (!row) return {};
  const sanitized = { ...row };
  delete (sanitized as Record<string, unknown>).org_id;
  delete (sanitized as Record<string, unknown>).registered_by;
  return sanitized;
}

type AgentLifecycleCaller =
  | { kind: 'user'; userId: string; orgId: string; role: string; ownerUserId: string }
  | { kind: 'api_key'; apiKeyId: string; keyPrefix: string; orgId: string; scopes: string[]; ownerUserId: string };

async function resolveCaller(
  req: Request,
  res: Response,
  opts: { requireAdmin?: boolean; emptyOnMissingOrg?: boolean; adminError?: string } = {},
): Promise<AgentLifecycleCaller | null> {
  if (req.apiKey && req.authUserId) {
    res.status(409).json({ error: 'ambiguous_caller' });
    return null;
  }
  if (req.apiKey) {
    if (!scopeSatisfies(req.apiKey.scopes ?? [], 'agents:manage')) {
      res.status(403).json({ error: 'insufficient_scope', required: 'agents:manage' });
      return null;
    }
    return {
      kind: 'api_key', apiKeyId: req.apiKey.keyId, keyPrefix: req.apiKey.keyPrefix,
      orgId: req.apiKey.orgId, scopes: req.apiKey.scopes ?? [], ownerUserId: req.apiKey.userId,
    };
  }
  const userId = req.authUserId;
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return null; }
  let profile: { org_id: string | null; role: string | null } | null;
  try {
    ({ data: profile } = await db.from('profiles').select('org_id, role').eq('id', userId).single());
  } catch (error) {
    logger.error({ error }, 'Agent lifecycle caller lookup failed');
    res.status(500).json({ error: 'Internal server error' });
    return null;
  }
  if (!profile?.org_id) {
    if (opts.emptyOnMissingOrg) res.status(200).json({ agents: [] });
    else res.status(403).json({ error: 'Organization membership required' });
    return null;
  }
  if (opts.requireAdmin && profile.role !== 'ORG_ADMIN') {
    res.status(403).json({ error: opts.adminError ?? "Only organization admins can change an agent's status" });
    return null;
  }
  return { kind: 'user', userId, orgId: profile.org_id, role: profile.role ?? '', ownerUserId: userId };
}

function callerAudit(caller: AgentLifecycleCaller): { actor_id: string | null; details: Record<string, string> } {
  return caller.kind === 'user'
    ? { actor_id: caller.userId, details: { actor_kind: 'user', actor_user_id: caller.userId } }
    : { actor_id: null, details: { actor_kind: 'api_key', actor_api_key_id: caller.apiKeyId, actor_key_prefix: caller.keyPrefix } };
}

function missingDelegatedScopes(caller: AgentLifecycleCaller, scopes: string[]): string[] {
  if (caller.kind === 'user') return [];
  return scopes.filter((required) => !scopeSatisfies(caller.scopes, required));
}

/** Helper: verify agent belongs to caller's org */
async function verifyAgentOwnership(agentId: string, orgId: string, res: Response): Promise<Record<string, unknown> | null> {
  const { data: agent, error } = await dbAny
    .from('agents')
    .select('*')
    .eq('id', agentId)
    .eq('org_id', orgId)
    .single();
  if (error || !agent) {
    res.status(404).json({ error: 'Agent not found' });
    return null;
  }
  return agent;
}

const router = Router();

export const AGENT_ALLOWED_SCOPES = API_KEY_SCOPES;
export const VALID_AGENT_TYPES = ['llm_agent', 'ats_integration', 'hr_platform', 'compliance_tool', 'custom'] as const;

export const CreateAgentSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  agent_type: z.enum(VALID_AGENT_TYPES).default('custom'),
  allowed_scopes: z.array(z.enum(AGENT_ALLOWED_SCOPES)).min(1).default(['verify']),
  framework: z.string().max(100).optional(),
  version: z.string().max(50).optional(),
  callback_url: z.string().url().startsWith('https://').optional(),
  metadata: z.record(z.string(), z.unknown()).refine((value) => !Object.hasOwn(value, 'computeid'), { message: 'metadata.computeid is provider-managed' }).optional(),
});

export const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  allowed_scopes: z.array(z.enum(AGENT_ALLOWED_SCOPES)).min(1).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  framework: z.string().max(100).optional(),
  version: z.string().max(50).optional(),
  callback_url: z.string().url().startsWith('https://').nullable().optional(),
});

// ─── POST /api/v1/agents — Register a new agent ─────────────────

router.post('/', async (req: Request, res: Response) => {
  const caller = await resolveCaller(req, res, { requireAdmin: true, adminError: 'Only organization admins can register agents' });
  if (!caller) return;

  const parsed = CreateAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  try {
    const missing = missingDelegatedScopes(caller, parsed.data.allowed_scopes);
    if (missing.length) { res.status(403).json({ error: 'delegation_scope_exceeded', missing }); return; }

    const { data: agent, error } = await dbAny.from('agents').insert({
      org_id: caller.orgId,
      registered_by: caller.ownerUserId,
      ...parsed.data,
    }).select().single();

    if (error) {
      logger.error({ error }, 'Failed to create agent');
      res.status(500).json({ error: 'Failed to create agent' });
      return;
    }

    // Audit event
    void recordAuditEvent({
      actor_id: callerAudit(caller).actor_id,
      event_type: 'AGENT_REGISTERED',
      event_category: 'SYSTEM',
      target_type: 'agent',
      target_id: agent.id,
      org_id: caller.orgId,
      details: JSON.stringify({ ...callerAudit(caller).details, name: parsed.data.name, agent_type: parsed.data.agent_type }),
    });

    logger.info({ agentId: agent.id, name: parsed.data.name, type: parsed.data.agent_type }, 'Agent registered');
    res.status(201).json(toPublicAgent(agent));
  } catch (err) {
    logger.error({ error: err }, 'Agent registration failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/v1/agents — List org's agents ──────────────────────

router.get('/', async (req: Request, res: Response) => {
  const caller = await resolveCaller(req, res, { emptyOnMissingOrg: true });
  if (!caller) return;

  try {
    const { data: agents, error } = await dbAny
      .from('agents')
      .select('*')
      .eq('org_id', caller.orgId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error({ error }, 'Failed to list agents');
      res.status(500).json({ error: 'Failed to list agents' });
      return;
    }

    res.json({ agents: (agents ?? []).map(toPublicAgent) });
  } catch (err) {
    logger.error({ error: err }, 'Agent list failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/v1/agents/:agentId — Get agent details ────────────

router.get('/:agentId', async (req: Request<{ agentId: string }>, res: Response) => {
  const caller = await resolveCaller(req, res);
  if (!caller) return;
  const { agentId } = req.params;

  try {
    const orgId = caller.orgId;

    const agent = await verifyAgentOwnership(agentId, orgId, res);
    if (!agent) return;

    // Also fetch API keys associated with this agent. Same defense-in-depth
    // org_id filter as the revoke path: prevents a hypothetical agent_id
    // collision from returning another tenant's keys via service_role.
    const { data: keys } = await dbAny
      .from('api_keys')
      .select('id, name, key_prefix, scopes, is_active, last_used_at, created_at, expires_at')
      .eq('agent_id', agentId)
      .eq('org_id', orgId)
      .eq('is_active', true);

    res.json({ ...toPublicAgent(agent), api_keys: keys ?? [] });
  } catch (err) {
    logger.error({ error: err }, 'Agent lookup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /api/v1/agents/:agentId — Update agent ───────────────

router.patch('/:agentId', async (req: Request<{ agentId: string }>, res: Response) => {
  const caller = await resolveCaller(req, res, { requireAdmin: true });
  if (!caller) return;
  const { agentId } = req.params;
  const parsed = UpdateAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  try {
    const orgId = caller.orgId;

    if (parsed.data.allowed_scopes) {
      const missing = missingDelegatedScopes(caller, parsed.data.allowed_scopes);
      if (missing.length) { res.status(403).json({ error: 'delegation_scope_exceeded', missing }); return; }
    }

    // Verify ownership before updating
    const existing = await verifyAgentOwnership(agentId, orgId, res);
    if (!existing) return;

    const existingMetadata = typeof existing.metadata === 'object' && existing.metadata !== null
      ? existing.metadata as Record<string, unknown> : {};
    const existingComputeid = typeof existingMetadata.computeid === 'object' && existingMetadata.computeid !== null
      ? existingMetadata.computeid as Record<string, unknown> : {};
    if (parsed.data.allowed_scopes && existingComputeid.issuer === 'computeid') {
      const outsidePassportCeiling = parsed.data.allowed_scopes.filter(
        (scope) => !(PASSPORT_AGENT_SCOPE_ALLOWLIST as readonly string[]).includes(scope),
      );
      if (outsidePassportCeiling.length) {
        res.status(403).json({ error: 'provider_scope_ceiling_exceeded', missing: outsidePassportCeiling });
        return;
      }
    }

    const metadata = typeof existing.metadata === 'object' && existing.metadata !== null
      ? existing.metadata as Record<string, unknown> : {};
    const computeid = typeof metadata.computeid === 'object' && metadata.computeid !== null
      ? metadata.computeid as Record<string, unknown> : {};
    if (parsed.data.status === 'active' && (computeid.suspended_by === 'computeid' || computeid.provider_suspended === true)) {
      res.status(409).json({ error: 'Agent is suspended by ComputeID and requires provider reinstatement' });
      return;
    }

    // Revoked is terminal (partner revocations, DELETE /:agentId). Re-activating
    // a revoked row would let POST /:agentId/key mint keys for a passport
    // ComputeID has revoked. Non-status edits (name, description) stay allowed.
    if (existing.status === 'revoked' && parsed.data.status !== undefined) {
      res.status(409).json({ error: 'Agent is revoked — revocation is terminal; register a new agent instead' });
      return;
    }

    const updates: Record<string, unknown> = { ...parsed.data };
    delete updates.status;
    let agent: Record<string, unknown> = existing;

    if (parsed.data.status) {
      const { data: transition, error: transitionError } = await dbAny.rpc('apply_admin_agent_status_transition', {
        p_org_id: orgId, p_agent_id: agentId, p_next_status: parsed.data.status, p_updates: updates,
        p_actor_kind: caller.kind,
        p_actor_id: caller.kind === 'user' ? caller.userId : caller.apiKeyId,
      });
      if (transitionError?.code === '23514') { res.status(409).json({ error: transitionError.message }); return; }
      if (transitionError) { logger.error({ agentId, error: transitionError }, 'Atomic agent status transition failed'); res.status(500).json({ error: 'Failed to change agent status' }); return; }
      if (!(transition as { found?: boolean } | null)?.found) { res.status(404).json({ error: 'Agent not found' }); return; }
      agent = (transition as { agent: Record<string, unknown> }).agent;
    }

    if (!parsed.data.status && Object.keys(updates).length > 0) {
      const { data: updatedAgent, error } = await dbAny.from('agents').update(updates)
        .eq('id', agentId).eq('org_id', orgId).select().single();
      if (error || !updatedAgent) { res.status(404).json({ error: 'Agent not found or update failed' }); return; }
      agent = updatedAgent;
      void recordAuditEvent({ actor_id: callerAudit(caller).actor_id, org_id: orgId,
        event_type: 'AGENT_UPDATED', event_category: 'SYSTEM', target_type: 'agent', target_id: agentId,
        details: JSON.stringify({ ...callerAudit(caller).details, changes: updates }) });
    }

    res.json(toPublicAgent(agent));
  } catch (err) {
    logger.error({ error: err }, 'Agent update failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/v1/agents/:agentId — Revoke agent ──────────────

router.delete('/:agentId', async (req: Request<{ agentId: string }>, res: Response) => {
  const caller = await resolveCaller(req, res, { requireAdmin: true });
  if (!caller) return;
  const { agentId } = req.params;

  try {
    const orgId = caller.orgId;

    // Verify ownership before revoking
    const existing = await verifyAgentOwnership(agentId, orgId, res);
    if (!existing) return;

    // One database transaction owns the terminal status, every associated key,
    // and the success audit. Migration 0488 locks the same parent row used by
    // 0448's active-key trigger, closing concurrent mint and stale-resume races.
    const rpcName = caller.kind === 'user' ? 'revoke_agent_and_keys' : 'revoke_agent_and_keys_as_api_key';
    const rpcArgs = caller.kind === 'user'
      ? { p_org_id: orgId, p_agent_id: agentId, p_actor_id: caller.userId }
      : { p_org_id: orgId, p_agent_id: agentId, p_actor_api_key_id: caller.apiKeyId };
    const { data: revokeResult, error } = await dbAny.rpc(rpcName, rpcArgs);

    if (error) {
      logger.error({ agentId, error }, 'Atomic agent revocation failed');
      res.status(500).json({ error: 'Failed to revoke agent' });
      return;
    }
    if (!(revokeResult as { found?: boolean } | null)?.found) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    logger.info({ agentId }, 'Agent revoked');
    res.json({ status: 'revoked', agent_id: agentId });
  } catch (err) {
    logger.error({ error: err }, 'Agent revocation failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/v1/agents/:agentId/key — Generate scoped API key ─

router.post('/:agentId/key', async (req: Request, res: Response) => {
  const caller = await resolveCaller(req, res, { requireAdmin: true });
  if (!caller) return;
  const { agentId } = req.params;
  const hmacSecret = (await import('../../config.js')).config.apiKeyHmacSecret;
  if (!hmacSecret) { res.status(500).json({ error: 'HMAC secret not configured' }); return; }

  try {
    // Minting a working credential is at least as privileged as suspending
    // or revoking one (both admin-only below) — so this is too.
    const orgId = caller.orgId;

    const { data: agent, error: agentError } = await dbAny
      .from('agents')
      .select('id, org_id, allowed_scopes, name, status')
      .eq('id', agentId)
      .eq('org_id', orgId)
      .single();

    if (agentError || !agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    if (agent.status !== 'active') {
      res.status(409).json({ error: `Agent is ${agent.status} — cannot generate keys` });
      return;
    }

    const missing = missingDelegatedScopes(caller, agent.allowed_scopes);
    if (missing.length) { res.status(403).json({ error: 'delegation_scope_exceeded', missing }); return; }

    // Generate key scoped to agent's allowed scopes
    const { raw, hash, prefix } = generateApiKey(hmacSecret);

    const { data: key, error: insertError } = await dbAny.from('api_keys').insert({
      org_id: agent.org_id,
      key_prefix: prefix,
      key_hash: hash,
      name: `${agent.name} — auto-generated`,
      scopes: agent.allowed_scopes,
      agent_id: agentId,
      created_by: caller.ownerUserId,
    }).select('id, name, key_prefix, scopes, created_at').single();

    if (insertError || !key) {
      logger.error({ error: insertError }, 'Failed to create agent API key');
      res.status(500).json({ error: 'Failed to create API key' });
      return;
    }

    void recordAuditEvent({
      actor_id: callerAudit(caller).actor_id,
      event_type: 'AGENT_KEY_CREATED',
      event_category: 'SYSTEM',
      target_type: 'api_key',
      target_id: key.id,
      org_id: agent.org_id,
      details: JSON.stringify({ ...callerAudit(caller).details, agent_name: agent.name, scopes: agent.allowed_scopes }),
    });

    // Return raw key ONCE (Constitution 1.4: never stored after creation)
    res.status(201).json({
      key: raw,
      key_id: key.id,
      key_prefix: key.key_prefix,
      agent_id: agentId,
      agent_name: agent.name,
      scopes: key.scopes,
      created_at: key.created_at,
      warning: 'This is the only time the raw API key will be shown. Store it securely.',
    });
  } catch (err) {
    logger.error({ error: err }, 'Agent key generation failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as agentsRouter };
