#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/targeted/computeid-passport-driver.ts  (PR #2668 — ComputeID AgentPassport)
 *
 * TARGETED soak driver for the two surfaces PR #2668 adds behind
 * `ENABLE_COMPUTEID_INTEGRATION`:
 *   - POST /api/v1/agents/computeid/admit   (org API key with agents:manage; receipt
 *                                            verified offline against the rig's pinned CA)
 *   - POST /webhooks/computeid               (HMAC-SHA256 `X-ComputeID-Signature`;
 *                                            passport.suspended / reinstated / revoked)
 *
 * Every cycle drives the FULL lifecycle end to end and asserts the changed
 * behaviour semantically — not by HTTP status alone:
 *   1. real-sender replay: the byte-exact delivery ComputeID's sender produced on
 *      2026-09-07 (fixtures/golden-test-delivery.json) is accepted → 200 ignored
 *   2. admit a fresh passport with a driver-signed receipt → 201, agent key minted
 *   3. the key authenticates (GET /api/v1/verify/<unknown> → 404/400, never 401)
 *   4. passport.suspended → applied:1 and the key is REFUSED (401) — keys-first enforcement
 *   5. passport.reinstated → applied:1 and the key works again (ownership-aware reinstate)
 *   6. passport.revoked → applied:1, key refused; the byte-exact replay is skipped;
 *      a later passport.reinstated cannot resurrect it (revoked is terminal)
 *   7. six interleaved deliveries fired in PARALLEL on a second passport → every
 *      response is 200 or 409 conflict_retry (compare-and-set), 409s are redelivered,
 *      the final state is revoked with the key refused (no lost terminal state)
 *   8. a signed passport.revoked OLDER than the receipt issued_at on a third passport
 *      is skipped (ordering floor) and the key keeps working; a current one then revokes it
 *   9. a receipt whose signed status is not `active` is refused at admission (401)
 *  10. a wrong-secret signature → 401 invalid_signature; a 70 KiB body → 413
 *  11. optional DB-delta assertions via the service-role client: agents.status =
 *      'revoked' and every api_keys row for the agent is_active=false
 *  12. /health → 200
 *
 * Env:
 *   STAGING_API_BASE                     REQUIRED tag-routed rig URL (pr-2668---arkova-worker-<rig>-staging-…run.app)
 *   STAGING_COMPUTEID_ORG_API_KEY        REQUIRED org API key ON THE RIG carrying agents:manage
 *   STAGING_COMPUTEID_WEBHOOK_SECRET     REQUIRED one of the rig's COMPUTEID_WEBHOOK_SECRET values
 *   STAGING_COMPUTEID_SIGNER_KEY_PEM     REQUIRED path to the RSA private key whose certificate is the rig's COMPUTEID_CA_CERT_PEM
 *   STAGING_COMPUTEID_GOLDEN_FIXTURE     optional path to the captured real delivery (default: the repo fixture);
 *                                        its throwaway secret must be in the rig's secret list for step 1 to pass
 *   STAGING_SUPABASE_URL / STAGING_SUPABASE_SERVICE_ROLE_KEY  optional — enables the DB-delta assertions
 *   STAGING_COMPUTEID_CYCLE_MS           optional cycle cadence (default 300000 = 5 min)
 *   STAGING_RIG_PUBLIC=1                 optional — skip the Cloud Run IAM header (rig deployed --allow-unauthenticated)
 *   STAGING_GCP_IDENTITY                 optional pre-fetched Cloud Run IAM token
 *
 * The raw agent key is read from the admission response to drive steps 3–8 and is
 * REDACTED before that body reaches evidence.
 */

import { createHash, createHmac, createPrivateKey, createPublicKey, randomUUID, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveStagingApiBase } from '../load-harness-env';
import {
  fireLabeled,
  newDriverStats,
  parseDriverArgs,
  recordOutcome,
  summarizeEvidence,
  type DriverOutcome,
  type DriverStats,
  type JsonBody,
} from './driver-core';
import { isDirectRun } from './public-projection-driver';
import { iamOnlyHeaders, requireEnv, runDriver, writeEvidenceFile, type DriverContext } from './runtime';

export const COMPUTEID_DRIVER = { driver: 'computeid-passport', pr: '#2668' } as const;
export const DEFAULT_CYCLE_MS = 5 * 60_000;

const ADMIT = '/api/v1/agents/computeid/admit';
const WEBHOOK = '/webhooks/computeid';
const KEY_PROBE = '/api/v1/verify/ARK-SOAK-NOPE';
const SIGNATURE_HEADER = 'X-ComputeID-Signature';
const OVERSIZE_BODY_BYTES = 70 * 1024;

export type PassportEvent = 'passport.suspended' | 'passport.reinstated' | 'passport.revoked';

// ─── Pure: receipt + delivery signing ───────────────────────────────────────

/** Mirrors `deriveKeyId` in the worker: sha256 over the SPKI PEM text, first 16 hex chars. */
export function deriveKeyIdFromSpkiPem(spkiPem: string): string {
  return createHash('sha256').update(spkiPem).digest('hex').slice(0, 16);
}

export interface SignReceiptArgs {
  privateKeyPem: string;
  /** SPKI PEM of the same key; derived from the private key when omitted. */
  spkiPem?: string;
  passportId: string;
  issuedAt: string;
  expiresAt: string;
  status?: string;
}

export interface SignedReceipt {
  passport_id: string;
  status: string;
  signature_valid: boolean;
  issued_at: string;
  expires_at: string;
  key_id: string;
  receipt_signature: string;
  receipt_algorithm: 'RSA-SHA256';
  receipt_payload: string;
}

/**
 * Build a `verification_receipt` the way ComputeID's CA does: RSA-SHA256 over the
 * canonical JSON in `receipt_payload`, unsigned sibling fields copied from it.
 */
export function signReceipt(args: SignReceiptArgs): SignedReceipt {
  const privateKey = createPrivateKey(args.privateKeyPem);
  const spkiPem = args.spkiPem ?? (createPublicKey(args.privateKeyPem).export({ type: 'spki', format: 'pem' }) as string);
  const status = args.status ?? 'active';
  const keyId = deriveKeyIdFromSpkiPem(spkiPem);
  const payload = {
    passport_id: args.passportId,
    status,
    signature_valid: true,
    issued_at: args.issuedAt,
    expires_at: args.expiresAt,
    key_id: keyId,
  };
  const receiptPayload = JSON.stringify(payload);
  const signature = cryptoSign('sha256', Buffer.from(receiptPayload, 'utf8'), privateKey).toString('base64');
  return {
    passport_id: args.passportId,
    status,
    signature_valid: true,
    issued_at: args.issuedAt,
    expires_at: args.expiresAt,
    key_id: keyId,
    receipt_signature: signature,
    receipt_algorithm: 'RSA-SHA256',
    receipt_payload: receiptPayload,
  };
}

export interface SignedDelivery {
  body: string;
  headers: Record<string, string>;
}

/** ComputeID wire format: compact JSON body, `sha256=<hex HMAC-SHA256(secret, raw body)>`. */
export function signDelivery(secret: string, envelope: Record<string, unknown>): SignedDelivery {
  const body = JSON.stringify(envelope);
  const mac = createHmac('sha256', secret).update(body).digest('hex');
  return { body, headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: `sha256=${mac}` } };
}

// ─── Pure: classification + plan ────────────────────────────────────────────

export type KeyState = 'on' | 'off' | 'unknown';

/**
 * GET /api/v1/verify/:publicId sits behind `apiKeyAuth` (optional key, but an
 * INVALID/INACTIVE key present is a hard 401) and `requireScope('verify')`, so an
 * active agent key reaches the route (404 unknown id / 400 malformed id) and a
 * deactivated one is refused before it.
 */
export function classifyKeyState(status: number): KeyState {
  if (status === 401) return 'off';
  if (status === 404 || status === 400) return 'on';
  return 'unknown';
}

export interface CyclePlan {
  cycle: number;
  agentName: string;
  passports: { lifecycle: string; race: string; floor: string };
  receipt: { issuedAt: string; expiresAt: string };
  lifecycle: { suspendAt: string; reinstateAt: string; revokeAt: string; lateReinstateAt: string };
  race: Array<{ event: PassportEvent; timestamp: string }>;
  preAdmissionRevokeAt: string;
  floorRevokeAt: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Deterministic per-cycle plan: three fresh passports and strictly ordered event times. */
export function planCycle(now: Date, cycle: number, uuid: () => string = randomUUID): CyclePlan {
  const t = now.getTime();
  const raceEvents: PassportEvent[] = [
    'passport.suspended',
    'passport.reinstated',
    'passport.revoked',
    'passport.suspended',
    'passport.reinstated',
    'passport.revoked',
  ];
  return {
    cycle,
    agentName: `computeid-soak-c${cycle}`,
    passports: { lifecycle: uuid(), race: uuid(), floor: uuid() },
    receipt: { issuedAt: iso(t - 60_000), expiresAt: iso(t + 45 * 60_000) },
    lifecycle: {
      suspendAt: iso(t + 1_000),
      reinstateAt: iso(t + 2_000),
      revokeAt: iso(t + 3_000),
      lateReinstateAt: iso(t + 4_000),
    },
    race: raceEvents.map((event, i) => ({ event, timestamp: iso(t + 5_000 + i * 1_000) })),
    preAdmissionRevokeAt: iso(t - 5 * 60_000),
    floorRevokeAt: iso(t + 11_000),
  };
}

// ─── Pure: evidence helpers ─────────────────────────────────────────────────

/** A semantic check recorded as a labeled outcome: status 1 = held, 0 = failed (never expected). */
export function recordAssertion(stats: DriverStats, label: string, ok: boolean, detail: JsonBody): void {
  recordOutcome(stats, {
    label,
    endpoint: 'assert',
    method: 'ASSERT',
    status: ok ? 1 : 0,
    latencyMs: 0,
    expected: ok,
    capturedBody: detail,
  });
}

/** The admission body carries the raw agent key exactly once — it never reaches evidence. */
export function redactAdmissionBody(body: JsonBody): JsonBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (!('key' in body)) return body;
  return { ...body, key: '[REDACTED]' };
}

function asObject(body: JsonBody | undefined): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function appliedOf(outcome: DriverOutcome): number | null {
  const body = asObject(outcome.capturedBody);
  return body && typeof body.applied === 'number' ? body.applied : null;
}

// ─── Runtime ────────────────────────────────────────────────────────────────

interface GoldenDelivery {
  body: string;
  header_name: string;
  header_value: string;
  content_type: string;
}

interface RigContext {
  orgApiKey: string;
  webhookSecret: string;
  signerKeyPem: string;
  golden: GoldenDelivery;
  db: { url: string; serviceRoleKey: string } | null;
  iam: () => Record<string, string>;
}

function defaultGoldenFixturePath(): string {
  return fileURLToPath(
    new URL('../../../services/worker/src/integrations/computeid/__fixtures__/golden-test-delivery.json', import.meta.url),
  );
}

function loadRigContext(): RigContext {
  const goldenPath = process.env.STAGING_COMPUTEID_GOLDEN_FIXTURE ?? defaultGoldenFixturePath();
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenDelivery; // NOSONAR S8707 — operator-supplied fixture path on the operator's own host.
  const dbUrl = process.env.STAGING_SUPABASE_URL;
  const dbKey = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY;
  const publicRig = process.env.STAGING_RIG_PUBLIC === '1';
  return {
    orgApiKey: requireEnv('STAGING_COMPUTEID_ORG_API_KEY', 'ComputeID admission calls'),
    webhookSecret: requireEnv('STAGING_COMPUTEID_WEBHOOK_SECRET', 'ComputeID webhook signing'),
    signerKeyPem: readFileSync(requireEnv('STAGING_COMPUTEID_SIGNER_KEY_PEM', 'ComputeID receipt signing'), 'utf8'), // NOSONAR S8707 — operator-supplied key path on the operator's own host.
    golden,
    db: dbUrl && dbKey ? { url: dbUrl, serviceRoleKey: dbKey } : null,
    iam: () => (publicRig ? {} : iamOnlyHeaders()),
  };
}

interface CycleIo {
  apiBase: string;
  rig: RigContext;
  stats: DriverStats;
  capture: boolean;
}

async function deliver(
  io: CycleIo,
  label: string,
  envelope: Record<string, unknown>,
  allowedStatuses: readonly number[],
  secret = io.rig.webhookSecret,
): Promise<DriverOutcome> {
  const signed = signDelivery(secret, envelope);
  return fireLabeled({
    stats: io.stats,
    label,
    method: 'POST',
    url: `${io.apiBase}${WEBHOOK}`,
    endpoint: WEBHOOK,
    headers: { ...io.rig.iam(), ...signed.headers },
    body: signed.body,
    allowedStatuses,
    // Webhook bodies are a few dozen bytes and carry the applied/skipped counts the
    // assertions read, so they are always captured.
    capture: true,
  });
}

async function admit(
  io: CycleIo,
  label: string,
  passportId: string,
  plan: CyclePlan,
  allowedStatuses: readonly number[],
  status?: string,
): Promise<{ outcome: DriverOutcome; key: string | null; agentId: string | null }> {
  const receipt = signReceipt({
    privateKeyPem: io.rig.signerKeyPem,
    passportId,
    issuedAt: plan.receipt.issuedAt,
    expiresAt: plan.receipt.expiresAt,
    status,
  });
  const outcome = await fireLabeled({
    stats: io.stats,
    label,
    method: 'POST',
    url: `${io.apiBase}${ADMIT}`,
    endpoint: ADMIT,
    headers: { ...io.rig.iam(), 'Content-Type': 'application/json', 'X-API-Key': io.rig.orgApiKey },
    body: JSON.stringify({
      passport_id: passportId,
      verification_receipt: receipt,
      name: plan.agentName,
      allowed_scopes: ['verify'],
    }),
    allowedStatuses,
    capture: true,
  });
  const body = asObject(outcome.capturedBody);
  const key = body && typeof body.key === 'string' ? body.key : null;
  const agent = body ? asObject(body.agent as JsonBody) : null;
  const agentId = agent && typeof agent.id === 'string' ? agent.id : null;
  // The recorded outcome IS the object in stats.outcomes — redact it in place.
  outcome.capturedBody = redactAdmissionBody(outcome.capturedBody ?? null);
  return { outcome, key, agentId };
}

async function keyState(io: CycleIo, label: string, agentKey: string, want: KeyState): Promise<KeyState> {
  const outcome = await fireLabeled({
    stats: io.stats,
    label,
    method: 'GET',
    url: `${io.apiBase}${KEY_PROBE}`,
    endpoint: KEY_PROBE,
    headers: { ...io.rig.iam(), 'X-API-Key': agentKey },
    allowedStatuses: want === 'off' ? [401] : [400, 404],
    capture: false,
  });
  return classifyKeyState(outcome.status);
}

async function assertDbState(io: CycleIo, prefix: string, agentId: string | null): Promise<void> {
  if (!io.rig.db || !agentId) return;
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(io.rig.db.url, io.rig.db.serviceRoleKey);
  const agent = await client.from('agents').select('status').eq('id', agentId).maybeSingle();
  recordAssertion(io.stats, `${prefix}-db-agent-revoked`, agent.data?.status === 'revoked', {
    status: agent.data?.status ?? null,
    error: agent.error?.message ?? null,
  });
  const keys = await client.from('api_keys').select('is_active, revocation_reason').eq('agent_id', agentId);
  const rows = keys.data ?? [];
  recordAssertion(io.stats, `${prefix}-db-keys-inactive`, rows.length > 0 && rows.every((k) => k.is_active === false), {
    keys: rows.length,
    inactive: rows.filter((k) => k.is_active === false).length,
    error: keys.error?.message ?? null,
  });
}

async function runLifecycle(io: CycleIo, plan: CyclePlan): Promise<void> {
  const pid = plan.passports.lifecycle;
  const admitted = await admit(io, 'admit-201', pid, plan, [201]);
  if (!admitted.key) {
    recordAssertion(io.stats, 'admit-returned-key', false, { status: admitted.outcome.status });
    return;
  }
  const key = admitted.key;
  await keyState(io, 'key-authenticates-after-admit', key, 'on');

  const s = await deliver(io, 'suspend-200', { event: 'passport.suspended', passport_id: pid, timestamp: plan.lifecycle.suspendAt, reason: 'soak' }, [200]);
  recordAssertion(io.stats, 'suspend-applied', appliedOf(s) === 1, { applied: appliedOf(s) });
  await keyState(io, 'key-refused-after-suspend', key, 'off');

  const r = await deliver(io, 'reinstate-200', { event: 'passport.reinstated', passport_id: pid, timestamp: plan.lifecycle.reinstateAt }, [200]);
  recordAssertion(io.stats, 'reinstate-applied', appliedOf(r) === 1, { applied: appliedOf(r) });
  await keyState(io, 'key-authenticates-after-reinstate', key, 'on');

  const revokeEnvelope = { event: 'passport.revoked', passport_id: pid, timestamp: plan.lifecycle.revokeAt, reason: 'soak' };
  const v = await deliver(io, 'revoke-200', revokeEnvelope, [200]);
  recordAssertion(io.stats, 'revoke-applied', appliedOf(v) === 1, { applied: appliedOf(v) });
  await keyState(io, 'key-refused-after-revoke', key, 'off');

  const replay = await deliver(io, 'exact-replay-200', revokeEnvelope, [200]);
  recordAssertion(io.stats, 'exact-replay-skipped', appliedOf(replay) === 0, { applied: appliedOf(replay) });

  const late = await deliver(io, 'late-reinstate-200', { event: 'passport.reinstated', passport_id: pid, timestamp: plan.lifecycle.lateReinstateAt }, [200]);
  const stillOff = await keyState(io, 'key-still-refused-after-late-reinstate', key, 'off');
  recordAssertion(io.stats, 'revoked-is-terminal', appliedOf(late) === 0 && stillOff === 'off', { applied: appliedOf(late), key: stillOff });

  await assertDbState(io, 'lifecycle', admitted.agentId);
}

async function runRace(io: CycleIo, plan: CyclePlan): Promise<void> {
  const pid = plan.passports.race;
  const admitted = await admit(io, 'race-admit-201', pid, plan, [201]);
  if (!admitted.key) return;
  const key = admitted.key;

  const first = await Promise.all(
    plan.race.map((r) => deliver(io, 'race-parallel-200-or-409', { event: r.event, passport_id: pid, timestamp: r.timestamp }, [200, 409])),
  );
  // 409 conflict_retry is the compare-and-set contract: the sender redelivers.
  let redeliveries = 0;
  for (const [i, outcome] of first.entries()) {
    if (outcome.status !== 409) continue;
    const r = plan.race[i];
    for (let attempt = 0; attempt < 3; attempt++) {
      redeliveries += 1;
      const again = await deliver(io, 'race-redelivery-200', { event: r.event, passport_id: pid, timestamp: r.timestamp }, [200, 409]);
      if (again.status === 200) break;
    }
  }
  recordAssertion(io.stats, 'race-no-5xx', first.every((o) => o.status === 200 || o.status === 409), {
    statuses: first.map((o) => o.status),
    redeliveries,
  });
  const finalKey = await keyState(io, 'race-key-refused-at-end', key, 'off');
  const late = await deliver(io, 'race-late-reinstate-200', { event: 'passport.reinstated', passport_id: pid, timestamp: plan.floorRevokeAt }, [200]);
  const stillOff = await keyState(io, 'race-key-still-refused', key, 'off');
  recordAssertion(io.stats, 'race-terminal-state-held', finalKey === 'off' && appliedOf(late) === 0 && stillOff === 'off', {
    finalKey,
    lateApplied: appliedOf(late),
  });
  await assertDbState(io, 'race', admitted.agentId);
}

async function runOrderingFloor(io: CycleIo, plan: CyclePlan): Promise<void> {
  const pid = plan.passports.floor;
  const admitted = await admit(io, 'floor-admit-201', pid, plan, [201]);
  if (!admitted.key) return;
  const key = admitted.key;
  const old = await deliver(io, 'pre-admission-revoke-200', { event: 'passport.revoked', passport_id: pid, timestamp: plan.preAdmissionRevokeAt }, [200]);
  const state = await keyState(io, 'key-authenticates-after-stale-revoke', key, 'on');
  recordAssertion(io.stats, 'pre-admission-replay-skipped', appliedOf(old) === 0 && state === 'on', { applied: appliedOf(old), key: state });
  const cur = await deliver(io, 'floor-current-revoke-200', { event: 'passport.revoked', passport_id: pid, timestamp: plan.floorRevokeAt }, [200]);
  const off = await keyState(io, 'floor-key-refused-after-current-revoke', key, 'off');
  recordAssertion(io.stats, 'current-revoke-applied', appliedOf(cur) === 1 && off === 'off', { applied: appliedOf(cur), key: off });
}

async function runNegatives(io: CycleIo, plan: CyclePlan): Promise<void> {
  // Real sender, real bytes: the delivery ComputeID produced on 2026-09-07.
  const g = await fireLabeled({
    stats: io.stats,
    label: 'golden-real-sender-replay-200',
    method: 'POST',
    url: `${io.apiBase}${WEBHOOK}`,
    endpoint: WEBHOOK,
    headers: { ...io.rig.iam(), 'Content-Type': io.rig.golden.content_type, [io.rig.golden.header_name]: io.rig.golden.header_value },
    body: io.rig.golden.body,
    allowedStatuses: [200],
    capture: true,
  });
  recordAssertion(io.stats, 'golden-replay-ignored-test-event', asObject(g.capturedBody)?.ignored === true, { body: g.capturedBody ?? null });

  await deliver(io, 'wrong-secret-401', { event: 'passport.revoked', passport_id: plan.passports.lifecycle, timestamp: plan.floorRevokeAt }, [401], 'not-the-rig-secret');

  const oversize = signDelivery(io.rig.webhookSecret, { event: 'passport.revoked', passport_id: plan.passports.lifecycle, timestamp: plan.floorRevokeAt, reason: 'x'.repeat(OVERSIZE_BODY_BYTES) });
  await fireLabeled({
    stats: io.stats,
    label: 'oversize-body-413',
    method: 'POST',
    url: `${io.apiBase}${WEBHOOK}`,
    endpoint: WEBHOOK,
    headers: { ...io.rig.iam(), ...oversize.headers },
    body: oversize.body,
    allowedStatuses: [413],
    capture: io.capture,
  });

  await admit(io, 'non-active-receipt-401', randomUUID(), plan, [401], 'revoked');
}

async function runCycle(ctx: DriverContext, rig: RigContext, stats: DriverStats, cycle: number): Promise<void> {
  const plan = planCycle(new Date(), cycle);
  const io: CycleIo = { apiBase: ctx.apiBase, rig, stats, capture: cycle <= 3 };
  const before = stats.outcomes.length;
  await runNegatives(io, plan);
  await runLifecycle(io, plan);
  await runRace(io, plan);
  await runOrderingFloor(io, plan);
  await fireLabeled({
    stats,
    label: 'health-200',
    method: 'GET',
    url: `${ctx.apiBase}/health`,
    endpoint: '/health',
    headers: rig.iam(),
    allowedStatuses: [200],
    capture: false,
  });
  const mine = stats.outcomes.slice(before);
  const fails = mine.filter((o) => !o.expected).map((o) => `${o.label}:${o.status}`);
  const failNote = fails.length > 0 ? ` fails=${fails.join(',')}` : '';
  ctx.log(`cycle ${cycle} requests=${mine.length} ok=${fails.length === 0}${failNote}`);
}

async function main(): Promise<void> {
  const args = parseDriverArgs(process.argv.slice(2));
  const apiBase = resolveStagingApiBase(process.env);
  const stats = newDriverStats();
  const meta = { ...COMPUTEID_DRIVER, apiBase };
  const cycleMs = Number.parseInt(process.env.STAGING_COMPUTEID_CYCLE_MS ?? String(DEFAULT_CYCLE_MS), 10);
  let cycle = 0;
  const flush = (): void => writeEvidenceFile(args.evidenceOut, { ...summarizeEvidence(stats, meta), cycles: cycle });

  await runDriver<RigContext>({
    apiBase,
    args,
    label: COMPUTEID_DRIVER.driver,
    stats,
    passIntervalMs: cycleMs,
    plan: async () => loadRigContext(),
    fireOnce: async (ctx, rig) => {
      cycle += 1;
      await runCycle(ctx, rig, stats, cycle);
      // A 12 h soak must not lose its evidence to a host blip: persist every cycle.
      flush();
    },
  });

  const evidence = summarizeEvidence(stats, meta);
  writeEvidenceFile(args.evidenceOut, { ...evidence, cycles: cycle });
  console.log(JSON.stringify({ cycles: cycle, totalRequests: evidence.totalRequests, allExpected: evidence.allExpected, byLabel: evidence.byLabel }, null, 2));
  if (!args.dryRun && !evidence.allExpected) process.exitCode = 1;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
