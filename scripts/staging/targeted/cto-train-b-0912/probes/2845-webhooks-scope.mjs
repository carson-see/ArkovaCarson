// PR #2845 — `webhooks:manage` enforced on the /api/v1/webhooks mount (SCRUM-3981).
//
// WHAT THIS RIG CAN AND CANNOT PROVE, stated plainly so the evidence is not
// read as more than it is.
//
// The PR is one line: `router.use('/webhooks', batchRateLimiter,
// requireScope('webhooks:manage'), webhooksRouter)`. Before it, every handler
// checked that *an* API key was present and five of the ten additionally
// checked ORG_ADMIN, but no layer read the key's SCOPES — so a key minted with
// the default `['read:search']` could list, read, test-ping, replay and
// DLQ-manage an org's webhook endpoints.
//
// PROVEN HERE. This is an unusually good fit for a rig, because the claim is
// about a request-time decision with four distinct outcomes on one mount and
// all four are reachable with seeded fixtures:
//   1. a key WITHOUT the scope gets 403 `insufficient_scope` on all ten routes;
//   2. a key WITH it is passed through — asserted by DB read-backs (an endpoint
//      created and deleted, a description updated, a delivery-log row inserted
//      by replay, a DLQ row flipped to resolved), never by a bare 200;
//   3. NO key still gets 401 `authentication_required`, never a fall-through
//      200. `requireScope` opens `if (!req.apiKey) { next(); return; }`, so it
//      NARROWS an authenticated caller and authenticates nobody; the
//      handler-level `requireApiKey` is the only thing between an anonymous
//      request and a 200. That pairing is the single most load-bearing thing in
//      this PR and probe 3 is what guards it on a live worker;
//   4. holding the scope is not authority over another org — an org-B key with
//      `webhooks:manage` gets 404 on an org-A endpoint id, never 403;
//   5. the limiter still precedes the guard (the 11th call is 429 + Retry-After);
//   6. the two surfaces this PR deliberately did NOT gate still work: the
//      dashboard's JWT self-service DLQ (ORG_ADMIN session) answers 200, and it
//      is reached without any API key at all.
//
// NOT PROVEN HERE, and no probe below pretends otherwise:
//   - "enforcement breaks no live integration". That is a statement about 18
//     real prod keys (0 of which hold `webhooks:manage`), re-verified read-only
//     on 2026-09-12. A rig can only show the response SHAPE; it cannot speak
//     for prod's key population. The grandfather backfill runs at cutover.
//   - the outbound delivery path. Deliveries are #2836's module; this one only
//     asserts that a row APPEARS, not how it was dispatched.
//
// TWO DRIVER-CORRECTNESS NOTES, both load-bearing:
//
// (a) `batchRateLimiter` is 10 req/min keyed by `req.apiKey.keyId`
//     (router.ts:282-287) and request 11 is the first refusal
//     (utils/rateLimit.ts: `entry.count > maxRequests`). A single key cannot
//     carry this module: probe 1 alone is ten calls. So the fixtures seed a
//     POOL of keys and each probe group gets its own bucket — otherwise the
//     module manufactures its own 429s and reds the cycle for a reason that has
//     nothing to do with the scope guard. Every key below exists for that
//     reason, not for variety.
// (b) The 401 probe sends NO key, so the limiter falls back to `req.ip` and all
//     ten calls share ONE bucket with every other anonymous `batch`-scope call
//     in the cycle. Ten is exactly the allowance. A 429 there is therefore a
//     driver/bucket condition, not a guard defect, and it is reported as its
//     own named failing probe (`2845_anon_batch_bucket_exhausted`) so it can
//     never be misread as the fall-through-200 regression.
//
// `POST /webhooks/test` is NOT used as the delivery-log read-back: the test-ping
// handler returns `{success, status_code, response_body}` and writes NO
// `webhook_delivery_logs` row (webhooks.ts:385-462). Replay does
// (`replayDelivery`, delivery.ts:1057), so replay is the vehicle.
import { randomBytes, randomUUID } from 'node:crypto';

export const pr = '#2845';

export const changedBehavior = [
  'Proven here: every one of the ten routes under /api/v1/webhooks now requires',
  'the webhooks:manage scope. (1) A key holding only the default read:search',
  'gets 403 insufficient_scope with required=webhooks:manage on all ten —',
  'POST /, GET /, POST /test, GET /deliveries, POST /deliveries/:id/replay,',
  'GET /dlq, POST /dlq/:id/resolve, GET /:id, PATCH /:id, DELETE /:id.',
  '(2) A key holding the scope is passed through, asserted by DB read-backs and',
  'not by a status: an endpoint is created and deleted (webhook_endpoints +1',
  'then back), a description is updated to a cycle-stamped value and read back,',
  'a replay inserts a new webhook_delivery_logs row, and a DLQ entry flips to',
  'resolved=true. (3) With NO key at all every route still answers 401',
  'authentication_required and never a fall-through 200 — requireScope opens',
  'if (!req.apiKey) next(), so the handler-level requireApiKey is the only thing',
  'holding that line. (4) An org-B key HOLDING webhooks:manage gets 404, never',
  '403, on an org-A endpoint id: scope is capability, org_id is ownership.',
  '(5) The limiter still precedes the guard — an 11th call on a dedicated key is',
  '429 with Retry-After. (6) The JWT surface this PR deliberately left alone',
  'still works: GET /api/v1/webhooks/self-service/dlq with an ORG_ADMIN session',
  'answers 200 with no API key present.',
  'NOT proven here: that enforcement breaks no live integration — that is a',
  'claim about prod’s 18 active keys (0 hold webhooks:manage, re-verified',
  'read-only 2026-09-12), not about this rig; the grandfather backfill runs at',
  'cutover, before the deploy. Outbound delivery behaviour is #2836’s module.',
].join(' ');

const NAME_PREFIX = 'cto-train-b-0912-2845';
const SINK_URL = 'https://cft-webhook-sink-kvojbeutfa-uc.a.run.app/';
const EVENT_TYPE = 'anchor.secured';
// Stored payloads are re-validated on replay against the strict anchor.secured
// schema (#2843 gates replay + retry before signPayload), so the fixture row
// must carry a schema-valid `data` -- a synthetic {probe} blob is refused 422.
const replaySourceData = (eventId) => ({
  public_id: `CTOB0912-2845-${eventId.slice(0, 8).toUpperCase()}`,
  chain_tx_id: `cto-train-b-0912-2845-synthetic-${eventId}`,
  chain_block_height: 900000,
  status: 'SECURED',
  chain_timestamp: new Date().toISOString(),
  secured_at: new Date().toISOString(),
});

/**
 * The ten routes `webhooks.ts` registers, transcribed with method + path from
 * the PR branch and ordered as Express matches them (the literal `/deliveries`,
 * `/dlq` and `/test` paths are registered BEFORE `/:id` on purpose).
 *
 * `needsOrgAdmin` records which five also run `requireWebhookOrgAdmin`. It is
 * not asserted on directly — the scope guard runs FIRST, so a scopeless key
 * never reaches the role check — but it is what makes the expected non-403
 * status in probe 2 legible.
 *
 * `bucket` assigns each route to one of the two keys per probe group; see
 * driver-correctness note (a).
 */
const ROUTES = [
  { method: 'POST', path: '/', body: () => ({ url: SINK_URL, events: [EVENT_TYPE] }), needsOrgAdmin: true, bucket: 0 },
  { method: 'GET', path: '/', needsOrgAdmin: false, bucket: 0 },
  { method: 'POST', path: '/test', body: (ids) => ({ endpoint_id: ids.endpointA }), needsOrgAdmin: false, bucket: 0 },
  { method: 'GET', path: '/deliveries', needsOrgAdmin: false, bucket: 0 },
  { method: 'POST', path: '/deliveries/:id/replay', param: (ids) => ids.deliveryA, needsOrgAdmin: false, bucket: 0 },
  { method: 'GET', path: '/dlq', needsOrgAdmin: true, bucket: 1 },
  { method: 'POST', path: '/dlq/:id/resolve', param: (ids) => ids.dlqA, needsOrgAdmin: true, bucket: 1 },
  { method: 'GET', path: '/:id', param: (ids) => ids.endpointA, needsOrgAdmin: false, bucket: 1 },
  { method: 'PATCH', path: '/:id', param: (ids) => ids.endpointA, body: () => ({ description: `${NAME_PREFIX}-probe` }), needsOrgAdmin: true, bucket: 1 },
  { method: 'DELETE', path: '/:id', param: (ids) => ids.endpointA, needsOrgAdmin: true, bucket: 1 },
];

/** Concrete URL + body for a route, with `:id` filled from the seeded ids. */
function requestFor(route, ids) {
  const tail = route.path === '/' ? '' : route.path.replace(':id', route.param ? route.param(ids) : 'x');
  return {
    method: route.method,
    url: `/api/v1/webhooks${tail}`,
    body: route.body ? route.body(ids) : undefined,
  };
}

/**
 * Mint (or re-mint) one fixture key. Always re-mints the raw half: the row
 * stores only the HMAC, so a fixture whose raw value was lost is a key no probe
 * can authenticate with.
 *
 * `scopes` must be inside the rig's `api_keys_scopes_known_values` CHECK list.
 * `webhooks:manage` is — it has been in the baseline vocabulary since before
 * this PR, which is exactly why the PR needs no migration.
 *
 * `created_by` is load-bearing, not bookkeeping: `requireOrgAdmin`
 * (webhooks.ts:74) resolves `profiles.role` for `api_keys.created_by`, so a key
 * minted under a non-admin would 403 on five routes for a reason that is not
 * the scope guard.
 */
async function ensureKey(admin, { orgId, createdBy, name, scopes, hashApiKey, secret }) {
  const { data: existing, error: findErr } = await admin
    .from('api_keys')
    .select('id')
    .eq('org_id', orgId)
    .eq('name', name)
    .maybeSingle();
  if (findErr) throw new Error(`#2845 lookup key ${name}: ${findErr.message}`);

  const raw = `ak_test_${randomBytes(32).toString('hex')}`;
  const row = {
    org_id: orgId,
    key_prefix: raw.slice(0, 12),
    key_hash: hashApiKey(raw, secret),
    name,
    scopes,
    created_by: createdBy,
    is_active: true,
    revoked_at: null,
  };

  if (existing) {
    const { error } = await admin.from('api_keys').update(row).eq('id', existing.id);
    if (error) throw new Error(`#2845 re-mint key ${name}: ${error.message}`);
    return { id: existing.id, raw, scopes };
  }
  const { data, error } = await admin.from('api_keys').insert(row).select('id').single();
  if (error) throw new Error(`#2845 insert key ${name}: ${error.message}`);
  return { id: data.id, raw, scopes };
}

/** One active https endpoint per org, looked up by its stable description. */
async function ensureEndpoint(admin, { orgId, createdBy, description, existingId }) {
  // The 4b PATCH probe renames the endpoint every cycle, so a description
  // lookup alone would mint a fresh endpoint on every setup re-run and strand
  // deliveryA on the old one. Prefer the id persisted in state when it still exists.
  if (existingId) {
    const { data: byId } = await admin.from('webhook_endpoints').select('id').eq('id', existingId).eq('org_id', orgId).maybeSingle();
    if (byId) return byId.id;
  }
  const { data: existing, error: findErr } = await admin
    .from('webhook_endpoints')
    .select('id, url, is_active')
    .eq('org_id', orgId)
    .eq('description', description)
    .maybeSingle();
  if (findErr) throw new Error(`#2845 lookup endpoint ${description}: ${findErr.message}`);

  if (existing) {
    // An inactive endpoint would 400 `endpoint_inactive` on test-ping and 409 on
    // replay — a non-403 for the wrong reason. Repair rather than tolerate.
    if (existing.url !== SINK_URL || existing.is_active !== true) {
      const { error } = await admin
        .from('webhook_endpoints')
        .update({ url: SINK_URL, is_active: true })
        .eq('id', existing.id);
      if (error) throw new Error(`#2845 repair endpoint ${description}: ${error.message}`);
    }
    return existing.id;
  }

  const { data, error } = await admin
    .from('webhook_endpoints')
    .insert({
      org_id: orgId,
      public_id: '', // set_webhook_endpoint_public_id() BEFORE INSERT trigger fills this
      url: SINK_URL,
      secret_hash: `whsec_${randomBytes(32).toString('hex')}`, // raw secret despite the column name
      events: [EVENT_TYPE],
      is_active: true,
      description,
      created_by: createdBy,
    })
    .select('id')
    .single();
  if (error) throw new Error(`#2845 insert endpoint ${description}: ${error.message}`);
  return data.id;
}

/**
 * Fixtures. Three scope shapes as ruled ({read:search} org A,
 * {webhooks:manage} org A, {webhooks:manage} org B), split across separate
 * keys per probe group so no group can spend another's 10/min bucket — see
 * driver-correctness note (a).
 */
export async function seed(admin, state, ctx) {
  const secret = ctx?.API_KEY_HMAC_SECRET ?? process.env.API_KEY_HMAC_SECRET;
  const hashApiKey = ctx?.hashApiKey;
  if (!secret || typeof hashApiKey !== 'function') {
    throw new Error('#2845 seed: API_KEY_HMAC_SECRET / hashApiKey unavailable — every probe would be vacuous');
  }
  const adminA = state.adminA.userId;
  const adminB = state.adminB.userId;

  const keys = {
    // {read:search} org A — the default a new key is minted with, split in two.
    unscoped0: await ensureKey(admin, { orgId: state.orgA, createdBy: adminA, name: `${NAME_PREFIX}-unscoped-0`, scopes: ['read:search'], hashApiKey, secret }),
    unscoped1: await ensureKey(admin, { orgId: state.orgA, createdBy: adminA, name: `${NAME_PREFIX}-unscoped-1`, scopes: ['read:search'], hashApiKey, secret }),
    // {webhooks:manage} org A — pass-through, split in two.
    scoped0: await ensureKey(admin, { orgId: state.orgA, createdBy: adminA, name: `${NAME_PREFIX}-scoped-0`, scopes: ['read:search', 'webhooks:manage'], hashApiKey, secret }),
    scoped1: await ensureKey(admin, { orgId: state.orgA, createdBy: adminA, name: `${NAME_PREFIX}-scoped-1`, scopes: ['read:search', 'webhooks:manage'], hashApiKey, secret }),
    // {webhooks:manage} org A, reserved for the DB-read-back group.
    work: await ensureKey(admin, { orgId: state.orgA, createdBy: adminA, name: `${NAME_PREFIX}-work`, scopes: ['read:search', 'webhooks:manage'], hashApiKey, secret }),
    // {webhooks:manage} org B — capability without ownership.
    orgB: await ensureKey(admin, { orgId: state.orgB, createdBy: adminB, name: `${NAME_PREFIX}-orgb`, scopes: ['read:search', 'webhooks:manage'], hashApiKey, secret }),
    // Dedicated bucket for the 11-call 429 probe, so it perturbs nothing.
    limiter: await ensureKey(admin, { orgId: state.orgA, createdBy: adminA, name: `${NAME_PREFIX}-limiter`, scopes: ['read:search', 'webhooks:manage'], hashApiKey, secret }),
  };

  const endpointA = await ensureEndpoint(admin, { orgId: state.orgA, createdBy: adminA, description: `${NAME_PREFIX}-endpoint-a`, existingId: state['#2845']?.endpointA });
  const endpointB = await ensureEndpoint(admin, { orgId: state.orgB, createdBy: adminB, description: `${NAME_PREFIX}-endpoint-b`, existingId: state['#2845']?.endpointB });

  // A delivery-log row on org A's endpoint, so replay has something to re-fire
  // and the insert it performs is a countable delta.
  let deliveryA = state['#2845']?.deliveryA ?? null;
  if (deliveryA) {
    const { data } = await admin.from('webhook_delivery_logs').select('id, endpoint_id').eq('id', deliveryA).maybeSingle();
    if (!data) deliveryA = null;
    else if (data.endpoint_id !== endpointA) {
      // Re-home the replay source onto the current endpointA (net-zero fixture, never a second row).
      const { error: rehomeErr } = await admin.from('webhook_delivery_logs').update({ endpoint_id: endpointA }).eq('id', deliveryA);
      if (rehomeErr) throw new Error(`#2845 re-home deliveryA: ${rehomeErr.message}`);
    }
  }
  if (!deliveryA) {
    const eventId = randomUUID();
    const { data, error } = await admin
      .from('webhook_delivery_logs')
      .insert({
        endpoint_id: endpointA,
        event_type: EVENT_TYPE,
        event_id: eventId,
        payload: { event_type: EVENT_TYPE, event_id: eventId, timestamp: new Date().toISOString(), data: replaySourceData(eventId) },
        attempt_number: 1,
        status: 'success',
        response_status: 200,
        delivered_at: new Date().toISOString(),
        idempotency_key: `${NAME_PREFIX}-replay-source-${eventId}`,
      })
      .select('id')
      .single();
    if (error) throw new Error(`#2845 seed delivery log: ${error.message}`);
    deliveryA = data.id;
  }

  // Two DLQ rows on org A. `listing` is never resolved, so GET /dlq (both the
  // key path and the JWT self-service path) always has a real entry to return;
  // `resolveTarget` is re-armed to resolved=false at the top of every cycle,
  // so the resolve read-back is repeatable and leaks no rows over a 48h soak.
  const dlq = {};
  for (const kind of ['listing', 'resolveTarget']) {
    const eventId = `${NAME_PREFIX}-dlq-${kind}`;
    const { data: existing } = await admin
      .from('webhook_dead_letter_queue')
      .select('id')
      .eq('org_id', state.orgA)
      .eq('event_id', eventId)
      .maybeSingle();
    if (existing) { dlq[kind] = existing.id; continue; }
    const { data, error } = await admin
      .from('webhook_dead_letter_queue')
      .insert({
        endpoint_id: endpointA,
        endpoint_url: SINK_URL,
        org_id: state.orgA,
        event_type: EVENT_TYPE,
        event_id: eventId,
        payload: { event_type: EVENT_TYPE, probe: kind },
        error_message: `${NAME_PREFIX} fixture — retries exhausted (synthetic)`,
        last_attempt: 5,
        resolved: false,
      })
      .select('id')
      .single();
    if (error) throw new Error(`#2845 seed dlq ${kind}: ${error.message}`);
    dlq[kind] = data.id;
  }

  return { keys, endpointA, endpointB, deliveryA, dlq };
}

/** GoTrue password grant -> access_token for a rig user. */
async function signIn(supabaseUrl, anonKey, email, password) {
  const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, token: body?.access_token ?? null, error: body?.error_description ?? body?.msg ?? null };
}

/** Exact-count reads scoped to THIS module's rows, so nothing else can move them. */
async function counts(admin, orgId, endpointIds) {
  const [endpoints, logs] = await Promise.all([
    admin.from('webhook_endpoints').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
    admin.from('webhook_delivery_logs').select('id', { count: 'exact', head: true }).in('endpoint_id', endpointIds),
  ]);
  return {
    endpointRows: endpoints.count ?? null,
    logRows: logs.count ?? null,
    errors: [endpoints.error, logs.error].filter(Boolean).map((e) => e.message),
  };
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch, SUPABASE_URL, ANON_KEY, cycleId } = ctx;
  const s = state['#2845'] ?? {};
  const out = [];

  // ── 0. Preconditions ──────────────────────────────────────────────────────
  // FAILS rather than skips: without fixtures every assertion below is vacuous
  // and a green cycle would be a hollow soak.
  if (!s.keys?.scoped0?.raw || !s.endpointA || !s.deliveryA || !s.dlq?.resolveTarget) {
    out.push(probe('2845_fixtures_seeded', true, false, {
      pass: false,
      detail: { reason: 'no #2845 fixture state — run setup.mjs', have: Object.keys(s) },
    }));
    return out;
  }
  const ids = { endpointA: s.endpointA, endpointB: s.endpointB, deliveryA: s.deliveryA, dlqA: s.dlq.resolveTarget };

  // The scope really is grantable on this rig — if the CHECK list lacked it the
  // seed would have thrown, but assert the stored row so the evidence carries it.
  const { data: scopedRow } = await admin.from('api_keys').select('scopes, is_active').eq('id', s.keys.scoped0.id).maybeSingle();
  out.push(probe('2845_scope_is_grantable_on_rig', true,
    Array.isArray(scopedRow?.scopes) && scopedRow.scopes.includes('webhooks:manage') && scopedRow.is_active === true,
    { detail: { scopes: scopedRow?.scopes ?? null, note: 'webhooks:manage is in api_keys_scopes_known_values in the baseline — this PR needs no migration.' } }));

  // Re-arm the resolve target so this probe is repeatable across 48h of cycles.
  const { error: rearmErr } = await admin
    .from('webhook_dead_letter_queue')
    .update({ resolved: false, resolved_at: null })
    .eq('id', s.dlq.resolveTarget);
  out.push(probe('2845_dlq_target_rearmed', true, !rearmErr, { detail: rearmErr?.message ?? null }));

  const before = await counts(admin, state.orgA, [s.endpointA]);
  out.push(probe('2845_snapshot_readable', true, before.errors.length === 0, { detail: { errors: before.errors, before } }));

  // ── 1. No key at all -> 401, never a fall-through 200 ─────────────────────
  // Run FIRST: these ten share the per-IP `batch` bucket with every other
  // anonymous batch-scope call in the cycle (note (b)), so they get the
  // freshest window this module can give them.
  let anonThrottled = 0;
  for (const route of ROUTES) {
    const { method, url, body } = requestFor(route, ids);
    const res = await workerFetch(url, { method, body });
    if (res.status === 429) { anonThrottled += 1; continue; }
    out.push(probe(`2845_noauth_${method}_${route.path}_401`, 401, res.status, {
      detail: { error: res.body?.error, note: 'A 200 here is the regression: requireScope falls through for an anonymous caller, so the handler-level requireApiKey is the only thing stopping it.' },
    }));
    out.push(probe(`2845_noauth_${method}_${route.path}_error_code`, 'authentication_required', res.body?.error ?? null));
  }
  out.push(probe('2845_anon_batch_bucket_exhausted', 0, anonThrottled, {
    detail: 'Anonymous calls key the batch limiter by req.ip, so they share one 10/min bucket with every other anonymous batch-scope call in the cycle. A non-zero count is a driver/bucket condition, NOT a scope-guard defect — the 401 assertions it displaced simply did not run.',
  }));

  // ── 2. read:search key -> 403 insufficient_scope on all ten ──────────────
  // DELETE targets a throwaway UUID, never the shared fixture. On a correct
  // worker the guard answers 403 before Express ever matches the id, so the
  // assertion is identical either way; on a LEAKY worker it means the probe
  // reports the leak instead of destroying the fixture every other cycle.
  const unscopedIds = { ...ids, endpointA: randomUUID() };
  for (const route of ROUTES) {
    const key = route.bucket === 0 ? s.keys.unscoped0 : s.keys.unscoped1;
    const { method, url, body } = requestFor(route, route.method === 'DELETE' ? unscopedIds : ids);
    const res = await workerFetch(url, { method, body, apiKeyRaw: key.raw });
    out.push(probe(`2845_unscoped_${method}_${route.path}_403`, 403, res.status, {
      detail: { error: res.body?.error, required: res.body?.required, granted: res.body?.granted, keyScopes: key.scopes },
    }));
    out.push(probe(`2845_unscoped_${method}_${route.path}_insufficient_scope`, 'insufficient_scope', res.body?.error ?? null));
    out.push(probe(`2845_unscoped_${method}_${route.path}_names_required_scope`, 'webhooks:manage', res.body?.required ?? null));
  }

  // Nothing the refused calls attempted may have landed. POST / and DELETE /:id
  // were among them; if the guard ran late, the endpoint count would have moved.
  const afterRefused = await counts(admin, state.orgA, [s.endpointA]);
  out.push(probe('2845_refused_calls_wrote_nothing', `${before.endpointRows}/${before.logRows}`,
    `${afterRefused.endpointRows}/${afterRefused.logRows}`,
    { detail: 'endpointRows/logRows across the ten 403s and the ten 401s. A 403 that still created or deleted an endpoint would pass a status check and fail this.' }));

  // ── 3. Scoped key -> passed through on all ten, with read-backs ──────────
  // Asserted as NOT-403-insufficient_scope: what is under test is the guard, so
  // a handler's own 404/400/409 is a pass. Where the route WRITES, the write is
  // read back from the DB — a status alone would not satisfy driver rule 1.
  //
  // POST / and DELETE /:id are paired on purpose: the create's row id becomes
  // the delete's target, so the loop is net-zero on `webhook_endpoints` and the
  // shared fixture is never the delete target. If the create failed, the delete
  // falls back to a throwaway UUID (a 404, still not-403) rather than to
  // `endpointA` — a fallback that destroyed the fixture would turn one failure
  // into a broken soak.
  const createdDesc = `${NAME_PREFIX}-created-${cycleId ?? Date.now()}`;
  let createdId = null;

  for (const route of ROUTES) {
    const key = route.bucket === 0 ? s.keys.scoped0 : s.keys.scoped1;
    const routeIds = route.method === 'DELETE' ? { ...ids, endpointA: createdId ?? randomUUID() } : ids;
    const { method, url, body } = requestFor(route, routeIds);
    const isCreate = route.method === 'POST' && route.path === '/';
    const res = await workerFetch(url, {
      method,
      body: isCreate ? { url: SINK_URL, events: [EVENT_TYPE], description: createdDesc } : body,
      apiKeyRaw: key.raw,
    });

    out.push(probe(`2845_scoped_${method}_${route.path}_not_insufficient_scope`, true,
      !(res.status === 403 && res.body?.error === 'insufficient_scope'),
      { detail: { status: res.status, error: res.body?.error, needsOrgAdmin: route.needsOrgAdmin } }));
    // A scoped key must never be refused for the ROLE either — every fixture key
    // is created_by an ORG_ADMIN, so a `forbidden` here means requireOrgAdmin
    // stopped resolving the actor and five routes are dark for the wrong reason.
    if (route.needsOrgAdmin) {
      out.push(probe(`2845_scoped_${method}_${route.path}_not_forbidden`, true, res.body?.error !== 'forbidden',
        { detail: { status: res.status, error: res.body?.error, createdByRole: 'ORG_ADMIN' } }));
    }

    if (isCreate) {
      createdId = res.body?.id ?? res.body?.endpoint?.id ?? null;
      const { data: createdRow } = createdId
        ? await admin.from('webhook_endpoints').select('id, org_id, description, is_active').eq('id', createdId).maybeSingle()
        : { data: null };
      out.push(probe('2845_scoped_create_wrote_endpoint_row', true,
        Boolean(createdRow) && createdRow.org_id === state.orgA && createdRow.description === createdDesc,
        { detail: { status: res.status, createdId, row: createdRow, note: 'The read-back, not the status, is the evidence.' } }));
    }

    if (route.method === 'DELETE' && createdId) {
      const { data: goneRow } = await admin.from('webhook_endpoints').select('id').eq('id', createdId).maybeSingle();
      out.push(probe('2845_scoped_delete_removed_endpoint_row', true, !goneRow,
        { detail: { status: res.status, createdId, note: 'Net-zero on webhook_endpoints: 48h of 5-minute cycles leaves no residue.' } }));
    }
  }

  // ── 4. Further DB read-backs on the dedicated `work` key ─────────────────
  const workKey = s.keys.work.raw;

  // 4b. patch -> the description really changed.
  const patchDesc = `${NAME_PREFIX}-patched-${cycleId ?? Date.now()}`;
  const patched = await workerFetch(`/api/v1/webhooks/${s.endpointA}`, {
    method: 'PATCH', apiKeyRaw: workKey, body: { description: patchDesc },
  });
  const { data: patchedRow } = await admin.from('webhook_endpoints').select('description').eq('id', s.endpointA).maybeSingle();
  out.push(probe('2845_scoped_patch_updated_row', patchDesc, patchedRow?.description ?? null,
    { detail: { status: patched.status, endpointId: s.endpointA } }));
  // Net-zero: put the seed's description back so the fixture stays addressable by name.
  await admin.from('webhook_endpoints').update({ description: `${NAME_PREFIX}-endpoint-a` }).eq('id', s.endpointA);

  // 4c. replay -> a NEW webhook_delivery_logs row. This is the delivery-log
  // advance; the test-ping route cannot serve it (it writes no log row).
  const logsBeforeReplay = await counts(admin, state.orgA, [s.endpointA]);
  const replayed = await workerFetch(`/api/v1/webhooks/deliveries/${s.deliveryA}/replay`, { method: 'POST', apiKeyRaw: workKey });
  const logsAfterReplay = await counts(admin, state.orgA, [s.endpointA]);
  out.push(probe('2845_scoped_replay_inserted_delivery_log', (logsBeforeReplay.logRows ?? 0) + 1, logsAfterReplay.logRows,
    { detail: { status: replayed.status, newDeliveryId: replayed.body?.delivery_id ?? null, replayedFrom: s.deliveryA } }));
  if (replayed.body?.delivery_id) {
    const { data: newLog } = await admin
      .from('webhook_delivery_logs')
      .select('id, endpoint_id, idempotency_key')
      .eq('id', replayed.body.delivery_id)
      .maybeSingle();
    out.push(probe('2845_replay_row_belongs_to_org_a_endpoint', s.endpointA, newLog?.endpoint_id ?? null,
      { detail: { idempotencyKey: newLog?.idempotency_key ?? null } }));
  }

  // 4d. dlq resolve -> the row really flipped. Re-armed first: the pass-through
  // loop above already called this route, so without a reset the read-back
  // would be asserting the state that loop left behind rather than this call's.
  await admin.from('webhook_dead_letter_queue').update({ resolved: false, resolved_at: null }).eq('id', s.dlq.resolveTarget);
  const { data: armedRow } = await admin.from('webhook_dead_letter_queue').select('resolved').eq('id', s.dlq.resolveTarget).maybeSingle();
  out.push(probe('2845_dlq_target_armed_before_resolve', false, armedRow?.resolved ?? null,
    { detail: 'A row already resolved would make the flip assertion below vacuous.' }));

  const resolved = await workerFetch(`/api/v1/webhooks/dlq/${s.dlq.resolveTarget}/resolve`, { method: 'POST', apiKeyRaw: workKey });
  const { data: dlqRow } = await admin
    .from('webhook_dead_letter_queue')
    .select('resolved, resolved_at')
    .eq('id', s.dlq.resolveTarget)
    .maybeSingle();
  out.push(probe('2845_scoped_dlq_resolve_flipped_row', true, dlqRow?.resolved === true,
    { detail: { status: resolved.status, resolvedAt: dlqRow?.resolved_at ?? null } }));

  // 4e. dlq list -> the never-resolved fixture is actually returned, so the
  // 200 above is a real listing and not an empty array.
  const dlqList = await workerFetch('/api/v1/webhooks/dlq', { apiKeyRaw: workKey });
  const listedIds = (dlqList.body?.entries ?? []).map((e) => e.id);
  out.push(probe('2845_scoped_dlq_list_returns_fixture', true, listedIds.includes(s.dlq.listing),
    { detail: { status: dlqList.status, returned: listedIds.length, lookingFor: s.dlq.listing } }));

  // ── 5. Cross-org: 404, never 403 ─────────────────────────────────────────
  // Org B HOLDS webhooks:manage. Scope is capability; org_id is ownership.
  const crossGet = await workerFetch(`/api/v1/webhooks/${s.endpointA}`, { apiKeyRaw: s.keys.orgB.raw });
  out.push(probe('2845_crossorg_get_404_not_403', 404, crossGet.status,
    { detail: { error: crossGet.body?.error, note: '403 here would leak that another org owns this id.' } }));
  out.push(probe('2845_crossorg_get_not_found_code', 'not_found', crossGet.body?.error ?? null));

  const crossDelete = await workerFetch(`/api/v1/webhooks/${s.endpointA}`, { method: 'DELETE', apiKeyRaw: s.keys.orgB.raw });
  const { data: survivor } = await admin.from('webhook_endpoints').select('id').eq('id', s.endpointA).maybeSingle();
  out.push(probe('2845_crossorg_delete_did_not_delete', true, Boolean(survivor),
    { detail: { status: crossDelete.status, note: 'The read-back is the assertion; a 404 that still deleted the row would pass a status check.' } }));

  // ── 6. The limiter still precedes the guard ──────────────────────────────
  // Dedicated key, dedicated bucket: eleven GETs, the 11th is the first refusal
  // (utils/rateLimit.ts `entry.count > maxRequests`, maxRequests=10).
  let firstThrottledAt = null;
  let retryAfter = null;
  for (let i = 1; i <= 11; i += 1) {
    const res = await workerFetch('/api/v1/webhooks', { apiKeyRaw: s.keys.limiter.raw });
    if (res.status === 429 && firstThrottledAt === null) {
      firstThrottledAt = i;
      retryAfter = res.headers['retry-after'] ?? null;
      break;
    }
  }
  out.push(probe('2845_limiter_refuses_eleventh_call', 11, firstThrottledAt,
    { detail: { note: 'Earlier than 11 means the bucket was not fresh; never means the limiter did not run. Both are limiter conditions, reported separately from the guard.' } }));
  out.push(probe('2845_limiter_sets_retry_after', true, retryAfter !== null && Number(retryAfter) >= 1,
    { detail: { retryAfter } }));

  // ── 7. The JWT surface this PR deliberately did NOT gate ─────────────────
  // /webhooks/self-service is mounted BEFORE the guarded mount with requireAuth
  // and its own limiter. An ORG_ADMIN session must still manage webhooks; a 403
  // insufficient_scope here would mean the guard swallowed the dashboard.
  const adminEmail = state.adminA?.email;
  const adminPassword = state.adminA?.password ?? state.password;
  const signedIn = await signIn(SUPABASE_URL, ANON_KEY, adminEmail, adminPassword);
  out.push(probe('2845_org_admin_signed_in', true, Boolean(signedIn.token),
    { detail: { status: signedIn.status, error: signedIn.error, email: adminEmail } }));

  if (signedIn.token) {
    const selfDlq = await workerFetch('/api/v1/webhooks/self-service/dlq', { jwt: signedIn.token });
    out.push(probe('2845_selfservice_dlq_jwt_200', 200, selfDlq.status,
      { detail: { error: selfDlq.body?.error, note: 'No API key is sent, so requireScope never sees req.apiKey — this mount is JWT-only by design.' } }));
    out.push(probe('2845_selfservice_dlq_not_scope_gated', true, selfDlq.body?.error !== 'insufficient_scope',
      { detail: { error: selfDlq.body?.error ?? null } }));
    const selfListed = (selfDlq.body?.entries ?? []).map((e) => e.id);
    out.push(probe('2845_selfservice_dlq_returns_fixture', true, selfListed.includes(s.dlq.listing),
      { detail: { returned: selfListed.length, lookingFor: s.dlq.listing, note: 'Proves the 200 is a real org-scoped listing, not an empty array.' } }));
  }

  // ── 8. Net effect on the shared fixtures ─────────────────────────────────
  // Endpoint count must be exactly where it started: the created endpoint was
  // deleted, and neither the refused calls nor the cross-org delete touched
  // anything. Delivery logs are allowed to have grown by the one replay.
  const after = await counts(admin, state.orgA, [s.endpointA]);
  out.push(probe('2845_endpoint_count_restored', before.endpointRows, after.endpointRows,
    { detail: 'Cycle is net-zero on webhook_endpoints, so a 48h soak leaves no residue.' }));

  return out;
}
