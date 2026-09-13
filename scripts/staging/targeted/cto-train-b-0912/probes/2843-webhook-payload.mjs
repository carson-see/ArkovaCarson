// PR #2843 — outbound webhook payload ratchet (SCRUM-3982).
//
// WHAT THIS PR CHANGED, AND WHAT A RIG CAN ACTUALLY SHOW.
//
// `validateWebhookPayload` used to inspect a payload only when its event type
// was a key of `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`. Everything else returned
// `{ ok: true, bypassed: true }` — signed and delivered with nothing having
// looked at it. The justification was "nothing can subscribe to an unregistered
// type", which is false: `POST /api/v1/webhooks` does restrict `events` to the
// registry, but `create_webhook_endpoint` (SECURITY DEFINER, GRANTed to
// `authenticated`) inserts `p_events` unvalidated, the
// `webhook_endpoints_insert_org` / `_update_org` RLS policies let any ORG_ADMIN
// write the column directly through PostgREST, and there is no CHECK
// constraint. Probe 3 below writes that array and reads it back, so the premise
// is demonstrated on the rig rather than asserted in a PR body.
//
// After this PR: banned keys are refused on every event type (registered and
// legacy-unregistered alike), the scan recurses into nested objects, and an
// event type that is neither registered nor on the shrinking
// `LEGACY_UNREGISTERED_EVENT_TYPES` ratchet FAILS CLOSED. The ratchet also
// binds the two paths that re-sign a STORED payload — `replayDelivery` and the
// retry sweep — because `dispatchWebhookEvent` only ever sees an event's first
// dispatch, so every row persisted before this PR was still deliverable.
//
// Each probe is chosen so the PRE-PR build produces a DIFFERENT, observable
// database state, not merely a different log line:
//
//   probe 1  leaky stored row      pre: status='success' (delivered!)  post: 'failed' + SCRUM-3982 reason
//   probe 2  head-of-line pair     pre: leaky delivers, both succeed   post: leaky terminated, clean delivers next sweep
//   probe 3  unregistered type     pre: status='success' (bypassed)    post: 'failed', refused
//   probe 4  registered clean      pre: success                        post: success  (regression control)
//   probe 5  replay of leaky row   pre: 200 + a new replay-* row       post: 422 payload_refused, no row
//
// Probe 2 is the one that is not about privacy. Terminating a refused row is a
// LIVENESS requirement, not tidiness: a refusal is permanent (the stored bytes
// do not change), so a row left in `retrying` is re-read every sweep forever
// AND, because the sweep advances only the lowest-`sequence` row per resource
// (SCRUM-2250), it head-of-line-blocks every newer event for that resource
// permanently. That is the property `machines/webhookPayloadRefusal.machine.ts`
// proves at the `pr` tier; probe 2 is the same property observed on real rows.
//
// NOT PROVEN HERE, stated so the evidence is not read as more than it is:
//   * `anchor.revocation_anchored` — the other live producer that ships
//     `fingerprint` — needs a real revocation broadcast (chain path). Its
//     refusal is covered by the same code path probe 1 exercises, with a
//     different event type; the rig cannot originate the event.
//   * `attestation.active` is exercised as a STORED payload shape, not as a
//     live dispatch: ENABLE_ATTESTATION_ANCHORING is OFF on this rig, so the
//     attestation anchoring job never runs and the rows are seeded directly.
//     The refusal happens in `validateWebhookPayload`, which does not know or
//     care which producer built the payload, so the seeded row exercises the
//     identical branch.
//   * The refusal-log rate limiter (one error per event type / path / key-path
//     per minute) is process-lifetime state and needs sustained volume across
//     Cloud Run instance recycles. Covered by `webhooks/delivery.test.ts`.
//
// Deliveries are driven through `POST /jobs/webhook-retries` with
// `X-Cron-Secret`, the same real production path #2836's module uses, and for
// the same reason: the test-ping routes write no `webhook_delivery_logs` row
// and so cannot satisfy driver rule 1. Endpoints are this module's OWN rows
// (`cto-train-b-0912-2843-*`); #2836's endpoints are never touched, because
// probe 3 mutates a subscription and probe 2 depends on a group containing
// exactly two rows.
export const pr = '#2843';

export const changedBehavior = [
  'Proven here, each against a before/after row count: (1) a stored delivery-log',
  'row whose payload carries data.fingerprint is refused by the retry sweep',
  "before signing — status='failed', error_message LIKE 'SCRUM-3982%', no",
  'delivered_at, zero new DLQ rows (pre-PR that row was DELIVERED, because the',
  'event type was unregistered and therefore unvalidated); (2) head-of-line: a',
  'leaky seq-100 row and a clean seq-200 row on ONE resource_key — sweep 1',
  'terminates the leaky head, sweep 2 delivers the clean row, which is the',
  'liveness half of the change (a refusal left in `retrying` blocks its resource',
  'forever); (3) webhook_endpoints.events accepts an unregistered event type',
  'written straight through PostgREST — the premise the PR originally got wrong',
  '— and a delivery of that type is now refused instead of bypassed; (4)',
  'regression control: a schema-valid anchor.secured payload still delivers',
  "status='success', and the stored payload->'data' contains no banned key; (5)",
  'replay of a leaky row via POST /api/v1/webhooks/deliveries/:id/replay answers',
  '422 payload_refused and inserts NO replay-* row.',
  'Receiver: the in-repo Cloud Run sink (shared with #2836 by URL only — this',
  'module seeds its own endpoints, since probe 3 mutates a subscription and',
  'probe 2 needs a two-row resource group).',
  'NOT proven here: anchor.revocation_anchored (needs a real revocation',
  'broadcast); attestation.active as a LIVE dispatch (ENABLE_ATTESTATION_ANCHORING',
  'is off on this rig, so its payload shape is seeded directly — the refusal',
  'branch is identical either way); and the refusal-log rate limiter, which is',
  'process-lifetime state and rests on webhooks/delivery.test.ts.',
].join(' ');

const DESC_PREFIX = 'cto-train-b-0912-2843';

/** The event type this module injects into a subscription to show it is accepted. */
const UNREGISTERED_EVENT = 'payment.subscription_updated';
/** A legacy-unregistered type with a live producer — the shape probe 1 refuses. */
const LEAKY_EVENT = 'attestation.active';
/** A registered type with a strict schema — the control that must still deliver. */
const CLEAN_EVENT = 'anchor.secured';

/**
 * Mirrors `BANNED_PAYLOAD_KEYS` in
 * `services/worker/src/webhooks/payload-schemas.ts`, which derives from
 * `BANNED_RESPONSE_KEYS` plus `fingerprint`. Duplicated here on purpose: the
 * driver must not import worker source, and a probe that read the ban list from
 * the code under test would pass for any ban list, including an empty one.
 */
const BANNED_KEYS = [
  'org_id', 'user_id', 'actor_id', 'registered_by', 'granted_by',
  'key_hash', 'secret_hash', 'parent_org_id', 'child_org_id',
  'attester_user_id', 'attester_org_id', 'anchor_id', 'fingerprint',
];

function bannedKeysIn(data) {
  if (data === null || typeof data !== 'object') return [];
  const hits = [];
  for (const [k, v] of Object.entries(data)) {
    const norm = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (k.startsWith('_') || norm.includes('fingerprint') || BANNED_KEYS.includes(norm)
      || BANNED_KEYS.some((b) => norm.endsWith(`_${b}`))) hits.push(k);
    else if (v && typeof v === 'object') hits.push(...bannedKeysIn(v).map((n) => `${k}.${n}`));
  }
  return hits;
}

function randomHex(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** The healthy receiver. Reuses #2836's seeded sink URL rather than a second sink. */
function sinkUrl(state, env) {
  return env.TRAIN_2843_SINK_URL
    ?? state['#2836']?.receivers?.healthy
    ?? env.TRAIN_2836_SINK_URL
    ?? 'https://cft-webhook-sink-kvojbeutfa-uc.a.run.app/';
}

/**
 * Two org-A endpoints on the same healthy sink:
 *
 *   `main`         — probes 1, 2, 4, 5. Subscribed to registered events only.
 *   `unregistered` — probe 3 only. Its `events` array is written DIRECTLY
 *                    through PostgREST with an event type the registry does not
 *                    know, which is the premise being demonstrated: no CHECK
 *                    constraint, and the RLS write policies admit it. Kept on
 *                    its own row so the control endpoint's subscription stays
 *                    honest and probe 2's resource group is never polluted.
 *
 * Mirrors what `POST /api/v1/webhooks` does on insert: `public_id: ''` (a BEFORE
 * INSERT trigger fills it) and `secret_hash` holding the RAW signing secret
 * despite the column name. Idempotent: looked up by `description`, and the URL
 * is repaired in place if an override moved the sink.
 */
export async function seed(admin, state, ctx) {
  const env = ctx?.env ?? process.env;
  const url = sinkUrl(state, env);
  const out = { endpoints: {}, receiver: url, unregisteredEvent: UNREGISTERED_EVENT };

  const specs = [
    { kind: 'main', events: [CLEAN_EVENT, 'anchor.revoked'] },
    { kind: 'unregistered', events: [CLEAN_EVENT, UNREGISTERED_EVENT] },
  ];

  for (const spec of specs) {
    const description = `${DESC_PREFIX}-${spec.kind}`;
    const { data: existing, error: lookupErr } = await admin
      .from('webhook_endpoints')
      .select('id, url, secret_hash, is_active, events')
      .eq('org_id', state.orgA)
      .eq('description', description)
      .maybeSingle();
    if (lookupErr) throw new Error(`#2843 seed lookup ${spec.kind}: ${lookupErr.message}`);

    if (existing) {
      // An endpoint left inactive by a crashed run is skipped by
      // processWebhookRetries, and every probe below would silently pass.
      const patch = {};
      if (existing.url !== url) patch.url = url;
      if (existing.is_active !== true) patch.is_active = true;
      if (spec.events.some((e) => !(existing.events ?? []).includes(e))) patch.events = spec.events;
      if (Object.keys(patch).length > 0) {
        const { error: fixErr } = await admin.from('webhook_endpoints').update(patch).eq('id', existing.id);
        if (fixErr) throw new Error(`#2843 seed repair ${spec.kind}: ${fixErr.message}`);
      }
      out.endpoints[spec.kind] = { id: existing.id, url, secret: existing.secret_hash, events: patch.events ?? existing.events };
      continue;
    }

    const secret = `whsec_${randomHex(32)}`;
    const { data, error } = await admin
      .from('webhook_endpoints')
      .insert({
        org_id: state.orgA,
        public_id: '', // set_webhook_endpoint_public_id() BEFORE INSERT trigger
        url,           // https only — webhook_endpoints has an https CHECK
        secret_hash: secret, // raw secret; signPayload() reads this column directly
        events: spec.events,
        is_active: true,
        description,
        created_by: state.adminA.userId,
      })
      .select('id, events')
      .single();
    if (error) throw new Error(`#2843 seed endpoint ${spec.kind}: ${error.message}`);
    out.endpoints[spec.kind] = { id: data.id, url, secret, events: data.events };
  }

  return out;
}

/** Exact counts scoped to THIS module's endpoints, so nothing else can move them. */
async function counts(admin, endpointIds) {
  const [logs, dlq, replays] = await Promise.all([
    admin.from('webhook_delivery_logs').select('id', { count: 'exact', head: true }).in('endpoint_id', endpointIds),
    admin.from('webhook_dead_letter_queue').select('id', { count: 'exact', head: true }).in('endpoint_id', endpointIds),
    admin.from('webhook_delivery_logs').select('id', { count: 'exact', head: true }).in('endpoint_id', endpointIds).like('idempotency_key', 'replay-%'),
  ]);
  return {
    logRows: logs.count ?? null,
    dlqRows: dlq.count ?? null,
    replayRows: replays.count ?? null,
    errors: [logs.error, dlq.error, replays.error].filter(Boolean).map((e) => e.message),
  };
}

function cleanAnchorSecuredData(publicId) {
  return {
    public_id: publicId,
    chain_tx_id: `soak-${randomHex(8)}`,
    chain_block_height: 850000,
    status: 'SECURED',
    chain_timestamp: '2026-09-12T10:00:00Z',
    secured_at: '2026-09-12T10:00:01Z',
  };
}

/**
 * Seed one delivery-log row the sweep can pick up.
 *
 * `armed: false` inserts it with `next_retry_at` in the FUTURE so no sweep —
 * including the rig's own 2-minute in-process cron — can act on it until
 * `arm()` flips it. Probe 2 needs both of its rows to become eligible in the
 * same instant, or a cron landing between the two inserts would deliver the
 * clean row while the leaky head did not yet exist, and the head-of-line
 * assertion would be vacuous.
 *
 * `idempotency_key` must equal what `deliverToEndpoint` recomputes
 * (`${endpoint.id}-${event_type}-${event_id}`) or the sweep INSERTS a second
 * row and ours sits untouched — a false "nothing happened" pass. `event_id` is
 * a UUID so `dbEventId === payload.event_id` and the two keys stay identical.
 */
async function seedRow(admin, { endpointId, eventType, data, resourceKey, sequence, armed = true }) {
  const eventId = globalThis.crypto.randomUUID();
  const nextRetryAt = armed
    ? new Date(Date.now() - 5 * 60_000).toISOString()
    : new Date(Date.now() + 60 * 60_000).toISOString();
  const payload = {
    event_type: eventType,
    event_id: eventId,
    timestamp: new Date().toISOString(),
    resource_key: resourceKey,
    sequence: sequence ?? null,
    data,
  };
  const { data: row, error } = await admin
    .from('webhook_delivery_logs')
    .insert({
      endpoint_id: endpointId,
      public_id: '', // set_webhook_delivery_log_public_id() BEFORE INSERT trigger
      event_id: eventId,
      event_type: eventType,
      idempotency_key: `${endpointId}-${eventType}-${eventId}`,
      payload,
      status: 'retrying',
      attempt_number: 1,
      next_retry_at: nextRetryAt,
    })
    .select('id, next_retry_at')
    .single();
  if (error) return { error: error.message };
  return { id: row.id, eventId, seededNextRetryAt: row.next_retry_at };
}

/** Make held rows eligible in one statement — see seedRow's `armed` note. */
async function arm(admin, ids) {
  const live = ids.filter(Boolean);
  if (live.length === 0) return null;
  const { error } = await admin
    .from('webhook_delivery_logs')
    .update({ next_retry_at: new Date(Date.now() - 5 * 60_000).toISOString() })
    .in('id', live);
  return error?.message ?? null;
}

/**
 * The delivery path sets `status:'pending'` before firing and the rig's own
 * cron may be mid-flight on the same row, so read back until the row leaves the
 * in-flight state rather than asserting on a torn value.
 */
async function readSettled(admin, rowId, budgetMs = 12_000) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  for (;;) {
    const { data, error } = await admin
      .from('webhook_delivery_logs')
      .select('id, status, response_status, error_message, next_retry_at, attempt_number, delivered_at, payload')
      .eq('id', rowId)
      .maybeSingle();
    if (error) return { error: error.message };
    last = data;
    if (data && data.status !== 'pending') return last;
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, 750));
  }
}

/** `/jobs/*` authenticates on X-Cron-Secret and sits behind a per-IP limiter. */
async function sweep(workerFetch, env) {
  const cronSecret = env.CRON_SECRET ?? '';
  return workerFetch('/jobs/webhook-retries', {
    method: 'POST',
    headers: cronSecret ? { 'X-Cron-Secret': cronSecret } : {},
  });
}

/** Retire leftovers so a later sweep cannot climb the ladder into the next cycle's DLQ delta. */
async function retire(admin, ids) {
  const live = ids.filter(Boolean);
  if (live.length === 0) return;
  // `next_retry_at IS NULL` never satisfies the sweep's `.lte(...)` filter (SQL
  // NULL comparison), so the row is excluded without inventing a status value.
  await admin.from('webhook_delivery_logs').update({ next_retry_at: null }).in('id', live);
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch, env, cycleId } = ctx;
  const seeded = state['#2843'] ?? {};
  const eps = seeded.endpoints ?? {};
  const out = [];
  const created = [];

  const main = eps.main;
  const unreg = eps.unregistered;
  out.push(
    probe('2843_endpoints_seeded', true, Boolean(main?.id && unreg?.id), {
      detail: { main: main?.id ?? null, unregistered: unreg?.id ?? null, receiver: seeded.receiver ?? null },
    }),
  );
  if (!main?.id || !unreg?.id) return out;

  const endpointIds = [main.id, unreg.id];
  const before = await counts(admin, endpointIds);
  out.push(probe('2843_snapshot_readable', true, before.errors.length === 0, { detail: { errors: before.errors, before } }));

  // ── Probe 3 premise: an unregistered event type IS subscribable ───────────
  // Written straight through PostgREST with the service role, exactly as an
  // ORG_ADMIN can through `webhook_endpoints_update_org`. If a CHECK constraint
  // is ever added this write fails and the probe reds — which is the correct
  // signal, because the fail-closed refusal would then be belt-and-braces
  // rather than the only guard.
  const { error: injectErr } = await admin
    .from('webhook_endpoints')
    .update({ events: [CLEAN_EVENT, UNREGISTERED_EVENT] })
    .eq('id', unreg.id);
  const { data: readBack, error: readBackErr } = await admin
    .from('webhook_endpoints')
    .select('events')
    .eq('id', unreg.id)
    .maybeSingle();
  out.push(
    probe('2843_unregistered_event_type_is_subscribable', true,
      !injectErr && !readBackErr && (readBack?.events ?? []).includes(UNREGISTERED_EVENT), {
        detail: {
          events: readBack?.events ?? null,
          injectError: injectErr?.message ?? null,
          readError: readBackErr?.message ?? null,
          note: 'the premise the PR body originally denied: webhook_endpoints.events has no allowlist CHECK and the RLS write policies admit any string, so "unregistered therefore undeliverable" was false',
        },
      }),
  );

  // ── Seed every row for this cycle, held until all of them exist ───────────
  const group = `${DESC_PREFIX}-${cycleId}-hol`;
  const rows = {};
  rows.leaky = await seedRow(admin, {
    endpointId: main.id,
    eventType: LEAKY_EVENT,
    // The historical shape: a legacy-unregistered type shipping the document
    // fingerprint. Pre-PR this was signed and delivered.
    data: { public_id: `SOAK-${randomHex(4)}`, status: 'ACTIVE', fingerprint: 'a'.repeat(64) },
    resourceKey: `${DESC_PREFIX}-${cycleId}-solo`,
    sequence: 10,
    armed: false,
  });
  // Head-of-line pair: ONE resource_key, leaky head first so a cron landing
  // mid-seed can never deliver the clean row ahead of an absent head.
  rows.holLeaky = await seedRow(admin, {
    endpointId: main.id,
    eventType: LEAKY_EVENT,
    data: { public_id: `SOAK-${randomHex(4)}`, status: 'ACTIVE', fingerprint: 'b'.repeat(64) },
    resourceKey: group,
    sequence: 100,
    armed: false,
  });
  rows.holClean = await seedRow(admin, {
    endpointId: main.id,
    eventType: CLEAN_EVENT,
    data: cleanAnchorSecuredData(`SOAK-${randomHex(4)}`),
    resourceKey: group,
    sequence: 200,
    armed: false,
  });
  rows.unregistered = await seedRow(admin, {
    endpointId: unreg.id,
    eventType: UNREGISTERED_EVENT,
    // Deliberately CLEAN: it carries no banned key, so the only thing that can
    // refuse it is the unregistered-type rule itself.
    data: { subscription_status: 'active', period_end: '2026-10-01T00:00:00Z' },
    resourceKey: `${DESC_PREFIX}-${cycleId}-unreg`,
    sequence: 300,
    armed: false,
  });
  rows.control = await seedRow(admin, {
    endpointId: main.id,
    eventType: CLEAN_EVENT,
    data: cleanAnchorSecuredData(`SOAK-${randomHex(4)}`),
    resourceKey: `${DESC_PREFIX}-${cycleId}-control`,
    sequence: 400,
    armed: false,
  });
  // Replay subject: a stored leaky row. Never armed — replay reads it by id.
  rows.replaySubject = await seedRow(admin, {
    endpointId: main.id,
    eventType: 'attestation.created',
    data: {
      public_id: `SOAK-${randomHex(4)}`,
      attestation_type: 'VERIFICATION',
      status: 'PENDING',
      created_at: '2026-09-12T10:00:00Z',
      fingerprint: 'c'.repeat(64),
    },
    resourceKey: `${DESC_PREFIX}-${cycleId}-replay`,
    sequence: 500,
    armed: false,
  });

  const kinds = ['leaky', 'holLeaky', 'holClean', 'unregistered', 'control', 'replaySubject'];
  for (const k of kinds) if (rows[k]?.id) created.push(rows[k].id);
  const seedErrors = kinds.filter((k) => rows[k]?.error).map((k) => `${k}: ${rows[k].error}`);
  out.push(
    probe('2843_rows_seeded', true, seedErrors.length === 0, {
      detail: { errors: seedErrors, ids: Object.fromEntries(kinds.map((k) => [k, rows[k]?.id ?? null])) },
    }),
  );
  if (seedErrors.length > 0) { await retire(admin, created); return out; }

  // Arm everything except the replay subject, in one statement.
  const armError = await arm(admin, [rows.leaky.id, rows.holLeaky.id, rows.holClean.id, rows.unregistered.id, rows.control.id]);
  out.push(probe('2843_rows_armed', null, armError, { detail: 'all sweep-driven rows became eligible in one UPDATE, so no cron can act on a half-seeded head-of-line group' }));

  // ── Sweep 1 ───────────────────────────────────────────────────────────────
  const sweep1 = await sweep(workerFetch, env);
  out.push(
    probe('2843_sweep1_authenticated', true, sweep1.status !== 401 && sweep1.status !== 403 && sweep1.status !== 429, {
      detail: { status: sweep1.status, cronSecretPresent: Boolean(env.CRON_SECRET), note: '429 = the per-IP /jobs limiter, not a delivery failure' },
    }),
  );
  out.push(probe('2843_sweep1_ran', 200, sweep1.status, { detail: sweep1.body }));

  const afterSweep1 = {};
  for (const k of ['leaky', 'holLeaky', 'holClean', 'unregistered', 'control']) {
    afterSweep1[k] = await readSettled(admin, rows[k].id);
  }

  // ── 1. A stored leaky row is refused before signing ───────────────────────
  const lk = afterSweep1.leaky ?? {};
  out.push(
    probe('2843_leaky_row_terminated_failed', 'failed', lk.status ?? null, {
      detail: {
        event_type: LEAKY_EVENT,
        error_message: lk.error_message,
        delivered_at: lk.delivered_at,
        regression: "pre-PR this row read status='success': the event type was unregistered, so validateWebhookPayload bypassed it and the document fingerprint was signed and delivered",
      },
    }),
  );
  out.push(
    probe('2843_leaky_row_reason_recorded', true, typeof lk.error_message === 'string' && lk.error_message.startsWith('SCRUM-3982'), {
      detail: { error_message: lk.error_message, note: 'the refusal is a durable audit fact on the row, not only a log line' },
    }),
  );
  out.push(
    probe('2843_leaky_row_names_the_key_never_the_value', true,
      typeof lk.error_message === 'string' && lk.error_message.includes('fingerprint') && !lk.error_message.includes('a'.repeat(64)), {
        detail: { note: 'error_message reaches logs, Sentry and job_queue.last_error, so it names the KEY — the value is exactly what is being withheld' },
      }),
  );
  out.push(
    probe('2843_leaky_row_never_delivered', true, lk.delivered_at == null && lk.response_status == null, {
      detail: { delivered_at: lk.delivered_at, response_status: lk.response_status, note: 'refused before signPayload, so no socket was opened' },
    }),
  );

  // ── 2. Head-of-line: the liveness half (the TLA property, on real rows) ───
  const h1 = afterSweep1.holLeaky ?? {};
  out.push(
    probe('2843_hol_leaky_head_terminated_after_sweep1', 'failed', h1.status ?? null, {
      detail: {
        resource_key: group,
        error_message: h1.error_message,
        note: "leaving a permanent refusal in 'retrying' would re-read it every sweep AND block every newer event for this resource_key forever — machines/webhookPayloadRefusal.machine.ts refusalIsTerminal",
      },
    }),
  );
  const h2first = afterSweep1.holClean ?? {};
  out.push(
    probe('2843_hol_clean_row_still_pending_or_delivered_not_lost', true,
      h2first.status === 'retrying' || h2first.status === 'success', {
        detail: { status: h2first.status, note: 'the newer event is never discarded by the head being refused; it is either still queued or already advanced' },
      }),
  );

  // ── Sweep 2: the clean row is now the head of its group ───────────────────
  const sweep2 = await sweep(workerFetch, env);
  out.push(
    probe('2843_sweep2_authenticated', true, sweep2.status !== 401 && sweep2.status !== 403 && sweep2.status !== 429, {
      detail: { status: sweep2.status, note: '429 = the per-IP /jobs limiter; two sweeps per cycle is within cadence' },
    }),
  );
  const holClean = await readSettled(admin, rows.holClean.id);
  out.push(
    probe('2843_hol_clean_row_delivered_after_head_cleared', 'success', holClean?.status ?? null, {
      detail: {
        response_status: holClean?.response_status,
        delivered_at: holClean?.delivered_at,
        note: 'the resource advanced once its refused head left `retrying` — fail-forward, not livelock',
      },
    }),
  );

  // ── 3. Fail-closed on the injected unregistered subscription ─────────────
  const un = afterSweep1.unregistered ?? {};
  out.push(
    probe('2843_unregistered_type_refused_not_bypassed', 'failed', un.status ?? null, {
      detail: {
        event_type: UNREGISTERED_EVENT,
        error_message: un.error_message,
        regression: "pre-PR: status='success'. The payload carries no banned key, so bypassing was the ONLY thing that delivered it — this probe isolates the fail-closed rule from the ban list",
      },
    }),
  );
  out.push(
    probe('2843_unregistered_type_reason_mentions_registration', true,
      typeof un.error_message === 'string' && /not registered/i.test(un.error_message), {
        detail: { error_message: un.error_message },
      }),
  );
  out.push(
    probe('2843_unregistered_type_never_delivered', true, un.delivered_at == null, {
      detail: { delivered_at: un.delivered_at, response_status: un.response_status },
    }),
  );

  // ── 4. Regression control: a registered clean payload still delivers ──────
  const ctl = afterSweep1.control ?? {};
  out.push(
    probe('2843_registered_clean_payload_delivered', 'success', ctl.status ?? null, {
      detail: {
        response_status: ctl.response_status,
        error_message: ctl.error_message,
        note: 'the ratchet only refuses; if this reds, fail-closed has over-reached and real subscribers are losing deliveries',
      },
    }),
  );
  out.push(
    probe('2843_registered_clean_payload_2xx_and_delivered_at_set', true,
      typeof ctl.response_status === 'number' && ctl.response_status >= 200 && ctl.response_status < 300 && Boolean(ctl.delivered_at), {
        detail: { response_status: ctl.response_status, delivered_at: ctl.delivered_at },
      }),
  );
  const storedData = ctl.payload?.data ?? null;
  const leaks = bannedKeysIn(storedData);
  out.push(
    probe('2843_delivered_payload_carries_no_banned_key', 0, leaks.length, {
      detail: { leaked: leaks, data_keys: storedData ? Object.keys(storedData) : null, note: "read back from webhook_delivery_logs.payload->'data' — the exact bytes that were signed and sent" },
    }),
  );

  // ── 5. Replay of a leaky stored row ──────────────────────────────────────
  // `dispatchWebhookEvent` only ever sees an event's FIRST dispatch;
  // `replayDelivery` re-signs the stored bytes, so before this PR every
  // pre-ratchet row was one authenticated API call from the wire.
  const replayBefore = await counts(admin, [main.id]);
  const replay = await workerFetch(`/api/v1/webhooks/deliveries/${rows.replaySubject.id}/replay`, {
    method: 'POST',
    apiKeyRaw: state.apiKey?.raw,
  });
  const replayCode = replay.body?.error?.code ?? replay.body?.error ?? null;
  out.push(probe('2843_replay_leaky_row_422', 422, replay.status, { detail: { code: replayCode, body: replay.body } }));
  out.push(probe('2843_replay_leaky_row_payload_refused', 'payload_refused', replayCode, { detail: { status: replay.status } }));
  const replayAfter = await counts(admin, [main.id]);
  out.push(
    probe('2843_replay_wrote_no_replay_row', replayBefore.replayRows, replayAfter.replayRows, {
      detail: {
        note: 'the gate short-circuits before the replay delivery-log insert, so a delta here would mean a refused payload still got a row it could be retried from',
        idempotency_key_pattern: 'replay-%',
      },
    }),
  );
  const replaySubject = await readSettled(admin, rows.replaySubject.id, 2_000);
  out.push(
    probe('2843_replay_left_the_original_row_untouched', 'retrying', replaySubject?.status ?? null, {
      detail: { note: 'a refused replay changes nothing about the audited original', attempt_number: replaySubject?.attempt_number },
    }),
  );

  // ── DLQ delta: a refusal is not an HTTP failure and must not dead-letter ──
  const after = await counts(admin, endpointIds);
  out.push(
    probe('2843_refusals_wrote_no_dlq_rows', before.dlqRows, after.dlqRows, {
      detail: {
        note: "migration 0338 constrains failure_kind to 'http_delivery' | 'log_write'; a payload refusal is neither, so it is recorded on the delivery row instead. DLQ growth here would mean a refusal was filed as a false audit fact (widening failure_kind is SCRUM-5063).",
      },
    }),
  );
  out.push(
    probe('2843_sweep_updated_in_place_no_duplicate_rows', before.logRows + created.length, after.logRows, {
      detail: 'one row seeded per case and none added by either sweep or the replay — proof the idempotency keys matched and the sweep UPDATED our rows rather than inserting alongside them, which would make every assertion above vacuous',
    }),
  );

  await retire(admin, created);
  return out;
}
