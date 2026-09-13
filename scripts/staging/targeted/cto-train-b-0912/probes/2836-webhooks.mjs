// PR #2836 — IP-pinned webhook dispatch + replay (SCRUM-4983).
//
// WHAT THIS RIG CAN AND CANNOT PROVE, stated plainly so the evidence is not
// read as more than it is.
//
// The PR routes all five outbound webhook dispatch sites through
// `createSafeFetchImpl()` — resolve, validate, then connect to the PINNED IP
// with the original Host/SNI — so a TTL-0 rebind between the pre-check and the
// socket can no longer reach the metadata server.
//
// The headline assertion (`error_message LIKE 'egress_refused: private_target%'`
// with exactly one DLQ row) is NOT exercisable on this rig, and no probe below
// pretends otherwise. The reason is structural, not an oversight:
// `isPrivateUrlResolved()` — the pre-check that still runs first in
// `deliverToEndpoint` (delivery.ts:334) and in the test-ping routes — and
// `resolveAndPin()` inside the pinned layer share the SAME `BLOCKED_HOSTNAMES`
// set, the same literal-metadata-IP check and the same `isPrivateIp` classifier
// (`lib/ssrf-guard.ts`). A literal private URL is therefore caught by the
// pre-check and never reaches the new layer, and an unresolvable host fails
// CLOSED at the pre-check too. The only input that separates the two layers is
// a host that answers PUBLIC at the pre-check and PRIVATE microseconds later at
// dispatch — a real TTL-0 rebinding zone. Set `TRAIN_REBIND_HOST` to one and
// the full assertion set below activates with no code change; until then that
// claim's evidence is `webhooks/delivery.test.ts` +
// `machines/webhookEgressRefusal.machine.ts`, not this rig.
//
// What this rig DOES prove, and what these probes assert:
//   1. the pinned socket delivers to a real public receiver at all (the whole
//      dispatch path changed, so this is not a formality);
//   2. `204 No Content` — the most common webhook acknowledgement — is recorded
//      as SUCCESS. This is the regression probe for the review fix: before it,
//      `new Response(<zero-length ArrayBuffer>, { status: 204 })` threw
//      `TypeError: Response constructor: Invalid response status code 204`,
//      which is not a SafeFetchError, so an ACCEPTED delivery was classified a
//      transient network error, burned the whole retry ladder and was
//      dead-lettered. On a rig this is the single highest-value probe in the
//      module;
//   3. a `302` whose Location is `http://169.254.169.254/` is NOT followed — the
//      response is recorded as HTTP 302 and no second socket is ever opened;
//   4. a private-target endpoint is refused with nothing written anywhere;
//   5. replay of a private-target delivery answers 403 `ssrf_blocked` and
//      creates no row.
//
// Deliveries are driven through `POST /jobs/webhook-retries`, NOT the test-ping
// route: the test-ping routes return `{success, status_code, response_body}` and
// write NO `webhook_delivery_logs` row (webhooks.ts:446), so they cannot satisfy
// driver rule 1 (never a bare HTTP status). `processWebhookRetries` →
// `deliverToEndpoint` is the real production delivery function this PR changed,
// and it is reachable deterministically by seeding a `retrying` row whose
// `idempotency_key` matches the key `deliverToEndpoint` recomputes
// (`${endpoint.id}-${event_type}-${event_id}`, delivery.ts:356), so the sweep
// UPDATES our row in place instead of inserting a second one.
//
// Every probe pairs its HTTP result with a before/after count taken from
// ctx.admin, scoped by `endpoint_id` so the rig's own 2-minute in-process cron
// and the other train probes cannot perturb the delta.
export const pr = '#2836';

export const changedBehavior = [
  'Proven here: every outbound webhook socket is IP-pinned, and the four',
  'receiver shapes settle correctly in webhook_delivery_logs —',
  '(a) healthy public receiver -> status=success with a 2xx response_status and',
  'delivered_at set; (b) a receiver answering 204 No Content -> status=success,',
  'response_status=204, delivered_at set, next_retry_at NOT re-armed, zero new',
  'DLQ rows (the review regression: 204 was classified a transient network error',
  'and dead-lettered after five attempts); (c) a 302 whose Location is',
  'http://169.254.169.254/ -> response_status=302, never success, zero new DLQ —',
  'the redirect is not followed and no second socket is opened; (d) a literal',
  'private-target endpoint -> refused with NOTHING written: the row is untouched',
  'and no DLQ row appears; (e) replay of a private-target delivery -> 403',
  'ssrf_blocked with zero new delivery-log rows.',
  'Receivers: healthy = the in-repo Cloud Run sink cft-webhook-sink (verified',
  'alive 2026-09-12, but it answers 200 to every path and query, so it CANNOT',
  'serve the 204 or 302 shapes); 204 = httpbingo.org/status/204; 302 = ',
  'httpbin.org/redirect-to?url=http%3A%2F%2F169.254.169.254%2F&status_code=302',
  '(httpbingo refuses that target with 403). Both third-party URLs are',
  'env-overridable and each has its own reachability preflight probe, so a',
  'third-party outage reds a named receiver probe and can never be mistaken for',
  'a worker defect.',
  'NOT proven here: that the refusal came from the PINNED layer with',
  "error_message 'egress_refused: private_target' and one DLQ row. The pre-check",
  'and the pinned layer share one blocklist, so a literal private URL is stopped',
  'by the pre-check and never reaches the new code; only a real TTL-0 rebinding',
  'host separates them. Set TRAIN_REBIND_HOST to one and those assertions',
  'activate. Until then that claim rests on webhooks/delivery.test.ts and',
  'machines/webhookEgressRefusal.machine.ts (proofPassed, equivalent, 121',
  'states), not on this rig.',
].join(' ');

const EVENT_TYPE = 'anchor.secured';
const DESC_PREFIX = 'cto-train-b-0912-2836';

/** Receivers. Overridable so a third-party outage is a config change, not a code change. */
function receivers(env) {
  return {
    healthy: env.TRAIN_2836_SINK_URL ?? 'https://cft-webhook-sink-kvojbeutfa-uc.a.run.app/',
    ack204: env.TRAIN_2836_204_URL ?? 'https://httpbingo.org/status/204',
    // Literal GCE metadata target. Refused by SOME layer; see the header note.
    privateTarget: env.TRAIN_2836_PRIVATE_URL ?? 'http://169.254.169.254/',
    redirect302:
      env.TRAIN_2836_302_URL
      ?? 'https://httpbin.org/redirect-to?url=http%3A%2F%2F169.254.169.254%2F&status_code=302',
    // OPTIONAL upgrade: a host you control that answers a public A record at the
    // pre-check and 169.254.169.254 (TTL 0) at dispatch. Only such a host can
    // reach the pinned layer's refusal path.
    rebind: env.TRAIN_REBIND_HOST ? `http://${env.TRAIN_REBIND_HOST}/hook` : null,
  };
}

const KINDS = ['healthy', 'ack204', 'privateTarget', 'redirect302', 'rebind'];

function randomHex(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Four (optionally five) endpoints on org A, one per receiver shape. Mirrors
 * what POST /api/v1/webhooks does on insert: `public_id: ''` (a BEFORE INSERT
 * trigger fills WHK-{org_prefix}-{16}) and `secret_hash` holding the RAW signing
 * secret, despite the column name.
 *
 * Idempotent: looked up by the stable `description` before insert, and the URL
 * is repaired in place if an env override changed it since the last setup.
 */
export async function seed(admin, state, ctx) {
  const env = ctx?.env ?? process.env;
  const urls = receivers(env);
  const out = { endpoints: {}, receivers: urls };

  for (const kind of KINDS) {
    const url = urls[kind];
    if (!url) continue; // rebind not configured
    const description = `${DESC_PREFIX}-${kind}`;

    const { data: existing, error: lookupErr } = await admin
      .from('webhook_endpoints')
      .select('id, url, secret_hash, is_active')
      .eq('org_id', state.orgA)
      .eq('description', description)
      .maybeSingle();
    if (lookupErr) throw new Error(`#2836 seed lookup ${kind}: ${lookupErr.message}`);

    if (existing) {
      // Keep the row honest if an env override moved the receiver, and make
      // sure a previous cycle never left it disabled (an inactive endpoint is
      // skipped by processWebhookRetries and every probe would silently pass).
      if (existing.url !== url || existing.is_active !== true) {
        const { error: fixErr } = await admin
          .from('webhook_endpoints')
          .update({ url, is_active: true })
          .eq('id', existing.id);
        if (fixErr) throw new Error(`#2836 seed repair ${kind}: ${fixErr.message}`);
      }
      out.endpoints[kind] = { id: existing.id, url, secret: existing.secret_hash };
      continue;
    }

    const secret = `whsec_${randomHex(32)}`;
    const { data, error } = await admin
      .from('webhook_endpoints')
      .insert({
        org_id: state.orgA,
        public_id: '', // set_webhook_endpoint_public_id() BEFORE INSERT trigger
        url,
        secret_hash: secret, // raw secret; signPayload() uses this column directly
        events: [EVENT_TYPE],
        is_active: true,
        description,
        created_by: state.adminA.userId,
      })
      .select('id')
      .single();
    if (error) throw new Error(`#2836 seed endpoint ${kind}: ${error.message}`);
    out.endpoints[kind] = { id: data.id, url, secret };
  }

  return out;
}

/** Exact-count reads, scoped to THIS PR's endpoints so nothing else can move them. */
async function counts(admin, endpointIds) {
  const [logs, dlq] = await Promise.all([
    admin.from('webhook_delivery_logs').select('id', { count: 'exact', head: true }).in('endpoint_id', endpointIds),
    admin.from('webhook_dead_letter_queue').select('id', { count: 'exact', head: true }).in('endpoint_id', endpointIds),
  ]);
  return {
    logRows: logs.count ?? null,
    dlqRows: dlq.count ?? null,
    errors: [logs.error, dlq.error].filter(Boolean).map((e) => e.message),
  };
}

/** A direct call FROM THE DRIVER, so a third-party outage reds its own probe. */
async function reachable(url, expectedStatus) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"preflight":true}',
      redirect: 'manual',
      signal: ctl.signal,
    });
    return { status: r.status, location: r.headers.get('location'), ok: r.status === expectedStatus };
  } catch (e) {
    return { status: 0, location: null, ok: false, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Seed ONE `retrying` delivery-log row the sweep will pick up and UPDATE in
 * place. The idempotency key must equal what deliverToEndpoint recomputes
 * (delivery.ts:356) or the sweep inserts a SECOND row and ours sits untouched —
 * a false "nothing happened" pass. `event_id` is a UUID so the column accepts it
 * and `dbEventId === payload.event_id`, keeping the two keys identical.
 */
async function seedRetryingRow(admin, endpointId, cycleId) {
  const eventId = globalThis.crypto.randomUUID();
  const nextRetryAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const payload = {
    event_type: EVENT_TYPE,
    event_id: eventId,
    timestamp: new Date().toISOString(),
    // Unique per row: each becomes its own head-of-line group (SCRUM-2250), so
    // all four are delivered in a single sweep instead of serialising.
    resource_key: `${DESC_PREFIX}-${cycleId}-${eventId.slice(0, 8)}`,
    data: { probe: '#2836', cycle: cycleId },
  };
  const { data, error } = await admin
    .from('webhook_delivery_logs')
    .insert({
      endpoint_id: endpointId,
      public_id: '', // set_webhook_delivery_log_public_id() BEFORE INSERT trigger
      event_id: eventId,
      event_type: EVENT_TYPE,
      idempotency_key: `${endpointId}-${EVENT_TYPE}-${eventId}`,
      payload,
      status: 'retrying',
      attempt_number: 1,
      next_retry_at: nextRetryAt,
    })
    .select('id, status, attempt_number, next_retry_at')
    .single();
  if (error) return { error: error.message };
  return { id: data.id, eventId, seededNextRetryAt: data.next_retry_at };
}

/**
 * The sweep sets `status:'pending'` before firing, and the rig's own 2-minute
 * in-process cron can be mid-flight on the same row, so read back until the row
 * leaves the in-flight states rather than asserting on a torn value.
 */
async function readSettled(admin, rowId, budgetMs = 12_000) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  for (;;) {
    const { data, error } = await admin
      .from('webhook_delivery_logs')
      .select('id, status, response_status, error_message, next_retry_at, attempt_number, delivered_at')
      .eq('id', rowId)
      .maybeSingle();
    if (error) return { error: error.message };
    last = data;
    if (data && data.status !== 'pending') return last;
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, 750));
  }
}

/** Retire our leftovers so a later sweep cannot climb the ladder and pollute the next cycle's DLQ delta. */
async function retire(admin, rowIds) {
  const ids = rowIds.filter(Boolean);
  if (ids.length === 0) return;
  // next_retry_at IS NULL never satisfies processWebhookRetries' `.lte(...)`
  // filter (SQL NULL comparison), so the row is excluded without inventing a
  // status value the rest of the system does not know about.
  await admin.from('webhook_delivery_logs').update({ next_retry_at: null }).in('id', ids);
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch, env, cycleId } = ctx;
  const seeded = state['#2836'] ?? {};
  const eps = seeded.endpoints ?? {};
  const out = [];

  const configured = KINDS.filter((k) => eps[k]?.id);
  const endpointIds = configured.map((k) => eps[k].id);
  out.push(
    probe('2836_endpoints_seeded', true, endpointIds.length >= 4, {
      detail: { configured, ids: endpointIds, rebindConfigured: Boolean(eps.rebind?.id) },
    }),
  );
  if (endpointIds.length < 4) return out;

  // ── 0. Receivers answer what we are about to assert the worker saw ────────
  // Separately named so a httpbin/httpbingo outage reds ITS probe, never the
  // worker's. A worker probe below failing while these pass is a real defect.
  const r204 = await reachable(eps.ack204.url, 204);
  out.push(
    probe('2836_receiver_204_reachable', 204, r204.status, {
      detail: { url: eps.ack204.url, error: r204.error ?? null, note: 'third-party receiver; a red here is a receiver outage, not a worker defect' },
    }),
  );
  const r302 = await reachable(eps.redirect302.url, 302);
  out.push(
    probe('2836_receiver_302_to_private_reachable', true, r302.status === 302 && (r302.location ?? '').includes('169.254.169.254'), {
      detail: { url: eps.redirect302.url, status: r302.status, location: r302.location, error: r302.error ?? null },
    }),
  );
  const rHealthy = await reachable(eps.healthy.url, 200);
  out.push(
    probe('2836_receiver_healthy_reachable', 200, rHealthy.status, {
      detail: { url: eps.healthy.url, error: rHealthy.error ?? null, note: 'in-repo Cloud Run sink cft-webhook-sink' },
    }),
  );

  // ── 1. Before-counts, scoped to this PR's endpoints ───────────────────────
  const before = await counts(admin, endpointIds);
  out.push(probe('2836_snapshot_readable', true, before.errors.length === 0, { detail: { errors: before.errors, before } }));

  // ── 2. Seed one retrying row per receiver shape ───────────────────────────
  const rows = {};
  for (const kind of configured) {
    rows[kind] = await seedRetryingRow(admin, eps[kind].id, cycleId);
  }
  const seedErrors = configured.filter((k) => rows[k].error).map((k) => `${k}: ${rows[k].error}`);
  out.push(probe('2836_retry_rows_seeded', true, seedErrors.length === 0, { detail: { errors: seedErrors, ids: Object.fromEntries(configured.map((k) => [k, rows[k].id ?? null])) } }));
  if (seedErrors.length > 0) return out;

  // ── 3. Drive the REAL delivery function via the retry sweep ───────────────
  // /jobs/* authenticates on X-Cron-Secret (constant-time compare, routes/cron.ts
  // verifyCronAuth) and is behind a PER-IP limiter — a 429 is a driver-cadence
  // problem, so it gets its own probe rather than being read as a failed sweep.
  const cronSecret = env.CRON_SECRET ?? '';
  const sweep = await workerFetch('/jobs/webhook-retries', {
    method: 'POST',
    headers: cronSecret ? { 'X-Cron-Secret': cronSecret } : {},
  });
  out.push(
    probe('2836_retry_sweep_authenticated', true, sweep.status !== 401 && sweep.status !== 403 && sweep.status !== 429, {
      detail: { status: sweep.status, cronSecretPresent: Boolean(cronSecret), note: '429 = per-IP /jobs limiter, not a delivery failure' },
    }),
  );
  out.push(probe('2836_retry_sweep_ran', 200, sweep.status, { detail: sweep.body }));

  const settled = {};
  for (const kind of configured) settled[kind] = await readSettled(admin, rows[kind].id);

  // ── 4a. Healthy receiver: the pinned socket actually delivers ─────────────
  const h = settled.healthy ?? {};
  out.push(
    probe('2836_healthy_receiver_delivered_success', 'success', h.status ?? null, {
      detail: { response_status: h.response_status, delivered_at: h.delivered_at, error_message: h.error_message, url: eps.healthy.url },
    }),
  );
  out.push(
    probe('2836_healthy_receiver_2xx_and_delivered_at_set', true, typeof h.response_status === 'number' && h.response_status >= 200 && h.response_status < 300 && Boolean(h.delivered_at), {
      detail: { response_status: h.response_status, delivered_at: h.delivered_at },
    }),
  );

  // ── 4b. 204 No Content — THE regression probe ─────────────────────────────
  // Pre-fix this row reads status='retrying' with
  // error_message='Response constructor: Invalid response status code 204',
  // and after five sweeps status='failed' with a DLQ row.
  const a = settled.ack204 ?? {};
  out.push(
    probe('2836_204_ack_recorded_success', 'success', a.status ?? null, {
      detail: { response_status: a.response_status, error_message: a.error_message, url: eps.ack204.url, regression: 'pre-fix: TypeError "Invalid response status code 204" classified transient' },
    }),
  );
  out.push(probe('2836_204_ack_response_status_204', 204, a.response_status ?? null, { detail: { status: a.status, delivered_at: a.delivered_at } }));
  out.push(
    probe('2836_204_ack_not_re_armed_for_retry', true, a.status === 'success' && a.next_retry_at === rows.ack204.seededNextRetryAt, {
      detail: {
        seeded_next_retry_at: rows.ack204.seededNextRetryAt,
        observed_next_retry_at: a.next_retry_at,
        note: 'The success branch does not clear next_retry_at, so the true assertion is that the ladder was NOT advanced — an identical value means no retry was scheduled.',
      },
    }),
  );
  out.push(probe('2836_204_ack_delivered_at_set', true, Boolean(a.delivered_at), { detail: { delivered_at: a.delivered_at } }));

  // ── 4c. 302 to a private IP is NOT followed ───────────────────────────────
  // safeFetchSingleHop runs 0 hops and every caller keeps redirect:'manual', so
  // the 3xx surfaces as a non-ok response. A success here would mean a second
  // socket was opened — to the metadata server.
  const rd = settled.redirect302 ?? {};
  out.push(probe('2836_302_response_status_recorded', 302, rd.response_status ?? null, { detail: { status: rd.status, error_message: rd.error_message, url: eps.redirect302.url } }));
  out.push(
    probe('2836_302_never_succeeded_no_second_socket', true, rd.status !== 'success' && rd.delivered_at == null, {
      detail: { status: rd.status, delivered_at: rd.delivered_at, note: 'success here would mean the redirect was followed to 169.254.169.254' },
    }),
  );

  // ── 4d. Literal private target: refused, and NOTHING written ──────────────
  // deliverToEndpoint's pre-check returns false before any log write, so the
  // seeded row must come back byte-identical. See the header: this proves the
  // refusal, not WHICH layer refused.
  const p = settled.privateTarget ?? {};
  out.push(
    probe('2836_private_target_row_untouched', JSON.stringify({ status: 'retrying', attempt_number: 1, response_status: null, delivered_at: null }), JSON.stringify({ status: p.status ?? null, attempt_number: p.attempt_number ?? null, response_status: p.response_status ?? null, delivered_at: p.delivered_at ?? null }), {
      detail: { url: eps.privateTarget.url, error_message: p.error_message, note: 'refused before any socket and before any log write; the pre-check and the pinned layer share one blocklist, so this does not attribute the refusal to the new layer' },
    }),
  );

  // ── 5. Replay of a private-target delivery ────────────────────────────────
  // replayDelivery runs its urlGuard BEFORE inserting the new log row
  // (delivery.ts:1075), so the literal-private case returns ssrf_blocked with NO
  // new row. The "+ a new failed row" variant belongs to the pinned-layer path
  // and needs TRAIN_REBIND_HOST.
  const replayBefore = await counts(admin, [eps.privateTarget.id]);
  const replay = await workerFetch(`/api/v1/webhooks/deliveries/${rows.privateTarget.id}/replay`, {
    method: 'POST',
    apiKeyRaw: state.apiKey?.raw,
  });
  const replayCode = replay.body?.error?.code ?? replay.body?.error ?? null;
  out.push(probe('2836_replay_private_target_403', 403, replay.status, { detail: { code: replayCode, body: replay.body } }));
  out.push(probe('2836_replay_private_target_ssrf_blocked', 'ssrf_blocked', replayCode, { detail: { status: replay.status } }));
  const replayAfter = await counts(admin, [eps.privateTarget.id]);
  out.push(
    probe('2836_replay_private_target_wrote_no_row', replayBefore.logRows, replayAfter.logRows, {
      detail: { note: 'the guard short-circuits before the new delivery_log insert, so a delta here would mean the guard moved' },
    }),
  );

  // ── 6. OPTIONAL: the pinned layer's own refusal, when a rebind host exists ─
  if (eps.rebind?.id && rows.rebind?.id) {
    const rb = settled.rebind ?? {};
    out.push(probe('2836_rebind_marked_failed', 'failed', rb.status ?? null, { detail: { host: eps.rebind.url, error_message: rb.error_message } }));
    out.push(
      probe('2836_rebind_error_message_egress_refused', true, typeof rb.error_message === 'string' && rb.error_message.startsWith('egress_refused: private_target'), {
        detail: { error_message: rb.error_message },
      }),
    );
    out.push(probe('2836_rebind_next_retry_at_null_terminal', null, rb.next_retry_at ?? null, { detail: 'a pinned-layer refusal is permanent: no retry is scheduled' }));
    const { data: dlqRows, error: dlqErr } = await admin
      .from('webhook_dead_letter_queue')
      .select('id, failure_kind, error_message')
      .eq('endpoint_id', eps.rebind.id)
      .eq('event_id', rows.rebind.eventId);
    out.push(probe('2836_rebind_exactly_one_dlq_row', 1, dlqErr ? null : (dlqRows ?? []).length, { detail: { error: dlqErr?.message ?? null, rows: dlqRows } }));
    out.push(
      probe('2836_rebind_dlq_failure_kind_within_0338_check', true, (dlqRows ?? []).every((r) => r.failure_kind === 'http_delivery' || r.failure_kind === 'log_write'), {
        detail: { kinds: (dlqRows ?? []).map((r) => r.failure_kind), note: "migration 0338: CHECK (failure_kind IN ('http_delivery','log_write')) — a third value is rejected 23514 and the PostgREST upsert loses the row silently" },
      }),
    );
  }

  // ── 7. DLQ delta: only the terminal shapes may dead-letter, and none did ──
  const after = await counts(admin, endpointIds);
  out.push(
    probe('2836_no_new_dlq_rows', before.dlqRows, after.dlqRows, {
      detail: 'None of this cycle\'s rows is terminal (attempt 2 of MAX_RETRIES 5), so any DLQ growth means an accepted or retryable delivery was dead-lettered — the exact shape of the 204 regression.',
    }),
  );
  out.push(
    probe('2836_sweep_updated_in_place_no_duplicate_rows', before.logRows + configured.length, after.logRows, {
      detail: 'One row seeded per receiver and none added by the sweep — proof the idempotency_key matched and deliverToEndpoint UPDATED our row rather than inserting a second one (which would make every assertion above vacuous).',
    }),
  );

  // Retire this cycle's rows so a later sweep cannot climb the ladder into the
  // next cycle's DLQ delta.
  await retire(admin, configured.map((k) => rows[k].id));

  return out;
}
