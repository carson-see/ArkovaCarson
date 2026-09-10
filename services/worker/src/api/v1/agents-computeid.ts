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
import type { Json } from '../../types/database.types.js';
import { logger } from '../../utils/logger.js';
import { recordAuditEvent } from '../../utils/auditEvent.js';
import { mintAgentKey } from './agent-keys.js';
import { toPublicAgent } from './agents.js';
import type { ApiKeyScope } from '../apiScopes.js';
import { loadPinnedCa, type PinnedCa } from '../../integrations/computeid/ca-cert.js';
import { verifyComputeIdReceipt } from '../../integrations/computeid/receipt-verifier.js';
import { COMPUTEID_ISSUER, ComputeIdAdmissionRequest } from '../../integrations/computeid/schemas.js';
import { writeBinding, type ComputeIdBinding } from '../../integrations/computeid/binding.js';

export const agentsComputeIdRouter = Router();

/** Scopes a passport-admitted agent may hold. Deliberately excludes every management scope. */
export const PASSPORT_AGENT_SCOPE_ALLOWLIST: readonly ApiKeyScope[] = [
  'verify',
  'verify:batch',
  'anchor:write',
  'write:anchors', // V2 spelling; scopeSatisfies() treats it as anchor:write
  'anchor:read',
  'read:records',
  'read:search',
];
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

interface BindingRow {
  id: string;
  status: string;
  revoked_at: string | null;
}

/**
 * The 409 body when this org already binds the passport, else null. A live
 * binding is a duplicate. A REVOKED one blocks re-admission unless the receipt
 * was provably issued after the revocation: a captured, still-unexpired receipt
 * must not resurrect a passport ComputeID has already revoked.
 */
function bindingConflict(rows: readonly BindingRow[], receiptIssuedAt: Date | null): Record<string, unknown> | null {
  const live = rows.find((r) => r.status !== 'revoked');
  if (live) return { code: 'passport_already_bound', agent_id: live.id };
  const revokedAfterReceipt = rows.some((r) => {
    if (r.status !== 'revoked') return false;
    if (!receiptIssuedAt) return true; // no issue time → cannot prove it post-dates the revocation
    const revokedAt = r.revoked_at ? Date.parse(r.revoked_at) : Number.NaN;
    return !Number.isFinite(revokedAt) || revokedAt >= receiptIssuedAt.getTime();
  });
  if (!revokedAfterReceipt) return null;
  return {
    code: 'passport_revoked',
    message: 'This passport was revoked on Arkova after the presented receipt was issued; obtain a fresh receipt.',
  };
}

agentsComputeIdRouter.post('/admit', async (req: Request, res: Response) => {
  if (!config.enableComputeidIntegration) {
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
  // From typed config, NOT req.hmacSecret: that field is attached only by the
  // JWT `requireAuth` middleware, which this API-key mount deliberately omits.
  const hmacSecret = config.apiKeyHmacSecret;
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

    // Every binding of this passport in this org, live or revoked (see bindingConflict).
    const { data: existing, error: dupErr } = await dbAny
      .from('agents')
      .select('id, status, revoked_at')
      .eq('org_id', orgId)
      .contains('metadata', { computeid: { passport_id: passportId } });
    if (dupErr) {
      logger.error({ error: dupErr }, 'ComputeID admission: duplicate-binding lookup failed');
      res.status(500).json({ error: { code: 'admission_failed' } });
      return;
    }
    const rows = (Array.isArray(existing) ? existing : []) as BindingRow[];
    const conflict = bindingConflict(rows, verdict.issuedAt);
    if (conflict) {
      res.status(409).json({ error: conflict });
      return;
    }

    const binding: ComputeIdBinding = {
      issuer: COMPUTEID_ISSUER,
      passport_id: passportId,
      bound_at: now.toISOString(),
      receipt_expires_at: verdict.expiresAt.toISOString(),
      ...(verdict.issuedAt ? { receipt_issued_at: verdict.issuedAt.toISOString() } : {}),
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
      .select('id, name, status, agent_type, allowed_scopes, created_at')
      .single();
    if (agentErr || !agent) {
      logger.error({ error: agentErr }, 'ComputeID admission: agent insert failed');
      res.status(500).json({ error: { code: 'admission_failed' } });
      return;
    }

    const minted = await mintAgentKey({
      hmacSecret,
      orgId,
      agentId: agent.id,
      agentName: name,
      scopes,
      keyName: `${name} — ComputeID passport ${shortId}`,
      createdBy: principalUserId,
      auditContext: `Minted at ComputeID passport admission (passport ${passportId})`,
    });
    if ('error' in minted) {
      logger.error({ error: minted.error, agentId: agent.id }, 'ComputeID admission: key insert failed');
      // The locked cleanup preserves a concurrent revocation and any key whose
      // INSERT committed despite an uncertain response. Never detach that key.
      const { error: cleanupError } = await db.rpc('cleanup_computeid_empty_admission', {
        p_org_id: orgId,
        p_agent_id: agent.id,
        p_expected_metadata: writeBinding({}, binding) as Json,
      });
      if (cleanupError) logger.error({ error: cleanupError, agentId: agent.id }, 'ComputeID admission: empty agent cleanup failed');
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

    const { key } = minted;
    res.status(201).json({
      agent: toPublicAgent(agent),
      binding,
      key: key.raw,
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
