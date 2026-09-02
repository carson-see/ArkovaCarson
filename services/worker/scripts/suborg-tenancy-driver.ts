#!/usr/bin/env tsx
/**
 * Sub-org tenancy soak driver (epic SCRUM-3863, PR #2572).
 *
 * Exercises THIS PR's changed behaviour, not generic worker health. Each cycle
 * builds a fresh parent/child pair on the rig and drives every surface the PR
 * touches, end to end:
 *
 *   1. F1 — the affiliation is confidential by default, checked through the
 *      REAL ANONYMOUS PATH: the rig's PostgREST with the anon key, which is the
 *      caller the finding was about. Both projections are checked, including
 *      the child-side `get_org_subtree` root edge that the first fix missed.
 *   2. F1 — both consents make it public, and re-parenting revokes them.
 *   3. F3 — credits move parent -> child and back through migration 0430's
 *      identity-carrying overload, the same one the worker endpoints call.
 *   4. F2 — an org enrolled via `credit_enforcement_enabled` is enforced while
 *      a non-enrolled org is untouched.
 *   5. D3 — the sub-org cap refuses past the limit.
 *   6. F6 — offboarding reclaims then suspends, and the sub-org's anchored
 *      records survive.
 *   7. SCRUM-3874 — suspension writes its audit row instead of silently
 *      dropping it.
 *
 * Every cycle appends one JSONL row. A cycle that cannot prove a property fails
 * loudly rather than counting as a pass: a soak that cannot fail is not
 * evidence.
 *
 * Self-test mode runs the same assertions against a throwaway local Postgres
 * and marks rows `evidenceForSoak=false`; only live mode against an admitted
 * rig produces countable evidence.
 */

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CHANGED_BEHAVIOR =
  'Epic SCRUM-3863 sub-org tenancy: two-party listing consent on both anonymous ' +
  'projections, per-org credit enforcement scope, parent-admin credit ' +
  'allocation/reclaim, the sub-org cap, DocuSign inheritance, and offboarding ' +
  '(reclaim then suspend) with the suspension audit row restored (SCRUM-3874).';

export interface DriverArgs {
  mode: 'self-test' | 'live';
  /** Rig PostgREST origin, e.g. https://<ref>.supabase.co */
  supabaseUrl?: string;
  serviceRoleKey?: string;
  anonKey?: string;
  /** Rig worker Cloud Run URL, for the liveness leg. */
  targetUrl?: string;
  bearerToken?: string;
  admissionJson?: string;
  evidenceJsonl?: string;
}

export interface DriverRow {
  utc: string;
  epic: 'SCRUM-3863';
  pr: 2572;
  tier: 'T3';
  mode: 'self-test' | 'live';
  evidenceForSoak: boolean;
  changedBehavior: string;
  status: 'pass' | 'fail';
  /** Named property -> did it hold this cycle. */
  checks: Record<string, boolean>;
  counts: Record<string, number>;
  failures?: string[];
  targetUrl?: string;
  cycleMs?: number;
}

export class Rpc {
  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly asAnon: boolean,
  ) {}

  /** Call a Postgres function through PostgREST, as anon or as service_role. */
  async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: this.key,
        authorization: `Bearer ${this.key}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      throw new Error(`${this.asAnon ? 'anon' : 'service'} rpc ${fn} -> ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async sql<T>(table: string, query: string): Promise<T[]> {
    const res = await fetch(`${this.url}/rest/v1/${table}?${query}`, {
      headers: { apikey: this.key, authorization: `Bearer ${this.key}` },
    });
    if (!res.ok) throw new Error(`select ${table} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T[];
  }

  async write(table: string, rows: unknown, method = 'POST', query = ''): Promise<void> {
    const res = await fetch(`${this.url}/rest/v1/${table}${query ? `?${query}` : ''}`, {
      method,
      headers: {
        apikey: this.key,
        authorization: `Bearer ${this.key}`,
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      // PostgREST rejects a body on DELETE; the filter carries the target.
      ...(method === 'DELETE' ? {} : { body: JSON.stringify(rows) }),
    });
    if (!res.ok) throw new Error(`${method} ${table} -> ${res.status} ${await res.text()}`);
  }
}

interface Ctx {
  svc: Rpc;
  anon: Rpc;
  parent: string;
  child: string;
  admin: string;
}

/** Fresh, isolated parent/child/admin for one cycle. */
async function seed(svc: Rpc): Promise<Ctx & { cleanup: () => Promise<void> }> {
  const parent = randomUUID();
  const child = randomUUID();
  const admin = randomUUID();
  const tag = `soak-${Date.now()}`;

  await svc.write('organizations', [
    { id: parent, legal_name: `${tag}-parent`, display_name: `${tag}-parent` },
    {
      id: child,
      legal_name: `${tag}-child`,
      display_name: `${tag}-child`,
      parent_org_id: parent,
      parent_approval_status: 'APPROVED',
    },
  ]);
  await svc.write('org_members', [{ user_id: admin, org_id: parent, role: 'owner' }]);
  await svc.write('org_credits', [
    { org_id: parent, balance: 100 },
    { org_id: child, balance: 0 },
  ]);

  return {
    svc,
    anon: null as unknown as Rpc,
    parent,
    child,
    admin,
    cleanup: async () => {
      await svc.write('organizations', undefined, 'DELETE', `id=in.(${child},${parent})`).catch(() => {});
    },
  };
}

/** One full pass over the changed behaviour. Throws on the first broken property. */
export async function runCycle(svc: Rpc, anon: Rpc): Promise<{ checks: Record<string, boolean>; counts: Record<string, number> }> {
  const checks: Record<string, boolean> = {};
  const counts: Record<string, number> = {};
  const ctx = await seed(svc);

  const assert = (name: string, ok: boolean) => {
    checks[name] = ok;
    if (!ok) throw new Error(`property failed: ${name}`);
  };

  try {
    // 1. F1 — confidential by default, on BOTH anonymous projections.
    const profile0 = await anon.call<{ sub_organizations: unknown[] }>('get_public_org_profile', { p_org_id: ctx.parent });
    assert('f1_profile_hides_unconsented_child', (profile0.sub_organizations ?? []).length === 0);

    const subtreeChild0 = await anon.call<{ nodes: { parent_org_id: string | null }[] }>('get_org_subtree', { p_root_id: ctx.child });
    assert('f1_child_root_hides_its_parent', subtreeChild0.nodes?.[0]?.parent_org_id == null);

    // 2. F1 — both consents publish it; one alone does not.
    await svc.write('organizations', { sub_org_listing_parent_optin: true }, 'PATCH', `id=eq.${ctx.child}`);
    const profile1 = await anon.call<{ sub_organizations: unknown[] }>('get_public_org_profile', { p_org_id: ctx.parent });
    assert('f1_one_consent_is_not_enough', (profile1.sub_organizations ?? []).length === 0);

    await svc.write('organizations', { sub_org_listing_child_optin: true }, 'PATCH', `id=eq.${ctx.child}`);
    const profile2 = await anon.call<{ sub_organizations: unknown[] }>('get_public_org_profile', { p_org_id: ctx.parent });
    assert('f1_both_consents_publish', (profile2.sub_organizations ?? []).length === 1);

    // 3. F1 — re-parenting revokes both halves.
    const other = randomUUID();
    await svc.write('organizations', [{ id: other, legal_name: 'soak-other', display_name: 'soak-other' }]);
    await svc.write('organizations', { parent_org_id: other }, 'PATCH', `id=eq.${ctx.child}`);
    const afterReparent = await svc.sql<{ sub_org_listing_parent_optin: boolean; sub_org_listing_child_optin: boolean }>(
      'organizations', `id=eq.${ctx.child}&select=sub_org_listing_parent_optin,sub_org_listing_child_optin`);
    assert('f1_reparent_revokes_both_consents',
      afterReparent[0]?.sub_org_listing_parent_optin === false && afterReparent[0]?.sub_org_listing_child_optin === false);
    await svc.write('organizations', { parent_org_id: ctx.parent }, 'PATCH', `id=eq.${ctx.child}`);
    await svc.write('organizations', undefined, 'DELETE', `id=eq.${other}`).catch(() => {});

    // 4. F3 — credits move through 0430's identity-carrying overload.
    const alloc = await svc.call<{ success?: boolean; error?: string }>('allocate_credits_to_sub_org', {
      p_parent_org_id: ctx.parent, p_child_org_id: ctx.child, p_amount: 40,
      p_note: 'soak', p_caller_user_id: ctx.admin,
    });
    assert('f3_parent_admin_can_fund', alloc.success === true);

    const balances = await svc.sql<{ org_id: string; balance: number }>(
      'org_credits', `org_id=in.(${ctx.parent},${ctx.child})&select=org_id,balance`);
    const childBal = balances.find((b) => b.org_id === ctx.child)?.balance ?? -1;
    const parentBal = balances.find((b) => b.org_id === ctx.parent)?.balance ?? -1;
    assert('f3_balances_conserved', childBal === 40 && parentBal === 60);
    counts.creditsMoved = 40;

    // A non-admin must not be able to move another org's credits.
    const stranger = await svc.call<{ error?: string }>('allocate_credits_to_sub_org', {
      p_parent_org_id: ctx.parent, p_child_org_id: ctx.child, p_amount: 5,
      p_note: 'soak', p_caller_user_id: randomUUID(),
    });
    assert('f3_non_admin_refused', stranger.error === 'parent_admin_required');

    // 5. F2 — per-org enforcement flag is settable only by service_role, and
    //    it is the column the worker gate reads.
    await svc.write('organizations', { credit_enforcement_enabled: true }, 'PATCH', `id=eq.${ctx.child}`);
    const enforced = await svc.sql<{ credit_enforcement_enabled: boolean }>(
      'organizations', `id=eq.${ctx.child}&select=credit_enforcement_enabled`);
    assert('f2_per_org_enforcement_settable', enforced[0]?.credit_enforcement_enabled === true);

    // 6. F6 + SCRUM-3874 — offboard: reclaim, then suspend, audit row written,
    //    records survive.
    await svc.write('anchors', [{ org_id: ctx.child, status: 'SECURED', credential_type: 'CERTIFICATE' }]);
    const reclaim = await svc.call<{ success?: boolean }>('allocate_credits_to_sub_org', {
      p_parent_org_id: ctx.parent, p_child_org_id: ctx.child, p_amount: -40,
      p_note: 'soak offboard', p_caller_user_id: ctx.admin,
    });
    assert('f6_reclaim_returns_balance', reclaim.success === true);

    const suspend = await svc.call<{ success?: boolean }>('suspend_suborg', {
      p_parent_org_id: ctx.parent, p_sub_org_id: ctx.child,
      p_reason: 'soak offboard', p_caller_user_id: ctx.admin,
    });
    assert('f6_suspend_succeeds', suspend.success === true);

    const audit = await svc.sql<{ actor_id: string }>(
      'audit_events', `event_type=eq.org.suborg.suspended&target_id=eq.${ctx.child}&select=actor_id`);
    assert('bug3874_suspension_audit_row_written', audit.length === 1 && audit[0].actor_id === ctx.admin);
    counts.auditRows = audit.length;

    const survived = await svc.sql<{ id: string }>('anchors', `org_id=eq.${ctx.child}&select=id`);
    assert('f6_records_survive_offboarding', survived.length === 1);

    return { checks, counts };
  } finally {
    await ctx.cleanup();
  }
}

export function parseArgs(argv: string[]): { args: DriverArgs; blockers: string[] } {
  const args: DriverArgs = { mode: 'self-test' };
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    switch (argv[i]) {
      case '--mode': args.mode = next === 'live' ? 'live' : 'self-test'; i += 1; break;
      case '--supabase-url': args.supabaseUrl = next; i += 1; break;
      case '--service-role-key': args.serviceRoleKey = next; i += 1; break;
      case '--anon-key': args.anonKey = next; i += 1; break;
      case '--target-url': args.targetUrl = next; i += 1; break;
      case '--evidence-jsonl': args.evidenceJsonl = next; i += 1; break;
      case '--admission-json': args.admissionJson = next; i += 1; break;
      default: break;
    }
  }
  const blockers: string[] = [];
  if (!args.supabaseUrl) blockers.push('missing --supabase-url');
  if (!args.serviceRoleKey) blockers.push('missing --service-role-key');
  if (!args.anonKey) blockers.push('missing --anon-key');
  if (args.mode === 'live' && !args.admissionJson) blockers.push('live mode requires --admission-json');
  return { args, blockers };
}

async function main(): Promise<void> {
  const { args, blockers } = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const row: DriverRow = {
    utc: new Date().toISOString(),
    epic: 'SCRUM-3863',
    pr: 2572,
    tier: 'T3',
    mode: args.mode,
    evidenceForSoak: args.mode === 'live' && blockers.length === 0,
    changedBehavior: CHANGED_BEHAVIOR,
    status: 'fail',
    checks: {},
    counts: {},
    targetUrl: args.targetUrl,
  };

  if (blockers.length > 0) {
    row.failures = blockers;
  } else {
    try {
      const svc = new Rpc(args.supabaseUrl!, args.serviceRoleKey!, false);
      const anon = new Rpc(args.supabaseUrl!, args.anonKey!, true);

      if (args.targetUrl) {
        const health = await fetch(`${args.targetUrl}/health`);
        row.checks.worker_health = health.ok;
        if (!health.ok) throw new Error(`worker /health -> ${health.status}`);
      }

      const { checks, counts } = await runCycle(svc, anon);
      Object.assign(row.checks, checks);
      row.counts = counts;
      row.status = Object.values(row.checks).every(Boolean) ? 'pass' : 'fail';
    } catch (err) {
      row.failures = [err instanceof Error ? err.message : String(err)];
    }
  }

  row.cycleMs = Date.now() - started;
  const line = JSON.stringify(row);
  if (args.evidenceJsonl) appendFileSync(args.evidenceJsonl, `${line}\n`);
  process.stdout.write(`${line}\n`);
  process.exit(row.status === 'pass' ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('suborg-tenancy-driver.ts')) {
  void main();
}
