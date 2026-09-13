// PR #2905 — branch feat/scrum-5024-partner-referral-attribution (SCRUM-5024).
// Migration 0455 adds `referral_codes` + `organization_referrals` plus four
// SECURITY DEFINER RPCs (`generate_referral_code` service-only,
// `ensure_org_referral_code`, `record_org_referral`, `get_org_referrals`).
// Migration 0456 (same branch, same soak) replaces the bodies of
// `record_org_referral` and `get_org_referrals` to fix a real authority gap:
// as shipped in 0455, ANY signed-in user who knew an organization's uuid could
// permanently attribute that organization to their own referral code (the
// hijack — `referred_org_id` is the PRIMARY KEY, first write wins forever, no
// revoke surface exists) and could inject rows into a DIFFERENT tenant's audit
// stream via the `unknown_code` branch. 0456 adds a membership check
// (NOT EXISTS ... get_user_org_ids(), NULL-safe) and forbids a non-service
// caller from asserting `p_source` other than 'signup'. This module's two
// highest-value probes are exactly those two fixes — a red on either is a
// live regression to the pre-0456 hijack, not a cosmetic miss.
//
// WHAT THIS RIG CAN AND CANNOT PROVE.
//
// CAN: everything in the task list, live, every cycle — minting (idempotent),
// recording with the disclosure-boundary org ids and NULL actor, the
// once-only guarantee, the cross-tenant RLS read returning nothing, the
// bounded/truncated audit row on an oversized code, AND (beyond the task list,
// because the fix is the point of this PR) that a non-member cannot record an
// attribution for someone else's org and that a non-service caller cannot
// assert `p_source != 'signup'` — the exact 0456 authority checks. Also a
// thin live check of the customer-facing surface: GET /api/v1/referrals
// reflects the attribution once it exists.
//
// CANNOT, and no probe below pretends otherwise: `organization_referrals`
// grants `service_role` only SELECT/INSERT/UPDATE — no DELETE — matching the
// feature's own guarantee that a first attribution is permanent. So this rig
// cannot reset the referred-fixture's attribution between cycles, and
// therefore cannot re-observe the true "first ever" `{applied:true,
// reason:'recorded'}` verdict past cycle 1 of this fixture's lifetime.
// `2905_record_referral_verdict` accepts EITHER `recorded` (cycle 1) OR
// `already_attributed` (every cycle after) as a pass for exactly this reason,
// and a SEPARATE, always-deterministic probe issues one more call in the same
// run and asserts it is `already_attributed` regardless of cycle number. The
// row's EXISTENCE and shape are asserted as a persistent read-back either way
// — see the parallel design note in probes/2904-suborg-webhooks.mjs.
// Similarly, `admin_provisioning` and `api` sources are not exercised as
// VALID calls (only as the two authority-refusal probes) — the worker route
// that legitimately asserts them runs as service_role, which this driver only
// impersonates through `ctx.admin`, and the RPC's own behavior for a
// service_role caller is identical regardless of which HTTP surface invoked
// it, so nothing further is proven by also driving admin-provisioning's HTTP
// route.
import { randomBytes } from 'node:crypto';
import { signInMfa } from '../common.mjs';

export const pr = '#2905';

export const changedBehavior = [
  'ensure_org_referral_code mints one ACTIVE 8-character code per organization',
  '(Crockford-style alphabet minus I/L/O/0/1) and is idempotent — a second call',
  'returns the existing code rather than rotating it. record_org_referral records',
  'at most one referrer per organization forever (referred_org_id is the PRIMARY',
  'KEY) and returns a TOTAL jsonb verdict -- no_code / unknown_code /',
  'self_referral / already_attributed / recorded -- never raising for a bad code.',
  'organization.referred is audited against the REFERRER org with a NULL actor,',
  'never against the referred org (0456 fix: the prior actor_id = auth.uid() let',
  'the referred org read back the referrer raw uuid through its own audit feed).',
  'organization_referrals has no SELECT policy matching referred_org_id at all --',
  'the referred organization sees nothing about itself, by design. 0456 adds the',
  'authority checks 0455 shipped without: a non-service caller may only record a',
  'referral for an org it is a MEMBER of (NULL-safe NOT EXISTS, closing a',
  'permanent cross-tenant attribution hijack), and may only assert p_source =',
  '\'signup\' for itself -- admin_provisioning and api are service_role-only,',
  'closing a caller-asserted-provenance spoof. An oversized code on the',
  'unknown_code path is audited truncated to 32 chars, never raised.',
].join(' ');

const TAG = 'cto-train-b-0912-2905';
const NAMES = {
  referrerOrg: `${TAG}-referrer-org`,
  referredOrg: `${TAG}-referred-org`,
};
const CODE_FORMAT_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

function orgPrefix() {
  return `Z${randomBytes(6).toString('hex').toUpperCase()}`;
}

async function ensureOrg(admin, name) {
  const { data: existing, error: findErr } = await admin.from('organizations').select('id, public_id').eq('display_name', name).maybeSingle();
  if (findErr) throw new Error(`#2905 lookup org ${name}: ${findErr.message}`);
  if (existing) return existing;
  const { data, error } = await admin.from('organizations').insert({ display_name: name, legal_name: name, org_prefix: orgPrefix(), tier: 'ENTERPRISE' }).select('id, public_id').single();
  if (error) throw new Error(`#2905 insert org ${name}: ${error.message}`);
  return data;
}

/** Mirrors setup.mjs's ensureUser — kept local since setup.mjs does not export it. */
async function ensureUser(admin, { local, role, orgId, password }) {
  const email = `${local}@staging.invalid.test`;
  const { data: prof } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
  let userId = prof?.id;
  if (userId) {
    const { error: pwErr } = await admin.auth.admin.updateUserById(userId, { password });
    if (pwErr) throw new Error(`#2905 password reset ${email}: ${pwErr.message}`);
  } else {
    const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: local } });
    if (error || !created.user) throw new Error(`#2905 create user ${email}: ${error?.message}`);
    userId = created.user.id;
  }
  const { error: pe } = await admin.from('profiles').upsert({ id: userId, email, full_name: local, role, org_id: orgId, is_public_profile: false, disclaimer_accepted_at: new Date().toISOString() });
  if (pe) throw new Error(`#2905 profile ${email}: ${pe.message}`);
  const memberRole = role === 'ORG_ADMIN' ? 'admin' : 'member';
  const { error: me } = await admin.from('org_members').upsert({ user_id: userId, org_id: orgId, role: memberRole }, { onConflict: 'user_id,org_id' });
  if (me) throw new Error(`#2905 org_members ${email}: ${me.message}`);
  return { userId, email, password };
}

async function ensureApiKey(admin, { orgId, createdBy, name, scopes, hashApiKey, secret }) {
  const { data: existing, error: findErr } = await admin.from('api_keys').select('id').eq('org_id', orgId).eq('name', name).maybeSingle();
  if (findErr) throw new Error(`#2905 lookup key ${name}: ${findErr.message}`);
  const raw = `ak_test_${randomBytes(32).toString('hex')}`;
  const row = { org_id: orgId, key_prefix: raw.slice(0, 12), key_hash: hashApiKey(raw, secret), name, scopes, created_by: createdBy, is_active: true, revoked_at: null };
  if (existing) {
    const { error } = await admin.from('api_keys').update(row).eq('id', existing.id);
    if (error) throw new Error(`#2905 re-mint key ${name}: ${error.message}`);
    return { id: existing.id, raw };
  }
  const { data, error } = await admin.from('api_keys').insert(row).select('id').single();
  if (error) throw new Error(`#2905 insert key ${name}: ${error.message}`);
  return { id: data.id, raw };
}

/** PostgREST RPC call as a given caller (jwt) or, when omitted, as anon-keyed but unauthenticated. */
async function callRpc(ctx, fnName, args, jwt) {
  const { restFetch, ANON_KEY } = ctx;
  return restFetch(`/rpc/${fnName}`, { apikey: ANON_KEY, jwt, method: 'POST', body: args });
}

// ───────────────────────────────── seed ─────────────────────────────────────

export async function seed(admin, state, ctx) {
  const { error: tableErr } = await admin.from('referral_codes').select('id').limit(1);
  if (tableErr) {
    const missing = tableErr.code === '42P01' || /relation .*referral_codes.* does not exist/i.test(tableErr.message ?? '');
    return {
      skipped: true,
      reason: missing
        ? `migration 0455 is NOT applied to this rig: referral_codes does not exist (${tableErr.message}). Apply 0455 + 0456, then re-run setup.mjs.`
        : `#2905 seed: referral_codes probe failed: ${tableErr.message}`,
    };
  }

  const secret = ctx?.API_KEY_HMAC_SECRET ?? process.env.API_KEY_HMAC_SECRET;
  const hashApiKey = ctx?.hashApiKey;
  if (!secret || typeof hashApiKey !== 'function') {
    return { skipped: true, reason: '#2905 seed: API_KEY_HMAC_SECRET / hashApiKey unavailable' };
  }
  if (!state.password) {
    return { skipped: true, reason: '#2905 seed: state.password missing — run setup.mjs first' };
  }

  const referrerOrg = await ensureOrg(admin, NAMES.referrerOrg);
  const referredOrg = await ensureOrg(admin, NAMES.referredOrg);
  const adminR = await ensureUser(admin, { local: `${TAG}-admin-r`, role: 'ORG_ADMIN', orgId: referrerOrg.id, password: state.password });
  const memberD = await ensureUser(admin, { local: `${TAG}-member-d`, role: 'ORG_MEMBER', orgId: referredOrg.id, password: state.password });
  const readKey = await ensureApiKey(admin, { orgId: referrerOrg.id, createdBy: adminR.userId, name: `${TAG}-read-orgs-key`, scopes: ['read:orgs'], hashApiKey, secret });

  return { referrerOrg, referredOrg, adminR, memberD, readKeyRaw: readKey.raw };
}

// ───────────────────────────────── run ──────────────────────────────────────

export async function run(ctx) {
  const { admin, state, probe, workerFetch, ANON_KEY } = ctx;
  const out = [];
  const seeded = state['#2905'];
  if (!seeded || seeded.skipped) {
    out.push(probe('2905_seed_ok', true, false, { pass: false, detail: seeded?.reason ?? '#2905 seed() did not run — call setup.mjs first' }));
    return out;
  }

  // 0451 mandatory MFA: adminR/memberD are per-module fixture users nested
  // under state['#2905'] (this module's own seed() output), not top-level
  // state keys like adminA/platformAdmin, so signInMfa (which persists a
  // TOTP factor to FIXTURE_STATE under a flat state[stateKey]) has no stable
  // top-level slot to write into by default. Alias them onto stable
  // top-level keys here, merging in the identity fields fresh every cycle
  // (seed() output, authoritative) with whatever totp fields a prior cycle
  // already persisted under that same alias — so the enrolled factor
  // survives across cycles instead of re-enrolling every time.
  state.referral2905AdminR = { ...seeded.adminR, ...(state.referral2905AdminR ?? {}) };
  state.referral2905MemberD = { ...seeded.memberD, ...(state.referral2905MemberD ?? {}) };

  const signedR = await signInMfa(ctx, 'referral2905AdminR');
  const signedD = await signInMfa(ctx, 'referral2905MemberD');
  out.push(probe('2905_referrer_admin_signed_in', true, Boolean(signedR.token), {
    detail: { status: signedR.status, error: signedR.error, aalBefore: signedR.aalBefore, roleBefore: signedR.roleBefore },
  }));
  out.push(probe('2905_referred_member_signed_in', true, Boolean(signedD.token), {
    detail: { status: signedD.status, error: signedD.error, aalBefore: signedD.aalBefore, roleBefore: signedD.roleBefore },
  }));
  if (!signedR.token || !signedD.token) return out;
  out.push(probe('2905_referrer_admin_session_is_aal2', 'aal2', signedR.aalAfter, { detail: { roleAfter: signedR.roleAfter } }));
  out.push(probe('2905_referred_member_session_is_aal2', 'aal2', signedD.aalAfter, { detail: { roleAfter: signedD.roleAfter } }));
  const jwtR = signedR.token;
  const jwtD = signedD.token;

  // ── (1) Minting: idempotent, format-correct ────────────────────────────
  const mint1 = await callRpc(ctx, 'ensure_org_referral_code', { p_org_id: seeded.referrerOrg.id }, jwtR);
  out.push(probe('2905_mint_200', 200, mint1.status, { detail: mint1.body ?? mint1.text }));
  const code = typeof mint1.body === 'string' ? mint1.body : null;
  out.push(probe('2905_mint_code_format', true, typeof code === 'string' && CODE_FORMAT_RE.test(code), { detail: { code, rawBody: mint1.body, rawText: mint1.text } }));

  const mint2 = await callRpc(ctx, 'ensure_org_referral_code', { p_org_id: seeded.referrerOrg.id }, jwtR);
  const code2 = typeof mint2.body === 'string' ? mint2.body : null;
  out.push(probe('2905_mint_idempotent_same_code', code, code2, { detail: { first: code, second: code2 } }));
  if (typeof code !== 'string') return out;

  // ── (2)+(3) Recording: verdict, org ids, NULL-actor disclosure boundary ──
  const record1 = await callRpc(ctx, 'record_org_referral', { p_org_id: seeded.referredOrg.id, p_code: code, p_source: 'signup' }, jwtD);
  out.push(probe('2905_record_referral_200', 200, record1.status, { detail: record1.body }));
  const verdict1 = record1.body?.reason;
  out.push(probe('2905_record_referral_verdict', ['recorded', 'already_attributed'], verdict1, {
    pass: verdict1 === 'recorded' || verdict1 === 'already_attributed',
    detail: { note: 'organization_referrals has no DELETE grant even for service_role (by design — first attribution is permanent), so only cycle 1 of this fixture\'s lifetime can observe "recorded"; every later cycle correctly observes "already_attributed"', body: record1.body },
  }));

  const { data: refRow, error: refRowErr } = await admin
    .from('organization_referrals')
    .select('referred_org_id, referrer_org_id, referral_code_used, source')
    .eq('referred_org_id', seeded.referredOrg.id)
    .maybeSingle();
  out.push(probe('2905_referral_row_org_ids_correct', { referred: seeded.referredOrg.id, referrer: seeded.referrerOrg.id }, { referred: refRow?.referred_org_id, referrer: refRow?.referrer_org_id }, {
    pass: refRow?.referred_org_id === seeded.referredOrg.id && refRow?.referrer_org_id === seeded.referrerOrg.id,
    detail: { error: refRowErr?.message ?? null, source: refRow?.source ?? null },
  }));

  const { data: referredAuditRow } = await admin
    .from('audit_events')
    .select('actor_id, org_id, target_id')
    .eq('event_type', 'organization.referred')
    .eq('org_id', seeded.referrerOrg.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // Bug fixed here: `referredAuditRow?.actor_id ?? 'NO_ROW'` collapsed the
  // desired PASS outcome (row exists, actor_id IS null) into the same
  // 'NO_ROW' sentinel used for "no row found" — `??` treats a real `null`
  // actor_id as nullish too, so this probe could never observe a true pass
  // for the exact 0456 regression it exists to guard. Distinguish "row
  // missing" from "row present with a null actor_id" explicitly instead.
  out.push(probe('2905_referred_audit_actor_is_null', null, referredAuditRow ? referredAuditRow.actor_id : 'NO_ROW', {
    detail: { note: '0456 fix: actor_id must be NULL — the pre-fix body filed auth.uid() here, letting the referred user read the referrer raw uuid back through their own audit_events row', row: referredAuditRow },
  }));
  out.push(probe('2905_referred_audit_filed_against_referrer_org', seeded.referrerOrg.id, referredAuditRow?.org_id ?? null, {}));

  // ── (4) Disclosure boundary: the REFERRED org's own member reads nothing ──
  const crossTenantRead = await ctx.restFetch(`/organization_referrals?referred_org_id=eq.${seeded.referredOrg.id}`, { apikey: ANON_KEY, jwt: jwtD });
  out.push(probe('2905_referred_org_member_sees_zero_rows', 0, Array.isArray(crossTenantRead.body) ? crossTenantRead.body.length : -1, {
    detail: { status: crossTenantRead.status, body: crossTenantRead.body, note: 'no SELECT policy matches referred_org_id on organization_referrals — this is a deliberate asymmetry, not a missing policy' },
  }));
  const cannotSeeCode = await ctx.restFetch(`/referral_codes?org_id=eq.${seeded.referrerOrg.id}`, { apikey: ANON_KEY, jwt: jwtD });
  out.push(probe('2905_referred_org_member_cannot_read_referrer_code_row', 0, Array.isArray(cannotSeeCode.body) ? cannotSeeCode.body.length : -1, {
    detail: { status: cannotSeeCode.status, note: 'referral_codes_select_member only matches the callers OWN org_id' },
  }));

  // ── (5) Duplicate is idempotent, deterministically, every cycle ─────────
  const record2 = await callRpc(ctx, 'record_org_referral', { p_org_id: seeded.referredOrg.id, p_code: code, p_source: 'signup' }, jwtD);
  out.push(probe('2905_duplicate_record_already_attributed', 'already_attributed', record2.body?.reason, { detail: record2.body }));
  const { count: rowCount } = await admin.from('organization_referrals').select('referred_org_id', { count: 'exact', head: true }).eq('referred_org_id', seeded.referredOrg.id);
  out.push(probe('2905_duplicate_record_did_not_create_second_row', 1, rowCount ?? -1, {}));

  // ── (6) Audit row is bounded: an oversized code is unknown_code, truncated, never a raise ──
  const oversizedCode = 'X'.repeat(60);
  const unknownCodeCall = await callRpc(ctx, 'record_org_referral', { p_org_id: seeded.referredOrg.id, p_code: oversizedCode, p_source: 'signup' }, jwtD);
  out.push(probe('2905_oversized_code_is_unknown_code_not_a_raise', ['unknown_code', 200], [unknownCodeCall.body?.reason, unknownCodeCall.status], {
    pass: unknownCodeCall.status === 200 && unknownCodeCall.body?.reason === 'unknown_code',
    detail: unknownCodeCall.body,
  }));
  const { data: invalidAuditRow } = await admin
    .from('audit_events')
    .select('details')
    .eq('event_type', 'organization.referral_code_invalid')
    .eq('org_id', seeded.referredOrg.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  let auditedCodeLen = null;
  try { auditedCodeLen = JSON.parse(invalidAuditRow?.details ?? '{}').code?.length ?? null; } catch { /* leave null */ }
  out.push(probe('2905_invalid_code_audited_truncated_to_32', true, typeof auditedCodeLen === 'number' && auditedCodeLen <= 32, {
    detail: { auditedCodeLen, sentLength: oversizedCode.length, row: invalidAuditRow },
  }));

  // ── 0456 authority fix 1: a non-member cannot record for someone else's org ──
  const hijackAttempt = await callRpc(ctx, 'record_org_referral', { p_org_id: seeded.referrerOrg.id, p_code: code, p_source: 'signup' }, jwtD);
  out.push(probe('2905_non_member_hijack_attempt_refused', true, hijackAttempt.status >= 400 && hijackAttempt.status < 500, {
    detail: { note: '0456 fix: memberD (a member of referredOrg only) attempting to record an attribution FOR referrerOrg must be refused — pre-0456 this succeeded and permanently hijacked referrerOrg to memberD\'s code', status: hijackAttempt.status, body: hijackAttempt.body },
  }));
  const { count: referrerOrgReferredCount } = await admin.from('organization_referrals').select('referred_org_id', { count: 'exact', head: true }).eq('referred_org_id', seeded.referrerOrg.id);
  out.push(probe('2905_referrer_org_never_hijacked', 0, referrerOrgReferredCount ?? -1, {
    detail: { note: 'referrerOrg must never appear as a referred_org_id — a non-zero count here is the hijack actually landing' },
  }));

  // ── 0456 authority fix 2: a non-service caller cannot assert p_source != 'signup' ──
  const spoofAttempt = await callRpc(ctx, 'record_org_referral', { p_org_id: seeded.referredOrg.id, p_code: code, p_source: 'api' }, jwtD);
  out.push(probe('2905_non_service_source_spoof_refused', true, spoofAttempt.status >= 400 && spoofAttempt.status < 500, {
    detail: { note: '0456 fix: only service_role may assert p_source other than signup', status: spoofAttempt.status, body: spoofAttempt.body },
  }));
  const { data: refRowAfterSpoof } = await admin.from('organization_referrals').select('source').eq('referred_org_id', seeded.referredOrg.id).maybeSingle();
  out.push(probe('2905_stored_source_unchanged_by_spoof_attempt', 'signup', refRowAfterSpoof?.source ?? null, {}));

  // ── HTTP-surface reflection: GET /api/v1/referrals shows the attribution ──
  const getReferrals = await workerFetch('/api/v1/referrals', { method: 'GET', apiKeyRaw: seeded.readKeyRaw });
  out.push(probe('2905_get_referrals_200', 200, getReferrals.status, { detail: getReferrals.body }));
  const referredList = getReferrals.body?.referred ?? [];
  const referredOrgPublicId = seeded.referredOrg.public_id;
  const listedByPublicId = referredOrgPublicId
    ? referredList.some((r) => r.organization_public_id === referredOrgPublicId)
    : referredList.length > 0;
  out.push(probe('2905_get_referrals_lists_referred_org', true, listedByPublicId, {
    detail: { referredOrgPublicId, listedCount: referredList.length, sample: referredList.slice(0, 3) },
  }));
  out.push(probe('2905_get_referrals_code_matches_minted', code, getReferrals.body?.referral_code ?? null, {}));

  return out;
}
