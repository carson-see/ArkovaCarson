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
 * Gate: `ENABLE_COMPUTEID_INTEGRATION=true` + `COMPUTEID_CA_CERT_PEM`, both read
 * through the typed `config` export (SCRUM-1258 — no ad-hoc `process.env`).
 */
import { Router, type Request, type Response } from 'express';
import { config } from '../../config.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { generateApiKey } from '../../middleware/apiKeyAuth.js';
import { toPublicAgent } from './agents.js';
import type { ApiKeyScope } from '../apiScopes.js';
import { PASSPORT_AGENT_SCOPE_ALLOWLIST } from './agentScopePolicy.js';
import { loadPinnedCa, type PinnedCa } from '../../integrations/computeid/ca-cert.js';
import { verifyComputeIdReceipt } from '../../integrations/computeid/receipt-verifier.js';
import { ComputeIdAdmissionRequest, isRecord } from '../../integrations/computeid/schemas.js';
import { emitAgentEvent } from '../../webhooks/agentEvents.js';

export const agentsComputeIdRouter = Router();

export { PASSPORT_AGENT_SCOPE_ALLOWLIST } from './agentScopePolicy.js';
const DEFAULT_PASSPORT_AGENT_SCOPES: ApiKeyScope[] = ['verify'];

let cachedCa: { pem: string; ca: PinnedCa } | null = null;
function getPinnedCa(): PinnedCa | null {
  const pem = config.computeidCaCertPem ?? '';
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

function clampScopes(requested: readonly ApiKeyScope[] | undefined): ApiKeyScope[] {
  const allow = new Set<string>(PASSPORT_AGENT_SCOPE_ALLOWLIST);
  const wanted = requested && requested.length > 0 ? requested : DEFAULT_PASSPORT_AGENT_SCOPES;
  return [...new Set(wanted.filter((s) => allow.has(s)))];
}

type AdmissionAgentStatus = 'active' | 'suspended' | 'revoked';

interface AdmissionResult {
  agent: Record<string, unknown> & { id: string; status: AdmissionAgentStatus };
  key: Record<string, unknown> & { id: string; key_prefix: string; scopes: unknown[] };
  binding: Record<string, unknown>;
}

function isAdmissionResult(data: Record<string, unknown>): data is Record<string, unknown> & AdmissionResult {
  if (!isRecord(data.agent) || !isRecord(data.key) || !isRecord(data.binding)) return false;
  if (typeof data.agent.id !== 'string' || typeof data.agent.status !== 'string') return false;
  if (!['active', 'suspended', 'revoked'].includes(data.agent.status)) return false;
  return typeof data.key.id === 'string'
    && typeof data.key.key_prefix === 'string'
    && Array.isArray(data.key.scopes);
}

function emitAdmissionEvents(data: AdmissionResult, orgId: string): void {
  emitAgentEvent({ eventType: 'agent.registered', orgId, agentId: data.agent.id,
    source: 'computeid', eventId: data.agent.id, status: data.agent.status,
    occurredAt: typeof data.agent.created_at === 'string' ? data.agent.created_at : undefined });
  emitAgentEvent({ eventType: 'agent.key_created', orgId, agentId: data.agent.id,
    keyId: data.key.id, source: 'computeid', eventId: data.key.id,
    occurredAt: typeof data.key.created_at === 'string' ? data.key.created_at : undefined });
}

interface AdmissionContext {
  hmacSecret: string;
  orgId: string;
  principalUserId: string;
  passportId: string;
  name: string;
  description?: string;
  scopes: ApiKeyScope[];
  issuedAt?: Date;
  expiresAt: Date;
}

function prepareAdmission(req: Request, res: Response): AdmissionContext | null {
  if (!config.enableComputeidIntegration) {
    res.status(503).json({
      error: { code: 'vendor_gated', message: 'ComputeID integration is not enabled in this environment.' },
    });
    return null;
  }
  const apiKey = req.apiKey;
  if (!apiKey) {
    res.status(401).json({ error: { code: 'api_key_required', message: 'Admission requires an organization API key.' } });
    return null;
  }
  const hmacSecret = config.apiKeyHmacSecret;
  if (!hmacSecret) { res.status(500).json({ error: { code: 'hmac_unconfigured' } }); return null; }
  const ca = getPinnedCa();
  if (!ca) { res.status(500).json({ error: { code: 'ca_unconfigured' } }); return null; }
  const parsed = ComputeIdAdmissionRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', details: parsed.error.issues } });
    return null;
  }
  const passportId = parsed.data.passport_id;
  const verdict = verifyComputeIdReceipt({
    receipt: parsed.data.verification_receipt, ca, expectedPassportId: passportId,
  });
  if (!verdict.ok) {
    res.status(401).json({ error: { code: 'receipt_invalid', reason: verdict.reason } });
    return null;
  }
  const scopes = clampScopes(parsed.data.allowed_scopes);
  if (scopes.length === 0) {
    res.status(400).json({ error: { code: 'no_permitted_scopes', permitted: PASSPORT_AGENT_SCOPE_ALLOWLIST } });
    return null;
  }
  return {
    hmacSecret, scopes, passportId,
    orgId: apiKey.orgId,
    principalUserId: apiKey.userId,
    name: parsed.data.name ?? `computeid-${passportId.slice(0, 8)}`,
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    ...(verdict.issuedAt ? { issuedAt: verdict.issuedAt } : {}),
    expiresAt: verdict.expiresAt,
  };
}

agentsComputeIdRouter.post('/admit', async (req: Request, res: Response) => {
  const admission = prepareAdmission(req, res);
  if (!admission) return;
  const { hmacSecret, orgId, principalUserId, passportId, name, description,
    scopes, issuedAt, expiresAt } = admission;

  try {
    const key = generateApiKey(hmacSecret);
    const { data, error } = await db.rpc('admit_computeid_agent', {
      p_org_id: orgId,
      p_principal_id: principalUserId,
      p_passport_id: passportId,
      ...(issuedAt ? { p_receipt_issued_at: issuedAt.toISOString() } : {}),
      p_receipt_expires_at: expiresAt.toISOString(),
      p_name: name,
      ...(description !== undefined ? { p_description: description } : {}),
      p_scopes: scopes,
      p_key_hash: key.hash,
      p_key_prefix: key.prefix,
    });
    if (error) throw error;
    if (!isRecord(data)) throw new Error('invalid_admission_result');
    if (data.error === 'passport_revoked' || data.error === 'passport_already_bound') {
      res.status(409).json({ error: { code: data.error, ...(typeof data.agent_id === 'string' ? { agent_id: data.agent_id } : {}) } });
      return;
    }
    if (!isAdmissionResult(data)) throw new Error('invalid_admission_result');
    emitAdmissionEvents(data, orgId);
    // The same transaction wrote both security audit rows. No compensation:
    // an uncertain reply must preserve any committed agent/key and its audit.
    res.status(201).json({
      agent: toPublicAgent(data.agent),
      binding: data.binding,
      key: key.raw,
      key_id: data.key.id,
      key_prefix: data.key.key_prefix,
      scopes: data.key.scopes,
      warning: 'This is the only time the raw API key will be shown. Store it securely.',
    });
  } catch (err) {
    logger.error({ error: err }, 'ComputeID admission failed');
    res.status(500).json({ error: { code: 'admission_failed' } });
  }
});
