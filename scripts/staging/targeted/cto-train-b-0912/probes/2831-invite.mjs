// PR #2831 — Complete selected-organization platform invitations (UAT-22)
// + migration 0452 (NULL-quota organization provisioning fix), SCRUM-4888,
// branch codex/uat22-invite-delivery, head 81d45bc859d7f91987d75ed65668b3e909af5040.
//
// PROVENANCE. An earlier standalone driver for this PR exists at
// /Volumes/Extreme/offload/cto-soak-2026-09-12/train-c/invite-2831/driver/
// (invite-cycle.mjs) — it is REAL, correct coverage of the same behavior
// this module proves, but it targets the shared standing rig's
// main-traffic URL with a hardcoded stale candidate git_sha baked into its
// own common.mjs, so it is not valid evidence for whatever candidate the
// train-c2 supervisor is actually soaking right now. This module is that
// same coverage, rewritten as a train-harness probe module (pr /
// changedBehavior / seed / run, common.mjs helpers, TRAIN_PROBES-filtered)
// so it binds to TRAIN_CANDIDATE_SHA / TRAIN_TAG_URL like every other
// module in this directory instead of a hardcoded URL, and reuses the
// shared fixtures (orgB, platformAdmin, memberA) setup.mjs already
// maintains on this rig instead of a second, parallel fixture file.
//
// WHAT THIS PROVES, every cycle, against the real deployed worker AND a
// direct service-role RPC call (migration 0452 has no HTTP surface of its
// own — `admin_provision_organization` is `service_role`-only by design,
// called from `handleCreateOrganization` in production; a direct RPC call
// here is the correct way to exercise it, not a workaround):
//   (1) A platform admin (AAL2, mandatory MFA) can read a FOREIGN org's
//       metadata via GET /api/admin/organizations/:id — the exact gap
//       UAT-22 closes (browser RLS correctly hides a non-member org; this
//       worker route explicitly re-authorizes a platform admin around it).
//   (2) POST .../invitations creates a real invitation row into that
//       foreign org (never silently dropped — a 502 email-delivery failure
//       still carries `created:true` and the row exists).
//   (3) Same idempotency_key replayed is treated as the SAME logical
//       request (200/502, not a second 201) — verified via a DIRECT DB
//       read-back (exactly one row for that key), not the response body
//       alone, because the 502 branch omits invitationId.
//   (4) Same idempotency_key with a DIFFERENT payload (different email)
//       fails closed 409 rather than silently overwriting the original
//       invitation's intent.
//   (5) A non-platform-admin (an ordinary org member) is rejected 403 —
//       the authority check UAT-22 exists to enforce.
//   (6) Migration 0452: `admin_provision_organization` with a NULL
//       anchor_quota provisions an UNCAPPED org (`anchor_quota IS NULL`
//       AND `cap_enforced = false` on `org_credits` — read back directly
//       from the table, not just the RPC's own summary), a zero quota
//       provisions a CAPPED, zero-quota org, and a finite quota provisions
//       a CAPPED org at that exact quota — the three cases 0452's own
//       header names as needing atomic consistency between anchor_quota
//       and cap_enforced.
//   (7) The provisioning RPC's own idempotency: the SAME (actor,
//       idempotency_key, request) replayed returns the SAME org_id rather
//       than creating a second organization.
//
// Session auth uses `signInMfa` (mandatory MFA, CLAUDE.md) — never a plain
// password grant, which 0451 rejects at AAL1 on every protected route.

import { signInMfa } from '../common.mjs';

export const pr = '#2831';

export const changedBehavior = [
  'GET /api/admin/organizations/:id lets a platform admin read a FOREIGN',
  "org's metadata (browser RLS correctly hides it; this worker route",
  're-authorizes around that for platform admins only). POST',
  '.../organizations/:id/invitations creates a real, durable invitation row',
  '(never silently dropped on email failure — 502 still created:true);',
  'same idempotency_key replayed is the same logical request (verified via',
  'DB read-back: exactly one row), a different payload under the same key',
  '409s fail-closed, and a non-platform-admin is rejected 403. Migration',
  '0452: admin_provision_organization keeps anchor_quota and cap_enforced on',
  'org_credits atomically consistent for NULL (uncapped), zero (capped at',
  'zero) and finite (capped at that value) quotas, and its own',
  '(actor, idempotency_key, request) tuple is itself replay-safe.',
].join(' ');

const NAME_PREFIX = 'cto-train-c2-2831';

function randomUuid() {
  return crypto.randomUUID();
}

/**
 * `adminRouter` (routes/admin.ts) is fronted by a shared, low-threshold,
 * per-IP `rateLimiters.checkout` limiter ahead of EVERY admin route,
 * `/admin/organizations/:id/invitations` included — confirmed empirically
 * 2026-09-13 against the standing rig: 4 back-to-back admin-authenticated
 * writes from one probing IP (create/replay/conflict/non-admin-reject) can
 * exhaust it, especially when sibling probe modules in the SAME cycle
 * (this rig also runs #2844/#2904/#2905) share the same source IP within
 * the same 5-minute window. A 429 here is the rate limiter doing exactly
 * what it is for — not a PR defect — so retry once after the server's own
 * `retry_after`, bounded, rather than either failing the probe on a
 * transient/expected condition or silently swallowing a REAL 429 (which
 * would be a defect if the PR itself introduced a stricter limiter).
 */
async function withRateLimitRetry(fn) {
  const first = await fn();
  if (first.status !== 429) return first;
  const waitMs = Math.min(Number(first.body?.retry_after) || 5, 60) * 1000;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return fn();
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch } = ctx;
  const out = [];

  if (!state.orgB || !state.platformAdmin || !state.memberA) {
    out.push(probe('2831_fixtures_present', true, false, {
      pass: false, detail: { reason: 'state.orgB/platformAdmin/memberA missing — run setup.mjs base fixtures first', have: Object.keys(state) },
    }));
    return out;
  }
  out.push(probe('2831_fixtures_present', true, true));

  const adminSigned = await signInMfa(ctx, 'platformAdmin');
  out.push(probe('2831_platform_admin_signin', true, Boolean(adminSigned.token), {
    detail: { status: adminSigned.status, error: adminSigned.error, aalBefore: adminSigned.aalBefore, aalAfter: adminSigned.aalAfter },
  }));
  const memberSigned = await signInMfa(ctx, 'memberA');
  out.push(probe('2831_member_signin', true, Boolean(memberSigned.token), {
    detail: { status: memberSigned.status, error: memberSigned.error },
  }));
  const adminJwt = adminSigned.token;
  const memberJwt = memberSigned.token;
  if (!adminJwt || !memberJwt) return out;

  // ═══════════════════ (1) Foreign-org read ═══════════════════
  const orgRead = await workerFetch(`/api/admin/organizations/${state.orgB}`, { jwt: adminJwt });
  out.push(probe('2831_platform_admin_reads_foreign_org_200', 200, orgRead.status, { detail: orgRead.body }));
  out.push(probe('2831_foreign_org_id_matches', state.orgB, orgRead.body?.organization?.id, { detail: orgRead.body }));

  const nonAdminOrgRead = await workerFetch(`/api/admin/organizations/${state.orgB}`, { jwt: memberJwt });
  out.push(probe('2831_non_platform_admin_read_rejected', true, nonAdminOrgRead.status === 401 || nonAdminOrgRead.status === 403, {
    detail: { status: nonAdminOrgRead.status, body: nonAdminOrgRead.body },
  }));

  // ═══════════════════ (2)-(4) Invitation create / replay / conflict ═══════════════════
  const inviteEmail = `${NAME_PREFIX}-invitee-${Date.now()}@example.com`;
  const idempotencyKey = randomUuid();
  const createBody = { email: inviteEmail, role: 'INDIVIDUAL', idempotency_key: idempotencyKey };
  // @example.com is IANA-reserved (RFC 2606) — never reaches a real inbox.
  // Resend/whatever provider is configured legitimately answers either 201
  // (accepted) or 502 email_delivery_failed for it; both are safe,
  // anticipated outcomes. The invariant under test is the invitation ROW,
  // not the email provider's opinion of a fake address.
  const created = await withRateLimitRetry(() => workerFetch(`/api/admin/organizations/${state.orgB}/invitations`, { method: 'POST', jwt: adminJwt, body: createBody }));
  out.push(probe('2831_invitation_created', [201, 502], created.status, { detail: created.body, pass: [201, 502].includes(created.status) }));
  out.push(probe('2831_invitation_created_not_silently_dropped', true, created.status === 201 || created.body?.created === true, {
    detail: created.body, pass: created.status === 201 || created.body?.created === true,
  }));

  const replay = await withRateLimitRetry(() => workerFetch(`/api/admin/organizations/${state.orgB}/invitations`, { method: 'POST', jwt: adminJwt, body: createBody }));
  out.push(probe('2831_invitation_replay_status', [200, 502], replay.status, { detail: replay.body, pass: [200, 502].includes(replay.status) }));

  // The 502 branch omits invitationId — verify the real DB invariant
  // directly rather than trusting a response shape that legitimately
  // varies by branch: exactly ONE row for this idempotency key.
  const { data: dupRows, error: dupErr } = await admin
    .from('invitations')
    .select('id, email, role, org_id, status')
    .eq('id', idempotencyKey);
  const noDuplicateRow = !dupErr && Array.isArray(dupRows) && dupRows.length === 1
    && dupRows[0].email === inviteEmail && dupRows[0].role === 'INDIVIDUAL' && dupRows[0].org_id === state.orgB;
  out.push(probe('2831_invitation_replay_exactly_one_row', true, noDuplicateRow, {
    detail: dupErr ? { error: dupErr.message } : dupRows, pass: noDuplicateRow,
  }));

  const conflictBody = { ...createBody, email: `${NAME_PREFIX}-different-${Date.now()}@example.com` };
  const conflict = await withRateLimitRetry(() => workerFetch(`/api/admin/organizations/${state.orgB}/invitations`, { method: 'POST', jwt: adminJwt, body: conflictBody }));
  out.push(probe('2831_invitation_conflict_fails_closed_409', 409, conflict.status, { detail: conflict.body }));

  // ═══════════════════ (5) Non-platform-admin rejected ═══════════════════
  const nonAdminAttempt = await withRateLimitRetry(() => workerFetch(`/api/admin/organizations/${state.orgB}/invitations`, {
    method: 'POST', jwt: memberJwt, body: { email: `${NAME_PREFIX}-nonadmin-${Date.now()}@example.com`, role: 'INDIVIDUAL', idempotency_key: randomUuid() },
  }));
  out.push(probe('2831_non_platform_admin_invite_rejected_403', 403, nonAdminAttempt.status, { detail: nonAdminAttempt.body }));

  // ═══════════════════ (6) Migration 0452 — quota/cap_enforced matrix ═══════════════════
  const actorId = state.platformAdmin.userId;
  async function provision(quota, label) {
    const key = randomUuid();
    const { data, error } = await admin.rpc('admin_provision_organization', {
      p_actor: actorId,
      p_idempotency_key: key,
      p_display_name: `${NAME_PREFIX}-${label}-${key.slice(0, 8)}`,
      p_legal_name: `${NAME_PREFIX}-${label}-${key.slice(0, 8)}`,
      p_anchor_quota: quota,
      p_credits: 0,
      p_is_test: true,
      p_allow_duplicate_name: true,
    });
    if (error) return { rpcError: error.message, key };
    return { ...data, key };
  }

  async function readCredits(orgId) {
    const { data, error } = await admin.from('org_credits').select('anchor_quota, cap_enforced').eq('org_id', orgId).maybeSingle();
    return { data, error };
  }

  const nullQuota = await provision(null, 'null-quota');
  out.push(probe('2831_provision_null_quota_rpc_success', true, nullQuota?.success === true, { detail: nullQuota }));
  if (nullQuota?.success) {
    out.push(probe('2831_provision_null_quota_anchor_quota_null', null, nullQuota.organization?.anchor_quota, { detail: nullQuota.organization }));
    const nullCredits = await readCredits(nullQuota.organization?.org_id);
    out.push(probe('2831_provision_null_quota_cap_enforced_false', false, nullCredits.data?.cap_enforced, { detail: nullCredits.data ?? nullCredits.error }));
  }

  const zeroQuota = await provision(0, 'zero-quota');
  out.push(probe('2831_provision_zero_quota_rpc_success', true, zeroQuota?.success === true, { detail: zeroQuota }));
  if (zeroQuota?.success) {
    out.push(probe('2831_provision_zero_quota_anchor_quota_zero', 0, zeroQuota.organization?.anchor_quota, { detail: zeroQuota.organization }));
    const zeroCredits = await readCredits(zeroQuota.organization?.org_id);
    out.push(probe('2831_provision_zero_quota_cap_enforced_true', true, zeroCredits.data?.cap_enforced, { detail: zeroCredits.data ?? zeroCredits.error }));
  }

  const FINITE_QUOTA = 25;
  const finiteQuota = await provision(FINITE_QUOTA, 'finite-quota');
  out.push(probe('2831_provision_finite_quota_rpc_success', true, finiteQuota?.success === true, { detail: finiteQuota }));
  if (finiteQuota?.success) {
    out.push(probe('2831_provision_finite_quota_anchor_quota_matches', FINITE_QUOTA, finiteQuota.organization?.anchor_quota, { detail: finiteQuota.organization }));
    const finiteCredits = await readCredits(finiteQuota.organization?.org_id);
    out.push(probe('2831_provision_finite_quota_cap_enforced_true', true, finiteCredits.data?.cap_enforced, { detail: finiteCredits.data ?? finiteCredits.error }));
  }

  // ═══════════════════ (7) Provisioning RPC's own idempotency ═══════════════════
  if (nullQuota?.success && nullQuota.key) {
    const { data: replayData, error: replayErr } = await admin.rpc('admin_provision_organization', {
      p_actor: actorId,
      p_idempotency_key: nullQuota.key,
      p_display_name: `${NAME_PREFIX}-null-quota-${nullQuota.key.slice(0, 8)}`,
      p_legal_name: `${NAME_PREFIX}-null-quota-${nullQuota.key.slice(0, 8)}`,
      p_anchor_quota: null,
      p_credits: 0,
      p_is_test: true,
      p_allow_duplicate_name: true,
    });
    out.push(probe('2831_provision_replay_no_rpc_error', true, !replayErr, { detail: replayErr?.message ?? null }));
    out.push(probe('2831_provision_replay_same_org_id', nullQuota.organization?.org_id, replayData?.organization?.org_id, { detail: replayData }));
  }

  return out;
}
