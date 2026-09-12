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
const captureMessage = vi.fn();
vi.mock('../utils/sentry.js', () => ({ Sentry: { captureMessage: (...a: unknown[]) => captureMessage(...a) } }));

const { loadPinnedCa } = await import('../integrations/computeid/ca-cert.js');
const { ComputeIdVerificationReceipt } = await import('../integrations/computeid/schemas.js');
const { PAYLOAD_HASH_RE } = await import('../integrations/computeid/passport-transition.js');
const {
  runComputeIdPassportRecheck,
  decideEvent,
  RECHECK_MAX_AGENTS_PER_RUN,
  RECHECK_MAX_VERIFY_CALLS,
  RECHECK_VERIFY_CONCURRENCY,
  STATUS_EVENT,
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
    readCursor: vi.fn(async () => undefined),
    writeCursor: vi.fn(async () => undefined),
    now: () => NOW,
    ...over,
  };
}

/** A clock that advances `stepMs` on every read — the real shape of a long run. */
function steppingClock(stepMs: number, from = NOW) {
  let t = from.getTime() - stepMs;
  return () => new Date((t += stepMs));
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

  it('skips (rather than failing the worker) when the partner API key is not provisioned — but says so LOUDLY', async () => {
    configMock.computeidApiKey = '';
    const p = ports({ listBoundAgents: vi.fn(async () => [agent('active')]) });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ skipped: true, reason: 'api_key_unconfigured' });
    expect(p.listBoundAgents).not.toHaveBeenCalled();
    // The flag is ON, so operators believe the safety net is running. A quiet
    // 200 {skipped:true} under a green Sentry check-in is how that belief
    // survives an hour at a time with nothing actually being re-checked.
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('COMPUTEID_API_KEY unconfigured'),
      expect.objectContaining({ level: 'error' }),
    );
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
  it('acts on an unsigned revoked_at when the partner returns no receipt, but only as far as a SUSPENSION', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'active', revoked_at: '2026-09-12T10:00:00.000Z' } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ applied: 1 });
    // Suspension deactivates the API keys just as revocation does — the whole
    // point of the job. What it does NOT do is write the cross-org terminal
    // tombstone, which has no clearing path in migration 0448 and is therefore
    // never earned by TLS + our own API key alone.
    expect(p.applyEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: 'passport.suspended', timestamp: NOW.toISOString() }),
    );
    expect(p.recordRevocationAuthority).not.toHaveBeenCalled();
  });

  it('writes the terminal tombstone ONLY on a signature-verified revoked receipt', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'revoked', verification_receipt: receipt('revoked') } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ applied: 1 });
    expect(p.recordRevocationAuthority).toHaveBeenCalledTimes(1);
  });

  it('never lets an active RECEIPT override a body that says the passport is revoked', async () => {
    // The partner mints the receipt before it reads the row, so the two can
    // disagree by up to the receipt lifetime. Taking the receipt here misses
    // the revocation outright.
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({
        ok: true as const,
        response: { passport_id: PASSPORT, status: 'revoked', revoked_at: '2026-09-12T11:59:00.000Z', verification_receipt: receipt('active') } as never,
      })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ applied: 1 });
    expect(p.applyEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: 'passport.suspended' }));
  });

  it('never REACTIVATES a suspended agent on an active receipt attached to a revoked body', async () => {
    // The dangerous half of the same disagreement: reinstatement turns the
    // agent's API keys back on.
    const p = ports({
      listBoundAgents: onePage([agent('suspended')]),
      verifyPassport: vi.fn(async () => ({
        ok: true as const,
        response: { passport_id: PASSPORT, status: 'revoked', revoked_at: '2026-09-12T11:59:00.000Z', verification_receipt: receipt('active') } as never,
      })),
    });
    await runComputeIdPassportRecheck(p);
    const events = (p.applyEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { event: string }).event);
    expect(events).not.toContain('passport.reinstated');
  });

  it('refuses a receipt minted in the future rather than submitting an event binding.ts will silently drop', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({
        ok: true as const,
        // Beyond MAX_PROVIDER_EVENT_CLOCK_SKEW_MS (5 min) ahead of NOW.
        response: { passport_id: PASSPORT, status: 'suspended', verification_receipt: receipt('suspended', { issuedAt: '2026-09-12T12:30:00.000Z' }) } as never,
      })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ unresolved: 1, applied: 0, declined: 0 });
    expect(p.applyEvent).not.toHaveBeenCalled();
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

  it('stops at the VERIFY cap when every agent carries a DISTINCT passport', async () => {
    // The other two cap tests share one passport, so the memo hides the verify
    // cap entirely and only the agent cap is ever exercised. 1:1 is the real
    // fleet shape and the verify cap (200) is the binding one.
    let issued = 0;
    const p = ports({
      listBoundAgents: vi.fn(async (_c: string | undefined, limit: number) =>
        Array.from({ length: limit }, () => {
          const i = issued++;
          const row = agent('active', `a${String(i).padStart(6, '0')}`);
          (row.metadata as { computeid: { passport_id: string } }).computeid.passport_id =
            `b390e5e6-c79d-4f02-9a42-${String(i).padStart(12, '0')}`;
          return row;
        }),
      ),
      verifyPassport: vi.fn(async (id: string) => ({ ok: true as const, response: { passport_id: id, status: 'active' } as never })),
    });
    const r = await runComputeIdPassportRecheck(p);
    expect(r.truncated).toBe(true);
    expect(r.passportsVerified).toBe(RECHECK_MAX_VERIFY_CALLS);
    expect(r.checked).toBeLessThan(RECHECK_MAX_AGENTS_PER_RUN);
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
  const EXPIRES = new Date(EXPIRES_AT).getTime();
  const signedActive: Observation = { kind: 'signed', status: 'active', at: ISSUED_AT, passportSignatureValid: true, expiresAt: EXPIRES };

  it('declines an unrecognized partner status rather than guessing — and names it as drift', () => {
    const d = decideEvent(agent('active'), { kind: 'signed', status: 'quarantined', at: ISSUED_AT, passportSignatureValid: true, expiresAt: EXPIRES }, NOW);
    expect(d).toEqual({ event: null, reason: 'unknown_status' });
  });

  it('does nothing when the partner agrees with us', () => {
    expect(decideEvent(agent('active'), signedActive, NOW)).toEqual({ event: null, reason: 'agreed' });
  });

  it('does nothing for an unresolved observation', () => {
    expect(decideEvent(agent('active'), { kind: 'unresolved', reason: 'verify_timeout' }, NOW))
      .toEqual({ event: null, reason: 'insufficient_evidence' });
  });

  it('stops submitting events for an agent we have already revoked (terminal, per binding.ts + 0448)', () => {
    expect(decideEvent(agent('revoked'), { kind: 'unsigned', status: 'suspended' }, NOW))
      .toEqual({ event: null, reason: 'locally_terminal' });
  });

  it('downgrades an unsigned revocation to a suspension and refuses the tombstone', () => {
    expect(decideEvent(agent('active'), { kind: 'unsigned', status: 'revoked' }, NOW))
      .toEqual({ event: 'passport.suspended', timestamp: NOW.toISOString(), tombstone: false });
  });

  it('grants the tombstone to a signed revocation', () => {
    expect(decideEvent(agent('active'), { kind: 'signed', status: 'revoked', at: ISSUED_AT, passportSignatureValid: true, expiresAt: EXPIRES }, NOW))
      .toEqual({ event: 'passport.revoked', timestamp: ISSUED_AT, tombstone: true });
  });

  it('does not try to reinstate an agent the ORGANIZATION suspended', () => {
    // `binding.ts` lifts only a suspension WE applied (`suspended_by`
    // 'computeid'); anything else is `suspended_by_org`. Without a matching
    // guard here the job submits `passport.reinstated` every hour forever,
    // and binding's noop branch still returns a metadata `update` — so each
    // run takes the row lock, writes a falsified `last_event`, ratchets the
    // ordering floor and adds a permanent `declined`.
    const orgSuspended = agent('suspended');
    delete (orgSuspended.metadata as { computeid: { suspended_by?: string } }).computeid.suspended_by;
    expect(decideEvent(orgSuspended, { kind: 'signed', status: 'active', at: ISSUED_AT, passportSignatureValid: true, expiresAt: EXPIRES }, NOW))
      .toEqual({ event: null, reason: 'suspended_by_org' });
  });

  it('still reinstates a suspension WE applied', () => {
    expect(decideEvent(agent('suspended'), { kind: 'signed', status: 'active', at: ISSUED_AT, passportSignatureValid: true, expiresAt: EXPIRES }, NOW))
      .toEqual({ event: 'passport.reinstated', timestamp: ISSUED_AT, tombstone: false });
  });

  it('an org-suspended agent is still SUSPENDABLE — the guard is reinstate-only, never fail-open', () => {
    const orgSuspended = agent('active');
    expect(decideEvent(orgSuspended, { kind: 'unsigned', status: 'revoked' }, NOW))
      .toEqual({ event: 'passport.suspended', timestamp: NOW.toISOString(), tombstone: false });
  });

  it('every STATUS_EVENT key is a real AgentStatus — a typo would silently never match', () => {
    // `decideEvent` compares the mapped key against `agent.status`. A key
    // outside the enum can never equal one, so the divergence it is supposed
    // to catch reads as "unknown status" forever.
    const agentStatuses: ReadonlyArray<BoundAgentRow['status']> = ['active', 'suspended', 'revoked'];
    for (const key of Object.keys(STATUS_EVENT)) {
      expect(agentStatuses).toContain(key as BoundAgentRow['status']);
    }
  });
});

describe('runComputeIdPassportRecheck — clock, cursor and diagnostics', () => {
  it('samples the clock PER OBSERVATION, so a receipt that expires mid-run cannot reinstate anything', async () => {
    // Receipts live 300 s; this run is slow enough to outlive one. With a
    // single run-level clock the expired receipt still reads as `signed`, and
    // the reinstate path reactivates API keys on it.
    const p = ports({
      listBoundAgents: onePage([agent('suspended')]),
      // First sample (the run marker) is inside the receipt's window; the
      // observation ten minutes later is not. A single run-level clock would
      // never see the second one.
      now: steppingClock(10 * 60 * 1000, NOW),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'active', verification_receipt: receipt('active') } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ applied: 0, unresolved: 1 });
    expect(p.applyEvent).not.toHaveBeenCalled();
  });

  it('gives every DLQ row a 64-hex payload hash — migration 0448 rejects anything else', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'suspended', verification_receipt: receipt('suspended') } as never })),
      applyEvent: vi.fn(async () => ({ outcome: 'failed' as const })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ failures: 1 });
    const calls = (p.recordFailure as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect((calls[0][0] as { payloadHash: string }).payloadHash).toMatch(PAYLOAD_HASH_RE);
  });

  it('records a durable row when the bound-agent lookup itself fails', async () => {
    const p = ports({ listBoundAgents: vi.fn(async () => { throw new Error('agent_lookup_failed'); }) });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ failures: 1, checked: 0 });
    const calls = (p.recordFailure as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0][0] as { reason: string }).reason).toBe('recheck_bound_agent_lookup_failed');
    expect((calls[0][0] as { payloadHash: string }).payloadHash).toMatch(PAYLOAD_HASH_RE);
  });

  it('THROWS when every partner call was rejected for authentication, so the cron monitor pages', async () => {
    // CTO ruling 2026-09-12. A rotated partner key verifies nothing, and a
    // 200 lets `withCronMonitoring` report an OK check-in — the monitor then
    // says the safety net is healthy while it is doing nothing at all. The
    // route's catch turns this into a 500, which is what fires the alert.
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: false as const, reason: 'http_error' as const, status: 401 })),
    });
    await expect(runComputeIdPassportRecheck(p)).rejects.toThrow(/authentication/i);
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('all partner calls rejected'),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('does NOT throw when only SOME calls failed auth — a partial failure is not a rotated key', async () => {
    const rows = [agent('active', 'a1'), agent('active', 'a2')];
    (rows[1].metadata as { computeid: { passport_id: string } }).computeid.passport_id =
      'adff394c-131d-4a5a-b7d5-a799d92af678';
    let call = 0;
    const p = ports({
      listBoundAgents: onePage(rows),
      verifyPassport: vi.fn(async (id: string) =>
        call++ === 0
          ? { ok: false as const, reason: 'http_error' as const, status: 401 }
          : { ok: true as const, response: { passport_id: id, status: 'active' } as never },
      ),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ unresolvedAuth: 1, passportsVerified: 2 });
  });

  it('a partner outage is unresolved but NOT an auth failure', async () => {
    const p = ports({
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: false as const, reason: 'timeout' as const })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ unresolved: 1, unresolvedAuth: 0 });
  });

  it('persists the cursor when a cap truncates the run, so the next run covers the REST of the fleet', async () => {
    let issued = 0;
    const p = ports({
      listBoundAgents: vi.fn(async (_c: string | undefined, limit: number) =>
        Array.from({ length: limit }, () => agent('active', `a${String(issued++).padStart(6, '0')}`)),
      ),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'active', verification_receipt: receipt('active') } as never })),
    });
    const r = await runComputeIdPassportRecheck(p);
    expect(r.truncated).toBe(true);
    expect(r.nextCursor).toEqual(expect.any(String));
    expect(p.writeCursor).toHaveBeenCalledWith(r.nextCursor);
    // Without this, the caps are a permanent ceiling: the first 200 agents are
    // re-checked forever and the rest are never checked at all.
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('truncated'),
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('resumes from the stored cursor and clears it once a full pass completes', async () => {
    const p = ports({
      readCursor: vi.fn(async () => 'agent-000123'),
      listBoundAgents: onePage([agent('active')]),
      verifyPassport: vi.fn(async () => ({ ok: true as const, response: { passport_id: PASSPORT, status: 'active', verification_receipt: receipt('active') } as never })),
    });
    await expect(runComputeIdPassportRecheck(p)).resolves.toMatchObject({ nextCursor: null, truncated: false });
    expect(p.listBoundAgents).toHaveBeenCalledWith('agent-000123', expect.any(Number));
    expect(p.writeCursor).toHaveBeenCalledWith(null);
  });

  it('resolves a page\'s distinct passports concurrently rather than one 5-second call at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const rows = Array.from({ length: 12 }, (_, i) => agent('active', `a${i}`));
    // Distinct passports per agent, so the memo cannot hide the fan-out.
    rows.forEach((r, i) => {
      (r.metadata as { computeid: { passport_id: string } }).computeid.passport_id =
        `b390e5e6-c79d-4f02-9a42-${String(i).padStart(12, '0')}`;
    });
    const p = ports({
      listBoundAgents: onePage(rows),
      verifyPassport: vi.fn(async (id: string) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { ok: true as const, response: { passport_id: id, status: 'active' } as never };
      }),
    });
    await runComputeIdPassportRecheck(p);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(RECHECK_VERIFY_CONCURRENCY);
  });
});
