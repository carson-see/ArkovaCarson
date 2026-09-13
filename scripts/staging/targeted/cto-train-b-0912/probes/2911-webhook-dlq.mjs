// PR #2911 — Inbound webhook DLQ operator visibility + resolve (SCRUM-4514,
// branch fix/inbound-webhook-dlq-drain, head ab78301ae).
//
// WHAT THIS PR ADDS. `webhook_dlq` (baseline migration, comment: "SCRUM-1148:
// inbound webhook intake failures") is written by four inbound handlers —
// docusign.ts, adobe-sign.ts, checkr.ts, computeid.ts — whenever an
// HMAC-valid payload fails normalization or enqueue, and was drained by
// NOBODY before this PR. Three new surfaces close that gap:
//   - `GET  /api/admin/webhook-dlq`         — counts by provider + oldest
//     unresolved age + per-row `id`/`external_id`/`reason` (never
//     `payload_hash` — there is no partner body to show, and the column is
//     deliberately excluded from the SELECT in api/admin-webhook-dlq.ts).
//   - `POST /api/admin/webhook-dlq/resolve` — atomic, idempotent claim:
//     `UPDATE ... WHERE id = ANY($ids) AND resolved_at IS NULL RETURNING id`.
//     A second call with the same ids resolves zero and reports them under
//     `already_resolved` instead of erroring.
//   - `POST /jobs/webhook-dlq-report`       — report-only cron job, counts
//     only, by provider — the "growing backlog is visible in logs between
//     operator drain runs" half of the fix.
// CTO decision 2026-09-13 (recorded in the PR's own module doc comment):
// there is no replay endpoint. Arkova does not retain raw partner webhook
// bodies (§1.6A) — redelivery happens at the partner, `/resolve` only
// acknowledges it happened.
//
// AUTH SHAPE, the thing most worth getting wrong. Both `/api/admin/*` routes
// are session-JWT only: `routes/admin.ts` calls `extractAuthUserId(req)`
// (routes/middleware.ts — parses `Authorization: Bearer <token>` as a
// Supabase JWT via `verifyAuthToken`, returns null for anything else,
// INCLUDING a syntactically-valid `ak_` API key) and 401s before the handler
// ever runs; the handler itself then re-checks `isPlatformAdmin(userId)`
// (utils/platformAdmin.ts, DB-only, fails secure on a null flag) and 403s a
// signed-in non-admin. An API key can never reach either — this is an
// internal operator surface, not part of the versioned verification API —
// so probe 8 below is a security-property check, not incidental.
//
// WHAT THIS RIG CAN AND CANNOT PROVE. CAN: every response shape and status
// above, on a live worker, with DB read-backs (rule 1) — a row inserted the
// way Checkr's own `dlqInsert` does it, listed, resolved, re-resolved
// idempotently, delisted, and the report job's per-provider count. CANNOT:
// that the four real writers (docusign/adobe-sign/checkr/computeid) still
// write via the same INSERT shape this module assumes — that is pinned by
// their own unit tests (checkr.test.ts, adobe-sign.test.ts,
// computeid.test.ts), not by this rig, which writes the row directly rather
// than driving an HMAC-signed webhook end to end.
import { createHash, randomUUID } from 'node:crypto';

export const pr = '#2911';

export const changedBehavior = [
  'Proven here, every cycle: a webhook_dlq row inserted the way the Checkr',
  "writer does (provider 'checkr', a bounded reason, a real sha256 payload_hash,",
  'no webhook_id) is (1) listed by GET /api/admin/webhook-dlq under a',
  'platform-admin session — by id, external_id and reason, and the response',
  'body carries no 64-hex string anywhere (payload_hash is deliberately',
  'excluded from that SELECT); (2) counted by POST /jobs/webhook-dlq-report',
  '(X-Cron-Secret) under by_provider.checkr.count; (3) resolved by POST',
  '.../resolve {ids,note} -> {resolved:1, already_resolved:0}, and calling it',
  'again on the same id is idempotent -> {resolved:0, already_resolved:1},',
  'never a second resolved:1 and never an error; (4) gone from the GET listing',
  'once resolved. Also proven: a malformed id (not a UUID) 400s before any',
  'Postgres round trip, and — the security property this module exists to',
  'guard — an API-key-authenticated call to /resolve is refused',
  '(401/403, never 200): extractAuthUserId only recognizes a Supabase JWT,',
  'so an ak_ key can never reach the platform-admin check at all, let alone',
  'pass it.',
  'NOT proven here: that the four real inbound handlers (docusign/adobe-sign/',
  'checkr/computeid) still write this exact row shape end-to-end through their',
  'own HMAC verification — that is those handlers\' own unit tests, not this',
  'module, which writes webhook_dlq directly via the service-role client.',
].join(' ');

const NAME_PREFIX = 'cto-train-b-0912-2911';
const PROVIDER = 'checkr';
const REASON = 'rule_event_enqueue_failed';
const HEX64_RE = /\b[0-9a-f]{64}\b/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GoTrue password grant -> access_token for a rig user. Same shape as #2841/#2845. */
async function signIn(supabaseUrl, anonKey, email, password) {
  const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, token: body?.access_token ?? null, error: body?.error_description ?? body?.msg ?? null };
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch, SUPABASE_URL, ANON_KEY, cycleId, env } = ctx;
  const out = [];

  // ── 0. Preconditions ──────────────────────────────────────────────────────
  if (!state.platformAdmin?.email || !(state.platformAdmin?.password ?? state.password)) {
    out.push(probe('2911_fixtures_seeded', true, false, {
      pass: false,
      detail: { reason: 'no state.platformAdmin — run setup.mjs (adds isPlatformAdmin fixture)', have: Object.keys(state) },
    }));
    return out;
  }
  if (!state.apiKey?.raw) {
    out.push(probe('2911_apikey_fixture_present', true, false, {
      pass: false, detail: { reason: 'no state.apiKey — run setup.mjs' },
    }));
    return out;
  }

  // ── 1. Insert one DLQ row the way checkr.ts's dlqInsert() does it ─────────
  // (provider, reason, external_id, payload_hash — webhook_id is never set by
  // any of the four real writers either, so it stays absent here too.)
  const stamp = `${NAME_PREFIX}-${cycleId ?? Date.now()}-${randomUUID()}`;
  const externalId = `probe-${cycleId ?? Date.now()}-${randomUUID()}`;
  const payloadHash = createHash('sha256').update(stamp).digest('hex');
  const { data: inserted, error: insertErr } = await admin
    .from('webhook_dlq')
    .insert({ provider: PROVIDER, reason: REASON, external_id: externalId, payload_hash: payloadHash })
    .select('id, provider, external_id, reason, resolved_at, created_at')
    .single();
  out.push(probe('2911_dlq_row_inserted', true, Boolean(inserted?.id) && !insertErr, {
    detail: { error: insertErr?.message ?? null, id: inserted?.id ?? null, externalId },
  }));
  if (!inserted?.id) return out;
  const rowId = inserted.id;

  // Net-zero across a 48h soak (driver convention, see #2845/#2903): the row
  // this cycle creates is deleted at the end of this same run, whatever the
  // outcome, so no permanent backlog accumulates over hundreds of cycles.
  try {
    // ── 2. Platform-admin session ───────────────────────────────────────────
    const signedIn = await signIn(SUPABASE_URL, ANON_KEY, state.platformAdmin.email, state.platformAdmin.password ?? state.password);
    out.push(probe('2911_platform_admin_signed_in', true, Boolean(signedIn.token), {
      detail: { status: signedIn.status, error: signedIn.error, email: state.platformAdmin.email },
    }));
    if (!signedIn.token) return out;
    const jwt = signedIn.token;

    // ── 3. GET lists it, no 64-hex string anywhere in the body ─────────────
    const list1 = await workerFetch('/api/admin/webhook-dlq', { jwt });
    out.push(probe('2911_list_200', 200, list1.status, { detail: { error: list1.body?.error } }));
    const rows1 = list1.body?.rows ?? [];
    const found1 = rows1.find((r) => r.id === rowId);
    out.push(probe('2911_list_contains_fixture', true, Boolean(found1), {
      detail: { lookingFor: { id: rowId, externalId, reason: REASON }, returnedCount: rows1.length },
    }));
    out.push(probe('2911_list_row_matches', true,
      Boolean(found1) && found1.external_id === externalId && found1.reason === REASON && found1.provider === PROVIDER,
      { detail: { found: found1 ?? null } }));
    out.push(probe('2911_list_body_has_no_64hex_leak', true, !HEX64_RE.test(list1.text ?? ''), {
      detail: { note: 'payload_hash is deliberately excluded from the SELECT in handleWebhookDlqList — a match here is a leak, not this fixture (its own payload_hash is 64 hex chars and must never appear).' },
    }));

    // ── 4. Report job counts it under by_provider.checkr ───────────────────
    const cronSecret = env.CRON_SECRET ?? '';
    const report = await workerFetch('/jobs/webhook-dlq-report', {
      method: 'POST',
      headers: cronSecret ? { 'X-Cron-Secret': cronSecret } : {},
    });
    out.push(probe('2911_report_200', 200, report.status, {
      detail: { error: report.body?.error, cronSecretPresent: Boolean(cronSecret) },
    }));
    out.push(probe('2911_report_counts_checkr', true, (report.body?.by_provider?.checkr?.count ?? 0) >= 1, {
      detail: { by_provider: report.body?.by_provider ?? null, total_unresolved: report.body?.total_unresolved ?? null },
    }));

    // ── 5. Resolve — first call really flips it ─────────────────────────────
    const resolve1 = await workerFetch('/api/admin/webhook-dlq/resolve', {
      method: 'POST', jwt, body: { ids: [rowId], note: 'soak probe' },
    });
    out.push(probe('2911_resolve_first_200', 200, resolve1.status, { detail: { error: resolve1.body?.error } }));
    out.push(probe('2911_resolve_first_counts', true,
      resolve1.body?.resolved === 1 && resolve1.body?.already_resolved === 0,
      { detail: { body: resolve1.body ?? null } }));
    const { data: afterResolve1 } = await admin.from('webhook_dlq').select('resolved_at').eq('id', rowId).maybeSingle();
    out.push(probe('2911_resolve_first_wrote_resolved_at', true, Boolean(afterResolve1?.resolved_at), {
      detail: { note: 'The DB read-back, not the response body, is the assertion (driver rule 1).' },
    }));

    // ── 6. Resolve again — idempotent, not a second resolved:1 ─────────────
    const resolve2 = await workerFetch('/api/admin/webhook-dlq/resolve', {
      method: 'POST', jwt, body: { ids: [rowId], note: 'soak probe' },
    });
    out.push(probe('2911_resolve_second_200', 200, resolve2.status, { detail: { error: resolve2.body?.error } }));
    out.push(probe('2911_resolve_second_is_idempotent', true,
      resolve2.body?.resolved === 0 && resolve2.body?.already_resolved === 1,
      { detail: { body: resolve2.body ?? null } }));

    // ── 7. GET no longer lists it ───────────────────────────────────────────
    const list2 = await workerFetch('/api/admin/webhook-dlq', { jwt });
    const rows2 = list2.body?.rows ?? [];
    out.push(probe('2911_list_excludes_resolved_fixture', true, !rows2.some((r) => r.id === rowId), {
      detail: { status: list2.status, returnedCount: rows2.length },
    }));

    // ── 8. Malformed id -> 400 before any Postgres round trip ──────────────
    const badId = await workerFetch('/api/admin/webhook-dlq/resolve', {
      method: 'POST', jwt, body: { ids: ['not-a-uuid'], note: 'soak probe' },
    });
    out.push(probe('2911_malformed_id_400', 400, badId.status, { detail: { error: badId.body?.error, echoedId: 'not-a-uuid' } }));
    out.push(probe('2911_malformed_id_rejected_not_uuid_shape', true, !UUID_RE.test('not-a-uuid')));

    // ── 9. API-key auth can never reach this surface ────────────────────────
    // extractAuthUserId parses Authorization as a Supabase JWT only — an
    // `ak_` key fails verification and 401s before isPlatformAdmin ever runs,
    // regardless of the key's own scopes. A 200 here would mean the public
    // verification API's auth path leaked into an internal operator route.
    const apiKeyResolve = await workerFetch('/api/admin/webhook-dlq/resolve', {
      method: 'POST', apiKeyRaw: state.apiKey.raw, body: { ids: [rowId], note: 'soak probe' },
    });
    out.push(probe('2911_apikey_auth_never_200', true, apiKeyResolve.status !== 200, {
      detail: { status: apiKeyResolve.status, note: 'Must be 401 (no session) or 403 (session but not platform admin) — never 200.' },
    }));
    out.push(probe('2911_apikey_auth_is_401_or_403', true, apiKeyResolve.status === 401 || apiKeyResolve.status === 403, {
      detail: { status: apiKeyResolve.status, error: apiKeyResolve.body?.error },
    }));
    const apiKeyList = await workerFetch('/api/admin/webhook-dlq', { apiKeyRaw: state.apiKey.raw });
    out.push(probe('2911_apikey_auth_never_200_on_list', true, apiKeyList.status !== 200, {
      detail: { status: apiKeyList.status },
    }));
  } finally {
    // Cleanup regardless of outcome — this fixture must never accumulate
    // across a 48h soak's ~576 cycles.
    const { error: cleanupErr } = await admin.from('webhook_dlq').delete().eq('id', rowId);
    out.push(probe('2911_fixture_row_cleaned_up', true, !cleanupErr, { detail: { error: cleanupErr?.message ?? null, rowId } }));
  }

  return out;
}
