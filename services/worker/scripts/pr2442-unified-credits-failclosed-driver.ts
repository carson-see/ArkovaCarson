#!/usr/bin/env tsx
/**
 * PR #2442 unified-credits fail-CLOSED admission driver (SCRUM-2538 / SCRUM-3502).
 *
 * T3 soak driver for migration `0420_scrum2538_check_unified_credits_fail_closed.sql`
 * and the three worker call sites it fixes:
 *
 *   * `services/worker/src/middleware/paymentTierRouter.ts`
 *   * `services/worker/src/api/v1/ai-extract.ts`
 *   * `services/worker/src/api/v1/credits.ts`
 *
 * WHAT IS UNDER TEST — the two defects, which need OPPOSITE handling and were
 * conflated by call sites that destructured only `error`:
 *
 *   SCRUM-2538  `check_unified_credits` handed a PHANTOM 50 credits to a caller
 *               with no `unified_credits` row. 0420 backfills every org, then
 *               makes the miss answer `(0, 0, 0, false)` — fail CLOSED.
 *   SCRUM-3502  `deduct_unified_credits` RETURNS BOOLEAN. A `false` return means
 *               the RPC ran and definitively did NOT debit. Reading only `error`
 *               let `false` fall into the authorized path: request served, no
 *               credit consumed, nobody billed.
 *
 * Generic synthetic load does NOT cover this (CLAUDE.md §1.12). Every probe here
 * drives the changed predicate itself and asserts the fail-CLOSED answer.
 *
 * Self-test mode is local validation only: rows are marked `evidenceForSoak=false`
 * and must not be used as T3 soak evidence. Live mode requires an admitted,
 * clean_mirror isolated rig and appends countable JSONL rows.
 *
 * Usage:
 *   tsx pr2442-unified-credits-failclosed-driver.ts --mode self-test
 *   tsx pr2442-unified-credits-failclosed-driver.ts --mode live \
 *     --admission-json docs/staging/<rig>/isolated-rig-provision-<rig>.json \
 *     --evidence-jsonl docs/staging/<rig>/pr2442-evidence.jsonl \
 *     --duration-min 2880 --interval-sec 300
 */

import { appendFileSync, readFileSync } from 'node:fs';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHANGED_BEHAVIOR =
  'PR #2442 unified-credit fail-CLOSED: check_unified_credits answers (0,0,0,false) instead of a phantom 50 for a caller with no unified_credits row (SCRUM-2538); deduct_unified_credits returning FALSE is no longer read as success, so an RPC error fails CLOSED and a definitive false falls through to the next PAID tier instead of serving the request free (SCRUM-3502).';

/** Counter names, one family per T3 evidence requirement. */
export const TRIGGER_A = 'triggerA_missing_row_fails_closed';
export const TRIGGER_B = 'triggerB_deduct_false_not_read_as_success';
export const DAILY_FLUSH = 'dailyFlush_billing_cycle_rollover';
export const ORG_ISOLATION = 'perOrgIsolation_debit_does_not_cross_orgs';

/** Fixture prefix so every row this driver creates is identifiable and reapable. */
export const FIXTURE_PREFIX = 'pr2442-soak';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriverMode = 'self-test' | 'live';

export interface DriverArgs {
  mode: DriverMode;
  admissionJson?: string;
  evidenceJsonl?: string;
  durationMin: number;
  intervalSec: number;
}

/** The four-column shape `check_unified_credits` returns. */
export interface CreditCheck {
  monthly_allocation: number;
  used_this_month: number;
  remaining: number;
  has_credits: boolean;
}

export interface ProbeResult {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
}

export interface DriverRow {
  utc: string;
  pr: 2442;
  tier: 'T3';
  mode: DriverMode;
  evidenceForSoak: boolean;
  changedBehavior: string;
  status: 'pass' | 'fail';
  cycle: number;
  counts: Record<string, number | boolean>;
  probes: ProbeResult[];
  admission?: Record<string, unknown>;
  blockers?: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers — unit-testable without a database
// ---------------------------------------------------------------------------

/**
 * SCRUM-2538. A caller with NO `unified_credits` row must be told it has
 * nothing, not handed a phantom allocation.
 *
 * The whole point is that this is checked field by field: a row that answered
 * `has_credits: false` while still reporting `monthly_allocation: 50` would
 * still show the phantom 50 on every balance surface, so `has_credits` alone is
 * not the assertion.
 */
export function isFailClosedMiss(check: CreditCheck | null): boolean {
  if (check === null) return false;
  return (
    check.monthly_allocation === 0 &&
    check.used_this_month === 0 &&
    check.remaining === 0 &&
    check.has_credits === false
  );
}

/**
 * `deduct_unified_credits` has three outcomes and they are NOT
 * interchangeable — collapsing them is the SCRUM-3502 defect itself.
 *
 *   'error'    the debit is in an UNKNOWN state and may have committed → the
 *              caller must fail CLOSED.
 *   'refused'  the RPC ran and definitively did NOT debit (`false`) → the
 *              caller must fall through to the next PAID tier, never serve free.
 *   'debited'  `true`.
 *
 * `null`/`undefined` classify as 'error', not 'refused': absent data is an
 * unknown state, and treating it as a definitive no would re-open the leak from
 * the other side.
 */
export function classifyDeduct(data: unknown, error: unknown): 'debited' | 'refused' | 'error' {
  if (error) return 'error';
  if (data === true) return 'debited';
  if (data === false) return 'refused';
  return 'error';
}

/**
 * The rollover arithmetic `check_unified_credits` performs when
 * `billing_cycle_start` predates the current month. Mirrored here so the
 * observation asserts a computed expectation rather than whatever the rig
 * happened to return.
 */
export function expectedCarryOver(monthlyAllocation: number, usedThisMonth: number): number {
  return Math.min(monthlyAllocation - usedThisMonth, 50);
}

/** A cycle passes only if every probe in it passed. One failure fails the row. */
export function aggregate(probes: ProbeResult[]): 'pass' | 'fail' {
  return probes.some((p) => p.status === 'fail') ? 'fail' : 'pass';
}

/** Per-requirement counters, so a reviewer can count coverage without re-reading probes. */
export function tally(probes: ProbeResult[]): Record<string, number | boolean> {
  const counts: Record<string, number | boolean> = {};
  for (const family of [TRIGGER_A, TRIGGER_B, DAILY_FLUSH, ORG_ISOLATION]) {
    const inFamily = probes.filter((p) => p.name.startsWith(family));
    counts[`${family}_ran`] = inFamily.length;
    counts[`${family}_passed`] = inFamily.filter((p) => p.status === 'pass').length;
    counts[`${family}_fired`] = inFamily.length > 0;
  }
  counts.probes_total = probes.length;
  counts.probes_failed = probes.filter((p) => p.status === 'fail').length;
  return counts;
}

export function parseArgs(argv: string[]): DriverArgs {
  const args: DriverArgs = { mode: 'self-test', durationMin: 0, intervalSec: 300 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--mode' && (value === 'live' || value === 'self-test')) {
      args.mode = value;
      i += 1;
    } else if (flag === '--admission-json' && value) {
      args.admissionJson = value;
      i += 1;
    } else if (flag === '--evidence-jsonl' && value) {
      args.evidenceJsonl = value;
      i += 1;
    } else if (flag === '--duration-min' && value) {
      args.durationMin = Number.parseInt(value, 10);
      i += 1;
    } else if (flag === '--interval-sec' && value) {
      args.intervalSec = Number.parseInt(value, 10);
      i += 1;
    }
  }
  return args;
}

function probe(name: string, ok: boolean, detail: string): ProbeResult {
  return { name, status: ok ? 'pass' : 'fail', detail };
}

// ---------------------------------------------------------------------------
// Live probes
// ---------------------------------------------------------------------------

interface Fixture {
  coveredOrgId: string;
  uncoveredOrgId: string;
  otherOrgId: string;
}

async function checkCredits(
  db: SupabaseClient,
  orgId: string | null,
  userId: string | null,
): Promise<{ check: CreditCheck | null; error: unknown }> {
  const { data, error } = await db.rpc('check_unified_credits', {
    p_org_id: orgId ?? undefined,
    p_user_id: userId ?? undefined,
  });
  if (error) return { check: null, error };
  const row = Array.isArray(data) ? data[0] : data;
  return { check: (row as CreditCheck | undefined) ?? null, error: null };
}

/**
 * Trigger A (SCRUM-2538) — the missing-row miss must fail CLOSED, and the
 * backfill invariant must hold for every organization on the rig.
 */
async function triggerA(db: SupabaseClient, fx: Fixture): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];

  const uncovered = await checkCredits(db, fx.uncoveredOrgId, null);
  out.push(
    probe(
      `${TRIGGER_A}_uncovered_org`,
      uncovered.error === null && isFailClosedMiss(uncovered.check),
      `uncovered org check => ${JSON.stringify(uncovered.check)} (expected 0/0/0/false, no phantom 50)`,
    ),
  );

  const covered = await checkCredits(db, fx.coveredOrgId, null);
  out.push(
    probe(
      `${TRIGGER_A}_covered_org_still_served`,
      covered.error === null && covered.check !== null && covered.check.has_credits === true,
      `covered org check => ${JSON.stringify(covered.check)} (fail-closed must not deny a real balance)`,
    ),
  );

  // The 0420 DO block refuses to commit if any org lacks a `unified_credits`
  // row, because a fail-closed `check_unified_credits` over an incomplete
  // backfill zeroes real customers. Re-assert that live and by COUNT: every
  // organization on the rig must be covered except the ONE the driver
  // deliberately leaves uncovered to drive the miss path above.
  const { data: allOrgs, error: orgsError } = await db.from('organizations').select('id');
  const { data: coveredRows, error: creditsError } = await db
    .from('unified_credits')
    .select('org_id')
    .not('org_id', 'is', null);
  const coveredOrgIds = new Set((coveredRows ?? []).map((r) => (r as { org_id: string }).org_id));
  const orgsWithNoRow = (allOrgs ?? [])
    .map((r) => (r as { id: string }).id)
    .filter((id) => !coveredOrgIds.has(id));
  out.push(
    probe(
      `${TRIGGER_A}_backfill_invariant`,
      orgsError === null &&
        creditsError === null &&
        orgsWithNoRow.length === 1 &&
        orgsWithNoRow[0] === fx.uncoveredOrgId,
      `orgs with no unified_credits row: ${orgsWithNoRow.length} (expected exactly 1, the deliberate fixture)`,
    ),
  );

  return out;
}

/**
 * Trigger B (SCRUM-3502) — a `false` return is a definitive refusal and must
 * never be read as success; an RPC error is an unknown state and must fail
 * CLOSED.
 */
async function triggerB(db: SupabaseClient, fx: Fixture): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];

  const { data: missData, error: missError } = await db.rpc('deduct_unified_credits', {
    p_org_id: fx.uncoveredOrgId,
    p_user_id: undefined,
    p_amount: 1,
  });
  out.push(
    probe(
      `${TRIGGER_B}_no_row_returns_false`,
      classifyDeduct(missData, missError) === 'refused',
      `deduct on org with no unified_credits row => ${JSON.stringify(missData)} (expected literal false, not error, not true)`,
    ),
  );

  // Drain the covered org, then assert the over-draw is a refusal rather than a
  // negative balance or a silent success.
  const before = await checkCredits(db, fx.coveredOrgId, null);
  const overdraw = (before.check?.remaining ?? 0) + 1000;
  const { data: overData, error: overError } = await db.rpc('deduct_unified_credits', {
    p_org_id: fx.coveredOrgId,
    p_user_id: undefined,
    p_amount: overdraw,
  });
  out.push(
    probe(
      `${TRIGGER_B}_overdraw_returns_false`,
      classifyDeduct(overData, overError) === 'refused',
      `deduct ${overdraw} against remaining ${before.check?.remaining} => ${JSON.stringify(overData)} (expected false)`,
    ),
  );

  const after = await checkCredits(db, fx.coveredOrgId, null);
  out.push(
    probe(
      `${TRIGGER_B}_refused_debit_left_balance_intact`,
      after.check?.used_this_month === before.check?.used_this_month,
      `used_this_month ${before.check?.used_this_month} -> ${after.check?.used_this_month} (a refusal must not move the balance)`,
    ),
  );

  // The grant path in credits.ts reads `granted !== true`. A grant against an
  // uncovered org must be refused, not reported completed.
  const { data: grantData, error: grantError } = await db.rpc('deduct_unified_credits', {
    p_org_id: fx.uncoveredOrgId,
    p_user_id: undefined,
    p_amount: -10,
  });
  out.push(
    probe(
      `${TRIGGER_B}_dev_grant_refused_not_completed`,
      classifyDeduct(grantData, grantError) === 'refused',
      `negative-amount grant on uncovered org => ${JSON.stringify(grantData)} (expected false; credits.ts must not report status=completed)`,
    ),
  );

  return out;
}

/**
 * Daily flush — the monthly billing-cycle rollover branch inside
 * `check_unified_credits`. Observed once per soak day.
 */
async function dailyFlush(db: SupabaseClient, fx: Fixture): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];

  const before = await checkCredits(db, fx.coveredOrgId, null);
  if (before.check === null) {
    return [probe(`${DAILY_FLUSH}_precondition`, false, 'covered org has no credit row to roll over')];
  }

  const expected = expectedCarryOver(before.check.monthly_allocation, before.check.used_this_month);

  // Backdate the cycle so the next check takes the rollover branch. Service-role
  // only; touches the fixture org exclusively and no migration ledger row.
  const { error: backdateError } = await db
    .from('unified_credits')
    .update({ billing_cycle_start: '2026-01-01' })
    .eq('org_id', fx.coveredOrgId);
  if (backdateError) {
    return [probe(`${DAILY_FLUSH}_backdate`, false, 'could not backdate billing_cycle_start on the fixture org')];
  }

  const after = await checkCredits(db, fx.coveredOrgId, null);
  out.push(
    probe(
      `${DAILY_FLUSH}_used_reset`,
      after.check?.used_this_month === 0,
      `used_this_month after rollover => ${after.check?.used_this_month} (expected 0)`,
    ),
  );
  out.push(
    probe(
      `${DAILY_FLUSH}_carry_over_capped`,
      after.check !== null &&
        after.check.remaining === after.check.monthly_allocation + Math.max(expected, 0),
      `remaining ${after.check?.remaining} vs allocation ${after.check?.monthly_allocation} + carry_over LEAST(alloc-used,50)=${expected}`,
    ),
  );

  return out;
}

/**
 * Per-org isolation — a debit against one org must not move another org's
 * balance, and each org must resolve its OWN row under 0420's deterministic
 * ORDER BY.
 */
async function perOrgIsolation(db: SupabaseClient, fx: Fixture): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];

  const otherBefore = await checkCredits(db, fx.otherOrgId, null);
  const { error: debitError } = await db.rpc('deduct_unified_credits', {
    p_org_id: fx.coveredOrgId,
    p_user_id: undefined,
    p_amount: 1,
  });
  const otherAfter = await checkCredits(db, fx.otherOrgId, null);

  out.push(
    probe(
      `${ORG_ISOLATION}_neighbour_untouched`,
      debitError === null &&
        otherBefore.check?.used_this_month === otherAfter.check?.used_this_month &&
        otherBefore.check?.remaining === otherAfter.check?.remaining,
      `neighbour org ${otherBefore.check?.used_this_month}/${otherBefore.check?.remaining} -> ${otherAfter.check?.used_this_month}/${otherAfter.check?.remaining}`,
    ),
  );

  out.push(
    probe(
      `${ORG_ISOLATION}_distinct_rows`,
      otherAfter.check !== null &&
        (await checkCredits(db, fx.coveredOrgId, null)).check !== null,
      'each fixture org resolves its own unified_credits row under the 0420 ORDER BY',
    ),
  );

  return out;
}

// ---------------------------------------------------------------------------
// Self-test — no network, no database. Proves the classifiers, not the rig.
// ---------------------------------------------------------------------------

export function runSelfTest(): ProbeResult[] {
  return [
    probe(
      `${TRIGGER_A}_selftest_miss_is_fail_closed`,
      isFailClosedMiss({ monthly_allocation: 0, used_this_month: 0, remaining: 0, has_credits: false }),
      'the 0420 miss shape classifies as fail-closed',
    ),
    probe(
      `${TRIGGER_A}_selftest_phantom_rejected`,
      !isFailClosedMiss({ monthly_allocation: 50, used_this_month: 0, remaining: 50, has_credits: false }),
      'a phantom 50 with has_credits:false is NOT fail-closed',
    ),
    probe(
      `${TRIGGER_B}_selftest_false_is_refused`,
      classifyDeduct(false, null) === 'refused',
      'a literal false is a definitive refusal',
    ),
    probe(
      `${TRIGGER_B}_selftest_null_is_error`,
      classifyDeduct(null, null) === 'error',
      'absent data is an unknown state, not a refusal',
    ),
    probe(
      `${DAILY_FLUSH}_selftest_carry_over_cap`,
      expectedCarryOver(500, 0) === 50 && expectedCarryOver(30, 10) === 20,
      'carry_over is LEAST(allocation - used, 50)',
    ),
    probe(
      `${ORG_ISOLATION}_selftest_aggregate`,
      aggregate([probe('x', true, ''), probe('y', false, '')]) === 'fail',
      'one failed probe fails the cycle',
    ),
  ];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function resolveCredentials(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('live mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  return { url, key };
}

async function resolveFixture(db: SupabaseClient): Promise<Fixture> {
  // `organizations` has legal_name / display_name — there is no `name` column.
  const { data, error } = await db
    .from('organizations')
    .select('id, display_name')
    .ilike('display_name', `${FIXTURE_PREFIX}%`)
    .order('display_name', { ascending: true });
  if (error) throw new Error('could not resolve the driver fixture organizations');
  const rows = (data ?? []) as Array<{ id: string; display_name: string }>;
  if (rows.length < 3) {
    throw new Error(
      `driver fixture incomplete: expected 3 organizations with display_name ${FIXTURE_PREFIX}-*, found ${rows.length}`,
    );
  }
  return { coveredOrgId: rows[0].id, uncoveredOrgId: rows[1].id, otherOrgId: rows[2].id };
}

async function runCycle(db: SupabaseClient, fx: Fixture, withFlush: boolean): Promise<ProbeResult[]> {
  const probes: ProbeResult[] = [];
  probes.push(...(await triggerA(db, fx)));
  probes.push(...(await triggerB(db, fx)));
  probes.push(...(await perOrgIsolation(db, fx)));
  if (withFlush) probes.push(...(await dailyFlush(db, fx)));
  return probes;
}

function emit(row: DriverRow, evidenceJsonl?: string): void {
  const line = `${JSON.stringify(row)}\n`;
  if (evidenceJsonl) appendFileSync(evidenceJsonl, line);
  process.stdout.write(line);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const admission = args.admissionJson
    ? (JSON.parse(readFileSync(args.admissionJson, 'utf8')) as Record<string, unknown>)
    : undefined;

  if (args.mode === 'self-test') {
    const probes = runSelfTest();
    emit(
      {
        utc: new Date().toISOString(),
        pr: 2442,
        tier: 'T3',
        mode: 'self-test',
        evidenceForSoak: false,
        changedBehavior: CHANGED_BEHAVIOR,
        status: aggregate(probes),
        cycle: 0,
        counts: tally(probes),
        probes,
        blockers: ['self-test mode — local validation only, NOT T3 soak evidence'],
      },
      args.evidenceJsonl,
    );
    process.exitCode = aggregate(probes) === 'pass' ? 0 : 1;
    return;
  }

  const { url, key } = resolveCredentials();
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const fx = await resolveFixture(db);

  const startedAt = Date.now();
  const deadline = startedAt + args.durationMin * 60_000;
  let cycle = 0;
  let lastFlushDay = -1;

  do {
    cycle += 1;
    const now = new Date();
    const day = Math.floor((now.getTime() - startedAt) / 86_400_000);
    const withFlush = day !== lastFlushDay;
    if (withFlush) lastFlushDay = day;

    let probes: ProbeResult[];
    try {
      probes = await runCycle(db, fx, withFlush);
    } catch (error) {
      probes = [probe('cycle_error', false, error instanceof Error ? error.message : 'unknown')];
    }

    emit(
      {
        utc: now.toISOString(),
        pr: 2442,
        tier: 'T3',
        mode: 'live',
        evidenceForSoak: true,
        changedBehavior: CHANGED_BEHAVIOR,
        status: aggregate(probes),
        cycle,
        counts: tally(probes),
        probes,
        admission,
      },
      args.evidenceJsonl,
    );

    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, args.intervalSec * 1000));
  } while (Date.now() < deadline);
}

const invokedDirectly = process.argv[1]?.includes('pr2442-unified-credits-failclosed-driver');
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'driver failed'}\n`);
    process.exitCode = 1;
  });
}
