/**
 * ComputeID AgentPassport admission (SCRUM-4494).
 *
 * `POST /api/v1/agents/computeid/admit` — machine-to-machine. Mounted in
 * router.ts with `requireScopeAnyAuth('agents:manage')` and BEFORE the
 * JWT-only `/agents` mount, so an org API key (the "authorizing principal")
 * reaches it. The agent presents its passport id plus the
 * `verification_receipt` from ComputeID's `/v1/agents/{id}/verify`; Arkova
 * verifies the receipt OFFLINE against the pinned CA (no partner call on
 * this path), binds the passport to a new `agents` row, and mints an
 * agent-scoped key. The raw key is returned once (Constitution 1.4).
 *
 * Gate: `ENABLE_COMPUTEID_INTEGRATION=true` + `COMPUTEID_CA_CERT_PEM`.
 */
import { Router, type Request, type Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { recordAuditEvent } from '../../utils/auditEvent.js';
import { generateApiKey } from '../../middleware/apiKeyAuth.js';
import { loadPinnedCa, type PinnedCa } from '../../integrations/computeid/ca-cert.js';
import { verifyComputeIdReceipt } from '../../integrations/computeid/receipt-verifier.js';
import { COMPUTEID_ISSUER, ComputeIdAdmissionRequest } from '../../integrations/computeid/schemas.js';
import { writeBinding, type ComputeIdBinding } from '../../integrations/computeid/binding.js';

export const agentsComputeIdRouter = Router();

/** Scopes a passport-admitted agent may hold. Deliberately excludes every management scope. */
export const PASSPORT_AGENT_SCOPE_ALLOWLIST = [
  'verify',
  'verify:batch',
  'anchor:write',
  'anchor:read',
  'read:records',
  'read:search',
] as const;
const DEFAULT_PASSPORT_AGENT_SCOPES = ['verify'];

let cachedCa: { pem: string; ca: PinnedCa } | null = null;
function getPinnedCa(): PinnedCa | null {
  const pem = process.env.COMPUTEID_CA_CERT_PEM ?? '';
  if (!pem.trim()) return null;
  if (cachedCa && cachedCa.pem === pem) return cachedCa.ca;
  try {
    const ca = loadPinnedCa(pem);
    cachedCa = { pem, ca };
    return ca;
  } catch (err) {
    logger.error({ error: err }, 'COMPUTEID_CA_CERT_PEM is not a usable CA pin');
    return null;
  }
}

function clampScopes(requested: string[] | undefined): string[] {
  const allow = new Set<string>(PASSPORT_AGENT_SCOPE_ALLOWLIST);
  const wanted = requested && requested.length > 0 ? requested : DEFAULT_PASSPORT_AGENT_SCOPES;
  return [...new Set(wanted.filter((s) => allow.has(s)))];
}

agentsComputeIdRouter.post('/admit', async (req: Request, res: Response) => {
  if (process.env.ENABLE_COMPUTEID_INTEGRATION !== 'true') {
    res.status(503).json({
      error: { code: 'vendor_gated', message: 'ComputeID integration is not enabled in this environment.' },
    });
    return;
  }

  const apiKey = req.apiKey;
  if (!apiKey) {
    res.status(401).json({ error: { code: 'api_key_required', message: 'Admission requires an organization API key.' } });
    return;
  }
  const hmacSecret = req.hmacSecret;
  if (!hmacSecret) {
    res.status(500).json({ error: { code: 'hmac_unconfigured' } });
    return;
  }
  const ca = getPinnedCa();
  if (!ca) {
    res.status(500).json({ error: { code: 'ca_unconfigured' } });
    return;
  }

  const parsed = ComputeIdAdmissionRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', details: parsed.error.issues } });
    return;
  }
  const { passport_id: passportId, verification_receipt: receipt } = parsed.data;

  const verdict = verifyComputeIdReceipt({ receipt, ca, expectedPassportId: passportId });
  if (!verdict.ok) {
    res.status(401).json({ error: { code: 'receipt_invalid', reason: verdict.reason } });
    return;
  }

  const scopes = clampScopes(parsed.data.allowed_scopes);
  if (scopes.length === 0) {
    res.status(400).json({ error: { code: 'no_permitted_scopes', permitted: PASSPORT_AGENT_SCOPE_ALLOWLIST } });
    return;
  }

  const orgId = apiKey.orgId;
  const principalUserId = apiKey.userId;
  const shortId = passportId.slice(0, 8);
  const name = parsed.data.name ?? `computeid-${shortId}`;
  const now = new Date();

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;

    const { data: existing, error: dupErr } = await dbAny
      .from('agents')
      .select('id')
      .eq('org_id', orgId)
      .contains('metadata', { computeid: { passport_id: passportId } })
      .neq('status', 'revoked')
      .limit(1);
    if (dupErr) {
      logger.error({ error: dupErr }, 'ComputeID admission: duplicate-binding lookup failed');
      res.status(500).json({ error: { code: 'admission_failed' } });
      return;
    }
    if (Array.isArray(existing) && existing.length > 0) {
      res.status(409).json({ error: { code: 'passport_already_bound', agent_id: existing[0].id } });
      return;
    }

    const binding: ComputeIdBinding = {
      issuer: COMPUTEID_ISSUER,
      passport_id: passportId,
      bound_at: now.toISOString(),
      receipt_expires_at: verdict.expiresAt.toISOString(),
    };

    const { data: agent, error: agentErr } = await dbAny
      .from('agents')
      .insert({
        org_id: orgId,
        registered_by: principalUserId,
        name,
        description: parsed.data.description,
        agent_type: 'llm_agent',
        allowed_scopes: scopes,
        metadata: writeBinding({}, binding),
      })
      .select('id, name, status, agent_type, allowed_scopes, created_at, metadata')
      .single();
    if (agentErr || !agent) {
      logger.error({ error: agentErr }, 'ComputeID admission: agent insert failed');
      res.status(500).json({ error: { code: 'admission_failed' } });
      return;
    }

    const { raw, hash, prefix } = generateApiKey(hmacSecret);
    const { data: key, error: keyErr } = await dbAny
      .from('api_keys')
      .insert({
        org_id: orgId,
        key_prefix: prefix,
        key_hash: hash,
        name: `${name} — ComputeID passport ${shortId}`,
        scopes,
        agent_id: agent.id,
        created_by: principalUserId,
      })
      .select('id, key_prefix, scopes, created_at')
      .single();
    if (keyErr || !key) {
      logger.error({ error: keyErr, agentId: agent.id }, 'ComputeID admission: key insert failed — rolling back agent');
      const { error: rollbackErr } = await dbAny.from('agents').delete().eq('org_id', orgId).eq('id', agent.id);
      if (rollbackErr) logger.error({ error: rollbackErr, agentId: agent.id }, 'ComputeID admission: agent rollback failed');
      res.status(500).json({ error: { code: 'key_issue_failed' } });
      return;
    }

    void recordAuditEvent({
      actor_id: principalUserId,
      event_type: 'AGENT_PASSPORT_ADMITTED',
      event_category: 'SECURITY',
      target_type: 'agent',
      target_id: agent.id,
      org_id: orgId,
      details:
        `ComputeID passport ${passportId} admitted as agent "${name}" with scopes ${scopes.join(', ')}; ` +
        `receipt key_id ${receipt.key_id}, receipt expires ${binding.receipt_expires_at}; authorized by API key ${apiKey.keyPrefix}.`,
    });

    res.status(201).json({
      agent: {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        agent_type: agent.agent_type,
        allowed_scopes: agent.allowed_scopes,
        created_at: agent.created_at,
      },
      binding,
      key: raw,
      key_id: key.id,
      key_prefix: key.key_prefix,
      scopes: key.scopes,
      warning: 'This is the only time the raw API key will be shown. Store it securely.',
    });
  } catch (err) {
    logger.error({ error: err }, 'ComputeID admission failed');
    res.status(500).json({ error: { code: 'admission_failed' } });
  }
});
