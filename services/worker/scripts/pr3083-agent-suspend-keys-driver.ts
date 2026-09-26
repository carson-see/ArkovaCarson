#!/usr/bin/env tsx
/**
 * PR #3083 agent-suspend-deactivates-keys admission driver
 * (`fix/agent-suspend-deactivates-keys`, head `c39dd9200`, T2).
 *
 * WHY THIS DRIVER EXISTS, NOT THE PR-1408 DEFAULT
 * ------------------------------------------------
 * `scripts/staging/provision-isolated-rig.sh` defaults `driver_path` to
 * `pr1408-chain-resilience-driver.ts` (chain retry/backoff/duplicate-tx
 * semantics). That drives ZERO of what #3083 changed. Set
 * `STAGING_DRIVER_PATH=services/worker/scripts/pr3083-agent-suspend-keys-driver.ts`
 * before provisioning, or the soak burns its window on the wrong surface and
 * produces green JSONL that says nothing about this PR.
 *
 * WHAT #3083 CHANGES
 * -------------------
 * Before: `middleware/apiKeyAuth.ts` authenticates a key by reading ONLY
 * `api_keys` (is_active / revoked_at / expires_at) — it never joins `agents`.
 * `PATCH /api/v1/agents/:agentId {status:'suspended'}` flipped the agent row
 * but left every one of that agent's keys live: a suspended agent kept
 * authenticating indefinitely.
 * After: `agents.ts`'s PATCH handler calls `setAgentKeysActive(agentId, orgId,
 * false)` BEFORE the agent row update on suspend (deactivating every currently
 * -active key, tagging `revocation_reason = 'admin:agent.suspended'`), and
 * `setAgentKeysActive(agentId, orgId, true)` AFTER the agent row update on
 * resume (reactivating ONLY keys still tagged with that exact marker).
 * `keys.ts`'s `UpdateKeySchema` gained a refine reserving the `admin:` and
 * `computeid:` revocation-reason prefixes so a caller can never revoke a key
 * FOR CAUSE under a string an automated resume path matches on.
 *
 * THE FIVE ASSERTIONS — how each is measured and how each can FAIL
 * -------------------------------------------------------------------
 *  1. SUSPEND_REJECTS_KEY — after suspending the agent, the SAME previously
 *     -minted key calling a real authenticated endpoint (`POST
 *     /api/v1/oracle/verify`) gets 401 `api_key_revoked` from
 *     `middleware/apiKeyAuth.ts` itself (the key never reaches the route
 *     handler). FAILS if the call still returns 200 — the exact pre-fix
 *     defect: a suspended agent's key kept authenticating because nothing
 *     read `agents.status`.
 *  2. RESUME_RESTORES_KEY — after resuming, the SAME key authenticates again
 *     (200). FAILS if it's still 401 — a regression in the reactivation
 *     branch (e.g. the `revocation_reason` filter never matching, or the
 *     resume write silently failing).
 *  3. SUSPEND_KEYS_COMMITTED_SYNCHRONOUSLY — see the SCOPING NOTE below. A
 *     direct, single (zero-retry) service-role read of the key's row
 *     immediately after the PATCH suspend response returns must ALREADY show
 *     `is_active=false` and `revocation_reason='admin:agent.suspended'`.
 *     FAILS if that immediate read still shows the key active — which is
 *     what a regression to a fire-and-forget write (the exact class of bug
 *     `touchApiKeyLastUsed` had — see `middleware/apiKeyAuth.ts`'s own
 *     comment on why `void <lazy-builder>` never fires) would produce.
 *  4. NEGATIVE_CONTROL_COMPUTEID_MARKER — a key revoked FOR CAUSE and tagged
 *     with a `computeid:`-prefixed marker BEFORE the suspend/resume cycle
 *     runs must read back byte-for-byte UNCHANGED afterward: still
 *     `is_active=false`, still the SAME `revocation_reason`. FAILS if the
 *     resume branch revives it (broadened its filter past the exact
 *     `admin:agent.suspended` marker) or mutates its reason. If this
 *     assertion cannot fail, the driver is not evidence that the marker
 *     reservation is real rather than a code comment.
 *  5. NON_STATUS_EDIT_PRESERVES_KEYS — a PATCH carrying only `{name: ...}`
 *     (no `status` field) must never touch the agent's keys. FAILS if the
 *     key's `is_active`/`revocation_reason` differ before vs. after the
 *     rename — which would mean the key-write branches stopped gating on
 *     `parsed.data.status === 'suspended' | 'active'` and started firing on
 *     the mere presence of a PATCH request.
 *
 * SCOPING NOTE ON ASSERTION 3 (read before citing it as ordering proof)
 * ---------------------------------------------------------------------------
 * The task frames this as "the writes are two round-trips ordered so the
 * restricting write commits first — assert keys are inactive even if the
 * agent row still reads active." That literal mid-request race window
 * (observing DB state BETWEEN the two round trips inside a single Express
 * handler invocation) is STRUCTURALLY UNREACHABLE from a black-box HTTP
 * driver: there is no fault-injection lever in this codebase that pauses or
 * fails the second write on demand, and a driver cannot attach a debugger to
 * the worker process to catch the gap between two `await`s inside one request
 * (this is the same class of problem PR #3087's driver hit with its
 * `queue_scope: 'member'` DS-04 combination — see that driver's own SCOPING
 * NOTE for the precedent this follows).
 *
 * What IS real and externally observable: the key deactivation write is
 * durable and synchronous with the request, not deferred. This driver reads
 * the key's row EXACTLY ONCE, with no poll/retry loop (every other assertion
 * in this file uses `pollUntil` with backoff; this one deliberately does not)
 * immediately after the HTTP response returns. If a future refactor turned
 * `setAgentKeysActive` into a fire-and-forget call — exactly the shape of the
 * `touchApiKeyLastUsed` bug this same codebase already shipped once, where
 * `void <lazy-supabase-builder>` discarded the write without ever invoking
 * `then` — this is the assertion that would catch it: the single synchronous
 * read would still see the key active. That is the nearest real regression
 * surface to "the restricting write commits first," and this file states
 * plainly that it is a substitute, not the literal race.
 *
 * Self-test mode is local validation only: rows are `evidenceForSoak=false`
 * and must never be cited as T2 soak evidence.
 */

import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  makeProbe as probe,
  aggregateProbes as aggregate,
  tallyProbes,
  parseDriverArgs,
  resolveSupabaseCredentials,
  ensureOrgWithAdmin,
  signInFixtureUser,
  fetchJson,
  runDriverMain,
  type ProbeResult,
  type BaseDriverArgs,
  type JsonHttpResult,
} from './lib/soak-driver-harness.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHANGED_BEHAVIOR =
  "PR #3083: PATCH /api/v1/agents/:agentId {status:'suspended'} now deactivates every one of the "
  + "agent's live API keys (tagged revocation_reason='admin:agent.suspended') BEFORE the agent row "
  + 'itself flips, and {status:\'active\'} restores only keys still carrying that exact marker AFTER '
  + 'the agent row flips. UpdateKeySchema now reserves the admin: and computeid: revocation-reason '
  + 'prefixes so a caller cannot revoke a key for cause under a string an automated resume matches on. '
  + 'A non-status edit (rename) must never touch keys.';

export const ASSERTION = {
  SUSPEND_REJECTS_KEY: 'suspend_rejects_key',
  RESUME_RESTORES_KEY: 'resume_restores_key',
  SUSPEND_KEYS_COMMITTED_SYNCHRONOUSLY: 'suspend_keys_committed_synchronously',
  NEGATIVE_CONTROL_COMPUTEID_MARKER: 'negative_control_computeid_marker_not_revived',
  NON_STATUS_EDIT_PRESERVES_KEYS: 'non_status_edit_preserves_keys',
} as const;

/** The exact marker `agents.ts`'s `setAgentKeysActive` writes/matches on. */
export const ADMIN_SUSPEND_REASON = 'admin:agent.suspended';

/** Fixture prefix so every row/user this driver creates is identifiable and reapable. */
export const FIXTURE_PREFIX = 'pr3083-soak';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ProbeResult };
export type DriverArgs = BaseDriverArgs;

export interface DriverRow {
  utc: string;
  pr: 3083;
  tier: 'T2';
  mode: BaseDriverArgs['mode'];
  evidenceForSoak: boolean;
  changedBehavior: string;
  status: 'pass' | 'fail';
  cycle: number;
  counts: Record<string, number | boolean>;
  probes: ProbeResult[];
  admission?: Record<string, unknown>;
  blockers?: string[];
}

/** Minimal shape this driver reads back off an `api_keys` row. */
export interface KeyFacts {
  is_active: boolean;
  revocation_reason: string | null;
}

// ---------------------------------------------------------------------------
// Pure classifiers — unit-testable without a network or a database.
// Every one returns a distinct pass/fail with its OWN detail string; none are
// collapsed into a shared boolean.
// ---------------------------------------------------------------------------

/** Assertion 1. The pre-fix defect is a 200 here — a suspended agent's key kept working. */
export function classifySuspendRejectsKey(httpStatusAfterSuspend: number): ProbeResult {
  if (httpStatusAfterSuspend === 200) {
    return probe(
      ASSERTION.SUSPEND_REJECTS_KEY,
      false,
      "authenticated call succeeded (200) with a suspended agent's key — the exact pre-fix defect: "
        + 'apiKeyAuth.ts reads only api_keys and never joins agents, so nothing stopped it authenticating',
    );
  }
  return probe(
    ASSERTION.SUSPEND_REJECTS_KEY,
    httpStatusAfterSuspend === 401,
    `httpStatus=${httpStatusAfterSuspend} (expected 401 api_key_revoked)`,
  );
}

/** Assertion 2. FAILS if the key never comes back to life after resume. */
export function classifyResumeRestoresKey(httpStatusAfterResume: number): ProbeResult {
  if (httpStatusAfterResume === 401) {
    return probe(
      ASSERTION.RESUME_RESTORES_KEY,
      false,
      "key is still rejected (401) after the agent was resumed — the reactivation branch's "
        + 'revocation_reason filter did not match, or the write silently failed',
    );
  }
  return probe(
    ASSERTION.RESUME_RESTORES_KEY,
    httpStatusAfterResume === 200,
    `httpStatus=${httpStatusAfterResume} (expected 200)`,
  );
}

/**
 * Assertion 3 — see the SCOPING NOTE in the file header. Reads the key's row
 * EXACTLY ONCE (no poll/retry) to prove the deactivation write is synchronous
 * with the request, not deferred.
 */
export function classifySuspendKeysCommittedSynchronously(args: {
  isActiveImmediatelyAfter: boolean;
  revocationReasonImmediatelyAfter: string | null;
}): ProbeResult {
  const deactivated = args.isActiveImmediatelyAfter === false;
  const tagged = args.revocationReasonImmediatelyAfter === ADMIN_SUSPEND_REASON;
  if (!deactivated) {
    return probe(
      ASSERTION.SUSPEND_KEYS_COMMITTED_SYNCHRONOUSLY,
      false,
      'a single, zero-retry read immediately after the suspend response still shows the key '
        + 'is_active=true — the restricting write is not committed synchronously with the request '
        + '(the touchApiKeyLastUsed fire-and-forget class of bug)',
    );
  }
  return probe(
    ASSERTION.SUSPEND_KEYS_COMMITTED_SYNCHRONOUSLY,
    tagged,
    `is_active=${args.isActiveImmediatelyAfter}, revocation_reason=${args.revocationReasonImmediatelyAfter ?? '(null)'} `
      + `(expected is_active=false, revocation_reason=${ADMIN_SUSPEND_REASON})`,
  );
}

/**
 * Assertion 4 — THE NEGATIVE CONTROL. A key already revoked for cause under a
 * `computeid:` marker must read back byte-for-byte unchanged after a full
 * suspend/resume cycle on its own agent. A driver that cannot FAIL this is
 * not evidence that the marker reservation / narrow resume filter is real.
 */
export function classifyNegativeControlComputeId(args: {
  reasonBefore: string;
  activeBefore: boolean;
  reasonAfter: string | null;
  activeAfter: boolean;
}): ProbeResult {
  if (args.activeAfter) {
    return probe(
      ASSERTION.NEGATIVE_CONTROL_COMPUTEID_MARKER,
      false,
      `a for-cause-revoked key (reason=${args.reasonBefore}) was REVIVED by an unrelated admin resume — `
        + "the reactivation filter is broader than the exact 'admin:agent.suspended' marker",
    );
  }
  if (args.reasonAfter !== args.reasonBefore) {
    return probe(
      ASSERTION.NEGATIVE_CONTROL_COMPUTEID_MARKER,
      false,
      `revocation_reason changed from '${args.reasonBefore}' to '${args.reasonAfter ?? '(null)'}' — `
        + 'the for-cause marker was overwritten even though the key stayed inactive',
    );
  }
  return probe(
    ASSERTION.NEGATIVE_CONTROL_COMPUTEID_MARKER,
    args.activeBefore === false && args.activeAfter === false,
    `reason unchanged ('${args.reasonAfter}'), is_active before/after = `
      + `${args.activeBefore}/${args.activeAfter} (expected false/false throughout)`,
  );
}

/** Assertion 5. A rename must be inert with respect to keys. */
export function classifyNonStatusEditPreservesKeys(args: {
  activeBefore: boolean;
  activeAfter: boolean;
  reasonBefore: string | null;
  reasonAfter: string | null;
}): ProbeResult {
  const unchanged = args.activeBefore === args.activeAfter && args.reasonBefore === args.reasonAfter;
  return probe(
    ASSERTION.NON_STATUS_EDIT_PRESERVES_KEYS,
    unchanged && args.activeBefore === true,
    `is_active ${args.activeBefore} -> ${args.activeAfter}, revocation_reason `
      + `${args.reasonBefore ?? '(null)'} -> ${args.reasonAfter ?? '(null)'} (expected both unchanged, `
      + 'active throughout — a rename PATCH carries no status field and must not gate a key write)',
  );
}

export { aggregate };

/** Per-assertion counters, so a reviewer can count coverage without re-reading probes. */
export function tally(probes: ProbeResult[]): Record<string, number | boolean> {
  return tallyProbes(probes, Object.values(ASSERTION));
}

// ---------------------------------------------------------------------------
// Self-test — no network, no database. Proves the classifiers, not the rig.
// ---------------------------------------------------------------------------

export function runSelfTest(): ProbeResult[] {
  return [
    classifySuspendRejectsKey(401),
    probe(
      `${ASSERTION.SUSPEND_REJECTS_KEY}_selftest_rejects_prefix_defect`,
      classifySuspendRejectsKey(200).status === 'fail',
      'a 200 after suspend (the pre-fix defect) must classify as a fail, not a pass',
    ),
    classifyResumeRestoresKey(200),
    probe(
      `${ASSERTION.RESUME_RESTORES_KEY}_selftest_rejects_still_dead`,
      classifyResumeRestoresKey(401).status === 'fail',
      'a still-401 key after resume must fail, not be treated as "eventually consistent"',
    ),
    classifySuspendKeysCommittedSynchronously({
      isActiveImmediatelyAfter: false,
      revocationReasonImmediatelyAfter: ADMIN_SUSPEND_REASON,
    }),
    probe(
      `${ASSERTION.SUSPEND_KEYS_COMMITTED_SYNCHRONOUSLY}_selftest_rejects_fire_and_forget`,
      classifySuspendKeysCommittedSynchronously({
        isActiveImmediatelyAfter: true,
        revocationReasonImmediatelyAfter: null,
      }).status === 'fail',
      'a key still active on the very next read must fail — this is the fire-and-forget regression shape',
    ),
    probe(
      `${ASSERTION.SUSPEND_KEYS_COMMITTED_SYNCHRONOUSLY}_selftest_rejects_wrong_marker`,
      classifySuspendKeysCommittedSynchronously({
        isActiveImmediatelyAfter: false,
        revocationReasonImmediatelyAfter: 'some-other-reason',
      }).status === 'fail',
      'deactivated but under the wrong marker must fail — a later resume could never distinguish it',
    ),
    classifyNegativeControlComputeId({
      reasonBefore: 'computeid:economic_abuse_fixture',
      activeBefore: false,
      reasonAfter: 'computeid:economic_abuse_fixture',
      activeAfter: false,
    }),
    probe(
      `${ASSERTION.NEGATIVE_CONTROL_COMPUTEID_MARKER}_selftest_rejects_revival`,
      classifyNegativeControlComputeId({
        reasonBefore: 'computeid:economic_abuse_fixture',
        activeBefore: false,
        reasonAfter: 'computeid:economic_abuse_fixture',
        activeAfter: true,
      }).status === 'fail',
      'a revived for-cause key must fail regardless of anything else — this is the negative control',
    ),
    probe(
      `${ASSERTION.NEGATIVE_CONTROL_COMPUTEID_MARKER}_selftest_rejects_reason_overwrite`,
      classifyNegativeControlComputeId({
        reasonBefore: 'computeid:economic_abuse_fixture',
        activeBefore: false,
        reasonAfter: null,
        activeAfter: false,
      }).status === 'fail',
      "a cleared/overwritten reason must fail even if the key stayed inactive — the for-cause marker "
        + 'itself must survive untouched',
    ),
    classifyNonStatusEditPreservesKeys({
      activeBefore: true, activeAfter: true, reasonBefore: null, reasonAfter: null,
    }),
    probe(
      `${ASSERTION.NON_STATUS_EDIT_PRESERVES_KEYS}_selftest_rejects_incidental_deactivation`,
      classifyNonStatusEditPreservesKeys({
        activeBefore: true, activeAfter: false, reasonBefore: null, reasonAfter: 'admin:agent.suspended',
      }).status === 'fail',
      'a rename that deactivated the key must fail — a non-status PATCH must be fully inert on keys',
    ),
    probe('aggregate_selftest', aggregate([probe('x', true, ''), probe('y', false, '')]) === 'fail',
      'one failed probe fails the whole cycle'),
  ];
}

// ---------------------------------------------------------------------------
// Live fixtures + probes
// ---------------------------------------------------------------------------

interface FixtureIdentity {
  orgId: string;
  orgAdminUserId: string;
  orgAdminEmail: string;
  orgAdminPassword: string;
}

/**
 * Idempotent, re-runnable fixture setup: one org, one ORG_ADMIN owner. A
 * fixed, deterministic password lets a re-run (interrupted soak resume) sign
 * in as the same identity rather than accumulating duplicates or losing the
 * ability to authenticate.
 */
async function ensureFixtureIdentity(db: SupabaseClient): Promise<FixtureIdentity> {
  const ownerEmail = `${FIXTURE_PREFIX}-owner@arkova-soak.invalid`;
  const orgDisplayName = `${FIXTURE_PREFIX}-org`;
  // Re-using a stable password across resumed runs by storing it on the
  // profile row would leak a credential into a durable table. Instead: if the
  // auth user already exists, `ensureFixtureAuthUser` returns its id without
  // touching its password, and re-signing-in requires the SAME password used
  // to create it — so it is deterministically derived from the fixture email
  // rather than randomized per run. Not a secret (fixture-only, soak rig
  // only): the goal is resumability, not confidentiality.
  const password = `Pr3083Soak-${Buffer.from(ownerEmail).toString('hex').slice(0, 24)}-Aa1!`;

  const { orgId, orgAdminUserId } = await ensureOrgWithAdmin(db, { ownerEmail, orgDisplayName, password });

  return { orgId, orgAdminUserId, orgAdminEmail: ownerEmail, orgAdminPassword: password };
}

async function callWorker(
  targetUrl: string,
  path: string,
  init: { method: string; bearerToken?: string; apiKey?: string; body?: unknown },
): Promise<JsonHttpResult> {
  const headers: Record<string, string> = {};
  if (init.bearerToken) headers.authorization = `Bearer ${init.bearerToken}`;
  if (init.apiKey) headers.authorization = `Bearer ${init.apiKey}`;
  return fetchJson(targetUrl, path, { method: init.method, headers, body: init.body });
}

async function fetchKeyFacts(db: SupabaseClient, orgId: string, keyId: string): Promise<KeyFacts> {
  const { data, error } = await db
    .from('api_keys')
    .select('is_active, revocation_reason')
    .eq('org_id', orgId)
    .eq('id', keyId)
    .single();
  if (error || !data) throw new Error(`api_keys lookup failed for ${keyId}: ${error?.message}`);
  return data as KeyFacts;
}

/** One full pass over all five assertions. */
async function runCycle(
  db: SupabaseClient,
  targetUrl: string,
  fx: FixtureIdentity,
  bearerToken: string,
  cycle: number,
): Promise<ProbeResult[]> {
  const probes: ProbeResult[] = [];
  const suffix = `${Date.now()}-${cycle}`;
  const agentName = `${FIXTURE_PREFIX}-agent-${suffix}`;

  // ── Register a fresh agent + mint its live key ──────────────────────────
  const createRes = await callWorker(targetUrl, '/api/v1/agents', {
    method: 'POST',
    bearerToken,
    body: { name: agentName, agent_type: 'custom', allowed_scopes: ['verify'] },
  });
  const agentId = createRes.body.id as string | undefined;
  if (createRes.httpStatus !== 201 || !agentId) {
    return [probe('cycle_setup_agent_create', false, `agent create failed: httpStatus=${createRes.httpStatus}, body=${JSON.stringify(createRes.body)}`)];
  }

  const keyRes = await callWorker(targetUrl, `/api/v1/agents/${agentId}/key`, { method: 'POST', bearerToken });
  const rawKey = (keyRes.body as { key?: { raw?: string; id?: string } }).key?.raw
    ?? (keyRes.body as { raw?: string }).raw;
  const keyId = (keyRes.body as { key?: { id?: string } }).key?.id ?? (keyRes.body as { id?: string }).id;
  if (keyRes.httpStatus !== 201 && keyRes.httpStatus !== 200) {
    return [probe('cycle_setup_key_mint', false, `key mint failed: httpStatus=${keyRes.httpStatus}, body=${JSON.stringify(keyRes.body)}`)];
  }
  if (!rawKey || !keyId) {
    return [probe('cycle_setup_key_mint', false, `key mint response missing raw key or id: ${JSON.stringify(keyRes.body)}`)];
  }

  // ── Assertion 5 first, on the pristine active state — a rename must be inert ──
  const beforeRename = await fetchKeyFacts(db, fx.orgId, keyId);
  const renameRes = await callWorker(targetUrl, `/api/v1/agents/${agentId}`, {
    method: 'PATCH',
    bearerToken,
    body: { name: `${agentName}-renamed` },
  });
  // A rejected PATCH (4xx/5xx) trivially satisfies "keys unchanged" — nothing
  // ran. That is a false positive, not evidence the rename path is inert on
  // keys. Require the write to have actually applied before asserting on it.
  if (renameRes.httpStatus !== 200) {
    return [probe(
      'cycle_setup_rename_call',
      false,
      `rename PATCH failed: httpStatus=${renameRes.httpStatus}, body=${JSON.stringify(renameRes.body)} — `
        + 'cannot assert keys were preserved by a request that was itself rejected',
    )];
  }
  const afterRename = await fetchKeyFacts(db, fx.orgId, keyId);
  probes.push(classifyNonStatusEditPreservesKeys({
    activeBefore: beforeRename.is_active,
    activeAfter: afterRename.is_active,
    reasonBefore: beforeRename.revocation_reason,
    reasonAfter: afterRename.revocation_reason,
  }));

  // ── Seed the negative-control key: for-cause revoked, computeid: marker, BEFORE the cycle ──
  const negControlReason = `computeid:economic_abuse_fixture-${suffix}`;
  const { data: negKey, error: negKeyError } = await db
    .from('api_keys')
    .insert({
      org_id: fx.orgId,
      agent_id: agentId,
      key_prefix: `ak_seed_${suffix}`.slice(0, 16),
      key_hash: randomBytes(32).toString('hex'),
      name: `${agentName} — for-cause fixture key`,
      scopes: ['verify'],
      created_by: fx.orgAdminUserId,
      is_active: false,
      revoked_at: new Date().toISOString(),
      revocation_reason: negControlReason,
    })
    .select('id')
    .single();
  if (negKeyError || !negKey) {
    return [probe('cycle_setup_negative_control_seed', false, `could not seed for-cause key: ${negKeyError?.message}`)];
  }
  const negKeyId = (negKey as { id: string }).id;
  const negBefore = await fetchKeyFacts(db, fx.orgId, negKeyId);

  // ── Assertion 3: suspend, then a SINGLE synchronous (no-retry) read ──
  const suspendRes = await callWorker(targetUrl, `/api/v1/agents/${agentId}`, {
    method: 'PATCH',
    bearerToken,
    body: { status: 'suspended' },
  });
  if (suspendRes.httpStatus !== 200) {
    return [probe('cycle_suspend_call', false, `suspend PATCH failed: httpStatus=${suspendRes.httpStatus}, body=${JSON.stringify(suspendRes.body)}`)];
  }
  const immediatelyAfterSuspend = await fetchKeyFacts(db, fx.orgId, keyId);
  probes.push(classifySuspendKeysCommittedSynchronously({
    isActiveImmediatelyAfter: immediatelyAfterSuspend.is_active,
    revocationReasonImmediatelyAfter: immediatelyAfterSuspend.revocation_reason,
  }));

  // ── Assertion 1: the same raw key must now be rejected by a real authenticated endpoint ──
  const oracleAfterSuspend = await callWorker(targetUrl, '/api/v1/oracle/verify', {
    method: 'POST',
    apiKey: rawKey,
    body: { public_ids: [`${FIXTURE_PREFIX}-nonexistent-${suffix}`] },
  });
  probes.push(classifySuspendRejectsKey(oracleAfterSuspend.httpStatus));

  // ── Assertion 2: resume, then the same key must authenticate again ──
  const resumeRes = await callWorker(targetUrl, `/api/v1/agents/${agentId}`, {
    method: 'PATCH',
    bearerToken,
    body: { status: 'active' },
  });
  if (resumeRes.httpStatus !== 200) {
    return [...probes, probe('cycle_resume_call', false, `resume PATCH failed: httpStatus=${resumeRes.httpStatus}, body=${JSON.stringify(resumeRes.body)}`)];
  }
  const oracleAfterResume = await callWorker(targetUrl, '/api/v1/oracle/verify', {
    method: 'POST',
    apiKey: rawKey,
    body: { public_ids: [`${FIXTURE_PREFIX}-nonexistent-${suffix}`] },
  });
  probes.push(classifyResumeRestoresKey(oracleAfterResume.httpStatus));

  // ── Assertion 4: the negative control must read back unchanged after the whole cycle ──
  const negAfter = await fetchKeyFacts(db, fx.orgId, negKeyId);
  probes.push(classifyNegativeControlComputeId({
    reasonBefore: negBefore.revocation_reason ?? negControlReason,
    activeBefore: negBefore.is_active,
    reasonAfter: negAfter.revocation_reason,
    activeAfter: negAfter.is_active,
  }));

  return probes;
}

// ---------------------------------------------------------------------------
// CLI + runner
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): DriverArgs {
  return parseDriverArgs(argv, {}, []);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await runDriverMain(args, {
    pr: 3083,
    tier: 'T2',
    changedBehavior: CHANGED_BEHAVIOR,
    assertionNames: Object.values(ASSERTION),
    selfTestBlockers: ['self-test mode — local validation only, NOT T2 soak evidence'],
    runSelfTest,
    resolveCreds: () => resolveSupabaseCredentials({ requireAnonKey: true }),
    setupFixture: (db) => ensureFixtureIdentity(db),
    runCycle: async (db, targetUrl, creds, fx, cycle) => {
      // Fresh sign-in EVERY cycle rather than one token captured before the
      // loop — see `signInFixtureUser`'s own doc comment for the incident
      // this avoids.
      const bearerToken = await signInFixtureUser(creds.url, creds.anonKey, fx.orgAdminEmail, fx.orgAdminPassword);
      return runCycle(db, targetUrl, fx, bearerToken, cycle);
    },
  });
}

const invokedDirectly = process.argv[1]?.includes('pr3083-agent-suspend-keys-driver');
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'driver failed'}\n`);
    process.exitCode = 1;
  }
}
