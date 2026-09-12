/**
 * Scheduled ComputeID passport re-check (SCRUM-4495).
 *
 * The properties worth pinning are not "it calls an API": they are the gate
 * (dark unless the flag AND the credentials are present), the evidence
 * asymmetry (reinstatement needs a verified signature; revocation does not),
 * the steady-state no-op, the caps, and the fact that reconciliation runs
 * through the SAME transition path the webhook uses rather than a second copy.
 *
 * Receipts are signed here with a locally generated key pinned as the CA, the
 * same way `receipt-verifier.test.ts` does. The partner-signed golden receipts
 * live in `integrations/computeid/receipt-verifier.golden.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

const configMock = {
  enableComputeidIntegration: true,
  computeidApiKey: 'test-partner-key',
  computeidApiBaseUrl: 'https://api.aicomputeid.com',
  computeidCaCertPem: '',
};
vi.mock('../config.js', () => ({ config: configMock }));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { loadPinnedCa } = await import('../integrations/computeid/ca-cert.js');
const { ComputeIdVerificationReceipt } = await import('../integrations/computeid/schemas.js');
const {
  runComputeIdPassportRecheck,
  decideEvent,
  RECHECK_MAX_AGENTS_PER_RUN,
  RECHECK_MAX_VERIFY_CALLS,
} = await import('./computeid-passport-recheck.js');
type RecheckPorts = import('./computeid-passport-recheck.js').RecheckPorts;
type Observation = import('./computeid-passport-recheck.js').Observation;
type BoundAgentRow = import('../integrations/computeid/passport-transition.js').BoundAgentRow;

const PASSPORT = 'b390e5e6-c79d-4f02-9a42-212494b1fd44';
const NOW = new Date('2026-09-12T12:00:00.000Z');
const ISSUED_AT = '2026-09-12T11:59:30.000Z';
const EXPIRES_AT = '2026-09-12T12:04:30.000Z';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ca = loadPinnedCa(publicKey.export({ type: 'spki', format: 'pem' }) as string);

function receipt(status: string, opts: { key?: KeyObject; issuedAt?: string; pqValid?: boolean } = {}) {
  const payload = {
    passport_id: PASSPORT,
    status,
    signature_valid: true,
    ...(opts.pqValid === undefined ? {} : { pq_signature_valid: opts.pqValid }),
    issued_at: opts.issuedAt ?? ISSUED_AT,
    expires_at: EXPIRES_AT,
    key_id: ca.keyId,
  };
  const receipt_payload = JSON.stringify(payload);
  return ComputeIdVerificationReceipt.parse({
    passport_id: PASSPORT,
    status,
    signature_valid: true,
    issued_at: payload.issued_at,
    expires_at: EXPIRES_AT,
    key_id: ca.keyId,
    receipt_signature: sign('sha256', Buffer.from(receipt_payload, 'utf8'), opts.key ?? privateKey).toString('base64'),
    receipt_algorithm: 'RSA-SHA256',
    receipt_payload,
  });
}

function agent(status: 'active' | 'suspended' | 'revoked', id = 'agent-1', orgId = 'org-1'): BoundAgentRow {
  return {
    id,
    org_id: orgId,
    name: 'Archer',
    status,
    metadata: {
      computeid: {
        issuer: 'computeid',
        passport_id: PASSPORT,
        bound_at: '2026-09-10T00:00:00.000Z',
        receipt_expires_at: '2026-09-10T00:05:00.000Z',
        ...(status === 'suspended' ? { suspended_by: 'computeid' } : {}),
      },
    },
  };
}

function ports(over: Partial<RecheckPorts> = {}): RecheckPorts {
  return {
    listBoundAgents: vi.fn(async () => []),
    verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'active' } as never })),
    applyEvent: vi.fn(async () => ({ outcome: 'applied' as const })),
    recordRevocationAuthority: vi.fn(async () => true),
    recordFailure: vi.fn(async () => undefined),
    loadCa: () => ca,
    now: () => NOW,
    ...over,
  };
}

/** One page of agents, then empty — the shape the real paged reader produces. */
function onePage(rows: BoundAgentRow[]) {
  let served = false;
  return vi.fn(async () => {
    if (served) return [];
    served = true;
    return rows;
  });
}

beforeEach(() => {
  configMock.enableComputeidIntegration = true;
  configMock.computeidApiKey = 'test-partner-key';
  vi.clearAllMocks();
});

describe('runComputeIdPassportRecheck — gate', () => {
  it('is a no-op that touches nothing when the flag is off', async () => {
    configMock.enableComputeidIntegration = false;
    const p = ports({ listBoundAgents: vi.fn(async () => [agent('active')]) });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ skipped: true, reason: 'flag_off', checked: 0 });
    expect(p.listBoundAgents).not.toHaveBeenCalled();
    expect(p.verifyPassport).not.toHaveBeenCalled();
  });

  it('skips (rather than failing the worker) when the partner API key is not provisioned', async () => {
    configMock.computeidApiKey = '';
    const p = ports({ listBoundAgents: vi.fn(async () => [agent('active')]) });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ skipped: true, reason: 'api_key_unconfigured' });
    expect(p.listBoundAgents).not.toHaveBeenCalled();
  });

  it('skips when the CA pin is unusable — an unverifiable receipt must never drive a transition', async () => {
    const p = ports({ loadCa: () => null, listBoundAgents: vi.fn(async () => [agent('active')]) });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ skipped: true, reason: 'ca_pin_unusable' });
    expect(p.verifyPassport).not.toHaveBeenCalled();
  });
});

describe('runComputeIdPassportRecheck — reconciliation', () => {
  it('writes nothing when the partner agrees with us (steady state is free)', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'active', verification_receipt: receipt('active') } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ checked: 1, applied: 0, passportsVerified: 1 });
    expect(p.applyEvent).not.toHaveBeenCalled();
    expect(p.recordRevocationAuthority).not.toHaveBeenCalled();
  });

  it('catches the lost revocation: an active agent whose passport is revoked is revoked through the shared path', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'revoked', verification_receipt: receipt('revoked') } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ applied: 1, failures: 0 });
    expect(p.recordRevocationAuthority).toHaveBeenCalledTimes(1);
    expect(p.applyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-1', org_id: 'org-1' }),
      expect.objectContaining({ event: 'passport.revoked', passportId: PASSPORT, timestamp: ISSUED_AT }),
    );
  });

  it('carries the receipt SIGNED issued_at as the event timestamp, so the ordering floor can reject it', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'suspended', verification_receipt: receipt('suspended', { issuedAt: '2026-09-12T11:58:00.000Z' }) } as never })),
    });
    await runComputeIdPassportRecheck(p);
    expect(p.applyEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: 'passport.suspended', timestamp: '2026-09-12T11:58:00.000Z' }),
    );
  });

  it('does not write the revocation tombstone twice for one passport in one run', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active', 'a1', 'org-1'), agent('active', 'a2', 'org-2')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'revoked', verification_receipt: receipt('revoked') } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ applied: 2, passportsVerified: 1 });
    expect(p.recordRevocationAuthority).toHaveBeenCalledTimes(1);
    // One partner call for one passport, but BOTH orgs are enforced separately.
    expect((p.applyEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as BoundAgentRow).org_id)).toEqual(['org-1', 'org-2']);
  });

  it('does not enforce agents when the terminal revocation write fails', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'revoked', verification_receipt: receipt('revoked') } as never })),
      recordRevocationAuthority: vi.fn(async () => false),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ failures: 1, applied: 0 });
    expect(p.applyEvent).not.toHaveBeenCalled();
  });

  it('counts a compare-and-set race as a conflict rather than a success', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'suspended', verification_receipt: receipt('suspended') } as never })),
      applyEvent: vi.fn(async () => ({ outcome: 'conflict' as const })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ conflicts: 1, applied: 0 });
  });
});

describe('runComputeIdPassportRecheck — evidence quality', () => {
  it('acts on an unsigned revoked_at when the partner returns no receipt (fail-safe direction)', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'active', revoked_at: '2026-09-12T10:00:00.000Z' } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ applied: 1 });
    expect(p.applyEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: 'passport.revoked', timestamp: NOW.toISOString() }),
    );
  });

  it('NEVER reinstates on unsigned evidence — reactivating keys requires a verified signature', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('suspended')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'active' } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ applied: 0, checked: 1 });
    expect(p.applyEvent).not.toHaveBeenCalled();
  });

  it('reinstates a suspended agent on a verified receipt', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('suspended')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'active', verification_receipt: receipt('active') } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ applied: 1 });
    expect(p.applyEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: 'passport.reinstated' }));
  });

  it('will not reinstate on a receipt whose own passport signature the CA says is invalid', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('suspended')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'active', verification_receipt: receipt('active', { pqValid: false }) } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ applied: 0 });
    expect(p.applyEvent).not.toHaveBeenCalled();
  });

  it('treats a receipt signed by the WRONG key as unresolved — it never falls back to the unsigned status', async () => {
    const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'revoked', verification_receipt: receipt('revoked', { key: rogue.privateKey }) } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ unresolved: 1, applied: 0 });
    expect(p.applyEvent).not.toHaveBeenCalled();
  });

  it('records a partner outage as unresolved, never as "the passport is fine"', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: false as const, reason: 'timeout' as const })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ unresolved: 1, applied: 0, failures: 0 });
  });

  it('ignores a response about a different passport', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: 'adff394c-131d-4a5a-b7d5-a799d92af678', status: 'revoked' } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ unresolved: 1, applied: 0 });
  });
});

describe('runComputeIdPassportRecheck — bounds', () => {
  it('stops at the per-run agent cap and says so', async () => {
    // Endless distinct pages — the cap, not the data, has to stop the run.
    let issued = 0;
    const p = ports({
      listBoundAgents: vi.fn(async (_cursor: string | undefined, limit: number) =>
        Array.from({ length: limit }, () => agent('active', `a${String(issued++).padStart(6, '0')}`)),
      ),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'active', verification_receipt: receipt('active') } as never })),
    });
    const r = await runComputeIdPassportRecheck(p);
    expect(r.truncated).toBe(true);
    expect(r.checked).toBe(RECHECK_MAX_AGENTS_PER_RUN);
  });

  it('caps outbound partner calls and memoizes per passport', async () => {
    expect(RECHECK_MAX_VERIFY_CALLS).toBeLessThanOrEqual(RECHECK_MAX_AGENTS_PER_RUN);
    const rows = Array.from({ length: 50 }, (_, i) => agent('active', `a${i}`));
    const p = ports({
      listBoundAgents: onePage(rows),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'active', verification_receipt: receipt('active') } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ checked: 50, passportsVerified: 1 });
    expect(p.verifyPassport).toHaveBeenCalledTimes(1);
  });

  it('stops rather than looping when the page cursor does not advance', async () => {
    const rows = [agent('active', 'a1')];
    const p = ports({ listBoundAgents: vi.fn(async () => rows) });
    const r = await runComputeIdPassportRecheck(p);
    expect(r.failures + r.checked).toBeGreaterThan(0);
    expect(p.listBoundAgents).toHaveBeenCalledTimes(2);
  });

  it('skips an agent whose binding is missing or malformed', async () => {
    const broken = { ...agent('active'), metadata: { computeid: { issuer: 'someone-else' } } };
    const p = ports({ listBoundAgents: onePage([broken]) });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ checked: 1, passportsVerified: 0, applied: 0 });
    expect(p.verifyPassport).not.toHaveBeenCalled();
  });
});

describe('decideEvent', () => {
  const signedActive: Observation = { kind: 'signed', status: 'active', at: ISSUED_AT, passportSignatureValid: true };

  it('returns null for an unrecognized partner status rather than guessing', () => {
    expect(decideEvent({ status: 'active' }, { kind: 'signed', status: 'quarantined', at: ISSUED_AT, passportSignatureValid: true }, NOW)).toBeNull();
  });

  it('returns null when the partner agrees with us', () => {
    expect(decideEvent({ status: 'active' }, signedActive, NOW)).toBeNull();
  });

  it('returns null for an unresolved observation', () => {
    expect(decideEvent({ status: 'active' }, { kind: 'unresolved', reason: 'verify_timeout' }, NOW)).toBeNull();
  });
});
