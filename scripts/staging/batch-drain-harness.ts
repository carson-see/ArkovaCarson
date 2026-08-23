#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/batch-drain-harness.ts — REAL batch-drain behavioral proof (#1417).
 *
 * The fleet audit found rig #1417 SELF-SKIPPED: the batch cron hit its
 * entrypoint but no-op'd on the PR's own ENABLE_BATCH_ANCHORING=off gate, so
 * Merkle / intent-persist / reconcile ran ZERO times. Synthetic HTTP load
 * (load-harness.ts) proves worker health, NOT that a real 10k backlog drains
 * into one Merkle-root OP_RETURN with positional proofs and crash-safe
 * reconcile. THIS is that missing proof.
 *
 * It runs against a PROPERLY-CONFIGURED isolated rig:
 *   - ENABLE_BATCH_ANCHORING = on (real gate, non-empty PENDING + prod-network)
 *   - a *-staging Cloud Run wired to an isolated Supabase project
 *   - MockChainClient or a signet signer (never mainnet treasury)
 *
 * Phases (each asserts and records evidence):
 *
 *   SEED     insert >= --count (default 10,000) PENDING anchors for a fresh
 *            synthetic org, all fingerprints random 32-byte hex, filenames
 *            + emails on RFC 2606 reserved domains. Idempotent per --run-id.
 *
 *   DRAIN    POST {api}/jobs/batch-anchors?force=true (Trigger D) with the
 *            cron secret. Poll until the PENDING backlog for the run's org
 *            drains. Assert: exactly ONE distinct chain_tx_id across the whole
 *            batch, exactly ONE merkle_root, and >= --count rows left PENDING
 *            → {SUBMITTED,SECURED}. This is the 10k-trigger proof.
 *
 *   PROOFS   query anchor_proofs for the run's anchors. Assert each SUBMITTED
 *            anchor carries a row whose merkle_index is a distinct integer in
 *            [0, N) and whose merkle_root matches the batch root (the 2.97M-vs-
 *            6,110 proof-gap path — FIX-1 / SCRUM-2471).
 *
 *   CRASH    seed a SECOND backlog, then drive the drain but KILL it
 *            mid-flight (SIGTERM the worker between claim and submit is not
 *            reachable over HTTP, so instead we assert the RECONCILE invariant
 *            directly against the DB): manufacture a "crashed" state — rows in
 *            BROADCASTING with chain_tx_id ALREADY SET (broadcast landed, submit
 *            never ran) — call the recovery RPC, and assert those rows are NOT
 *            reverted to PENDING (chain_tx_id IS NULL guard). Then a second
 *            forced drain must NOT emit a second, different tx for them.
 *
 * SAFETY:
 *   - Prod Supabase ref vzwyaatejekddvltxyye is HARD-BLOCKED everywhere.
 *   - STAGING_API_BASE must be an isolated tag-routed Cloud Run URL
 *     (resolveStagingApiBase refuses shared/main staging).
 *   - Writes are confined to the run's synthetic org; --cleanup removes them.
 *   - This script MUTATES a rig DB. NEVER point it at a live/soaking rig.
 *     Provision a throwaway isolated rig (scripts/staging/provision-isolated-rig.sh).
 *
 * Env:
 *   STAGING_API_BASE                 isolated tag-routed worker URL (required for DRAIN/CRASH)
 *   STAGING_CRON_SECRET              X-Cron-Secret for /jobs/* (required for DRAIN/CRASH)
 *   STAGING_SUPABASE_URL             isolated rig URL (required)
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY isolated rig service role (required)
 *   STAGING_SUPABASE_PROJECT_REF     isolated rig ref (optional; used for the safety allow-list)
 *   ALLOWED_STAGING_PROJECT_REFS     comma-list of refs this harness may write to
 *   STAGING_GCP_IDENTITY             IAM bearer token for Cloud Run tag URL
 *                                    (required for DRAIN/CRASH unless the rig
 *                                    is explicitly allow-unauthenticated)
 *
 * Usage:
 *   npx tsx scripts/staging/batch-drain-harness.ts --phase all --count 10000 --evidence-out docs/staging/batch-drain-pr1417.json
 *   npx tsx scripts/staging/batch-drain-harness.ts --phase seed --count 10000 --run-id r1
 *   npx tsx scripts/staging/batch-drain-harness.ts --phase drain --run-id r1
 *   npx tsx scripts/staging/batch-drain-harness.ts --phase cleanup --run-id r1
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { resolveStagingApiBase } from './load-harness-env';
import { resolveRigTarget, runOrgId } from './batch-drain-harness-lib';

const BASELINE_FIXTURE_PROFILE_ID = '5eed0000-0000-4000-8000-0000000000a1';

const { values: args } = parseArgs({
  options: {
    phase: { type: 'string', default: 'all' }, // seed | drain | proofs | crash | cleanup | all
    count: { type: 'string', default: '10000' },
    'run-id': { type: 'string' },
    'poll-timeout': { type: 'string', default: '600' }, // seconds
    'evidence-out': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

function safeForLog(value: unknown): string {
  return String(value)
    .replace(/[^\x20-\x7E]/g, '?')
    .slice(0, 600);
}

function die(msg: string): never {
  console.error(`::error::${safeForLog(msg)}`);
  process.exit(1);
}

async function withSupabaseReadRetry<T extends { error: { message?: string } | null }>(
  label: string,
  op: () => PromiseLike<T>,
): Promise<T> {
  let latest: T | null = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    latest = await op();
    if (!latest.error) return latest;
    if (attempt < 5) {
      console.warn(`  ${safeForLog(label)} failed on attempt ${attempt}/5: ${safeForLog(latest.error.message ?? 'unknown')}; retrying`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  return latest as T;
}

async function anchorIdsForOrg(
  client: SupabaseClient,
  orgId: string,
  statuses?: string[],
): Promise<string[]> {
  const ids: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const to = from + PAGE - 1;
    const { data, error } = await withSupabaseReadRetry('anchor id page select', () => {
      const query = client
        .from('anchors')
        .select('id')
        .eq('org_id', orgId)
        .range(from, to);
      return statuses ? query.in('status', statuses) : query;
    });
    if (error) die(`anchor id page select failed: ${error.message}`);
    const page = (data ?? []).map((r) => r.id as string);
    ids.push(...page);
    if (page.length < PAGE) return ids;
  }
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) die(`${name} is required.`);
  return v;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const n = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isFinite(n) || n <= 0) die(`--${name}=${raw} must be a positive integer.`);
  return n;
}

type EvidencePath = string & { readonly __validatedEvidencePath: unique symbol };

function resolveEvidencePath(raw: string | undefined): EvidencePath | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (!trimmed.endsWith('.json')) die('--evidence-out must end with .json.');

  const candidate = resolve(process.cwd(), trimmed);
  const cwd = resolve(process.cwd());
  const tmp = resolve('/tmp');
  const privateTmp = resolve('/private/tmp');
  const fromCwd = relative(cwd, candidate);
  const fromTmp = relative(tmp, candidate);
  const fromPrivateTmp = relative(privateTmp, candidate);
  const inside = (rel: string) => rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));

  if (!inside(fromCwd) && !inside(fromTmp) && !inside(fromPrivateTmp)) {
    die('--evidence-out must stay under this checkout, /tmp, or /private/tmp.');
  }
  return candidate as EvidencePath;
}

// ── Supabase safety-guarded client (mirrors seed.ts guards) ─────────────────

function makeRigClient(): { client: SupabaseClient; url: string; ref: string } {
  const rawUrl = requireEnv('STAGING_SUPABASE_URL');
  const key = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY');

  let target: { url: string; ref: string };
  try {
    target = resolveRigTarget(rawUrl, process.env.ALLOWED_STAGING_PROJECT_REFS);
  } catch (err) {
    return die(err instanceof Error ? err.message : String(err));
  }

  const client = createClient(target.url, key, { auth: { persistSession: false } });
  return { client, url: target.url, ref: target.ref };
}

// ── Run identity + synthetic seed ───────────────────────────────────────────

function fakeFingerprint(): string {
  return randomBytes(32).toString('hex');
}

interface Evidence {
  runId: string;
  ref: string;
  apiBase?: string;
  phases: Record<string, unknown>;
  startedAt: string;
  endedAt?: string;
}

function writeEvidenceFile(evidencePath: EvidencePath, evidence: Evidence): void {
  // The path is canonicalized and confined by resolveEvidencePath before this sink.
  mkdirSync(dirname(evidencePath), { recursive: true }); // NOSONAR S8707
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n'); // NOSONAR S8707
}

async function ensureRunFixture(client: SupabaseClient, orgId: string, count: number): Promise<string> {
  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('id')
    .eq('id', BASELINE_FIXTURE_PROFILE_ID)
    .maybeSingle();
  if (profileError) die(`profile fixture lookup failed: ${profileError.message}`);
  if (!profile?.id) {
    die(
      `baseline fixture profile ${BASELINE_FIXTURE_PROFILE_ID} is missing; run scripts/staging/seed-baseline-fixture.sql before this harness`,
    );
  }

  const label = orgId.slice(0, 8);
  const { error: orgError } = await client.from('organizations').upsert(
    {
      id: orgId,
      legal_name: `Batch Drain Harness ${label} LLC`,
      display_name: `Batch Drain Harness ${label}`,
      domain: `batch-drain-${label}.invalid`,
      verification_status: 'UNVERIFIED',
    },
    { onConflict: 'id' },
  );
  if (orgError) die(`synthetic organization upsert failed: ${orgError.message}`);

  const { error: creditError } = await client.from('org_credits').upsert(
    {
      org_id: orgId,
      balance: count,
      monthly_allocation: count,
      purchased: 0,
      is_test: true,
      anchor_quota: null,
    },
    { onConflict: 'org_id' },
  );
  if (creditError) die(`synthetic org_credits upsert failed: ${creditError.message}`);

  return profile.id as string;
}

async function seedPending(client: SupabaseClient, orgId: string, count: number): Promise<number> {
  const userId = await ensureRunFixture(client, orgId, count);
  const CHUNK = 1000;
  let inserted = 0;
  for (let base = 0; base < count; base += CHUNK) {
    const rows = [];
    const n = Math.min(CHUNK, count - base);
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      rows.push({
        id,
        org_id: orgId,
        user_id: userId,
        public_id: `ANC-BD-${orgId.slice(0, 8)}-${base + i}`,
        fingerprint: fakeFingerprint(),
        filename: `batch-drain-${base + i}.pdf`,
        status: 'PENDING',
        credential_type: 'OTHER',
        metadata: { source: 'batch-drain-harness', run_org: orgId, fixture_user_id: userId },
        version_number: 1,
      });
    }
    const { error } = await client.from('anchors').insert(rows);
    if (error) die(`SEED insert failed at base ${base}: ${error.message}`);
    inserted += n;
    process.stdout.write(`\r  seeded ${inserted}/${count}`);
  }
  process.stdout.write('\n');
  return inserted;
}

async function statusCounts(client: SupabaseClient, orgId: string): Promise<Record<string, number>> {
  const statuses = ['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'REVOKED'];
  const out: Record<string, number> = {};
  for (const s of statuses) {
    const { count, error } = await client
      .from('anchors')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('status', s);
    if (error) die(`status count for ${s} failed: ${error.message}`);
    out[s] = count ?? 0;
  }
  return out;
}

// ── HTTP: drive the drain ───────────────────────────────────────────────────

async function iamHeader(): Promise<Record<string, string>> {
  const pre = process.env.STAGING_GCP_IDENTITY?.trim();
  if (pre) return { Authorization: `Bearer ${pre}` };
  if (process.env.STAGING_ALLOW_ANONYMOUS_CLOUD_RUN === '1') return {};
  die('STAGING_GCP_IDENTITY is required for DRAIN/CRASH. Export `gcloud auth print-identity-token` for the tag URL, or set STAGING_ALLOW_ANONYMOUS_CLOUD_RUN=1 only on an explicitly unauthenticated dev rig.');
}

async function postDrain(apiBase: string, orgId: string): Promise<unknown> {
  const secret = requireEnv('STAGING_CRON_SECRET');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Cron-Secret': secret,
    ...(await iamHeader()),
  };
  const url = `${apiBase}/jobs/batch-anchors?force=true`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ org_id: orgId }) });
  const body = await res.text();
  if (!res.ok) die(`DRAIN POST ${url} → ${res.status}: ${body.slice(0, 400)}`);
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

async function pollDrained(
  client: SupabaseClient,
  orgId: string,
  timeoutSec: number,
): Promise<Record<string, number>> {
  const deadline = Date.now() + timeoutSec * 1000;
  let counts = await statusCounts(client, orgId);
  while (Date.now() < deadline) {
    counts = await statusCounts(client, orgId);
    if ((counts.PENDING ?? 0) === 0 && (counts.BROADCASTING ?? 0) === 0) return counts;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return counts;
}

// ── Assertions on the drained batch ─────────────────────────────────────────

interface DrainProof {
  distinctTxIds: string[];
  distinctMerkleRoots: string[];
  submitted: number;
  pendingLeft: number;
}

async function assertSingleBatch(client: SupabaseClient, orgId: string, count: number): Promise<DrainProof> {
  const { data, error } = await client
    .from('anchors')
    .select('chain_tx_id, status')
    .eq('org_id', orgId)
    .in('status', ['SUBMITTED', 'SECURED']);
  if (error) die(`assertSingleBatch select failed: ${error.message}`);
  const txIds = new Set<string>();
  for (const row of data ?? []) {
    if (row.chain_tx_id) txIds.add(row.chain_tx_id as string);
  }

  // Merkle roots live in anchor_proofs for this run's anchors.
  const roots = await distinctMerkleRoots(client, orgId);

  const counts = await statusCounts(client, orgId);
  const proof: DrainProof = {
    distinctTxIds: [...txIds],
    distinctMerkleRoots: roots,
    submitted: (counts.SUBMITTED ?? 0) + (counts.SECURED ?? 0),
    pendingLeft: counts.PENDING ?? 0,
  };

  if (proof.distinctTxIds.length !== 1) {
    die(`Expected exactly ONE chain_tx_id across the batch; got ${proof.distinctTxIds.length}: ${proof.distinctTxIds.join(', ')}`);
  }
  if (proof.distinctMerkleRoots.length !== 1) {
    die(`Expected exactly ONE merkle_root; got ${proof.distinctMerkleRoots.length}`);
  }
  if (proof.submitted < count) {
    die(`Expected >= ${count} anchors SUBMITTED/SECURED; got ${proof.submitted}`);
  }
  if (proof.pendingLeft !== 0) {
    die(`Expected 0 PENDING left; got ${proof.pendingLeft}`);
  }
  return proof;
}

async function distinctMerkleRoots(client: SupabaseClient, orgId: string): Promise<string[]> {
  // anchor_proofs has no org_id; join via the run's anchor ids.
  const ids = await anchorIdsForOrg(client, orgId, ['SUBMITTED', 'SECURED']);
  if (ids.length === 0) return [];
  const roots = new Set<string>();
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await withSupabaseReadRetry('anchor_proofs merkle_root select', () =>
      client
        .from('anchor_proofs')
        .select('merkle_root')
        .in('anchor_id', chunk),
    );
    if (error) die(`anchor_proofs select failed: ${error.message}`);
    for (const row of data ?? []) if (row.merkle_root) roots.add(row.merkle_root as string);
  }
  return [...roots];
}

async function assertPositionalProofs(client: SupabaseClient, orgId: string, count: number): Promise<{ proofRows: number; distinctIndices: number }> {
  const ids = await anchorIdsForOrg(client, orgId, ['SUBMITTED', 'SECURED']);

  const indices = new Set<number>();
  let proofRows = 0;
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await withSupabaseReadRetry('anchor_proofs positional select', () =>
      client
        .from('anchor_proofs')
        .select('anchor_id, merkle_index')
        .in('anchor_id', chunk),
    );
    if (error) die(`assertPositionalProofs anchor_proofs select failed: ${error.message}`);
    for (const row of data ?? []) {
      proofRows += 1;
      if (typeof row.merkle_index === 'number') indices.add(row.merkle_index);
    }
  }
  if (proofRows < count) {
    die(`PROOF GAP: expected >= ${count} anchor_proofs rows; got ${proofRows}. This is the 2.97M-vs-6110 gap — the drain did NOT persist a proof per leaf.`);
  }
  if (indices.size < count) {
    die(`Expected >= ${count} DISTINCT merkle_index values (positional); got ${indices.size}. Proof positions collided.`);
  }
  return { proofRows, distinctIndices: indices.size };
}

// ── CRASH / reconcile invariant, asserted against the DB ────────────────────

async function assertReconcileNoDoubleBroadcast(
  client: SupabaseClient,
  apiBase: string,
  orgId: string,
): Promise<{ reverted: number; secondBroadcastTxCount: number }> {
  const userId = await ensureRunFixture(client, orgId, 5);
  // Manufacture a "crashed after broadcast" state: a handful of BROADCASTING
  // rows that ALREADY carry a chain_tx_id (the TX landed on chain, but the
  // worker died before submit_batch_anchors flipped them to SUBMITTED).
  const crashTx = `mock_crash_${randomBytes(8).toString('hex')}`;
  const { data: victims, error: vErr } = await client
    .from('anchors')
    .insert(
      Array.from({ length: 5 }, (_, i) => ({
        id: randomUUID(),
        org_id: orgId,
        user_id: userId,
        public_id: `ANC-BD-CRASH-${orgId.slice(0, 8)}-${i}`,
        fingerprint: fakeFingerprint(),
        filename: `batch-drain-crash-${i}.pdf`,
        status: 'BROADCASTING',
        chain_tx_id: crashTx, // broadcast already landed
        credential_type: 'OTHER',
        metadata: { source: 'batch-drain-harness', _claimed_by: 'crashed-worker', run_org: orgId, fixture_user_id: userId },
        version_number: 1,
      })),
    )
    .select('id');
  if (vErr) die(`CRASH seed failed: ${vErr.message}`);
  const victimIds = (victims ?? []).map((r) => r.id as string);

  // Run the recovery RPC (the restart path). It MUST NOT revert these — they
  // carry a chain_tx_id, so recover_stuck_broadcasts skips them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: recErr } = await (client.rpc as any)('recover_stuck_broadcasts', { p_stale_minutes: 0 });
  if (recErr) die(`recover_stuck_broadcasts RPC failed: ${recErr.message}`);

  // Assert none of the victims were reverted to PENDING.
  const { data: after, error: afterErr } = await client
    .from('anchors')
    .select('id, status, chain_tx_id')
    .in('id', victimIds);
  if (afterErr) die(`CRASH re-select failed: ${afterErr.message}`);
  const reverted = (after ?? []).filter((r) => r.status === 'PENDING').length;
  if (reverted > 0) {
    die(`DOUBLE-BROADCAST RISK: ${reverted}/${victimIds.length} rows with chain_tx_id set were reverted to PENDING by recovery. The next drain would broadcast a SECOND tx for the same fingerprints.`);
  }

  // A forced drain must NOT emit a second, different tx for the crashed rows.
  await postDrain(apiBase, orgId);
  const { data: post, error: postErr } = await client
    .from('anchors')
    .select('chain_tx_id')
    .in('id', victimIds);
  if (postErr) die(`CRASH post-drain select failed: ${postErr.message}`);
  const txs = new Set((post ?? []).map((r) => r.chain_tx_id as string).filter(Boolean));
  // The only tx these rows should ever carry is the original crashTx.
  const foreign = [...txs].filter((t) => t !== crashTx);
  if (foreign.length > 0) {
    die(`DOUBLE-BROADCAST: crashed rows acquired a NEW chain_tx_id after re-drain: ${foreign.join(', ')}`);
  }
  return { reverted, secondBroadcastTxCount: foreign.length };
}

async function cleanup(client: SupabaseClient, orgId: string): Promise<number> {
  // Remove proofs first (FK-safe), then anchors, then the synthetic org.
  const ids = await anchorIdsForOrg(client, orgId);
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    await client.from('anchor_proofs').delete().in('anchor_id', ids.slice(i, i + CHUNK));
  }
  const { error } = await client.from('anchors').delete().eq('org_id', orgId);
  if (error) die(`cleanup anchors delete failed: ${error.message}`);
  await client.from('org_credits').delete().eq('org_id', orgId);
  await client.from('organizations').delete().eq('id', orgId);
  return ids.length;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const phase = args.phase ?? 'all';
  const count = parsePositiveInt(args.count, 10000, 'count');
  const pollTimeout = parsePositiveInt(args['poll-timeout'], 600, 'poll-timeout');
  const runId = args['run-id'] ?? randomBytes(4).toString('hex');
  const orgId = runOrgId(runId);
  const evidencePath = resolveEvidencePath(args['evidence-out']);

  const { client, ref } = makeRigClient();
  const needsApi = phase === 'drain' || phase === 'crash' || phase === 'all';
  const apiBase = needsApi ? resolveStagingApiBase(process.env as { STAGING_API_BASE?: string }) : undefined;

  const evidence: Evidence = { runId, ref, apiBase, phases: {}, startedAt: new Date().toISOString() };

  console.log(`▶ batch-drain-harness  phase=${safeForLog(phase)}  run=${safeForLog(runId)}  ref=${safeForLog(ref)}  org=${safeForLog(orgId)}`);
  if (apiBase) console.log(`  api_base=${safeForLog(apiBase)}`);
  console.log(`  count=${count}  poll-timeout=${pollTimeout}s`);
  if (args['dry-run']) {
    console.log('  --dry-run: validated env + safety guards, exiting without writing.');
    return;
  }

  const runSeed = phase === 'seed' || phase === 'all';
  const runDrain = phase === 'drain' || phase === 'all';
  const runProofs = phase === 'proofs' || phase === 'all';
  const runCrash = phase === 'crash' || phase === 'all';
  const runCleanup = phase === 'cleanup';

  if (runSeed) {
    console.log('── SEED ──');
    const inserted = await seedPending(client, orgId, count);
    const counts = await statusCounts(client, orgId);
    evidence.phases.seed = { inserted, counts };
    console.log(`  inserted=${inserted}  PENDING=${counts.PENDING}`);
  }

  if (runDrain) {
    console.log('── DRAIN (Trigger D: force=true) ──');
    const resp = await postDrain(apiBase!, orgId);
    console.log('  drain response accepted');
    const drained = await pollDrained(client, orgId, pollTimeout);
    const proof = await assertSingleBatch(client, orgId, count);
    evidence.phases.drain = { response: resp, drained, proof };
    console.log(`  ✔ ONE txId=${proof.distinctTxIds[0]}  ONE merkleRoot=${proof.distinctMerkleRoots[0].slice(0, 16)}…  submitted=${proof.submitted}`);
  }

  if (runProofs) {
    console.log('── PROOFS (positional anchor_proofs) ──');
    const pp = await assertPositionalProofs(client, orgId, count);
    evidence.phases.proofs = pp;
    console.log(`  ✔ proofRows=${pp.proofRows}  distinctMerkleIndices=${pp.distinctIndices}`);
  }

  if (runCrash) {
    console.log('── CRASH / reconcile (no double-broadcast) ──');
    const rec = await assertReconcileNoDoubleBroadcast(client, apiBase!, orgId);
    evidence.phases.crash = rec;
    console.log(`  ✔ reverted=${rec.reverted} (must be 0)  secondBroadcastTx=${rec.secondBroadcastTxCount} (must be 0)`);
  }

  if (runCleanup) {
    console.log('── CLEANUP ──');
    const removed = await cleanup(client, orgId);
    evidence.phases.cleanup = { removedAnchors: removed };
    console.log(`  removed ${removed} anchors + proofs + org`);
  }

  evidence.endedAt = new Date().toISOString();
  if (evidencePath) {
    writeEvidenceFile(evidencePath, evidence);
    console.log(`\n📄 Evidence written: ${evidencePath}`);
  }
  console.log('\n✅ batch-drain-harness complete.');
}

main().catch((err) => {
  console.error(`::error::batch-drain-harness failed: ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
