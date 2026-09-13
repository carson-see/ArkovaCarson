// PR #2904 — branch feat/scrum-3972-suborg-webhook-events (SCRUM-3972).
// Migration 0454 adds `webhook_endpoints.scope` ('self' | 'self_and_descendants',
// NOT NULL DEFAULT 'self') and gives `create_webhook_endpoint` a `p_scope`
// argument. `webhooks/suborg-fanout.ts` is the ONLY thing that widens the
// historical flat `.eq('org_id', orgId)` endpoint selection in
// `dispatchWebhookEvent`: an event owned by child C additionally reaches an
// endpoint of parent P when C.parent_org_id = P.id AND
// C.parent_approval_status = 'APPROVED' AND C.suspended = false AND the
// endpoint's scope is 'self_and_descendants' AND
// ENABLE_SUBORG_WEBHOOK_FANOUT is on. Separately, `webhooks/subOrgEvents.ts`
// dispatches the seven `suborg.*` affiliate-lifecycle events directly on the
// parent id (all seven) and the child id (four of them) — that path is NOT
// gated by the flag and does NOT go through suborg-fanout.ts at all
// (`resolveDescendantFanout` returns emptyResolution() immediately for any
// `eventType.startsWith('suborg.')`, R17 in the module's own header).
//
// WHAT THIS RIG CAN AND CANNOT PROVE.
//
// CAN, live, every cycle: the migration invariant (a); the four-outcome CRUD
// contract on POST/PATCH /api/v1/webhooks' new `scope` field (b); the seven/
// four suborg.* lifecycle event set via the real
// POST /api/v1/org/sub-orgs/{approve,credits,revoke,offboard} routes (e),
// six of seven on the parent fresh every cycle plus the seventh
// (suborg.created) pinned once at seed time — see the note below.
//
// CAN, live, ONLY when ENABLE_SUBORG_WEBHOOK_FANOUT is on for this rig (read
// from `TRAIN_FANOUT_FLAG`, since this driver runs as a separate Node process
// from the worker and cannot read the worker's own env): the actual anchor.*-
// style cross-org widening (c), its five denial predicates (d), and the 60s
// cache-staleness bound (f). The vehicle is `POST /api/v1/verify/batch` with
// > SYNC_THRESHOLD (20) items, which after completing async dispatches
// `job.completed` via the SAME `dispatchWebhookEvent` call site every anchor
// lifecycle event uses (services/worker/src/api/v1/batch.ts). `job.completed`
// is a LEGACY_UNREGISTERED event type (payload-schemas.ts), so it carries no
// `.strict()` shape and the fan-out's `org_public_id` stamp never trips
// `cross_org_payload_rejected` — this rig therefore cannot exercise that one
// rejection branch, and item (e)'s "zero cross_org_payload_rejected markers"
// check is consequently a structural guarantee, not a live negative test (see
// its own probe detail). No real Bitcoin, chain client or anchor pipeline is
// needed: this is real production traffic through a real endpoint, not an
// internal test-only hook (none exists in this diff).
//
// CANNOT, and no probe below pretends otherwise: `suborg.created` freshly
// this cycle. POST /org/sub-orgs/create resolves `adminEmail` to an existing
// profile and conditionally sends a real invitation email
// (`maybeSendAffiliateAdminInvitationEmail`) — every other probe in this
// driver goes out of its way to avoid live outbound email, and repeating that
// call every 5 minutes for 24h would be exactly that. The event's shape is
// instead verified structurally from the diff (the `emitSubOrgEvent` call
// site is the last statement before the 201 response, sharing the same
// `eventType`-keyed emitter as the six that ARE driven live), and the ORIGINAL
// seed-time creation's audit/delivery rows are asserted to still exist —
// a persistent read-back, not a manufactured one. Sentry-marker absence
// (WEBHOOK-1 / R17 `suborg_webhook_cross_org_payload_rejected`) is inferred
// from the DB delivery-log table, per the task's own instruction — this rig
// has no Sentry read access at all.
import { randomBytes } from 'node:crypto';

export const pr = '#2904';

export const changedBehavior = [
  'Migration 0454 adds webhook_endpoints.scope (self default | self_and_descendants),',
  'NOT VALID-then-VALIDATE so the ADD COLUMN default satisfies every existing row before',
  'the CHECK is enforced, plus create_webhook_endpoint gains p_scope (DROP+CREATE, not a',
  'second overload, per CLAUDE.md 6). POST and PATCH /api/v1/webhooks accept scope;',
  'a PATCH omitting scope leaves the stored value untouched (no silent reset on an',
  'unrelated description edit) and an invalid scope value is 400 before any write.',
  'webhooks/suborg-fanout.ts is the only widening of dispatchWebhookEvent\'s flat',
  'org_id selection: a self_and_descendants endpoint on a parent additionally receives',
  'an event owned by a directly-affiliated, APPROVED, unsuspended child, one hop only,',
  'gated by ENABLE_SUBORG_WEBHOOK_FANOUT and two 60s-TTL in-process caches. Every other',
  'combination -- self scope, REVOKED, PENDING/NULL status, suspended=true, no parent --',
  'delivers zero copies to the parent while leaving the child\'s own delivery unaffected',
  'and the dispatch still ok. The seven suborg.* affiliate-lifecycle events (created,',
  'approved, revoked, credits_allocated, credits_reclaimed, suspended, offboarded) are',
  'dispatched directly on the parent id (all seven) and the child id (the four that',
  'change something the child owns), independent of the fan-out flag, and never widen',
  'through suborg-fanout.ts (eventType.startsWith(\'suborg.\') short-circuits it).',
].join(' ');

const TAG = 'cto-train-b-0912-2904';
const SINK_URL = 'https://cft-webhook-sink-kvojbeutfa-uc.a.run.app/';
const FANOUT_EVENT = 'job.completed';
const BATCH_ITEM_COUNT = 21; // SYNC_THRESHOLD is 20 (batch.ts) — this forces the async/job.completed path.
const CACHE_TTL_MS = 60_000; // FANOUT_CACHE_TTL_MS in suborg-fanout.ts.

const NAMES = {
  fanoutEndpoint: `${TAG}-fanout-endpoint`,
  selfEndpoint: `${TAG}-self-endpoint`,
  crudEndpoint: `${TAG}-crud-endpoint`,
  lifecycleChild: `${TAG}-lifecycle-child`,
  fanoutApproved: `${TAG}-fanout-approved`,
  fanoutRevoked: `${TAG}-fanout-revoked`,
  fanoutPending: `${TAG}-fanout-pending`,
  fanoutSuspended: `${TAG}-fanout-suspended`,
  fanoutNullParent: `${TAG}-fanout-nullparent`,
};

// ───────────────────────────── fixture helpers ─────────────────────────────

function orgPrefix() {
  return `Z${randomBytes(6).toString('hex').toUpperCase()}`;
}

/** Upsert one organization to an exact affiliation shape; public_id is server-minted, always read back. */
async function ensureOrg(admin, { name, parentOrgId = null, approvalStatus = null, suspended = false }) {
  const { data: existing, error: findErr } = await admin
    .from('organizations')
    .select('id, public_id')
    .eq('display_name', name)
    .maybeSingle();
  if (findErr) throw new Error(`#2904 lookup org ${name}: ${findErr.message}`);

  if (existing) {
    const { error } = await admin
      .from('organizations')
      .update({ parent_org_id: parentOrgId, parent_approval_status: approvalStatus, suspended, suspended_at: null, suspended_by: null, suspended_reason: null })
      .eq('id', existing.id);
    if (error) throw new Error(`#2904 normalise org ${name}: ${error.message}`);
    if (!existing.public_id) throw new Error(`#2904 org ${name} has no public_id`);
    return { id: existing.id, publicId: existing.public_id };
  }

  const { data, error } = await admin
    .from('organizations')
    .insert({ display_name: name, legal_name: name, org_prefix: orgPrefix(), tier: 'ENTERPRISE', parent_org_id: parentOrgId, parent_approval_status: approvalStatus, suspended })
    .select('id, public_id')
    .single();
  if (error) throw new Error(`#2904 insert org ${name}: ${error.message}`);
  if (!data.public_id) throw new Error(`#2904 org ${name} inserted with a NULL public_id`);
  return { id: data.id, publicId: data.public_id };
}

async function ensureCredits(admin, orgId, balance) {
  const { error } = await admin.from('org_credits').upsert({ org_id: orgId, balance, monthly_allocation: 0 }, { onConflict: 'org_id' });
  if (error) throw new Error(`#2904 org_credits ${orgId}: ${error.message}`);
}

/** Mint (or re-mint) an active API key. `verify:batch` is the only scope the fan-out dispatch vehicle needs. */
async function ensureKey(admin, { orgId, createdBy, name, scopes, hashApiKey, secret }) {
  const { data: existing, error: findErr } = await admin.from('api_keys').select('id').eq('org_id', orgId).eq('name', name).maybeSingle();
  if (findErr) throw new Error(`#2904 lookup key ${name}: ${findErr.message}`);
  const raw = `ak_test_${randomBytes(32).toString('hex')}`;
  const row = { org_id: orgId, key_prefix: raw.slice(0, 12), key_hash: hashApiKey(raw, secret), name, scopes, created_by: createdBy, is_active: true, revoked_at: null };
  if (existing) {
    const { error } = await admin.from('api_keys').update(row).eq('id', existing.id);
    if (error) throw new Error(`#2904 re-mint key ${name}: ${error.message}`);
    return { id: existing.id, raw };
  }
  const { data, error } = await admin.from('api_keys').insert(row).select('id').single();
  if (error) throw new Error(`#2904 insert key ${name}: ${error.message}`);
  return { id: data.id, raw };
}

/** One endpoint per stable description; scope/events are repaired in place if drifted. */
async function ensureEndpoint(admin, { orgId, createdBy, description, scope, events }) {
  const { data: existing, error: findErr } = await admin.from('webhook_endpoints').select('id, scope, events, is_active').eq('org_id', orgId).eq('description', description).maybeSingle();
  if (findErr) throw new Error(`#2904 lookup endpoint ${description}: ${findErr.message}`);
  if (existing) {
    const eventsDrift = JSON.stringify([...existing.events].sort()) !== JSON.stringify([...events].sort());
    if (existing.scope !== scope || eventsDrift || existing.is_active !== true) {
      const { error } = await admin.from('webhook_endpoints').update({ scope, events, is_active: true }).eq('id', existing.id);
      if (error) throw new Error(`#2904 repair endpoint ${description}: ${error.message}`);
    }
    return existing.id;
  }
  const { data, error } = await admin
    .from('webhook_endpoints')
    .insert({ org_id: orgId, public_id: '', url: SINK_URL, secret_hash: `whsec_${randomBytes(32).toString('hex')}`, events, scope, is_active: true, description, created_by: createdBy })
    .select('id')
    .single();
  if (error) throw new Error(`#2904 insert endpoint ${description}: ${error.message}`);
  return data.id;
}

/** GoTrue password grant → access_token for a rig user. */
async function signIn(supabaseUrl, anonKey, email, password) {
  const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, token: body?.access_token ?? null, error: body?.error_description ?? body?.msg ?? null };
}

// ───────────────────────────────── seed ─────────────────────────────────────

export async function seed(admin, state, ctx) {
  // Migration precondition: `scope` column present? A rig without 0454 answers
  // 42703 (undefined_column) on this SELECT — every assertion below would
  // otherwise be vacuous against a table that cannot hold the new value at all.
  const { error: colErr } = await admin.from('webhook_endpoints').select('scope').limit(1);
  if (colErr) {
    const missing = colErr.code === '42703' || /column .*scope.* does not exist/i.test(colErr.message ?? '');
    return {
      skipped: true,
      reason: missing
        ? `migration 0454 is NOT applied to this rig: webhook_endpoints.scope does not exist (${colErr.message}). Apply 0454, then re-run setup.mjs.`
        : `#2904 seed: webhook_endpoints.scope probe failed: ${colErr.message}`,
    };
  }

  const secret = ctx?.API_KEY_HMAC_SECRET ?? process.env.API_KEY_HMAC_SECRET;
  const hashApiKey = ctx?.hashApiKey;
  if (!secret || typeof hashApiKey !== 'function') {
    return { skipped: true, reason: '#2904 seed: API_KEY_HMAC_SECRET / hashApiKey unavailable' };
  }
  if (!state.orgA || !state.adminA?.userId) {
    return { skipped: true, reason: '#2904 seed: shared fixtures (orgA/adminA) missing — run setup first' };
  }

  // requirePaymentCurrent gates the whole /api/v1 prefix; idempotent no-op if
  // #2844's seed already set this (file-sort order runs #2844 first, but this
  // module must not depend on that ordering to stay independently seedable).
  const { error: payErr } = await admin.from('organizations').update({ payment_state: 'ok' }).eq('id', state.orgA);
  if (payErr) throw new Error(`#2904 payment_state orgA: ${payErr.message}`);

  const parentEndpointEvents = [
    FANOUT_EVENT,
    'suborg.created', 'suborg.approved', 'suborg.revoked',
    'suborg.credits_allocated', 'suborg.credits_reclaimed', 'suborg.suspended', 'suborg.offboarded',
  ];
  const childEndpointEvents = ['suborg.credits_allocated', 'suborg.credits_reclaimed', 'suborg.suspended', 'suborg.offboarded'];

  const fanoutEndpointId = await ensureEndpoint(admin, { orgId: state.orgA, createdBy: state.adminA.userId, description: NAMES.fanoutEndpoint, scope: 'self_and_descendants', events: parentEndpointEvents });
  const selfEndpointId = await ensureEndpoint(admin, { orgId: state.orgA, createdBy: state.adminA.userId, description: NAMES.selfEndpoint, scope: 'self', events: [FANOUT_EVENT] });

  // The lifecycle child: real, API-driven affiliation transitions every cycle.
  const lifecycleChild = await ensureOrg(admin, { name: NAMES.lifecycleChild, parentOrgId: state.orgA, approvalStatus: 'PENDING' });
  await ensureCredits(admin, lifecycleChild.id, 0);
  const lifecycleChildEndpointId = await ensureEndpoint(admin, { orgId: lifecycleChild.id, createdBy: state.adminA.userId, description: `${TAG}-lifecycle-child-endpoint`, scope: 'self', events: childEndpointEvents });

  // Fan-out predicate fixtures. Four share orgA as parent; the fifth has none.
  const fanoutApproved = await ensureOrg(admin, { name: NAMES.fanoutApproved, parentOrgId: state.orgA, approvalStatus: 'APPROVED', suspended: false });
  const fanoutRevoked = await ensureOrg(admin, { name: NAMES.fanoutRevoked, parentOrgId: state.orgA, approvalStatus: 'REVOKED', suspended: false });
  const fanoutPending = await ensureOrg(admin, { name: NAMES.fanoutPending, parentOrgId: state.orgA, approvalStatus: 'PENDING', suspended: false });
  const fanoutSuspended = await ensureOrg(admin, { name: NAMES.fanoutSuspended, parentOrgId: state.orgA, approvalStatus: 'APPROVED', suspended: true });
  const fanoutNullParent = await ensureOrg(admin, { name: NAMES.fanoutNullParent, parentOrgId: null, approvalStatus: null, suspended: false });

  const batchScopes = ['verify:batch'];
  const keyApproved = await ensureKey(admin, { orgId: fanoutApproved.id, createdBy: state.adminA.userId, name: `${TAG}-key-approved`, scopes: batchScopes, hashApiKey, secret });
  const keyRevoked = await ensureKey(admin, { orgId: fanoutRevoked.id, createdBy: state.adminA.userId, name: `${TAG}-key-revoked`, scopes: batchScopes, hashApiKey, secret });
  const keyPending = await ensureKey(admin, { orgId: fanoutPending.id, createdBy: state.adminA.userId, name: `${TAG}-key-pending`, scopes: batchScopes, hashApiKey, secret });
  const keySuspended = await ensureKey(admin, { orgId: fanoutSuspended.id, createdBy: state.adminA.userId, name: `${TAG}-key-suspended`, scopes: batchScopes, hashApiKey, secret });
  const keyNullParent = await ensureKey(admin, { orgId: fanoutNullParent.id, createdBy: state.adminA.userId, name: `${TAG}-key-nullparent`, scopes: batchScopes, hashApiKey, secret });

  return {
    fanoutEndpointId, selfEndpointId,
    lifecycleChild, lifecycleChildEndpointId,
    fanoutApproved: { ...fanoutApproved, apiKeyRaw: keyApproved.raw },
    fanoutRevoked: { ...fanoutRevoked, apiKeyRaw: keyRevoked.raw },
    fanoutPending: { ...fanoutPending, apiKeyRaw: keyPending.raw },
    fanoutSuspended: { ...fanoutSuspended, apiKeyRaw: keySuspended.raw },
    fanoutNullParent: { ...fanoutNullParent, apiKeyRaw: keyNullParent.raw },
  };
}

// ───────────────────────────────── run helpers ──────────────────────────────

/** (a) Migration invariant: every row not owned by this module reads 'self'. */
async function checkMigrationInvariant(ctx) {
  const { admin, probe } = ctx;
  const out = [];
  const { data, error } = await admin.from('webhook_endpoints').select('id, scope, description');
  out.push(probe('2904_scope_column_readable', true, !error, { detail: error?.message ?? null }));
  if (error || !data) return out;

  const invalidScope = data.filter((r) => r.scope !== 'self' && r.scope !== 'self_and_descendants');
  out.push(probe('2904_every_row_has_known_scope', 0, invalidScope.length, { detail: { invalid: invalidScope.map((r) => ({ id: r.id, scope: r.scope })) } }));

  // "Pre-existing" = every row this module did not itself create with a
  // non-default scope (the fanout endpoint). Everything else — rows from
  // #2836/#2841/#2845 and any endpoint that predates 0454 — never sets scope
  // and must therefore read the column DEFAULT.
  const nonDefaultOwn = new Set([NAMES.fanoutEndpoint]);
  const preExisting = data.filter((r) => !nonDefaultOwn.has(r.description));
  const notSelf = preExisting.filter((r) => r.scope !== 'self');
  out.push(probe('2904_pre_existing_rows_are_self_scope', 0, notSelf.length, {
    detail: { checked: preExisting.length, offenders: notSelf.map((r) => ({ id: r.id, description: r.description, scope: r.scope })) },
  }));
  return out;
}

/** (b) POST/PATCH /api/v1/webhooks scope CRUD, against the shared key + orgA. */
async function checkCrudScope(ctx) {
  const { admin, state, workerFetch, probe, cycleId } = ctx;
  const out = [];
  const apiKeyRaw = state.apiKey?.raw;
  if (!apiKeyRaw) {
    out.push(probe('2904_crud_shared_key_available', true, false, { pass: false, detail: 'state.apiKey missing — setup.mjs must run first' }));
    return out;
  }

  // Clean slate: delete any endpoint left over from a crashed prior cycle.
  const { data: stale } = await admin.from('webhook_endpoints').select('id').eq('org_id', state.orgA).eq('description', NAMES.crudEndpoint);
  for (const row of stale ?? []) await admin.from('webhook_endpoints').delete().eq('id', row.id);

  const created = await workerFetch('/api/v1/webhooks', {
    method: 'POST',
    apiKeyRaw,
    body: { url: SINK_URL, events: ['anchor.secured'], description: NAMES.crudEndpoint, scope: 'self_and_descendants' },
  });
  out.push(probe('2904_post_201_echoes_scope', [201, 'self_and_descendants'], [created.status, created.body?.scope], {
    pass: created.status === 201 && created.body?.scope === 'self_and_descendants',
    detail: { status: created.status, body: created.body },
  }));
  const endpointId = created.body?.id;
  if (!endpointId) return out;

  const patchedDescription = await workerFetch(`/api/v1/webhooks/${endpointId}`, {
    method: 'PATCH',
    apiKeyRaw,
    body: { description: `${NAMES.crudEndpoint}-${cycleId}` },
  });
  const { data: afterDescPatch } = await admin.from('webhook_endpoints').select('scope, description').eq('id', endpointId).maybeSingle();
  out.push(probe('2904_patch_description_only_leaves_scope_unchanged', 'self_and_descendants', afterDescPatch?.scope ?? null, {
    detail: { patchStatus: patchedDescription.status, descriptionNowReads: afterDescPatch?.description ?? null },
  }));

  const patchedBogus = await workerFetch(`/api/v1/webhooks/${endpointId}`, { method: 'PATCH', apiKeyRaw, body: { scope: 'bogus' } });
  out.push(probe('2904_patch_bogus_scope_400', 400, patchedBogus.status, { detail: patchedBogus.body }));
  const { data: afterBogus } = await admin.from('webhook_endpoints').select('scope').eq('id', endpointId).maybeSingle();
  out.push(probe('2904_bogus_patch_did_not_write', 'self_and_descendants', afterBogus?.scope ?? null, {}));

  await admin.from('webhook_endpoints').delete().eq('id', endpointId); // cleanup for next cycle
  return out;
}

/** Renormalise the fan-out predicate fixtures every cycle — see module header. */
async function renormaliseFanoutFixtures(admin, seeded) {
  const writes = [
    admin.from('organizations').update({ parent_approval_status: 'APPROVED', suspended: false }).eq('id', seeded.fanoutApproved.id),
    admin.from('organizations').update({ parent_approval_status: 'REVOKED', suspended: false }).eq('id', seeded.fanoutRevoked.id),
    admin.from('organizations').update({ parent_approval_status: 'PENDING', suspended: false }).eq('id', seeded.fanoutPending.id),
    admin.from('organizations').update({ parent_approval_status: 'APPROVED', suspended: true }).eq('id', seeded.fanoutSuspended.id),
    admin.from('organizations').update({ parent_org_id: null, parent_approval_status: null, suspended: false }).eq('id', seeded.fanoutNullParent.id),
  ];
  const results = await Promise.all(writes);
  return results.filter((r) => r.error).map((r) => r.error.message);
}

async function submitBatchJob(workerFetch, apiKeyRaw, tag) {
  const publicIds = Array.from({ length: BATCH_ITEM_COUNT }, (_, i) => `NOPE-${tag}-${i}`);
  return workerFetch('/api/v1/verify/batch', { method: 'POST', apiKeyRaw, body: { public_ids: publicIds } });
}

/** Poll batch_verification_jobs.status; bounded, since job.completed dispatches after 'complete'/'failed'. */
async function pollBatchJob(admin, jobId, { tries = 6, intervalMs = 2500 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const { data } = await admin.from('batch_verification_jobs').select('status').eq('id', jobId).maybeSingle();
    if (data?.status === 'complete' || data?.status === 'failed') return { settled: true, status: data.status };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { settled: false, status: null };
}

/** Rows the fanout endpoint received for exactly this job's event_id. */
async function fanoutDeliveriesForJob(admin, endpointId, jobId) {
  const { data, error } = await admin.from('webhook_delivery_logs').select('id, payload').eq('endpoint_id', endpointId).eq('event_id', jobId);
  return { rows: data ?? [], error: error?.message ?? null };
}

/** (c)+(d) live dispatch: one qualifying org, five denial predicates. */
async function checkLiveFanoutAndDenials(ctx, seeded) {
  const { admin, workerFetch, probe, cycleId } = ctx;
  const out = [];

  const renormErrors = await renormaliseFanoutFixtures(admin, seeded);
  out.push(probe('2904_fanout_fixtures_renormalised', 0, renormErrors.length, { detail: renormErrors }));

  const cases = [
    { key: 'fanoutApproved', label: 'approved_qualifies', expectDescendant: true },
    { key: 'fanoutRevoked', label: 'denial_revoked', expectDescendant: false },
    { key: 'fanoutPending', label: 'denial_pending', expectDescendant: false },
    { key: 'fanoutSuspended', label: 'denial_suspended', expectDescendant: false },
    { key: 'fanoutNullParent', label: 'denial_null_parent', expectDescendant: false },
  ];

  for (const c of cases) {
    const fixture = seeded[c.key];
    const tag = `${TAG}-${c.label}-${cycleId}`.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 60);
    const submit = await submitBatchJob(workerFetch, fixture.apiKeyRaw, tag);
    out.push(probe(`2904_${c.label}_batch_submitted`, 202, submit.status, { detail: submit.body }));
    const jobId = submit.body?.job_id;
    if (submit.status !== 202 || !jobId) continue;

    const settled = await pollBatchJob(admin, jobId);
    out.push(probe(`2904_${c.label}_batch_settled`, true, settled.settled, { detail: settled }));
    if (!settled.settled) continue; // job.completed dispatch never fired this cycle — not a fan-out verdict either way

    const descendant = await fanoutDeliveriesForJob(admin, seeded.fanoutEndpointId, jobId);
    const selfScope = await fanoutDeliveriesForJob(admin, seeded.selfEndpointId, jobId);

    if (c.expectDescendant) {
      out.push(probe(`2904_${c.label}_descendant_endpoint_received_exactly_one`, 1, descendant.rows.length, { detail: { error: descendant.error, ids: descendant.rows.map((r) => r.id) } }));
      const payload = descendant.rows[0]?.payload;
      out.push(probe(`2904_${c.label}_delivery_carries_org_public_id`, fixture.publicId, payload?.data?.org_public_id ?? null, { detail: { payloadDataKeys: payload?.data ? Object.keys(payload.data) : null } }));
    } else {
      out.push(probe(`2904_${c.label}_descendant_endpoint_received_zero`, 0, descendant.rows.length, { detail: { error: descendant.error, ids: descendant.rows.map((r) => r.id) } }));
    }
    // scope='self' denial: regardless of the case, an endpoint whose scope is
    // 'self' must never receive a cross-org copy, even for the fully-qualifying org.
    out.push(probe(`2904_${c.label}_self_scope_endpoint_received_zero`, 0, selfScope.rows.length, { detail: { error: selfScope.error } }));
  }
  return out;
}

/** (f) 60s cache-staleness bound. Only run for the APPROVED fixture, right after (c) has already warmed the cache for it. */
async function checkCacheBound(ctx, seeded) {
  const { admin, workerFetch, probe, cycleId } = ctx;
  const out = [];
  const fixture = seeded.fanoutApproved;

  // Warm the cache with one more qualifying dispatch, then revoke immediately.
  const warmTag = `${TAG}-cachewarm-${cycleId}`.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 60);
  const warm = await submitBatchJob(workerFetch, fixture.apiKeyRaw, warmTag);
  const warmJobId = warm.body?.job_id;
  out.push(probe('2904_cache_bound_warm_submitted', 202, warm.status, { detail: warm.body }));
  if (warm.status !== 202 || !warmJobId) return out;
  await pollBatchJob(admin, warmJobId);

  const { error: revokeErr } = await admin.from('organizations').update({ parent_approval_status: 'REVOKED' }).eq('id', fixture.id);
  const t0 = Date.now();
  out.push(probe('2904_cache_bound_revoked', true, !revokeErr, { detail: revokeErr?.message ?? null }));
  if (revokeErr) return out;

  // t+5s: informational only — the task's own contract says this MAY still
  // deliver (a warm in-process cache entry is valid for up to 60s), so both
  // outcomes are a pass; only the DB observation is recorded.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, 5000 - (Date.now() - t0))));
  const tag5 = `${TAG}-t5-${cycleId}`.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 60);
  const at5 = await submitBatchJob(workerFetch, fixture.apiKeyRaw, tag5);
  const job5 = at5.body?.job_id;
  if (at5.status === 202 && job5) {
    const settled5 = await pollBatchJob(admin, job5);
    const deliveries5 = settled5.settled ? await fanoutDeliveriesForJob(admin, seeded.fanoutEndpointId, job5) : { rows: [], error: 'not settled' };
    out.push(probe('2904_cache_bound_t5s_observed', true, true, {
      detail: { note: 'informational: a stale <=60s cache MAY still deliver here; both 0 and 1 are consistent with the documented contract', settled: settled5.settled, descendantCopies: deliveries5.rows.length },
    }));
  }

  // t+65s from the revoke: past the 60s TTL, the cache MUST be fresh and MUST
  // show zero — this is the hard, deterministic half of the bound.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, (CACHE_TTL_MS + 5000) - (Date.now() - t0))));
  const tag65 = `${TAG}-t65-${cycleId}`.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 60);
  const at65 = await submitBatchJob(workerFetch, fixture.apiKeyRaw, tag65);
  out.push(probe('2904_cache_bound_t65s_batch_submitted', 202, at65.status, { detail: at65.body }));
  const job65 = at65.body?.job_id;
  if (at65.status === 202 && job65) {
    const settled65 = await pollBatchJob(admin, job65);
    out.push(probe('2904_cache_bound_t65s_batch_settled', true, settled65.settled, {}));
    if (settled65.settled) {
      const deliveries65 = await fanoutDeliveriesForJob(admin, seeded.fanoutEndpointId, job65);
      out.push(probe('2904_cache_bound_t65s_must_not_deliver', 0, deliveries65.rows.length, { detail: { error: deliveries65.error } }));
    }
  }
  return out;
}

/** Dark contract: flag is off, the widening code path must issue zero extra deliveries. */
async function checkDarkContract(ctx, seeded) {
  const { admin, workerFetch, probe, cycleId } = ctx;
  const out = [];
  const renormErrors = await renormaliseFanoutFixtures(admin, seeded);
  out.push(probe('2904_dark_fixtures_renormalised', 0, renormErrors.length, { detail: renormErrors }));

  const fixture = seeded.fanoutApproved; // fully qualifying, so a leak would show here first
  const tag = `${TAG}-dark-${cycleId}`.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 60);
  const submit = await submitBatchJob(workerFetch, fixture.apiKeyRaw, tag);
  out.push(probe('2904_dark_batch_submitted', 202, submit.status, { detail: submit.body }));
  const jobId = submit.body?.job_id;
  if (submit.status !== 202 || !jobId) return out;
  const settled = await pollBatchJob(admin, jobId);
  out.push(probe('2904_dark_batch_settled', true, settled.settled, {}));
  if (!settled.settled) return out;
  const descendant = await fanoutDeliveriesForJob(admin, seeded.fanoutEndpointId, jobId);
  out.push(probe('2904_dark_flag_off_zero_descendant_copies', 0, descendant.rows.length, {
    detail: { error: descendant.error, note: 'ENABLE_SUBORG_WEBHOOK_FANOUT reads off on this rig (TRAIN_FANOUT_FLAG); a fully-qualifying child must still receive zero cross-org copies' },
  }));
  return out;
}

/** (e) suborg.* lifecycle: six fresh types on the parent this cycle + the persisted 'created' row; four on the child. */
async function checkSubOrgLifecycle(ctx, seeded) {
  const { admin, workerFetch, state, probe, SUPABASE_URL, ANON_KEY, cycleId } = ctx;
  const out = [];
  const child = seeded.lifecycleChild;

  const signed = await signIn(SUPABASE_URL, ANON_KEY, state.adminA.email, state.password);
  out.push(probe('2904_suborg_admin_signed_in', true, Boolean(signed.token), { detail: signed.error }));
  if (!signed.token) return out;
  const jwt = signed.token;

  // Renormalise: PENDING, unsuspended, zero balance — every action below must
  // succeed from scratch regardless of where last cycle left off.
  await admin.from('organizations').update({ parent_approval_status: 'PENDING', suspended: false, suspended_at: null }).eq('id', child.id);
  await admin.from('org_credits').update({ balance: 0 }).eq('org_id', child.id);

  const cycleStart = new Date().toISOString();

  const approve = await workerFetch('/api/v1/org/sub-orgs/approve', { method: 'POST', jwt, body: { childOrgId: child.id } });
  out.push(probe('2904_suborg_approve_200', 200, approve.status, { detail: approve.body }));

  const credits = await workerFetch('/api/v1/org/sub-orgs/credits', { method: 'POST', jwt, body: { childOrgId: child.id, amount: 25, note: `${TAG}-${cycleId}` } });
  out.push(probe('2904_suborg_credits_allocated_200', 200, credits.status, { detail: credits.body }));

  const revoke = await workerFetch('/api/v1/org/sub-orgs/revoke', { method: 'POST', jwt, body: { childOrgId: child.id } });
  out.push(probe('2904_suborg_revoke_200', 200, revoke.status, { detail: revoke.body }));

  const reason500 = 'x'.repeat(500);
  const offboard = await workerFetch('/api/v1/org/sub-orgs/offboard', { method: 'POST', jwt, body: { childOrgId: child.id, reason: reason500 } });
  out.push(probe('2904_suborg_offboard_200', 200, offboard.status, { detail: offboard.body }));
  out.push(probe('2904_suborg_offboard_reason_500_chars_accepted', true, offboard.status === 200, { detail: { sentLength: reason500.length } }));

  const { data: afterChild } = await admin.from('organizations').select('parent_approval_status, suspended').eq('id', child.id).maybeSingle();
  out.push(probe('2904_suborg_child_suspended_after_offboard', true, afterChild?.suspended === true, { detail: afterChild }));

  // Parent-side: six fresh event types this cycle (created is asserted separately, below, as a persisted fact).
  const { data: parentDeliveries, error: parentErr } = await admin
    .from('webhook_delivery_logs')
    .select('event_type')
    .eq('endpoint_id', seeded.fanoutEndpointId)
    .gte('created_at', cycleStart)
    .in('event_type', ['suborg.approved', 'suborg.revoked', 'suborg.credits_allocated', 'suborg.credits_reclaimed', 'suborg.suspended', 'suborg.offboarded']);
  const parentTypesFresh = new Set((parentDeliveries ?? []).map((r) => r.event_type));
  const expectedFresh = ['suborg.approved', 'suborg.revoked', 'suborg.credits_allocated', 'suborg.credits_reclaimed', 'suborg.suspended', 'suborg.offboarded'];
  out.push(probe('2904_suborg_parent_six_fresh_types_this_cycle', expectedFresh.length, parentTypesFresh.size, {
    detail: { error: parentErr?.message ?? null, seen: [...parentTypesFresh], missing: expectedFresh.filter((t) => !parentTypesFresh.has(t)) },
  }));

  const { data: createdRow, error: createdErr } = await admin
    .from('webhook_delivery_logs')
    .select('id')
    .eq('endpoint_id', seeded.fanoutEndpointId)
    .eq('event_type', 'suborg.created')
    .limit(1);
  out.push(probe('2904_suborg_parent_created_persisted_from_seed', true, (createdRow ?? []).length > 0, {
    detail: { error: createdErr?.message ?? null, note: 'suborg.created is pinned once at seed time — see module header on why it is not re-driven every cycle (real outbound email)' },
  }));

  // Child-side: the four events the affiliate is also told about, fresh this cycle.
  const { data: childDeliveries, error: childErr } = await admin
    .from('webhook_delivery_logs')
    .select('event_type')
    .eq('endpoint_id', seeded.lifecycleChildEndpointId)
    .gte('created_at', cycleStart)
    .in('event_type', ['suborg.credits_allocated', 'suborg.credits_reclaimed', 'suborg.suspended', 'suborg.offboarded']);
  const childTypesFresh = new Set((childDeliveries ?? []).map((r) => r.event_type));
  out.push(probe('2904_suborg_child_four_fresh_types_this_cycle', 4, childTypesFresh.size, {
    detail: { error: childErr?.message ?? null, seen: [...childTypesFresh] },
  }));

  // Cross-org payload rejection marker: structurally unreachable for suborg.*
  // (resolveDescendantFanout short-circuits on eventType.startsWith('suborg.')
  // before ever touching org_public_id), so this is a regression guard, not a
  // live negative test — the module header states this plainly.
  const { data: rejectedRows, error: rejectedErr } = await admin
    .from('webhook_delivery_logs')
    .select('id')
    .eq('endpoint_id', seeded.fanoutEndpointId)
    .gte('created_at', cycleStart)
    .ilike('error_message', '%cross_org_payload_rejected%');
  out.push(probe('2904_suborg_zero_cross_org_payload_rejected_markers', 0, (rejectedRows ?? []).length, {
    detail: { error: rejectedErr?.message ?? null, note: 'structurally unreachable for suborg.* — regression guard, see module header' },
  }));

  return out;
}

// ───────────────────────────────── run ──────────────────────────────────────

export async function run(ctx) {
  const { state, env, probe } = ctx;
  const out = [];
  const seeded = state['#2904'];

  if (!seeded || seeded.skipped) {
    out.push(probe('2904_seed_ok', true, false, { pass: false, detail: seeded?.reason ?? '#2904 seed() did not run — call setup.mjs first' }));
    return out;
  }

  out.push(...(await checkMigrationInvariant(ctx)));
  out.push(...(await checkCrudScope(ctx)));
  out.push(...(await checkSubOrgLifecycle(ctx, seeded)));

  const fanoutOn = /^(1|true)$/i.test(String(env.TRAIN_FANOUT_FLAG ?? '').trim());
  if (fanoutOn) {
    out.push(...(await checkLiveFanoutAndDenials(ctx, seeded)));
    out.push(...(await checkCacheBound(ctx, seeded)));
  } else {
    out.push(...(await checkDarkContract(ctx, seeded)));
  }

  return out;
}
