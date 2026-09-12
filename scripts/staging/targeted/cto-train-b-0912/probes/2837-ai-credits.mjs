// PR #2837 — auto-provision the current `ai_credits` period before deduction
// (SCRUM-4939). Lit path: `ENABLE_AI_EXTRACTION` is ON on this rig, so unlike
// #2842 every probe below exercises real behavior rather than a dark contract.
//
// TWO CORRECTIONS TO THE SPEC, both verified against the candidate source and
// both turned into positive assertions rather than silent deviations:
//
//  1. `/api/v1/ai/extract` is JWT-ONLY. `requireAuth` in api/v1/router.ts
//     rejects any `Bearer ak_` with 401 "Supabase JWT authentication required
//     for this endpoint" BEFORE the route runs, so an org API key cannot reach
//     this surface at all. The probes authenticate org C with a real GoTrue
//     password grant; `2837_api_key_rejected_jwt_only` pins the contract so the
//     next author does not re-derive it.
//  2. The route has an EFF-1 result cache keyed on `fingerprint`
//     (`ai_usage_events` lookup) that returns `provider:'cache'` and short-
//     circuits BEFORE the credit path entirely. A probe that reuses a
//     fingerprint would therefore never reach provisioning and would pass
//     vacuously. Every request below uses a fresh random 64-hex fingerprint.
//
// A third property shapes the assertions: on a provider failure or latency
// timeout the route sets `degraded:true`, builds the `fast-fallback` stub AND
// REFUNDS the credit (`deductAICredits(org,user,-1)`), so `used_this_month`
// returns to its prior value. `used >= 1` is therefore asserted only on a
// non-degraded response; on a degraded one the assertion inverts to "refunded".
// The covering-ROW assertion is unconditional either way — that is the actual
// claim this PR makes.
export const pr = '#2837';

export const changedBehavior = [
  'An org with no ai_credits row covering the current period is now provisioned',
  'implicitly on its first POST /api/v1/ai/extract instead of receiving a hard',
  '503 credit_system_unavailable (the fail-closed state since PR #2442, which',
  'nothing ever provisioned a row for). Provisioning is idempotent, never',
  'overwrites used_this_month on an existing row, stamps',
  'config.aiCreditsMonthlyAllocation (default 100 — the value on all 16 seeded',
  'prod org rows), and runs BEFORE the up-front checkAICredits 402 guard rather',
  'than between that guard and the debit. ai_credits has no unique',
  '(org_id, period_start), so the select-then-insert closes its TOCTOU window by',
  're-reading after insert: racers agree on keeper = lowest (created_at, id) and',
  'the loser deletes only the row it itself inserted. A genuine deduction',
  'failure still fails CLOSED with 503, and an exhausted period still 402s.',
].join(' ');

const ORG_C_NAME = 'cto-train-b-0912-org-c';
const USER_C_LOCAL = 'cto-train-b-0912-2837-user-c';
/** Repeat-idempotence loop size. Kept small: aiRateLimiter is 30 req/min per authUserId. */
const REPEAT_POSTS = 3;
/** Concurrency for the TOCTOU probe. */
const PARALLEL_POSTS = 10;

function freshFingerprint() {
  // 64 lowercase hex, unique per call — defeats the EFF-1 fingerprint cache.
  let s = '';
  for (let i = 0; i < 8; i += 1) s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return s.slice(0, 64);
}

function extractBody() {
  return {
    strippedText:
      'CERTIFICATE OF COMPLETION. This certifies that the named participant completed '
      + 'the Advanced Records Management program, 40 contact hours, on 12 March 2026. '
      + 'Issued by the Institute of Records Practice. Certificate reference IRP-2026-0412.',
    credentialType: 'certificate',
    fingerprint: freshFingerprint(),
    issuerHint: 'Institute of Records Practice',
  };
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

/** Exact read of every ai_credits row covering `now` for one org. */
async function coveringRows(admin, orgId) {
  const nowIso = new Date().toISOString();
  const { data, error, count } = await admin
    .from('ai_credits')
    .select('id, monthly_allocation, used_this_month, period_start, period_end', { count: 'exact' })
    .eq('org_id', orgId)
    .lte('period_start', nowIso)
    .gt('period_end', nowIso)
    .order('created_at', { ascending: true });
  return { rows: data ?? [], count: count ?? null, error: error?.message ?? null };
}

async function allRows(admin, orgId) {
  const { data, error } = await admin
    .from('ai_credits')
    .select('id, monthly_allocation, used_this_month, period_start, period_end')
    .eq('org_id', orgId);
  return { rows: data ?? [], error: error?.message ?? null };
}

/**
 * Rows whose period has already ENDED, by parsed instant.
 *
 * Never compare these bounds as strings. PostgREST renders `timestamptz` as
 * `2026-09-01T00:00:00+00:00` while `Date.prototype.toISOString()` produces
 * `2026-09-01T00:00:00.000Z` — the same instant, never `===`. Cycle 1
 * (2026-09-12T21:48:24Z, rev 00005-z58) failed `2837_stale_prior_row_untouched`
 * on exactly that: the row was present and correct, the string match found
 * nothing, and the probe reported `actual: null` as if provisioning had deleted
 * it. Server-side filters (`.lte`/`.gt`/`.gte`) are unaffected — PostgREST
 * parses those — so this is the only place in the module that needed it.
 */
function endedRows(rows, at = Date.now()) {
  return rows.filter((r) => {
    const end = Date.parse(r.period_end);
    return Number.isFinite(end) && end <= at;
  });
}

/** Remove every ai_credits row for the probe org — the cold-start precondition. */
async function clearCredits(admin, orgId) {
  const { error } = await admin.from('ai_credits').delete().eq('org_id', orgId);
  return error?.message ?? null;
}

function monthBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start, end, prevStart };
}

/**
 * Org C exists ONLY for this probe: every other probe's org must never have its
 * ai_credits deleted mid-soak, and this one deletes them on every cycle. A
 * dedicated org is what makes the cold-start precondition safe to repeat.
 *
 * The API key is created deliberately even though the route cannot accept one —
 * `2837_api_key_rejected_jwt_only` needs a real, live key to prove the rejection
 * is the JWT-only contract and not a bad-credential 401.
 */
export async function seed(admin, state, ctx) {
  const existing = state['#2837'];
  if (existing?.orgC && existing?.userC?.email) {
    const { data } = await admin.from('organizations').select('id').eq('id', existing.orgC).maybeSingle();
    if (data) return existing;
  }

  const { data: foundOrg } = await admin
    .from('organizations')
    .select('id')
    .eq('display_name', ORG_C_NAME)
    .maybeSingle();
  let orgC = foundOrg?.id ?? null;
  if (!orgC) {
    const prefix = `Z${Math.random().toString(36).slice(2, 13).toUpperCase().padEnd(11, 'X')}`;
    const { data, error } = await admin
      .from('organizations')
      .insert({ display_name: ORG_C_NAME, legal_name: ORG_C_NAME, org_prefix: prefix })
      .select('id')
      .single();
    if (error) throw new Error(`#2837 seed org C: ${error.message}`);
    orgC = data.id;
  }

  const email = `${USER_C_LOCAL}@staging.invalid.test`;
  const password = state.password;
  if (!password) throw new Error('#2837 seed: state.password missing — run shared fixture setup first');
  const { data: prof } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
  let userId = prof?.id ?? null;
  if (!userId) {
    const { data: created, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: USER_C_LOCAL },
    });
    if (error || !created?.user) throw new Error(`#2837 seed user C: ${error?.message}`);
    userId = created.user.id;
  }
  // org_id on the PROFILE is what ai-extract.ts reads to resolve orgId.
  const { error: pe } = await admin.from('profiles').upsert({
    id: userId, email, full_name: USER_C_LOCAL, role: 'ORG_ADMIN', org_id: orgC,
    is_public_profile: false, is_platform_admin: false,
    disclaimer_accepted_at: new Date().toISOString(),
  });
  if (pe) throw new Error(`#2837 seed profile C: ${pe.message}`);
  const { error: me } = await admin
    .from('org_members')
    .upsert({ user_id: userId, org_id: orgC, role: 'admin' }, { onConflict: 'user_id,org_id' });
  if (me) console.warn(`[setup] #2837 org_members: ${me.message} (continuing)`);

  // A real, live org-C API key for the JWT-only rejection probe.
  let apiKey = existing?.apiKey ?? null;
  if (!apiKey?.raw) {
    const hmacSecret = ctx?.API_KEY_HMAC_SECRET ?? ctx?.env?.API_KEY_HMAC_SECRET;
    if (!hmacSecret) throw new Error('#2837 seed: API_KEY_HMAC_SECRET required to seed the org-C key');
    const raw = `ak_test_${[...Array(8)].map(() => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')).join('')}`;
    const { data, error } = await admin.from('api_keys').insert({
      org_id: orgC,
      key_prefix: raw.slice(0, 12),
      key_hash: ctx.hashApiKey(raw, hmacSecret),
      name: 'cto-train-b-0912-2837-org-c-key',
      scopes: ['read:search', 'anchor:write'],
      created_by: userId,
    }).select('id').single();
    if (error) throw new Error(`#2837 seed org-C key: ${error.message}`);
    apiKey = { id: data.id, raw, orgId: orgC };
  }

  // Start the soak from the cold-start precondition, not from whatever the
  // provisioner's baseline fixture left behind.
  await clearCredits(admin, orgC);

  return { orgC, userC: { userId, email }, apiKey };
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch, ANON_KEY, SUPABASE_URL } = ctx;
  const seeded = state['#2837'] ?? {};
  const orgC = seeded.orgC ?? null;
  const out = [];

  out.push(probe('2837_org_c_seeded', true, Boolean(orgC && seeded.userC?.email), {
    detail: { orgC, email: seeded.userC?.email ?? null },
  }));
  if (!orgC || !seeded.userC?.email) return out;

  const { status: authStatus, token: jwt, error: authError } = await signIn(
    SUPABASE_URL, ANON_KEY, seeded.userC.email, state.password,
  );
  out.push(probe('2837_org_c_jwt_acquired', true, Boolean(jwt), {
    detail: { authStatus, error: authError },
  }));
  if (!jwt) return out;

  const post = (body) => workerFetch('/api/v1/ai/extract', { method: 'POST', body, jwt });
  const rateLimited = [];
  const record = (label, r) => { if (r.status === 429) rateLimited.push(label); return r; };

  // ── 0. JWT-only contract ────────────────────────────────────────────────
  // A LIVE org-C key. 401 here is requireAuth's `Bearer ak_` short-circuit, not
  // a bad credential — which is why the key had to be real to make the point.
  if (seeded.apiKey?.raw) {
    const viaKey = await workerFetch('/api/v1/ai/extract', {
      method: 'POST', body: extractBody(), apiKeyRaw: seeded.apiKey.raw,
    });
    out.push(probe('2837_api_key_rejected_jwt_only', 401, viaKey.status, {
      detail: { error: viaKey.body?.error ?? null, note: 'requireAuth rejects Bearer ak_ before the route; the key itself is valid.' },
    }));
  }

  // ── 1. Cold start: no row at all → provisioned, not 503 ──────────────────
  const clearErr1 = await clearCredits(admin, orgC);
  const preCold = await coveringRows(admin, orgC);
  out.push(probe('2837_cold_start_precondition_zero_rows', 0, preCold.count, {
    detail: { clearError: clearErr1, readError: preCold.error },
  }));

  const cold = record('cold', await post(extractBody()));
  out.push(probe('2837_cold_start_not_503', true, cold.status !== 503, {
    detail: { status: cold.status, error: cold.body?.error ?? null, note: 'Pre-#2837 this was a hard 503 credit_system_unavailable.' },
  }));
  out.push(probe('2837_cold_start_status_200', 200, cold.status, { detail: cold.body?.error ?? null }));

  const afterCold = await coveringRows(admin, orgC);
  out.push(probe('2837_cold_start_provisioned_exactly_one_row', 1, afterCold.count, {
    detail: { rows: afterCold.rows, readError: afterCold.error },
  }));
  out.push(probe('2837_cold_start_allocation_is_100', 100, afterCold.rows[0]?.monthly_allocation ?? null, {
    detail: 'Matches every operator-seeded prod row; a different value means config.aiCreditsMonthlyAllocation drifted.',
  }));
  // Degraded responses REFUND the credit, so the debit assertion inverts.
  const coldDegraded = cold.body?.degraded === true;
  const coldUsed = afterCold.rows[0]?.used_this_month ?? null;
  out.push(probe(
    coldDegraded ? '2837_cold_start_degraded_credit_refunded' : '2837_cold_start_credit_debited',
    true,
    coldDegraded ? coldUsed === 0 : (coldUsed ?? -1) >= 1,
    { detail: { degraded: coldDegraded, provider: cold.body?.provider ?? null, fallbackReason: cold.body?.fallbackReason ?? null, used_this_month: coldUsed } },
  ));

  // ── 2. Stale exhausted PRIOR period, no current row ──────────────────────
  // The fold moved provisioning ahead of the checkAICredits 402 guard for
  // exactly this shape. What it guarantees is that a CURRENT row gets created;
  // it does NOT guarantee a 200, because check_ai_credits' WHERE clause is
  // `A OR B AND C AND D` — parsed `A OR (B AND C AND D)` — so with an org id it
  // matches ANY row for that org regardless of period, LIMIT 1 and no ORDER BY.
  // It may therefore still read the exhausted prior row and answer 402. That
  // precedence bug is pre-existing, needs its own migration (T3, filed), and is
  // the reason the HTTP outcome below is RECORDED across {200,402} instead of
  // pinned: asserting 200 would be writing a probe we expect to fail, and
  // asserting 402 would enshrine the bug. A 5xx is a genuine regression and
  // fails.
  await clearCredits(admin, orgC);
  const { start, end, prevStart } = monthBounds();
  const { error: staleErr } = await admin.from('ai_credits').insert({
    org_id: orgC,
    monthly_allocation: 100,
    used_this_month: 100,
    period_start: prevStart.toISOString(),
    period_end: start.toISOString(),
  });
  out.push(probe('2837_stale_prior_row_seeded', true, !staleErr, { detail: staleErr?.message ?? null }));

  const stale = record('stale', await post(extractBody()));
  const afterStale = await coveringRows(admin, orgC);
  out.push(probe('2837_stale_prior_row_current_period_provisioned', 1, afterStale.count, {
    detail: { status: stale.status, rows: afterStale.rows, expectedPeriodStart: start.toISOString(), expectedPeriodEnd: end.toISOString() },
  }));
  out.push(probe('2837_stale_prior_row_not_5xx', true, stale.status < 500, {
    detail: { status: stale.status, error: stale.body?.error ?? null },
  }));
  out.push(probe('2837_stale_prior_row_http_outcome', [200, 402], stale.status, {
    detail: 'DIAGNOSTIC, not a regression gate. 200 = check_ai_credits read the fresh row; 402 = it read the exhausted prior row via the documented WHERE-precedence bug (own T3 migration). Either way the provisioning assertion above is the claim under test.',
  }));
  // Partition by parsed instant, not by string equality (see endedRows).
  const orgRows = await allRows(admin, orgC);
  const ended = endedRows(orgRows.rows);
  // Guard first, so a read that found NOTHING can never again be reported as a
  // bare `actual: null` that reads like "provisioning deleted the row".
  out.push(probe('2837_stale_prior_row_still_present', 1, ended.length, {
    detail: {
      allRows: orgRows.rows,
      readError: orgRows.error,
      seededPeriod: { period_start: prevStart.toISOString(), period_end: start.toISOString() },
      note: '0 here means the prior row is gone (a real regression); >1 means the cold-start clear did not run.',
    },
  }));
  out.push(probe('2837_stale_prior_row_untouched', 100, ended[0]?.used_this_month ?? null, {
    detail: {
      row: ended[0] ?? null,
      note: 'Provisioning must never rewrite an existing period row. Read via parsed instants; PostgREST renders timestamptz as +00:00, not .000Z.',
    },
  }));

  // ── 3. TOCTOU: concurrent first-ever requests converge to ONE row ────────
  // ai_credits has no unique (org_id, period_start), so without the re-read
  // compensation these can all insert. A surviving duplicate makes every later
  // deduct_ai_credits UPDATE (no row limit) increment BOTH rows.
  await clearCredits(admin, orgC);
  const burst = await Promise.all(Array.from({ length: PARALLEL_POSTS }, () => post(extractBody())));
  burst.forEach((r, i) => record(`burst[${i}]`, r));
  const afterBurst = await coveringRows(admin, orgC);
  out.push(probe('2837_concurrent_converges_to_one_row', 1, afterBurst.count, {
    detail: {
      parallel: PARALLEL_POSTS,
      statuses: burst.map((r) => r.status),
      rows: afterBurst.rows,
      note: 'More than 1 means the compensating delete did not converge; 0 means it deleted too much (the worse failure).',
    },
  }));
  out.push(probe('2837_concurrent_never_zero_rows', true, (afterBurst.count ?? 0) >= 1, {
    detail: 'The compensation may never remove the last covering row — that would re-create the 503 this PR removes.',
  }));

  // ── 4. Idempotence: repeat calls never add a row or rewrite allocation ───
  const beforeRepeat = await coveringRows(admin, orgC);
  for (let i = 0; i < REPEAT_POSTS; i += 1) record(`repeat[${i}]`, await post(extractBody()));
  const afterRepeat = await coveringRows(admin, orgC);
  out.push(probe('2837_repeat_calls_row_count_stable', beforeRepeat.count, afterRepeat.count, {
    detail: { posts: REPEAT_POSTS, before: beforeRepeat.rows, after: afterRepeat.rows },
  }));
  out.push(probe('2837_repeat_calls_allocation_stable',
    beforeRepeat.rows[0]?.monthly_allocation ?? null,
    afterRepeat.rows[0]?.monthly_allocation ?? null,
    { detail: 'ensureAICreditsPeriod must never overwrite an existing row.' }));

  // ── 5. Exhausted CURRENT period still 402s, and does not debit ───────────
  const { error: exhaustErr } = await admin
    .from('ai_credits')
    .update({ used_this_month: 100, monthly_allocation: 100 })
    .eq('org_id', orgC)
    .lte('period_start', new Date().toISOString())
    .gt('period_end', new Date().toISOString());
  out.push(probe('2837_exhaust_current_period_applied', true, !exhaustErr, { detail: exhaustErr?.message ?? null }));

  const exhausted = record('exhausted', await post(extractBody()));
  out.push(probe('2837_exhausted_returns_402', 402, exhausted.status, {
    detail: { error: exhausted.body?.error ?? null, used: exhausted.body?.used ?? null, limit: exhausted.body?.limit ?? null },
  }));
  out.push(probe('2837_exhausted_error_code', 'insufficient_credits', exhausted.body?.error ?? null, {
    detail: 'credit_system_unavailable here would mean the debit was attempted instead of the up-front guard firing.',
  }));
  const afterExhausted = await coveringRows(admin, orgC);
  out.push(probe('2837_exhausted_no_further_debit', 100, afterExhausted.rows[0]?.used_this_month ?? null, {
    detail: { rows: afterExhausted.rows, note: 'A 402 must consume nothing.' },
  }));
  out.push(probe('2837_exhausted_still_one_row', 1, afterExhausted.count, {
    detail: 'A refused request must not provision a second row.',
  }));

  // ── 6. Rate-limit interference guard ────────────────────────────────────
  // aiRateLimiter is 30 req/min keyed on authUserId; this module issues ~16.
  // A 429 makes the assertions above ambiguous, so surface it explicitly rather
  // than letting it read as a behavioral failure.
  out.push(probe('2837_no_rate_limit_interference', 0, rateLimited.length, {
    detail: { rateLimited, note: 'If non-zero, re-read this cycle: 429s invalidate the status assertions above.' },
  }));

  // ── 7. Per-cycle cleanup: next cycle starts cold ────────────────────────
  const cleanupCredits = await clearCredits(admin, orgC);
  const { error: cleanupEvents } = await admin.from('ai_usage_events').delete().eq('org_id', orgC);
  out.push(probe('2837_cycle_cleanup_ok', true, !cleanupCredits && !cleanupEvents, {
    detail: { credits: cleanupCredits, usageEvents: cleanupEvents?.message ?? null },
  }));

  return out;
}
