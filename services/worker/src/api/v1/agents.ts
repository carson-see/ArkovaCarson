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
import { API_KEY_SCOPES } from '../apiScopes.js';

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
function toPublicAgent<T extends Record<string, unknown>>(row: T | null | undefined): Partial<T> {
  if (!row) return {};
  const sanitized = { ...row };
  delete (sanitized as Record<string, unknown>).org_id;
  delete (sanitized as Record<string, unknown>).registered_by;
  return sanitized;
}

/** Helper: get caller's org_id or return 403 */
async function getCallerOrgId(userId: string, res: Response): Promise<string | null> {
  const { data: profile } = await db.from('profiles').select('org_id, role').eq('id', userId).single();
  if (!profile?.org_id) {
    res.status(403).json({ error: 'Organization membership required' });
    return null;
  }
  return profile.org_id;
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

const VALID_AGENT_TYPES = ['llm_agent', 'ats_integration', 'hr_platform', 'compliance_tool', 'custom'] as const;

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  agent_type: z.enum(VALID_AGENT_TYPES).default('custom'),
  allowed_scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).default(['verify']),
  framework: z.string().max(100).optional(),
  version: z.string().max(50).optional(),
  callback_url: z.string().url().startsWith('https://').optional(),
  metadata: z.record(z.unknown()).optional(),
});

const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  allowed_scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  framework: z.string().max(100).optional(),
  version: z.string().max(50).optional(),
  callback_url: z.string().url().startsWith('https://').nullable().optional(),
});

// ─── POST /api/v1/agents — Register a new agent ─────────────────

router.post('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  const parsed = CreateAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  try {
    // Look up user's org + verify admin role (migration 0158: admin-only)
    const { data: profile } = await db.from('profiles').select('org_id, role').eq('id', userId).single();
    if (!profile?.org_id) {
      res.status(403).json({ error: 'Organization membership required to register agents' });
      return;
    }
    if (profile.role !== 'ORG_ADMIN') {
      res.status(403).json({ error: 'Only organization admins can register agents' });
      return;
    }

    const { data: agent, error } = await dbAny.from('agents').insert({
      org_id: profile.org_id,
      registered_by: userId,
      ...parsed.data,
    }).select().single();

    if (error) {
      logger.error({ error }, 'Failed to create agent');
      res.status(500).json({ error: 'Failed to create agent' });
      return;
    }

    // Audit event
    void db.from('audit_events').insert({
      actor_id: userId,
      event_type: 'AGENT_REGISTERED',
      event_category: 'SYSTEM',
      target_type: 'agent',
      target_id: agent.id,
      org_id: profile.org_id,
      details: `Agent "${parsed.data.name}" registered (type: ${parsed.data.agent_type})`,
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
  const userId = req.authUserId;
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  try {
    const { data: profile } = await db.from('profiles').select('org_id').eq('id', userId).single();
    if (!profile?.org_id) {
      res.status(200).json({ agents: [] });
      return;
    }

    const { data: agents, error } = await dbAny
      .from('agents')
      .select('*')
      .eq('org_id', profile.org_id)
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
  const userId = req.authUserId;
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  const { agentId } = req.params;

  try {
    const orgId = await getCallerOrgId(userId, res);
    if (!orgId) return;

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
  const userId = req.authUserId;
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  const { agentId } = req.params;
  const parsed = UpdateAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  try {
    const orgId = await getCallerOrgId(userId, res);
    if (!orgId) return;

    // Verify ownership before updating
    const existing = await verifyAgentOwnership(agentId, orgId, res);
    if (!existing) return;

    const updates: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.status === 'suspended') {
      updates.suspended_at = new Date().toISOString();
    }

    const { data: agent, error } = await dbAny
      .from('agents')
      .update(updates)
      .eq('id', agentId)
      .eq('org_id', orgId)
      .select()
      .single();

    if (error || !agent) {
      res.status(404).json({ error: 'Agent not found or update failed' });
      return;
    }

    void db.from('audit_events').insert({
      actor_id: userId,
      event_type: parsed.data.status === 'suspended' ? 'AGENT_SUSPENDED' : 'AGENT_UPDATED',
      event_category: 'SYSTEM',
      target_type: 'agent',
      target_id: agentId,
      details: JSON.stringify(parsed.data),
    });

    res.json(toPublicAgent(agent));
  } catch (err) {
    logger.error({ error: err }, 'Agent update failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/v1/agents/:agentId — Revoke agent ──────────────

router.delete('/:agentId', async (req: Request<{ agentId: string }>, res: Response) => {
  const userId = req.authUserId;
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  const { agentId } = req.params;

  try {
    const orgId = await getCallerOrgId(userId, res);
    if (!orgId) return;

    // Verify ownership before revoking
    const existing = await verifyAgentOwnership(agentId, orgId, res);
    if (!existing) return;

    const { data: updated, error } = await dbAny
      .from('agents')
      .update({ status: 'revoked', revoked_at: new Date().toISOString() })
      .eq('id', agentId)
      .eq('org_id', orgId)
      .select('id');

    if (error || !updated || (updated as unknown[]).length === 0) {
      res.status(500).json({ error: 'Failed to revoke agent' });
      return;
    }

    // Also revoke all associated API keys. Scope by org_id even though
    // agent_id is a UUID — defense-in-depth against a hypothetical agent_id
    // collision (race or test-seed leak) silently revoking another tenant's
    // keys. Required by services/worker/agents.md service-role rule.
    await dbAny
      .from('api_keys')
      .update({ is_active: false, revoked_at: new Date().toISOString() })
      .eq('agent_id', agentId)
      .eq('org_id', orgId);

    void db.from('audit_events').insert({
      actor_id: userId,
      event_type: 'AGENT_REVOKED',
      event_category: 'SYSTEM',
      target_type: 'agent',
      target_id: agentId,
      details: 'Agent and all associated API keys revoked',
    });

    logger.info({ agentId }, 'Agent revoked');
    res.json({ status: 'revoked', agent_id: agentId });
  } catch (err) {
    logger.error({ error: err }, 'Agent revocation failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/v1/agents/:agentId/key — Generate scoped API key ─

router.post('/:agentId/key', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  const { agentId } = req.params;
  const hmacSecret = req.hmacSecret;
  if (!hmacSecret) { res.status(500).json({ error: 'HMAC secret not configured' }); return; }

  try {
    // Verify caller owns the agent's org
    const orgId = await getCallerOrgId(userId, res);
    if (!orgId) return;

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

    // Generate key scoped to agent's allowed scopes
    const { raw, hash, prefix } = generateApiKey(hmacSecret);

    const { data: key, error: insertError } = await dbAny.from('api_keys').insert({
      org_id: agent.org_id,
      key_prefix: prefix,
      key_hash: hash,
      name: `${agent.name} — auto-generated`,
      scopes: agent.allowed_scopes,
      agent_id: agentId,
      created_by: userId,
    }).select('id, name, key_prefix, scopes, created_at').single();

    if (insertError || !key) {
      logger.error({ error: insertError }, 'Failed to create agent API key');
      res.status(500).json({ error: 'Failed to create API key' });
      return;
    }

    void db.from('audit_events').insert({
      actor_id: userId,
      event_type: 'AGENT_KEY_CREATED',
      event_category: 'SYSTEM',
      target_type: 'api_key',
      target_id: key.id,
      org_id: agent.org_id,
      details: `API key created for agent "${agent.name}" with scopes: ${agent.allowed_scopes.join(', ')}`,
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
