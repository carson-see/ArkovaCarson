// PR #2844 — sub-organization management over an organization API key
// (SCRUM-3971), plus the CTO review fixes U1/U2/U4/U6/U7/U13.
//
// WHAT THIS RIG CAN AND CANNOT PROVE, stated before the probes so the evidence
// is not read as more than it is.
//
// CAN: every behaviour this PR changed that is observable through the HTTP
// surface plus a DB read-back. That is most of it, because this PR is a LIT
// path — six routes that really move credits and really change a tenancy
// relationship. The two orders the review fix exists for (offboard -> revoke
// and revoke -> offboard) are executed end to end, every cycle, against
// re-normalised fixtures, with `parent_approval_status` / `suspended` /
// `org_credits.balance` read back from `ctx.admin` after each call.
//
// CANNOT, and no probe below pretends otherwise:
//   - `503 api_key_principal_unresolved` and the `502` unmapped-code path.
//     `api_keys.created_by` is NOT NULL and no code 0453 returns is unmapped,
//     so both are structurally unreachable without editing the rig's schema or
//     the RPC. They are unit-tested instead (orgSubOrgsApiKey.test.ts).
//   - The `account-export` GDPR shape change: needs a real subject with
//     `SUB_ORG_*` rows carrying their own `actor_id`, which a key-driven rig
//     never produces (key rows are `actor_id NULL` by construction).
//   - Production ACCESS EXCLUSIVE queue depth during the 0453 apply. A rig
//     with a handful of `organizations` rows says nothing about prod's lock
//     queue; that belongs to the apply rehearsal, not to a probe.
//   - The free-tier `usageTracking` 429. Rig keys are seeded paid.
//
// 0453 IS A HARD PRECONDITION AND ITS ABSENCE FAILS, IT DOES NOT SKIP QUIETLY.
// `orgs:manage` only exists in `api_keys_scopes_known_values` after 0453, so
// on a rig without it the live key cannot be minted and EVERY assertion below
// would be vacuous. `seed()` detects the constraint by attempting the real
// insert and reading the SQLSTATE, and records the reason; `run()` then emits
// ONE failing probe naming it. A green cycle that had silently skipped this
// module would be exactly the hollow soak the driver rules exist to prevent.
//
// MUTATION AND CYCLE ISOLATION. This module mutates its own fixtures on
// purpose — that is the point, the lifecycle is the thing under test. Every
// cycle begins by RE-NORMALISING them (child1 -> PENDING/unsuspended/0
// credits, child2 -> APPROVED/unsuspended/0 credits, parent balance restored,
// cap restored), so cycle N re-proves both wind-down orders rather than
// finding them already done by cycle 1. `audit_events` is append-only
// (`reject_audit_modification` raises on UPDATE and DELETE), so every audit
// assertion is scoped to `created_at >= cycleStart` instead of to a count.
// Nothing outside the `cto-train-b-0912-2844-` fixture set is touched.
import { randomBytes, randomUUID } from 'node:crypto';

export const pr = '#2844';

export const changedBehavior = [
  'Six sub-organization routes are reachable by an organization API key at',
  '/api/v1/organizations/sub-orgs, addressed ONLY by public id. GET / needs',
  'read:orgs; the four POSTs and GET /credits need orgs:manage (U2 — the',
  'rollup RPC requires that grant in SQL, so a read:orgs gate published a',
  'contract the database refuses).',
  'The child predicate is per ACTION, not per surface (U1): approve accepts',
  'PENDING only, revoke accepts APPROVED or PENDING, offboard accepts ANY',
  'owned child in any status suspended or not, credits accepts APPROVED and',
  'not suspended — so offboard->revoke AND revoke->offboard are both',
  'reachable and an offboarded child stops consuming an affiliate-cap slot.',
  'Failures on this surface are MACHINE CODES with the documented status (U6):',
  'sub_org_limit_reached / affiliation_changed / already_* are 409, never the',
  'dashboard prose or its embedded count. Unmapped RPC codes are 502 and',
  'api_key_principal_unresolved is 503, never a bare 500 (U7).',
  'A failed approve/revoke audit insert is 500 audit_write_failed, not a',
  'silent 200 (U4) — on this surface actor_id is NULL by construction so',
  'details.actor is the ONLY attribution that exists.',
  'Every negative — absent, another parent\'s, wrong status, suspended —',
  'collapses to 404 sub_org_not_found; a 403 would make the endpoint an',
  'existence oracle over every organization\'s public id.',
  'NOT proven here: api_key_principal_unresolved (503) and the 502 unmapped',
  'path (structurally unreachable — created_by is NOT NULL, no code is',
  'unmapped), the account-export GDPR shape change, and prod lock-queue depth.',
].join(' ');

const TAG = 'cto-train-b-0912-2844';
const NAMES = {
  childPending: `${TAG}-child-pending`,
  childApproved: `${TAG}-child-approved`,
  orgBChild: `${TAG}-orgb-child`,
  keyLive: `${TAG}-key-orgs-manage`,
  keyLive2: `${TAG}-key-orgs-manage-2`,
  keyRead: `${TAG}-key-read-orgs`,
  keyRevoked: `${TAG}-key-revoked`,
  keyExpired: `${TAG}-key-expired`,
  keyBurst: `${TAG}-key-burst`,
  keyChild: `${TAG}-key-child-org`,
};

/** Restored at the top of every cycle. */
const PARENT_START_BALANCE = 100_000;
const CAP_RESTORED = 20;
const ALLOC_OFFBOARD_FIRST = 25;
const ALLOC_REVOKE_FIRST = 15;

/** Well-formed under PUBLIC_ORG_ID_RE, and belongs to no organization. */
const UNKNOWN_PUBLIC_ID = 'zzz-2844-no-such-affiliate';

const DAY_MS = 24 * 60 * 60 * 1000;

// ───────────────────────────── seed ──────────────────────────────────────────

function orgPrefix() {
  return `Z${randomUUID().replace(/-/g, '').slice(0, 11).toUpperCase()}`;
}

/**
 * Upsert one organization to an exact shape and return its id AND public_id.
 * `public_id` is server-minted (the 0128 trigger before 0453, the column
 * DEFAULT after), so it is READ BACK rather than supplied — this surface
 * addresses affiliates only by that value and a probe that invented one would
 * be testing its own fixture.
 */
async function ensureOrg(admin, { name, parentOrgId = null, approvalStatus = null, suspended = false }) {
  const { data: existing, error: findErr } = await admin
    .from('organizations')
    .select('id, public_id')
    .eq('display_name', name)
    .maybeSingle();
  if (findErr) throw new Error(`#2844 lookup org ${name}: ${findErr.message}`);

  if (existing) {
    const { error } = await admin
      .from('organizations')
      .update({
        parent_org_id: parentOrgId,
        parent_approval_status: approvalStatus,
        suspended,
        suspended_at: null,
        suspended_by: null,
        suspended_reason: null,
      })
      .eq('id', existing.id);
    if (error) throw new Error(`#2844 normalise org ${name}: ${error.message}`);
    if (!existing.public_id) throw new Error(`#2844 org ${name} has no public_id — the key surface cannot name it`);
    return { id: existing.id, publicId: existing.public_id };
  }

  const { data, error } = await admin
    .from('organizations')
    .insert({
      display_name: name,
      legal_name: name,
      org_prefix: orgPrefix(),
      parent_org_id: parentOrgId,
      parent_approval_status: approvalStatus,
      suspended,
    })
    .select('id, public_id')
    .single();
  if (error) throw new Error(`#2844 insert org ${name}: ${error.message}`);
  if (!data.public_id) throw new Error(`#2844 org ${name} inserted with a NULL public_id`);
  return { id: data.id, publicId: data.public_id };
}

async function ensureCredits(admin, orgId, balance) {
  const { error } = await admin
    .from('org_credits')
    .upsert({ org_id: orgId, balance, monthly_allocation: 0 }, { onConflict: 'org_id' });
  if (error) throw new Error(`#2844 org_credits ${orgId}: ${error.message}`);
}

/**
 * Mint one API key to an exact shape, returning the RAW value (the rig needs it
 * to authenticate) and the row id (the RPC-level probes need it).
 *
 * A `check_violation` (23514) naming `api_keys_scopes_known_values` is the
 * 0453-absent signal: `orgs:manage` is not in the pre-0453 20-value vocabulary,
 * so the INSERT is refused by the database itself. That is a far better
 * detector than reading a migration ledger — it asks the constraint the worker
 * will actually hit.
 */
async function ensureKey(admin, { orgId, createdBy, name, scopes, hashApiKey, secret, isActive = true, revokedAt = null, expiresAt = null }) {
  const { data: existing, error: findErr } = await admin
    .from('api_keys')
    .select('id, key_prefix')
    .eq('org_id', orgId)
    .eq('name', name)
    .maybeSingle();
  if (findErr) throw new Error(`#2844 lookup key ${name}: ${findErr.message}`);

  const raw = `ak_test_${randomBytes(32).toString('hex')}`;
  const row = {
    org_id: orgId,
    key_prefix: raw.slice(0, 12),
    key_hash: hashApiKey(raw, secret),
    name,
    scopes,
    created_by: createdBy,
    is_active: isActive,
    revoked_at: revokedAt,
    expires_at: expiresAt,
  };

  // Always re-mint: the raw value is not recoverable from the row, and a
  // fixture key whose raw half was lost is a key no probe can use.
  if (existing) {
    const { error } = await admin.from('api_keys').update(row).eq('id', existing.id);
    if (error) return { error };
    return { id: existing.id, raw };
  }
  const { data, error } = await admin.from('api_keys').insert(row).select('id').single();
  if (error) return { error };
  return { id: data.id, raw };
}

export async function seed(admin, state, ctx) {
  const secret = ctx?.API_KEY_HMAC_SECRET ?? process.env.API_KEY_HMAC_SECRET;
  const hashApiKey = ctx?.hashApiKey;
  if (!secret || typeof hashApiKey !== 'function') {
    return { skipped: true, reason: '#2844 seed: API_KEY_HMAC_SECRET / hashApiKey unavailable' };
  }
  if (!state.orgA || !state.orgB || !state.adminA?.userId) {
    return { skipped: true, reason: '#2844 seed: shared fixtures (orgA/orgB/adminA) missing — run setup first' };
  }

  // The 0453 probe FIRST: if `orgs:manage` is not in the CHECK list there is no
  // point seeding anything else, and the reason must name the constraint.
  const live = await ensureKey(admin, {
    orgId: state.orgA, createdBy: state.adminA.userId, name: NAMES.keyLive,
    scopes: ['read:orgs', 'orgs:manage'], hashApiKey, secret,
  });
  if (live.error) {
    const msg = live.error.message ?? String(live.error);
    const isScopeCheck = live.error.code === '23514' || /api_keys_scopes_known_values|check constraint/i.test(msg);
    return {
      skipped: true,
      reason: isScopeCheck
        ? `migration 0453 is NOT applied to this rig: api_keys_scopes_known_values rejects 'orgs:manage' (${msg}). Apply 0453, then re-run setup.mjs.`
        : `#2844 seed key ${NAMES.keyLive}: ${msg}`,
    };
  }

  // `payment_state` gates the whole /api/v1 prefix (requirePaymentCurrent,
  // index.ts): 'suspended' and 'cancelled' 402 before any route runs. Nothing
  // else is needed — there is no subscription row in that lookup.
  const { error: payErr } = await admin
    .from('organizations')
    .update({ payment_state: 'active' })
    .eq('id', state.orgA);
  if (payErr) throw new Error(`#2844 payment_state orgA: ${payErr.message}`);

  const childPending = await ensureOrg(admin, { name: NAMES.childPending, parentOrgId: state.orgA, approvalStatus: 'PENDING' });
  const childApproved = await ensureOrg(admin, { name: NAMES.childApproved, parentOrgId: state.orgA, approvalStatus: 'APPROVED' });
  const orgBChild = await ensureOrg(admin, { name: NAMES.orgBChild, parentOrgId: state.orgB, approvalStatus: 'APPROVED' });

  await ensureCredits(admin, state.orgA, PARENT_START_BALANCE);
  await ensureCredits(admin, childPending.id, 0);
  await ensureCredits(admin, childApproved.id, 0);
  await ensureCredits(admin, orgBChild.id, 0);

  const read = await ensureKey(admin, {
    orgId: state.orgA, createdBy: state.adminA.userId, name: NAMES.keyRead,
    scopes: ['read:orgs'], hashApiKey, secret,
  });
  const revoked = await ensureKey(admin, {
    orgId: state.orgA, createdBy: state.adminA.userId, name: NAMES.keyRevoked,
    scopes: ['read:orgs', 'orgs:manage'], hashApiKey, secret,
    isActive: false, revokedAt: new Date(Date.now() - DAY_MS).toISOString(),
  });
  const expired = await ensureKey(admin, {
    orgId: state.orgA, createdBy: state.adminA.userId, name: NAMES.keyExpired,
    scopes: ['read:orgs', 'orgs:manage'], hashApiKey, secret,
    expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
  });
  // Its own key id, because the §1.10 batch bucket is keyed on `req.apiKey.keyId`
  // and is SHARED with /webhooks and /verify/batch. Bursting the live key would
  // starve every probe above it and every other module using that bucket.
  // A SECOND live orgs:manage key of the same organization. Not redundancy:
  // the §1.10 batch bucket allows 10 POSTs per key per minute and one cycle
  // makes more than that, so the lifecycle half and the negative half act
  // through different keys. Authority is identical (same org, same scope), so
  // nothing under test changes — this is purely a rate-budget split, and the
  // probe below asserts no lifecycle call was silently 429'd.
  const live2 = await ensureKey(admin, {
    orgId: state.orgA, createdBy: state.adminA.userId, name: NAMES.keyLive2,
    scopes: ['read:orgs', 'orgs:manage'], hashApiKey, secret,
  });
  const burst = await ensureKey(admin, {
    orgId: state.orgA, createdBy: state.adminA.userId, name: NAMES.keyBurst,
    scopes: ['read:orgs', 'orgs:manage'], hashApiKey, secret,
  });
  // A key belonging to an organization that HAS a parent. `resolveSubOrgCaller`
  // must refuse it: one affiliation level exists, so a child has no children.
  const childKey = await ensureKey(admin, {
    orgId: childApproved.id, createdBy: state.adminA.userId, name: NAMES.keyChild,
    scopes: ['read:orgs', 'orgs:manage'], hashApiKey, secret,
  });

  for (const [label, r] of [['read', read], ['live2', live2], ['revoked', revoked], ['expired', expired], ['burst', burst], ['child', childKey]]) {
    if (r.error) throw new Error(`#2844 seed key ${label}: ${r.error.message ?? r.error}`);
  }

  return {
    skipped: false,
    childPendingId: childPending.id, childPendingPublicId: childPending.publicId,
    childApprovedId: childApproved.id, childApprovedPublicId: childApproved.publicId,
    orgBChildId: orgBChild.id, orgBChildPublicId: orgBChild.publicId,
    keys: {
      live: { id: live.id, raw: live.raw },
      live2: { id: live2.id, raw: live2.raw },
      read: { id: read.id, raw: read.raw },
      revoked: { id: revoked.id, raw: revoked.raw },
      expired: { id: expired.id, raw: expired.raw },
      burst: { id: burst.id, raw: burst.raw },
      child: { id: childKey.id, raw: childKey.raw },
    },
  };
}

// ───────────────────────────── run ───────────────────────────────────────────

/** The two affiliation columns plus the balance, for one child. */
async function readChild(admin, orgId) {
  const [{ data: org, error: orgErr }, { data: credits, error: creditErr }] = await Promise.all([
    admin.from('organizations').select('parent_org_id, parent_approval_status, suspended, public_id').eq('id', orgId).maybeSingle(),
    admin.from('org_credits').select('balance').eq('org_id', orgId).maybeSingle(),
  ]);
  return {
    status: org?.parent_approval_status ?? null,
    suspended: org?.suspended === true,
    parentOrgId: org?.parent_org_id ?? null,
    balance: credits?.balance ?? null,
    errors: [orgErr, creditErr].filter(Boolean).map((e) => e.message),
  };
}

/** Re-normalise every fixture so this cycle re-proves both wind-down orders. */
async function resetFixtures(admin, state, s) {
  const restore = async (orgId, approvalStatus, balance) => {
    const { error } = await admin
      .from('organizations')
      .update({
        parent_org_id: state.orgA,
        parent_approval_status: approvalStatus,
        suspended: false,
        suspended_at: null,
        suspended_by: null,
        suspended_reason: null,
      })
      .eq('id', orgId);
    if (error) return `organizations ${orgId}: ${error.message}`;
    const { error: cErr } = await admin
      .from('org_credits')
      .upsert({ org_id: orgId, balance, monthly_allocation: 0 }, { onConflict: 'org_id' });
    return cErr ? `org_credits ${orgId}: ${cErr.message}` : null;
  };
  const errs = [];
  errs.push(await restore(s.childPendingId, 'PENDING', 0));
  errs.push(await restore(s.childApprovedId, 'APPROVED', 0));
  const { error: parentErr } = await admin
    .from('organizations')
    .update({ max_sub_orgs: CAP_RESTORED, payment_state: 'active' })
    .eq('id', state.orgA);
  if (parentErr) errs.push(`parent org: ${parentErr.message}`);
  const { error: balErr } = await admin
    .from('org_credits')
    .upsert({ org_id: state.orgA, balance: PARENT_START_BALANCE, monthly_allocation: 0 }, { onConflict: 'org_id' });
  if (balErr) errs.push(`parent credits: ${balErr.message}`);
  return errs.filter(Boolean);
}

/** Newest audit row of this event type for this target, written in THIS cycle. */
async function latestAudit(admin, { eventType, targetId, since }) {
  const { data, error } = await admin
    .from('audit_events')
    .select('id, event_type, actor_id, target_id, org_id, details, created_at')
    .eq('event_type', eventType)
    .eq('target_id', targetId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: data ?? null, error: null };
}

function parsedDetails(row) {
  if (!row?.details) return null;
  if (typeof row.details === 'object') return row.details;
  try { return JSON.parse(row.details); } catch { return null; }
}

/** Recursively: does anything in this body look like a raw uuid? (R11) */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function uuidsIn(value, path = '$', found = []) {
  if (typeof value === 'string') { if (UUID_RE.test(value)) found.push(`${path}=${value}`); return found; }
  if (Array.isArray(value)) { value.forEach((v, i) => uuidsIn(v, `${path}[${i}]`, found)); return found; }
  if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value)) uuidsIn(v, `${path}.${k}`, found); return found; }
  return found;
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch } = ctx;
  const s = state['#2844'] ?? {};
  const out = [];
  const cycleStart = new Date(Date.now() - 5_000).toISOString();

  // ── 0. Precondition: 0453 applied, fixtures present ──────────────────────
  if (s.skipped || !s.keys?.live?.raw) {
    out.push(probe('2844_migration_0453_applied_and_fixtures_seeded', true, false, {
      pass: false,
      detail: {
        reason: s.reason ?? 'no #2844 fixture state — setup.mjs has not seeded this module',
        note: 'This FAILS rather than skipping on purpose: orgs:manage does not exist in api_keys_scopes_known_values before 0453, so every assertion in this module would be vacuous and a green cycle would be a hollow soak.',
      },
    }));
    return out;
  }
  out.push(probe('2844_migration_0453_applied_and_fixtures_seeded', true, true, {
    detail: { childPending: s.childPendingPublicId, childApproved: s.childApprovedPublicId, orgBChild: s.orgBChildPublicId },
  }));

  const resetErrors = await resetFixtures(admin, state, s);
  out.push(probe('2844_fixtures_renormalised_for_this_cycle', 0, resetErrors.length, {
    detail: { errors: resetErrors, note: 'Without this, cycle 2+ would find the wind-down already done and prove nothing.' },
  }));
  if (resetErrors.length) return out;

  const BASE = '/api/v1/organizations/sub-orgs';
  const call = (path, { method = 'GET', body, key } = {}) =>
    workerFetch(`${BASE}${path}`, { method, body, apiKeyRaw: key });
  const live = s.keys.live.raw;
  // Second half of the cycle acts through a second key of the SAME
  // organization with the SAME scope: §1.10 gives each key 10 POSTs a minute
  // and one cycle makes more than that. Discovered by the stub harness, which
  // 429'd the cross-org probes and turned four "must be 404" assertions into
  // rate-limit noise. Authority is unchanged; only the bucket differs.
  const live2 = s.keys.live2?.raw ?? live;
  const throttled = [];
  const notThrottled = (label, r) => { if (r.status === 429) throttled.push(label); return r; };

  // ── 1. Scope gate (U2) ───────────────────────────────────────────────────
  const listAsRead = await call('/', { key: s.keys.read.raw });
  out.push(probe('2844_list_admits_read_orgs_key', 200, listAsRead.status, { detail: { body: listAsRead.body } }));
  out.push(probe('2844_list_returns_public_ids_only', 0, uuidsIn(listAsRead.body).length, {
    detail: { leaks: uuidsIn(listAsRead.body) },
  }));

  const rollupAsRead = await call('/credits', { key: s.keys.read.raw });
  out.push(probe('2844_rollup_refuses_read_orgs_key', 403, rollupAsRead.status, { detail: { body: rollupAsRead.body } }));
  // `insufficient_scope` + `required` can ONLY come from requireScopeAnyAuth.
  // The RPC's own refusal is `parent_admin_required`, so this discriminates
  // "refused at the gate" from "reached the database and was refused there"
  // without needing pg_stat_statements.
  out.push(probe('2844_rollup_refused_at_the_gate_not_by_the_rpc', 'insufficient_scope', rollupAsRead.body?.error ?? null, {
    detail: { required: rollupAsRead.body?.required ?? null, note: 'parent_admin_required here would mean the request reached the RPC.' },
  }));
  out.push(probe('2844_rollup_names_the_missing_scope', 'orgs:manage', rollupAsRead.body?.required ?? null));

  const writeAsRead = await call('/approve', { method: 'POST', key: s.keys.read.raw, body: { org_public_id: s.childPendingPublicId } });
  out.push(probe('2844_write_refuses_read_orgs_key', 403, writeAsRead.status, { detail: { body: writeAsRead.body } }));
  const afterRefusedWrite = await readChild(admin, s.childPendingId);
  out.push(probe('2844_refused_write_changed_nothing', 'PENDING', afterRefusedWrite.status, {
    detail: 'A 403 that had already flipped the row would pass a status check and fail this.',
  }));

  // ── 2. Cap: a machine code, never the counted sentence (U6) ──────────────
  // child2 is APPROVED, so a cap of 1 is already full.
  const { error: capErr } = await admin.from('organizations').update({ max_sub_orgs: 1 }).eq('id', state.orgA);
  out.push(probe('2844_cap_lowered_for_this_probe', true, !capErr, { detail: { error: capErr?.message ?? null } }));
  const capped = notThrottled('cap_approve', await call('/approve', { method: 'POST', key: live, body: { org_public_id: s.childPendingPublicId } }));
  out.push(probe('2844_cap_reached_is_409', 409, capped.status, { detail: { body: capped.body } }));
  out.push(probe('2844_cap_reached_is_a_machine_code', 'sub_org_limit_reached', capped.body?.error ?? null));
  out.push(probe('2844_cap_error_carries_no_prose_or_live_count', false, /Affiliated-organization limit/i.test(JSON.stringify(capped.body ?? {})), {
    detail: { body: capped.body, note: '"Affiliated-organization limit reached (1 of 1)." would freeze a live count into a frozen contract.' },
  }));
  const cappedChild = await readChild(admin, s.childPendingId);
  out.push(probe('2844_cap_refusal_did_not_approve', 'PENDING', cappedChild.status));
  await admin.from('organizations').update({ max_sub_orgs: CAP_RESTORED }).eq('id', state.orgA);

  // ── 3. approve is the PENDING transition, and only that (U1) ─────────────
  const approveAlready = notThrottled('approve_already', await call('/approve', { method: 'POST', key: live, body: { org_public_id: s.childApprovedPublicId } }));
  out.push(probe('2844_approve_on_approved_child_is_404', 404, approveAlready.status, { detail: { body: approveAlready.body } }));
  out.push(probe('2844_approve_on_approved_child_is_not_an_oracle', true, approveAlready.status !== 403, {
    detail: 'A 403 here distinguishes "exists but wrong status" from "does not exist".',
  }));

  const approved = notThrottled('approve_pending', await call('/approve', { method: 'POST', key: live, body: { org_public_id: s.childPendingPublicId } }));
  out.push(probe('2844_approve_pending_child_200', 200, approved.status, { detail: { body: approved.body } }));
  out.push(probe('2844_approve_echoes_public_id_only', 0, uuidsIn(approved.body).length, { detail: { leaks: uuidsIn(approved.body) } }));
  const afterApprove = await readChild(admin, s.childPendingId);
  out.push(probe('2844_approve_wrote_APPROVED', 'APPROVED', afterApprove.status, { detail: afterApprove }));

  // Audit attribution: actor_id NULL by construction, actor in details (U4/R13).
  const approveAudit = await latestAudit(admin, { eventType: 'SUB_ORG_APPROVED', targetId: s.childPendingId, since: cycleStart });
  out.push(probe('2844_approve_wrote_an_audit_row', true, Boolean(approveAudit.row), { detail: { error: approveAudit.error } }));
  out.push(probe('2844_approve_audit_actor_id_is_null', null, approveAudit.row?.actor_id ?? null, {
    detail: 'audit_events.actor_id REFERENCES profiles(id); an api_key id is an FK violation and a user id is a false claim about who acted.',
  }));
  const approveDetails = parsedDetails(approveAudit.row);
  out.push(probe('2844_approve_audit_details_is_json_not_prose', true, approveDetails !== null, {
    detail: { raw: typeof approveAudit.row?.details, sample: String(approveAudit.row?.details ?? '').slice(0, 120) },
  }));
  out.push(probe('2844_approve_audit_names_the_acting_key', s.keys.live.id, approveDetails?.actor?.actor_api_key_id ?? null, {
    detail: { actor: approveDetails?.actor ?? null },
  }));
  out.push(probe('2844_approve_audit_actor_kind_is_api_key', 'api_key', approveDetails?.actor?.actor_kind ?? null));

  // ── 4. offboard -> revoke, end to end (U1) ───────────────────────────────
  const alloc = notThrottled('allocate_first', await call('/credits', { method: 'POST', key: live, body: { org_public_id: s.childPendingPublicId, amount: ALLOC_OFFBOARD_FIRST, note: `${TAG} offboard-first` } }));
  out.push(probe('2844_allocate_to_live_affiliate_200', 200, alloc.status, { detail: { body: alloc.body } }));
  const funded = await readChild(admin, s.childPendingId);
  out.push(probe('2844_allocate_moved_credits', ALLOC_OFFBOARD_FIRST, funded.balance, { detail: funded }));
  const allocAudit = await latestAudit(admin, { eventType: 'ORG_CREDIT_ALLOCATED', targetId: s.childPendingId, since: cycleStart });
  out.push(probe('2844_allocate_audit_actor_id_is_null', null, allocAudit.row?.actor_id ?? null, { detail: { found: Boolean(allocAudit.row) } }));
  out.push(probe('2844_allocate_audit_names_the_acting_key', s.keys.live.id, parsedDetails(allocAudit.row)?.actor?.actor_api_key_id ?? null));

  const offboard1 = notThrottled('offboard_first', await call('/offboard', { method: 'POST', key: live, body: { org_public_id: s.childPendingPublicId, reason: `${TAG} offboard-first` } }));
  out.push(probe('2844_offboard_200', 200, offboard1.status, { detail: { body: offboard1.body } }));
  out.push(probe('2844_offboard_reclaimed_the_balance', ALLOC_OFFBOARD_FIRST, offboard1.body?.reclaimed ?? null));
  out.push(probe('2844_offboard_reports_suspended', true, offboard1.body?.suspended === true));
  const offboarded = await readChild(admin, s.childPendingId);
  out.push(probe('2844_offboard_wrote_suspended', true, offboarded.suspended, { detail: offboarded }));
  out.push(probe('2844_offboard_emptied_the_child_balance', 0, offboarded.balance, {
    detail: 'Reclaim precedes suspend by design: credits left inside a suspended affiliate are unspendable and unrecoverable on this surface.',
  }));
  out.push(probe('2844_offboard_left_the_status_alone', 'APPROVED', offboarded.status, {
    detail: 'offboard is reclaim+suspend; it is revoke that ends the relationship. This is exactly why revoke must accept a suspended child.',
  }));

  // THE U1 REGRESSION. Before the fix this was 404: revoke refused a suspended
  // child, so a parent who offboarded first could never revoke, and the child
  // kept consuming an affiliate-cap slot (the cap counts APPROVED rows) with no
  // remedy on the key surface at all.
  const revokeAfterOffboard = notThrottled('revoke_after_offboard', await call('/revoke', { method: 'POST', key: live, body: { org_public_id: s.childPendingPublicId } }));
  out.push(probe('2844_offboard_then_revoke_200', 200, revokeAfterOffboard.status, {
    detail: { body: revokeAfterOffboard.body, note: 'Pre-U1 this was 404 sub_org_not_found — the wind-down was stranded.' },
  }));
  const woundDown = await readChild(admin, s.childPendingId);
  out.push(probe('2844_offboard_then_revoke_wrote_REVOKED', 'REVOKED', woundDown.status, { detail: woundDown }));
  out.push(probe('2844_offboard_then_revoke_kept_the_suspension', true, woundDown.suspended));
  out.push(probe('2844_offboard_then_revoke_freed_the_cap_slot', true, woundDown.status !== 'APPROVED', {
    detail: 'resolveSubOrgCap counts APPROVED rows; a child stuck at APPROVED+suspended consumed a slot forever.',
  }));
  const revokeAudit = await latestAudit(admin, { eventType: 'SUB_ORG_REVOKED', targetId: s.childPendingId, since: cycleStart });
  out.push(probe('2844_revoke_audit_names_the_acting_key', s.keys.live.id, parsedDetails(revokeAudit.row)?.actor?.actor_api_key_id ?? null, {
    detail: { found: Boolean(revokeAudit.row) },
  }));

  // ── 5. revoke -> offboard, the other documented order (U1) ───────────────
  const alloc2 = notThrottled('allocate_second', await call('/credits', { method: 'POST', key: live2, body: { org_public_id: s.childApprovedPublicId, amount: ALLOC_REVOKE_FIRST, note: `${TAG} revoke-first` } }));
  out.push(probe('2844_allocate_second_affiliate_200', 200, alloc2.status, { detail: { body: alloc2.body } }));

  const revokeFirst = notThrottled('revoke_first', await call('/revoke', { method: 'POST', key: live2, body: { org_public_id: s.childApprovedPublicId } }));
  out.push(probe('2844_revoke_approved_child_200', 200, revokeFirst.status, { detail: { body: revokeFirst.body } }));
  const revoked = await readChild(admin, s.childApprovedId);
  out.push(probe('2844_revoke_wrote_REVOKED', 'REVOKED', revoked.status, { detail: revoked }));
  out.push(probe('2844_revoke_does_not_reclaim', ALLOC_REVOKE_FIRST, revoked.balance, {
    detail: 'Revoke ends the relationship; offboard is what moves money. This is why the credits must still be reclaimable afterwards.',
  }));

  // Pre-U1 this was 404: offboard demanded APPROVED, so a parent who revoked
  // first could never reclaim. The credits were stranded either way round.
  const offboardAfterRevoke = notThrottled('offboard_after_revoke', await call('/offboard', { method: 'POST', key: live2, body: { org_public_id: s.childApprovedPublicId, reason: `${TAG} revoke-first` } }));
  out.push(probe('2844_revoke_then_offboard_200', 200, offboardAfterRevoke.status, {
    detail: { body: offboardAfterRevoke.body, note: 'Pre-U1 this was 404 — offboard required APPROVED.' },
  }));
  out.push(probe('2844_revoke_then_offboard_reclaimed', ALLOC_REVOKE_FIRST, offboardAfterRevoke.body?.reclaimed ?? null));
  const woundDown2 = await readChild(admin, s.childApprovedId);
  out.push(probe('2844_revoke_then_offboard_emptied_the_balance', 0, woundDown2.balance, { detail: woundDown2 }));
  out.push(probe('2844_revoke_then_offboard_suspended', true, woundDown2.suspended));

  // Idempotent retry: already-suspended is a SUCCESS, not a refusal.
  const retry = notThrottled('offboard_retry', await call('/offboard', { method: 'POST', key: live2, body: { org_public_id: s.childApprovedPublicId } }));
  out.push(probe('2844_offboard_retry_is_idempotent_200', 200, retry.status, { detail: { body: retry.body } }));
  out.push(probe('2844_offboard_retry_reports_already_suspended', true, retry.body?.already_suspended === true));
  out.push(probe('2844_offboard_retry_moved_no_credits_twice', 0, retry.body?.reclaimed ?? null));

  // Money must not enter a dead affiliation.
  const allocDead = notThrottled('allocate_into_dead', await call('/credits', { method: 'POST', key: live2, body: { org_public_id: s.childApprovedPublicId, amount: 5 } }));
  out.push(probe('2844_credits_into_a_suspended_affiliate_is_404', 404, allocDead.status, { detail: { body: allocDead.body } }));
  const stillEmpty = await readChild(admin, s.childApprovedId);
  out.push(probe('2844_refused_allocation_moved_nothing', 0, stillEmpty.balance, { detail: stillEmpty }));

  // ── 6. Rollup shape (U2 path, orgs:manage) ──────────────────────────────
  const rollup = await call('/credits', { key: live });
  out.push(probe('2844_rollup_admits_orgs_manage_key', 200, rollup.status, { detail: { body: rollup.body } }));
  out.push(probe('2844_rollup_leaks_no_uuid', 0, uuidsIn(rollup.body).length, { detail: { leaks: uuidsIn(rollup.body) } }));
  const rollupIds = (rollup.body?.children ?? []).map((c) => c?.public_id).filter(Boolean);
  out.push(probe('2844_rollup_keys_children_by_public_id', true, rollupIds.includes(s.childApprovedPublicId), {
    detail: { rollupIds, expectedOneOf: [s.childPendingPublicId, s.childApprovedPublicId] },
  }));

  // ── 7. Tenancy: 404, never 403; and the RPC refuses independently ───────
  const crossOrgCalls = [];
  for (const [label, path, extra] of [
    ['approve', '/approve', {}],
    ['revoke', '/revoke', {}],
    ['credits', '/credits', { amount: 1 }],
    ['offboard', '/offboard', {}],
  ]) {
    // Serial and on live2: four parallel POSTs on the lifecycle key would land
    // past its §1.10 budget and turn "must be 404" into rate-limit noise.
    // eslint-disable-next-line no-await-in-loop
    crossOrgCalls.push(notThrottled(`cross_org_${label}`, await call(path, {
      method: 'POST', key: live2, body: { org_public_id: s.orgBChildPublicId, ...extra },
    })));
  }
  crossOrgCalls.forEach((r, i) => {
    const label = ['approve', 'revoke', 'credits', 'offboard'][i];
    out.push(probe(`2844_cross_org_${label}_is_404`, 404, r.status, { detail: { body: r.body } }));
    out.push(probe(`2844_cross_org_${label}_is_never_403`, true, r.status !== 403, {
      detail: 'A 403 would confirm to org A that this public id exists and belongs to someone.',
    }));
  });
  const orgBChildAfter = await readChild(admin, s.orgBChildId);
  out.push(probe('2844_cross_org_child_unmutated_status', 'APPROVED', orgBChildAfter.status, { detail: orgBChildAfter }));
  out.push(probe('2844_cross_org_child_unmutated_suspension', false, orgBChildAfter.suspended));
  out.push(probe('2844_cross_org_child_unmutated_balance', 0, orgBChildAfter.balance));

  // The route layer 404s before the RPC, so ask the RPC directly: authority is
  // re-decided in SQL under FOR UPDATE and must refuse org A's key against org B.
  const { data: rpcCross, error: rpcCrossErr } = await admin.rpc('allocate_credits_to_sub_org_as_api_key', {
    p_parent_org_id: state.orgB,
    p_child_org_id: s.orgBChildId,
    p_amount: 1,
    p_note: `${TAG} cross-org`,
    p_caller_api_key_id: s.keys.live.id,
  });
  out.push(probe('2844_rpc_refuses_org_a_key_against_org_b', 'parent_admin_required', rpcCross?.error ?? null, {
    detail: { rpcError: rpcCrossErr?.message ?? null, body: rpcCross },
  }));

  // A key whose OWN organization is an affiliate cannot administer affiliates.
  const childKeyCall = await call('/', { key: s.keys.child.raw });
  out.push(probe('2844_affiliate_owned_key_is_403', 403, childKeyCall.status, { detail: { body: childKeyCall.body } }));
  out.push(probe('2844_affiliate_owned_key_names_the_reason', 'sub_org_cannot_manage_sub_orgs', childKeyCall.body?.error ?? null));

  // ── 8. Key liveness: refused at the gate AND at the RPC ─────────────────
  for (const [label, key] of [['revoked', s.keys.revoked], ['expired', s.keys.expired]]) {
    const r = await call('/approve', { method: 'POST', key: key.raw, body: { org_public_id: s.childPendingPublicId } });
    out.push(probe(`2844_${label}_key_refused_at_the_gate`, true, r.status === 401 || r.status === 403, {
      detail: { status: r.status, body: r.body, note: 'apiKeyAuth filters is_active / revoked_at / expires_at before any route runs.' },
    }));
    const { data: rpcRes, error: rpcErr } = await admin.rpc('allocate_credits_to_sub_org_as_api_key', {
      p_parent_org_id: state.orgA,
      p_child_org_id: s.childPendingId,
      p_amount: 1,
      p_note: `${TAG} ${label}`,
      p_caller_api_key_id: key.id,
    });
    out.push(probe(`2844_${label}_key_refused_by_the_rpc_too`, 'parent_admin_required', rpcRes?.error ?? null, {
      detail: { rpcError: rpcErr?.message ?? null, note: 'Three of the five predicate clauses are invisible to any test that uses a freshly-minted key.' },
    }));
  }
  // A live key of the right org WITHOUT orgs:manage: refused in SQL, not only
  // at the route. This is the clause a route-only test cannot see.
  const { data: rpcNoScope, error: rpcNoScopeErr } = await admin.rpc('allocate_credits_to_sub_org_as_api_key', {
    p_parent_org_id: state.orgA,
    p_child_org_id: s.childPendingId,
    p_amount: 1,
    p_note: `${TAG} no-scope`,
    p_caller_api_key_id: s.keys.read.id,
  });
  out.push(probe('2844_read_orgs_key_refused_by_the_rpc', 'parent_admin_required', rpcNoScope?.error ?? null, {
    detail: { rpcError: rpcNoScopeErr?.message ?? null },
  }));
  const { data: rpcNull } = await admin.rpc('get_parent_credit_rollup_as_api_key', {
    p_parent_org_id: state.orgA,
    p_caller_api_key_id: null,
  });
  out.push(probe('2844_null_key_id_fails_closed', 'authentication_required', rpcNull?.error ?? null, {
    detail: 'A NULL caller matches no row in _suborg_api_key_authorized, so every caller must fail closed.',
  }));

  // ── 10. §1.10 batch tier: 429 with Retry-After, and nothing written ──────
  // Dedicated key: the batch bucket is keyed on apiKey.keyId and SHARED with
  // /webhooks and /verify/batch, so bursting the live key would starve this
  // module's own probes and other modules' too.
  // The selector is well-formed but belongs to no organization, so each of the
  // first ten calls is a 404 that writes nothing — the limiter is what is
  // under test, not the handler.
  const burstResults = [];
  for (let i = 0; i < 11; i += 1) {
    // Serial, not Promise.all: a parallel burst can race the limiter's own
    // counter and report a 429 count that depends on scheduling.
    // eslint-disable-next-line no-await-in-loop
    burstResults.push(await call('/approve', { method: 'POST', key: s.keys.burst.raw, body: { org_public_id: UNKNOWN_PUBLIC_ID } }));
  }
  const limited = burstResults.filter((r) => r.status === 429);
  out.push(probe('2844_eleventh_post_is_rate_limited', true, limited.length >= 1, {
    detail: { statuses: burstResults.map((r) => r.status), note: '§1.10 batch tier: 10 req/min on the four POSTs.' },
  }));
  const retryAfter = limited[0]?.headers?.['retry-after'] ?? null;
  out.push(probe('2844_429_carries_retry_after', true, retryAfter !== null && retryAfter !== undefined, {
    detail: { retryAfter, note: '§1.10 requires Retry-After on every 429.' },
  }));
  out.push(probe('2844_unthrottled_burst_calls_were_404_not_writes', true, burstResults.slice(0, 10).every((r) => r.status === 404 || r.status === 429), {
    detail: { statuses: burstResults.map((r) => r.status), selector: UNKNOWN_PUBLIC_ID },
  }));
  const afterBurst = await readChild(admin, s.childPendingId);
  out.push(probe('2844_burst_wrote_nothing', 'REVOKED', afterBurst.status, {
    detail: { note: 'Still the terminal state of the offboard->revoke run above; a burst that had matched a real child would have moved it.' },
  }));

  // A 429 anywhere in the lifecycle half makes every assertion after it
  // ambiguous — a rate-limited call looks like a refusal. Surface it as its own
  // probe rather than letting it read as a behaviour failure. The stub harness
  // caught exactly this: four "must be 404" cross-org assertions were reading
  // 429 because one key had made more than ten POSTs in the minute.
  out.push(probe('2844_no_lifecycle_call_was_rate_limited', 0, throttled.length, {
    detail: { throttled, note: '§1.10 batch tier is 10 POSTs/min PER KEY; the cycle is split across two keys of the same org to stay inside it.' },
  }));

  return out;
}
