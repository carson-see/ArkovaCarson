// PR #2841 — API-key expiry visibility (SCRUM-5023).
//
// WHAT THIS RIG CAN AND CANNOT PROVE, stated before the probes so the evidence
// is not read as more than it is.
//
// CAN: every server-side behaviour the PR changed that is observable through
// the HTTP surface plus a DB read-back — the derived `status` /
// `days_until_expiry` fields on GET, the extend that must land on exactly the
// requested day count, the two 409s (shorten guard, revoked guard), and the
// revoke-carrying-an-expiry case that must revoke and must NOT write an
// `api_key.expiry_changed` row.
//
// CANNOT: actual mail delivery. `runApiKeyExpiryNotice` returns
// `{skipped:true, reason:'email_not_configured'}` as its FIRST statement when
// `config.resendApiKey` is unset, before it reads a single key — so on a rig
// with no Resend key the selection sweep and the (kind, expires_at) dedupe are
// not exercised at all, and `scanned`/`deduped` are structurally 0. The probes
// below detect which branch they are in and assert accordingly: the notice
// probes NEVER report a dedupe as proven when the job short-circuited. What
// the skipped branch does prove is its own invariant — a skipped run writes NO
// ledger row, so a correctly configured environment still delivers the notice
// on its next run rather than finding it "already sent".
//
// Every probe pairs its response assertion with a DB read-back or an exact
// count taken from ctx.admin (driver rule 1: never a bare HTTP status). A 409
// that had already written the shortened expiry would pass a status check and
// fail these.
//
// MUTATION AND RESET. This probe mutates its own fixture rows (extend, revoke)
// and the job writes `api_key.expiry_notice` rows against them. `reset()` at
// the end of every cycle restores the seeded expiries and deletes the audit
// rows THIS probe caused on THOSE fixture keys, so each cycle is independent
// and cycle N+1 re-proves the notice from a clean ledger. Nothing outside the
// `cto-train-b-0912-2841-` fixture set is touched.
import { randomBytes, randomUUID } from 'node:crypto';

export const pr = '#2841';

export const changedBehavior = [
  'GET /api/v1/keys returns the server-derived `status` and `days_until_expiry`',
  '(additive §1.8 fields) and NEVER the request-side name `expires_in_days`.',
  'PATCH /api/v1/keys/:id accepts `expires_in_days` to set, extend or clear an',
  'expiry from ONE request clock, so a 90-day extend reports exactly 90;',
  'refuses with 409 api_key_expiry_would_shorten when the requested expiry is',
  'earlier than the current one and `allow_shorten` is absent (an already-lapsed',
  'key is exempt); refuses with 409 api_key_already_revoked when the row is',
  'revoked OR merely is_active=false; and honours {is_active:false,',
  'expires_in_days:n} as a REVOKE with the expiry dropped — revoked_at stamped,',
  'no api_key.expiry_changed audit row.',
  'POST /jobs/api-key-expiry-notice sweeps every org with no lower time bound,',
  'dedupes on (kind, expires_at) in audit_events, and resolves recipients from',
  'the UNION of profiles.role=ORG_ADMIN and org_members owner/admin.',
  'NOT proven on a rig without RESEND_API_KEY: mail delivery, and — because the',
  'unconfigured-provider skip precedes the sweep — the selection and dedupe',
  'counters themselves. The probes below say which branch ran and assert the',
  'skip-writes-nothing invariant instead of a vacuous pass.',
].join(' ');

const DAY_MS = 24 * 60 * 60 * 1000;
const TAG = 'cto-train-b-0912-2841';

/** The job's own lead window (NOTICE_LEAD_DAYS in jobs/api-key-expiry-notice.ts). */
const NOTICE_LEAD_DAYS = 7;
const EXPIRY_NOTICE_EVENT = 'api_key.expiry_notice';
const EXPIRY_CHANGED_EVENT = 'api_key.expiry_changed';
const REVOKED_EVENT = 'api_key.revoked';

const NAMES = {
  expired: `${TAG}-expired-73d`,
  soon: `${TAG}-expiring-5d`,
  long: `${TAG}-active-330d`,
  never: `${TAG}-no-expiry`,
  deactivated: `${TAG}-deactivated-unstamped`,
  revokeTarget: `${TAG}-revoke-target`,
  orgD: `${TAG}-orgd-expiring-3d`,
};

// ───────────────────────────── seed ──────────────────────────────────────────

/**
 * Upsert one fixture key to an EXACT shape. Re-running normalises an existing
 * row rather than inserting a second one, so setup.mjs is idempotent and a
 * mid-cycle crash cannot leave a mutated fixture behind.
 *
 * `key_hash` is random per key and is never authenticated with — these rows
 * exist to be read and PATCHed, not to sign a request. The column is unique,
 * so a shared placeholder would collide across the six keys.
 */
async function ensureKey(admin, { orgId, createdBy, name, expiresAt, isActive = true }) {
  const { data: existing, error: findErr } = await admin
    .from('api_keys')
    .select('id')
    .eq('org_id', orgId)
    .eq('name', name)
    .maybeSingle();
  if (findErr) throw new Error(`#2841 lookup ${name}: ${findErr.message}`);

  if (existing) {
    const { error } = await admin
      .from('api_keys')
      .update({ expires_at: expiresAt, is_active: isActive, revoked_at: null, revocation_reason: null })
      .eq('id', existing.id);
    if (error) throw new Error(`#2841 normalise ${name}: ${error.message}`);
    return existing.id;
  }

  const raw = `ak_test_${randomBytes(32).toString('hex')}`;
  const { data, error } = await admin
    .from('api_keys')
    .insert({
      org_id: orgId,
      key_prefix: raw.slice(0, 12),
      key_hash: randomBytes(32).toString('hex'),
      name,
      scopes: ['read:search', 'write:anchor'],
      created_by: createdBy,
      expires_at: expiresAt,
      is_active: isActive,
    })
    .select('id')
    .single();
  if (error) throw new Error(`#2841 insert ${name}: ${error.message}`);
  return data.id;
}

/**
 * Org D: the prod shape that a profiles-only recipient lookup loses.
 *
 * Its ONLY administrator is an `org_members` row with role `admin`. The
 * matching profile is deliberately `ORG_MEMBER`, so
 * `profiles.role = 'ORG_ADMIN' AND org_id = D` returns ZERO rows — exactly the
 * "Fragile Rocks" shape read out of prod on 2026-09-12. If the union in
 * utils/orgAdminRecipients.ts regressed to a profiles-only query, this org's
 * key lapses in silence and the job counts a `noRecipients`.
 */
async function ensureOrgD(admin, password) {
  const displayName = `${TAG}-org-d`;
  let orgId;
  const { data: existingOrg } = await admin
    .from('organizations')
    .select('id')
    .eq('display_name', displayName)
    .maybeSingle();
  if (existingOrg) {
    orgId = existingOrg.id;
  } else {
    const { data, error } = await admin
      .from('organizations')
      .insert({
        display_name: displayName,
        legal_name: displayName,
        org_prefix: `Z${randomUUID().replace(/-/g, '').slice(0, 11).toUpperCase()}`,
      })
      .select('id')
      .single();
    if (error) throw new Error(`#2841 org D: ${error.message}`);
    orgId = data.id;
  }

  const email = `${TAG}-member-admin-d@staging.invalid.test`;
  const { data: prof } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
  let userId = prof?.id;
  if (!userId) {
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: `${TAG}-member-admin-d` },
    });
    if (error || !created?.user) throw new Error(`#2841 org D user: ${error?.message}`);
    userId = created.user.id;
  }

  // ORG_MEMBER on purpose — see the header. This is the half the union needs.
  const { error: pe } = await admin.from('profiles').upsert({
    id: userId,
    email,
    full_name: `${TAG}-member-admin-d`,
    role: 'ORG_MEMBER',
    org_id: orgId,
    is_public_profile: false,
    is_platform_admin: false,
    disclaimer_accepted_at: new Date().toISOString(),
  });
  if (pe) throw new Error(`#2841 org D profile: ${pe.message}`);

  const { error: me } = await admin
    .from('org_members')
    .upsert({ user_id: userId, org_id: orgId, role: 'admin', status: 'active' }, { onConflict: 'user_id,org_id' });
  if (me) throw new Error(`#2841 org D membership: ${me.message}`);

  return { orgId, userId, email };
}

export async function seed(admin, state) {
  const now = Date.now();
  const createdBy = state.adminA.userId;

  // Absolute timestamps, persisted in state: reset() restores these EXACT
  // values, so an assertion that a 409 left `expires_at` untouched compares
  // against a string rather than a recomputed instant.
  const expiredAt = new Date(now - 73 * DAY_MS).toISOString();
  const soonAt = new Date(now + 5 * DAY_MS).toISOString();
  const longAt = new Date(now + 330 * DAY_MS).toISOString();
  const deactivatedAt = new Date(now + 60 * DAY_MS).toISOString();
  const revokeTargetAt = new Date(now + 120 * DAY_MS).toISOString();
  const orgDAt = new Date(now + 3 * DAY_MS).toISOString();

  const orgD = await ensureOrgD(admin, state.password);

  const ids = {
    expired: await ensureKey(admin, { orgId: state.orgA, createdBy, name: NAMES.expired, expiresAt: expiredAt }),
    soon: await ensureKey(admin, { orgId: state.orgA, createdBy, name: NAMES.soon, expiresAt: soonAt }),
    long: await ensureKey(admin, { orgId: state.orgA, createdBy, name: NAMES.long, expiresAt: longAt }),
    never: await ensureKey(admin, { orgId: state.orgA, createdBy, name: NAMES.never, expiresAt: null }),
    // is_active=false with revoked_at NULL — the pre-FD-P7 withdrawn-but-
    // unstamped shape prod still holds. deriveKeyStatus must call it `revoked`
    // off the boolean alone, or PATCH would extend a key auth refuses.
    deactivated: await ensureKey(admin, {
      orgId: state.orgA, createdBy, name: NAMES.deactivated, expiresAt: deactivatedAt, isActive: false,
    }),
    revokeTarget: await ensureKey(admin, {
      orgId: state.orgA, createdBy, name: NAMES.revokeTarget, expiresAt: revokeTargetAt,
    }),
    orgD: await ensureKey(admin, { orgId: orgD.orgId, createdBy: orgD.userId, name: NAMES.orgD, expiresAt: orgDAt }),
  };

  return {
    ids,
    seededExpiries: {
      expired: expiredAt,
      soon: soonAt,
      long: longAt,
      never: null,
      deactivated: deactivatedAt,
      revokeTarget: revokeTargetAt,
      orgD: orgDAt,
    },
    orgD,
  };
}

// ───────────────────────────── helpers ───────────────────────────────────────

/**
 * An ORG_ADMIN access token from GoTrue, the same password grant the dashboard
 * uses. The keys router is mounted `requireAuth, requireScope('keys:manage')`:
 * requireAuth REJECTS a `Bearer ak_` token outright, so these routes are
 * reachable only with a real Supabase JWT — an API key cannot stand in.
 */
async function signIn(ctx) {
  const email = ctx.state.adminA?.email;
  const password = ctx.state.adminA?.password ?? ctx.state.password;
  if (!email || !password) throw new Error('#2841: state.adminA credentials missing — run setup.mjs');

  const r = await fetch(`${ctx.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ctx.ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.access_token) {
    throw new Error(`#2841 sign-in failed (${r.status}): ${JSON.stringify(body)?.slice(0, 300)}`);
  }
  return body.access_token;
}

/**
 * Compare two timestamps ACROSS sources by instant, never by string.
 * PostgREST renders `timestamptz` as `...+00:00` while JS `toISOString()`
 * emits `...Z`; the same moment fails an `===` between them. Two values read
 * from the SAME source are still compared as strings elsewhere, which is
 * stricter and correct there.
 */
function sameInstant(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

/** The stored row, read with the service role — the read-back behind every assertion. */
async function readKey(admin, keyId) {
  const { data, error } = await admin
    .from('api_keys')
    .select('id, expires_at, is_active, revoked_at, revocation_reason')
    .eq('id', keyId)
    .maybeSingle();
  if (error) throw new Error(`#2841 read-back ${keyId}: ${error.message}`);
  return data;
}

async function countAuditRows(admin, eventType, keyId) {
  const { count, error } = await admin
    .from('audit_events')
    .select('id', { count: 'exact', head: true })
    .eq('event_type', eventType)
    .eq('target_id', keyId);
  if (error) throw new Error(`#2841 audit count ${eventType}: ${error.message}`);
  return count ?? 0;
}

/** Poll a fire-and-forget audit write (logAuditEvent floats its promise). */
async function waitForAuditRow(admin, eventType, keyId, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await countAuditRows(admin, eventType, keyId);
    if (n > 0 || Date.now() >= deadline) return n;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Every `api_key.expiry_notice` ledger row for one key, details parsed. */
async function listNoticeLedger(admin, keyId) {
  const { data, error } = await admin
    .from('audit_events')
    .select('details')
    .eq('event_type', EXPIRY_NOTICE_EVENT)
    .eq('target_type', 'api_key')
    .eq('target_id', keyId);
  if (error) throw new Error(`#2841 ledger read ${keyId}: ${error.message}`);
  return (data ?? []).flatMap((row) => {
    try {
      const parsed = JSON.parse(String(row.details ?? '{}'));
      return [{ kind: parsed?.kind ?? null, expiresAt: parsed?.expires_at ?? null }];
    } catch {
      return [];
    }
  });
}

/**
 * Restore every fixture row this cycle mutated and drop the audit rows this
 * probe caused on those rows. Scoped strictly to the seeded key ids.
 */
async function reset(admin, seeded) {
  const { ids, seededExpiries } = seeded;
  const restore = [
    ['expired', { expires_at: seededExpiries.expired, is_active: true, revoked_at: null, revocation_reason: null }],
    ['soon', { expires_at: seededExpiries.soon, is_active: true, revoked_at: null, revocation_reason: null }],
    ['long', { expires_at: seededExpiries.long, is_active: true, revoked_at: null, revocation_reason: null }],
    ['never', { expires_at: null, is_active: true, revoked_at: null, revocation_reason: null }],
    ['deactivated', { expires_at: seededExpiries.deactivated, is_active: false, revoked_at: null, revocation_reason: null }],
    ['revokeTarget', { expires_at: seededExpiries.revokeTarget, is_active: true, revoked_at: null, revocation_reason: null }],
    ['orgD', { expires_at: seededExpiries.orgD, is_active: true, revoked_at: null, revocation_reason: null }],
  ];
  const errors = [];
  for (const [key, patch] of restore) {
    const id = ids[key];
    if (!id) continue;
    const { error } = await admin.from('api_keys').update(patch).eq('id', id);
    if (error) errors.push(`${key}: ${error.message}`);
  }
  const keyIds = Object.values(ids).filter(Boolean);
  for (const eventType of [EXPIRY_NOTICE_EVENT, EXPIRY_CHANGED_EVENT, REVOKED_EVENT]) {
    const { error } = await admin.from('audit_events').delete().eq('event_type', eventType).in('target_id', keyIds);
    if (error) errors.push(`${eventType} cleanup: ${error.message}`);
  }
  return errors;
}

// ───────────────────────────── run ───────────────────────────────────────────

export async function run(ctx) {
  const { admin, state, probe, workerFetch, env } = ctx;
  const seeded = state[pr];
  const out = [];

  if (!seeded?.ids?.expired) {
    return [probe('2841_fixtures_present', true, false, { pass: false, detail: 'state["#2841"] missing — setup.mjs did not seed' })];
  }
  const { ids, seededExpiries, orgD } = seeded;

  let jwt;
  try {
    jwt = await signIn(ctx);
  } catch (e) {
    return [probe('2841_org_admin_signin', 'access_token', 'failed', { pass: false, detail: String(e.message ?? e) })];
  }
  out.push(probe('2841_org_admin_signin', true, Boolean(jwt), { detail: { email: state.adminA.email } }));

  try {
    // ── (a) GET /api/v1/keys: derived status, and the renamed field ─────────
    const list = await workerFetch('/api/v1/keys', { jwt });
    const rows = Array.isArray(list.body?.keys) ? list.body.keys : [];
    out.push(probe('2841a_list_keys_200', 200, list.status, { detail: { returned: rows.length } }));

    const byId = new Map(rows.map((k) => [k.id, k]));
    const missingStatus = rows.filter((k) => !Object.prototype.hasOwnProperty.call(k, 'status')).length;
    out.push(probe('2841a_status_present_on_every_row', 0, missingStatus, {
      detail: 'keyExpiryFields() is spread onto every row; a row without `status` means the list route dropped the derivation.',
    }));

    // The rename is the point: `expires_in_days` is the REQUEST field ("set the
    // expiry n days out"). Echoing it back as a countdown that goes negative is
    // what invites a client to read one and PUT the other.
    const leakedRequestName = rows.filter((k) => Object.prototype.hasOwnProperty.call(k, 'expires_in_days')).length;
    out.push(probe('2841a_response_does_not_carry_expires_in_days', 0, leakedRequestName, {
      detail: 'Response field must be `days_until_expiry`.',
    }));

    const missingCountdown = rows.filter((k) => !Object.prototype.hasOwnProperty.call(k, 'days_until_expiry')).length;
    out.push(probe('2841a_days_until_expiry_present_on_every_row', 0, missingCountdown, { detail: null }));

    for (const [label, expectedStatus] of [['expired', 'expired'], ['soon', 'expiring_soon'], ['long', 'active'], ['never', 'active']]) {
      const row = byId.get(ids[label]);
      out.push(probe(`2841a_status_${label}`, expectedStatus, row?.status ?? null, {
        detail: { keyId: ids[label], days_until_expiry: row?.days_until_expiry ?? null, expires_at: row?.expires_at ?? null },
      }));
    }

    // A never-expiring key must report a NULL countdown, not 0 — `0` would
    // render as "expires today" on a key that never expires.
    const neverRow = byId.get(ids.never);
    // PRESENT AND NULL, which `??` cannot distinguish from absent — the field
    // has to be read through hasOwnProperty or a missing key reads as null.
    const countdownPresent = Boolean(neverRow) && Object.prototype.hasOwnProperty.call(neverRow, 'days_until_expiry');
    out.push(probe('2841a_no_expiry_countdown_is_null', true, countdownPresent && neverRow.days_until_expiry === null, {
      detail: {
        present: countdownPresent,
        value: countdownPresent ? neverRow.days_until_expiry : '<absent>',
        note: '`0` here would render as "expires today" on a key that never expires.',
      },
    }));

    // ── (f) the notice sweep, twice ─────────────────────────────────────────
    // Run BEFORE the mutations below: (b) extends the lapsed key 90 days out,
    // which would carry it past the 7-day lead window and change what the
    // sweep selects.
    const cronSecret = env.CRON_SECRET ?? '';
    const noticeBefore = {
      expired: await countAuditRows(admin, EXPIRY_NOTICE_EVENT, ids.expired),
      soon: await countAuditRows(admin, EXPIRY_NOTICE_EVENT, ids.soon),
      orgD: await countAuditRows(admin, EXPIRY_NOTICE_EVENT, ids.orgD),
    };

    // Fixture shape, asserted directly — this is what the sweep WOULD select,
    // and it is the half that stays true whether or not the mailer is wired.
    const windowEnd = new Date(Date.now() + NOTICE_LEAD_DAYS * DAY_MS).toISOString();
    const { data: selectable, error: selErr } = await admin
      .from('api_keys')
      .select('id')
      .eq('is_active', true)
      .is('revoked_at', null)
      .not('expires_at', 'is', null)
      .lte('expires_at', windowEnd)
      .in('id', [ids.expired, ids.soon, ids.long, ids.orgD]);
    const selectableIds = new Set((selectable ?? []).map((r) => r.id));
    out.push(probe('2841f_window_selects_lapsed_and_soon_not_long', true,
      selectableIds.has(ids.expired) && selectableIds.has(ids.soon) && selectableIds.has(ids.orgD) && !selectableIds.has(ids.long), {
        detail: {
          note: 'No LOWER bound: the 73-day-lapsed key must still be selectable. The +330d key must not be.',
          windowEnd, selected: [...selectableIds], error: selErr?.message ?? null,
        },
      }));

    // The recipient union's precondition: org D has ZERO profiles ORG_ADMINs
    // and at least one org_members admin carrying a live address. Without this
    // the union assertion below would be vacuous.
    const { count: orgDProfileAdmins } = await admin
      .from('profiles').select('id', { count: 'exact', head: true })
      .eq('org_id', orgD.orgId).eq('role', 'ORG_ADMIN').is('deleted_at', null);
    const { data: orgDMemberAdmins } = await admin
      .from('org_members').select('user_id').eq('org_id', orgD.orgId).in('role', ['owner', 'admin']);
    out.push(probe('2841f_orgD_has_prod_shape_admin_only_in_org_members', true,
      (orgDProfileAdmins ?? 0) === 0 && (orgDMemberAdmins ?? []).length >= 1, {
        detail: {
          profilesOrgAdmins: orgDProfileAdmins ?? 0,
          orgMembersAdmins: (orgDMemberAdmins ?? []).length,
          note: 'The "Fragile Rocks" shape: a profiles-only recipient lookup returns nothing for this org.',
        },
      }));

    const run1 = await workerFetch('/jobs/api-key-expiry-notice', {
      method: 'POST', headers: cronSecret ? { 'X-Cron-Secret': cronSecret } : {},
    });
    out.push(probe('2841f_notice_cron_authenticated', true, run1.status !== 401 && run1.status !== 403, {
      detail: { status: run1.status, cronSecretPresent: Boolean(cronSecret) },
    }));
    out.push(probe('2841f_notice_run1_200', 200, run1.status, { detail: run1.body }));

    const run2 = await workerFetch('/jobs/api-key-expiry-notice', {
      method: 'POST', headers: cronSecret ? { 'X-Cron-Secret': cronSecret } : {},
    });
    out.push(probe('2841f_notice_run2_200', 200, run2.status, { detail: run2.body }));

    const skipped = run1.body?.skipped === true;
    const deliveryNote = skipped
      ? 'email_delivery: not exercised on rig — the provider is unconfigured, so runApiKeyExpiryNotice short-circuits BEFORE the sweep and scanned/deduped are structurally 0.'
      : 'email_delivery: attempted through the configured provider; `notified` counts a successful send.';

    if (skipped) {
      // The skip's own invariant: it must write NOTHING. A ledger row written
      // here would consume the key's one warning in an environment that never
      // sent it.
      out.push(probe('2841f_skip_reason_is_email_not_configured', 'email_not_configured', run1.body?.reason ?? null, {
        detail: deliveryNote,
      }));
      out.push(probe('2841f_skipped_run_scanned_zero', 0, run1.body?.scanned ?? null, {
        detail: 'The provider check precedes listKeysInWindow.',
      }));
      out.push(probe('2841f_skipped_run_notified_zero', 0, run1.body?.notified ?? null, { detail: deliveryNote }));

      const after = {
        expired: await countAuditRows(admin, EXPIRY_NOTICE_EVENT, ids.expired),
        soon: await countAuditRows(admin, EXPIRY_NOTICE_EVENT, ids.soon),
        orgD: await countAuditRows(admin, EXPIRY_NOTICE_EVENT, ids.orgD),
      };
      out.push(probe('2841f_skipped_run_writes_no_ledger_row', JSON.stringify(noticeBefore), JSON.stringify(after), {
        detail: 'A skipped run must not mark any key notified — otherwise a configured environment finds the warning "already sent".',
      }));
      out.push(probe('2841f_dedupe_not_exercised_on_this_rig', true, true, {
        detail: 'RECORDED, NOT PROVEN: the (kind, expires_at) dedupe and the recipient union need RESEND_API_KEY on the rig. Unit coverage: api-key-expiry-notice.test.ts.',
      }));
    } else {
      // Live branch: the sweep ran, so the counters mean something.
      out.push(probe('2841f_run1_scanned_covers_fixtures', true, (run1.body?.scanned ?? 0) >= 3, {
        detail: { scanned: run1.body?.scanned, note: 'expired + expiring-soon + org D, at minimum.', deliveryNote },
      }));
      out.push(probe('2841f_run1_notified_at_least_one', true, (run1.body?.notified ?? 0) >= 1, {
        detail: { notified: run1.body?.notified, failed: run1.body?.failed, noRecipients: run1.body?.noRecipients },
      }));

      // The dedupe: a second run inside the same window re-mails nobody, and
      // every key run 1 notified is counted as deduped in run 2.
      out.push(probe('2841f_run2_notified_zero', 0, run2.body?.notified ?? null, {
        detail: 'Second sweep in the same window must send nothing.',
      }));
      out.push(probe('2841f_run2_deduped_covers_run1_notified', true,
        (run2.body?.deduped ?? 0) >= (run1.body?.notified ?? 0), {
          detail: { run1: run1.body, run2: run2.body },
        }));

      // Exactly one ledger row per key per (kind, expires_at) — the assertion
      // the counters alone cannot make.
      const expiredLedger = await listNoticeLedger(admin, ids.expired);
      out.push(probe('2841f_lapsed_key_ledger_row_exactly_one', 1, expiredLedger.length - noticeBefore.expired, {
        detail: { rows: expiredLedger, seededExpiry: seededExpiries.expired },
      }));
      out.push(probe('2841f_lapsed_key_ledger_keyed_on_kind_and_expiry', true,
        expiredLedger.some((r) => r.kind === 'expired' && sameInstant(r.expiresAt, seededExpiries.expired)), {
          detail: { rows: expiredLedger, expected: { kind: 'expired', expires_at: seededExpiries.expired } },
        }));

      const soonLedger = await listNoticeLedger(admin, ids.soon);
      out.push(probe('2841f_expiring_key_ledger_kind_is_expiring', true,
        soonLedger.some((r) => r.kind === 'expiring' && sameInstant(r.expiresAt, seededExpiries.soon)), {
          detail: { rows: soonLedger },
        }));

      // THE RECIPIENT UNION. Org D's only admin lives in org_members. A
      // profiles-only lookup returns [], the job counts a noRecipients, and
      // this ledger row never appears.
      const orgDLedger = await listNoticeLedger(admin, ids.orgD);
      out.push(probe('2841f_org_members_only_admin_was_notified', true, orgDLedger.length > noticeBefore.orgD, {
        detail: {
          rows: orgDLedger, orgId: orgD.orgId, recipientEmail: orgD.email,
          note: 'Zero profiles ORG_ADMINs for this org — proven above. A row here can only come from the org_members half of the union.',
        },
      }));
    }

    // ── (b) extend a lapsed key: exactly the requested day count ────────────
    const extend = await workerFetch(`/api/v1/keys/${ids.expired}`, {
      method: 'PATCH', jwt, body: { expires_in_days: 90 },
    });
    out.push(probe('2841b_extend_expired_key_200', 200, extend.status, { detail: extend.body }));
    // EXACTLY 90. Reading the clock twice made `now + 90d` fall milliseconds
    // short by the time the response was derived, so the key reported 89.
    out.push(probe('2841b_days_until_expiry_is_exactly_90', 90, extend.body?.days_until_expiry ?? null, {
      detail: 'One request clock for the write and the response.',
    }));
    out.push(probe('2841b_status_back_to_active', 'active', extend.body?.status ?? null, { detail: null }));
    const extendedRow = await readKey(admin, ids.expired);
    const extendedMs = extendedRow?.expires_at ? new Date(extendedRow.expires_at).getTime() : 0;
    out.push(probe('2841b_stored_expiry_moved_into_the_future', true, extendedMs > Date.now(), {
      detail: { stored: extendedRow?.expires_at, wasSeededAt: seededExpiries.expired },
    }));
    // Counted from NOW, never from the old expiry: `old + 90d` on a key that
    // lapsed 73 days ago lands 17 days out, not 90.
    const daysOut = Math.floor((extendedMs - Date.now()) / DAY_MS);
    out.push(probe('2841b_extension_counted_from_now_not_old_expiry', true, daysOut >= 89 && daysOut <= 90, {
      detail: { daysOut, note: 'old + 90d would be ~17 days out for a key 73 days lapsed.' },
    }));
    out.push(probe('2841b_expiry_change_audited', true,
      (await waitForAuditRow(admin, EXPIRY_CHANGED_EVENT, ids.expired)) >= 1, {
        detail: 'An expiry change is how a key auth had started refusing becomes usable again — it must be on the record.',
      }));

    // ── (c) the shorten guard ──────────────────────────────────────────────
    const beforeShorten = await readKey(admin, ids.long);
    const shorten = await workerFetch(`/api/v1/keys/${ids.long}`, {
      method: 'PATCH', jwt, body: { expires_in_days: 30 },
    });
    out.push(probe('2841c_shorten_without_allow_shorten_409', 409, shorten.status, { detail: shorten.body }));
    out.push(probe('2841c_shorten_error_code', 'api_key_expiry_would_shorten', shorten.body?.error ?? null, {
      detail: { current_expires_at: shorten.body?.current_expires_at, requested_expires_at: shorten.body?.requested_expires_at },
    }));
    const afterShorten = await readKey(admin, ids.long);
    // The read-back is the point: a 409 that had already written would pass a
    // status check and cut ten months off the key.
    out.push(probe('2841c_stored_expiry_unchanged_by_refused_shorten',
      beforeShorten?.expires_at ?? null, afterShorten?.expires_at ?? null, {
        detail: { seeded: seededExpiries.long },
      }));
    out.push(probe('2841c_refused_shorten_wrote_no_audit_row', 0,
      await countAuditRows(admin, EXPIRY_CHANGED_EVENT, ids.long), { detail: null }));

    // ── (d) the revoked guard, on a withdrawn-but-unstamped row ────────────
    const beforeRevokedPatch = await readKey(admin, ids.deactivated);
    const onRevoked = await workerFetch(`/api/v1/keys/${ids.deactivated}`, {
      method: 'PATCH', jwt, body: { expires_in_days: 30 },
    });
    out.push(probe('2841d_extend_deactivated_key_409', 409, onRevoked.status, { detail: onRevoked.body }));
    out.push(probe('2841d_revoked_error_code', 'api_key_already_revoked', onRevoked.body?.error ?? null, {
      detail: 'is_active=false with revoked_at NULL must be refused off the boolean alone — auth reads is_active.',
    }));
    const afterRevokedPatch = await readKey(admin, ids.deactivated);
    out.push(probe('2841d_stored_expiry_unchanged_on_revoked_key',
      beforeRevokedPatch?.expires_at ?? null, afterRevokedPatch?.expires_at ?? null, { detail: null }));

    // ── (e) revoke carrying an expiry: revoke wins, expiry dropped ─────────
    const revoke = await workerFetch(`/api/v1/keys/${ids.revokeTarget}`, {
      method: 'PATCH', jwt, body: { is_active: false, expires_in_days: 30, revocation_reason: `${TAG} probe` },
    });
    // Before the fix the blanket "one intent per request" refine made this a
    // 400 — the call that stops a leaked credential became a no-op.
    out.push(probe('2841e_revoke_with_expiry_200_not_400', 200, revoke.status, { detail: revoke.body }));
    const revokedRow = await readKey(admin, ids.revokeTarget);
    out.push(probe('2841e_is_active_false', false, revokedRow?.is_active ?? null, { detail: null }));
    out.push(probe('2841e_revoked_at_stamped', true, Boolean(revokedRow?.revoked_at), {
      detail: { revoked_at: revokedRow?.revoked_at, revocation_reason: revokedRow?.revocation_reason },
    }));
    out.push(probe('2841e_status_reports_revoked', 'revoked', revoke.body?.status ?? null, {
      detail: 'revoked outranks expired when a row is both.',
    }));
    // The expiry in the same body must be DROPPED, not written: a future
    // timestamp on a key revocation made permanently unusable is a lie.
    out.push(probe('2841e_expiry_not_written', true, sameInstant(revokedRow?.expires_at, seededExpiries.revokeTarget), {
      detail: {
        seeded: seededExpiries.revokeTarget,
        stored: revokedRow?.expires_at ?? null,
        note: 'The request carried expires_in_days: 30; the stored expiry must be untouched.',
      },
    }));
    // Positive control FIRST: if audit writing were dark altogether, the
    // "no expiry_changed row" assertion below would pass vacuously.
    const revokedRows = await waitForAuditRow(admin, REVOKED_EVENT, ids.revokeTarget);
    out.push(probe('2841e_revocation_audited_positive_control', true, revokedRows >= 1, {
      detail: 'Proves audit writes land at all, so the zero below is a real absence.',
    }));
    out.push(probe('2841e_no_expiry_changed_audit_row', 0,
      await countAuditRows(admin, EXPIRY_CHANGED_EVENT, ids.revokeTarget), {
        detail: 'No expiry was written, so no expiry-change event may be recorded.',
      }));
  } catch (error) {
    // Keep what was already proven. Re-throwing would hand train-cycle.mjs a
    // bare `module_threw` and discard every probe that had already run — the
    // ones that localise the failure.
    out.push(probe('2841_probe_threw', 'ok', 'threw', {
      pass: false, detail: String(error && error.stack ? error.stack : error),
    }));
  } finally {
    // Always — a probe that threw mid-cycle must not leave a mutated fixture
    // for the next cycle to misread.
    let resetErrors;
    try {
      resetErrors = await reset(admin, seeded);
    } catch (error) {
      resetErrors = [String(error && error.message ? error.message : error)];
    }
    out.push(probe('2841_cycle_reset_clean', 0, resetErrors.length, {
      detail: { errors: resetErrors, note: 'Seeded expiries restored; this probe\'s own audit rows on its own fixture keys removed so the next cycle re-proves the notice from a clean ledger.' },
    }));
  }

  return out;
}
