// PR #2842 — ComputeID activation readiness (SCRUM-4495 / SCRUM-4501).
//
// WHAT THIS RIG CAN AND CANNOT PROVE, stated plainly so the evidence is not
// read as more than it is.
//
// The rig runs `ENABLE_COMPUTEID_INTEGRATION=false` — prod's real state, and
// the state this PR ships in. So the lit path (a real revocation reconciled
// through the shared transition path) is NOT exercisable here, and no probe
// below pretends to. Its evidence is elsewhere and is already in hand:
//   - the offline golden test verifies the production verifier against the two
//     REAL partner-signed receipts captured 2026-09-07 (independently
//     re-derived during review: RSA PKCS#1 v1.5 / SHA-256 against the pinned
//     CA, key_id ebb276c2f18ed34f; PSS rejected), and
//   - 38 unit tests pin the re-check's decision logic, 19 of which fail
//     against the pre-review head 36b66a110.
//
// What the rig CAN prove — and what these probes assert — is the DARK
// CONTRACT: that a PR adding two HTTP surfaces, a cron route, two Secret
// Manager wirings and an outbound partner client changes NOTHING observable
// while the flag is off. That is the claim the release actually makes, and it
// is a claim about absence, which is exactly what a rig is good at.
//
// Every probe therefore pairs a response assertion with a DB delta of ZERO
// taken from ctx.admin before and after (driver rule 1: never a bare HTTP
// status). A 503 that quietly wrote a DLQ row would pass a status check and
// fail these.
export const pr = '#2842';

export const changedBehavior = [
  'Dark contract (what this rig proves): with ENABLE_COMPUTEID_INTEGRATION=false,',
  'POST /webhooks/computeid and POST /api/v1/agents/computeid/admit answer 503',
  'vendor_gated at the mount-level gate — BEFORE the raw-body parser, the rate',
  'limiter bucket and requireScopeAnyAuth — and POST /jobs/computeid-passport-recheck',
  'answers 200 {skipped:true,reason:"flag_off"} as its first statement, before any',
  'agent lookup or partner call. Nothing is written: webhook_dlq,',
  'computeid_passport_authority, agents and api_keys are unchanged, and no',
  'job_queue re-check cursor row is created.',
  'NOT proven here (flag is off, by design): the lit reconciliation path. Its',
  'evidence is the offline golden test against the two real partner-signed',
  'receipts (receipt-verifier.golden.test.ts) plus 38 unit tests on the re-check',
  'decision logic, 19 of which fail against the pre-review head 36b66a110.',
].join(' ');

/** The re-check's cursor singleton (RECHECK_CURSOR_ROW_ID in jobs/computeid-passport-recheck.ts). */
const RECHECK_CURSOR_ROW_ID = '00000000-0000-4000-8000-00000004495c';
/** Any UUID; the point is that the dark path never looks at it. */
const PROBE_PASSPORT_ID = 'b390e5e6-c79d-4f02-9a42-212494b1fd44';

/** Exact-count reads of every table a lit ComputeID path would touch. */
async function snapshot(admin, agentId) {
  const [dlq, authority, cursor, agent, keys] = await Promise.all([
    admin.from('webhook_dlq').select('id', { count: 'exact', head: true }).eq('provider', 'computeid'),
    admin.from('computeid_passport_authority').select('passport_id', { count: 'exact', head: true }),
    admin.from('job_queue').select('id', { count: 'exact', head: true }).eq('id', RECHECK_CURSOR_ROW_ID),
    agentId
      ? admin.from('agents').select('id, status, metadata, revoked_at, suspended_at').eq('id', agentId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    agentId
      ? admin.from('api_keys').select('id, is_active').eq('name', `cto-train-b-0912-2842-agent-key`)
      : Promise.resolve({ data: null, error: null }),
  ]);
  return {
    dlqCount: dlq.count ?? null,
    authorityCount: authority.count ?? null,
    cursorRows: cursor.count ?? null,
    agent: agent.data ?? null,
    keys: (keys.data ?? []).map((k) => ({ id: k.id, is_active: k.is_active })).sort((a, b) => a.id.localeCompare(b.id)),
    // Surfaced so a read that ERRORED cannot masquerade as a zero delta.
    errors: [dlq.error, authority.error, cursor.error, agent.error, keys.error].filter(Boolean).map((e) => e.message),
  };
}

/**
 * A bound agent + its key, so "nothing mutated" is a statement about a row a
 * lit path WOULD have changed, not about an empty table. Deliberately shaped
 * like a real admission: the binding is what `readBinding` parses, and the key
 * is what a revocation would deactivate.
 */
export async function seed(admin, state) {
  const existing = state['#2842'];
  if (existing?.agentId) {
    const { data } = await admin.from('agents').select('id').eq('id', existing.agentId).maybeSingle();
    if (data) return existing;
  }
  const boundAt = '2026-09-10T00:00:00.000Z';
  const { data: agent, error } = await admin
    .from('agents')
    .insert({
      org_id: state.orgA,
      name: 'cto-train-b-0912-2842-bound-agent',
      description: 'Dark-contract probe for PR #2842. A lit ComputeID path would mutate this row; nothing may.',
      status: 'active',
      allowed_scopes: ['write:anchors'],
      registered_by: state.adminA.userId,
      metadata: {
        computeid: {
          issuer: 'computeid',
          passport_id: PROBE_PASSPORT_ID,
          bound_at: boundAt,
          receipt_expires_at: '2026-09-10T00:05:00.000Z',
          receipt_issued_at: boundAt,
        },
      },
    })
    .select('id')
    .single();
  if (error) throw new Error(`#2842 seed agent: ${error.message}`);

  // An agent-scoped key, so key enforcement has something to deactivate.
  const { data: key, error: keyErr } = await admin
    .from('api_keys')
    .insert({
      org_id: state.orgA,
      key_prefix: 'ak_test_2842',
      key_hash: 'f'.repeat(64), // Never authenticated with; presence is the point.
      name: 'cto-train-b-0912-2842-agent-key',
      scopes: ['write:anchors'],
      created_by: state.adminA.userId,
    })
    .select('id')
    .single();
  if (keyErr) throw new Error(`#2842 seed key: ${keyErr.message}`);

  return { agentId: agent.id, apiKeyId: key.id, passportId: PROBE_PASSPORT_ID };
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch, env } = ctx;
  const seeded = state['#2842'] ?? {};
  const agentId = seeded.agentId ?? null;
  const out = [];

  const before = await snapshot(admin, agentId);
  out.push(
    probe('2842_snapshot_readable', true, before.errors.length === 0, {
      detail: { errors: before.errors, before },
    }),
  );

  // ── 1. Webhook: 503 before the raw-body parser and before HMAC auth ───────
  // An oversized garbage body is the discriminator. If the gate did not sit in
  // front of `computeidWebhookBody`, this is a 413 or a parser 400; if it sat
  // after HMAC verification it is a 401. Only a gate mounted first answers 503.
  const garbage = 'A'.repeat(512 * 1024);
  const oversized = await workerFetch('/webhooks/computeid', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: garbage,
  });
  out.push(
    probe('2842_webhook_oversized_garbage_503_vendor_gated', 503, oversized.status, {
      detail: { code: oversized.body?.error?.code, bodyBytes: garbage.length },
    }),
  );
  out.push(
    probe('2842_webhook_gate_precedes_body_parse', 'vendor_gated', oversized.body?.error?.code ?? null, {
      detail: 'A 413/400 here would mean the body parser ran first; a 401 would mean HMAC auth ran first.',
    }),
  );

  // An UNSIGNED but well-formed delivery: no X-ComputeID-Signature at all.
  // Dark, this must be 503 and must NOT reach the DLQ. Lit, it would be 401
  // with a webhook_dlq row — which is exactly the delta we assert stays zero.
  const unsigned = await workerFetch('/webhooks/computeid', {
    method: 'POST',
    body: {
      event: 'passport.revoked',
      passport_id: PROBE_PASSPORT_ID,
      timestamp: new Date().toISOString(),
    },
  });
  out.push(
    probe('2842_webhook_unsigned_delivery_503', 503, unsigned.status, {
      detail: { code: unsigned.body?.error?.code },
    }),
  );

  // ── 2. Admission: 503 before requireScopeAnyAuth ──────────────────────────
  // No Authorization header at all. A 401 here would mean the auth middleware
  // ran ahead of the gate — the integration would then be doing profile
  // lookups for a vendor that is switched off.
  const admitUnauth = await workerFetch('/api/v1/agents/computeid/admit', {
    method: 'POST',
    body: { passport_id: PROBE_PASSPORT_ID, verification_receipt: { nonsense: true } },
  });
  out.push(
    probe('2842_admit_unauthenticated_503_not_401', 503, admitUnauth.status, {
      detail: { code: admitUnauth.body?.error?.code, note: '401 would mean auth ran before the gate' },
    }),
  );

  // ── 3. The re-check cron route: 200 {skipped:true}, and no cursor row ─────
  // /jobs/* authenticates via X-Cron-Secret (constant-time compare in
  // routes/cron.ts verifyCronAuth) — the same header Cloud Scheduler sends.
  const cronSecret = env.CRON_SECRET ?? '';
  const recheck = await workerFetch('/jobs/computeid-passport-recheck', {
    method: 'POST',
    headers: cronSecret ? { 'X-Cron-Secret': cronSecret } : {},
  });
  out.push(
    probe('2842_recheck_cron_authenticated', true, recheck.status !== 401 && recheck.status !== 403, {
      detail: { status: recheck.status, cronSecretPresent: Boolean(cronSecret) },
    }),
  );
  out.push(probe('2842_recheck_returns_200', 200, recheck.status, { detail: recheck.body }));
  out.push(
    probe('2842_recheck_skipped_flag_off', true, recheck.body?.skipped === true && recheck.body?.reason === 'flag_off', {
      detail: { skipped: recheck.body?.skipped, reason: recheck.body?.reason },
    }),
  );
  // The gate is the job's FIRST statement, so a dark run cannot have looked at
  // a single agent or called the partner once.
  out.push(
    probe('2842_recheck_did_no_work', true, (recheck.body?.checked ?? 0) === 0 && (recheck.body?.passportsVerified ?? 0) === 0, {
      detail: { checked: recheck.body?.checked, passportsVerified: recheck.body?.passportsVerified },
    }),
  );

  // ── 4. switchboard_flags read-back ────────────────────────────────────────
  // ENABLE_COMPUTEID_INTEGRATION is env-sourced (flag-inventory.json), so the
  // row may legitimately be ABSENT. Absent and false both mean "not enabled";
  // a row reading TRUE while the worker reports flag_off is the drift worth
  // catching, so that is the only failing shape.
  const { data: flagRow, error: flagErr } = await admin
    .from('switchboard_flags')
    .select('flag_key, enabled')
    .eq('flag_key', 'ENABLE_COMPUTEID_INTEGRATION')
    .maybeSingle();
  out.push(
    probe('2842_switchboard_flag_not_enabled', true, !flagErr && flagRow?.enabled !== true, {
      detail: { present: Boolean(flagRow), enabled: flagRow?.enabled ?? null, error: flagErr?.message ?? null },
    }),
  );

  // ── 5. Zero delta across everything a lit path would have written ─────────
  const after = await snapshot(admin, agentId);
  out.push(
    probe('2842_no_webhook_dlq_rows_written', before.dlqCount, after.dlqCount, {
      detail: 'A dark webhook must not reach the DLQ — the unsigned delivery above would create a row if it did.',
    }),
  );
  out.push(
    probe('2842_no_revocation_tombstone_written', before.authorityCount, after.authorityCount, {
      detail: 'computeid_passport_authority is terminal and cross-org with no clearing path (migration 0448).',
    }),
  );
  out.push(
    probe('2842_no_recheck_cursor_row', 0, after.cursorRows, {
      detail: { rowId: RECHECK_CURSOR_ROW_ID, note: 'The cursor singleton is only written by a run that is not skipped.' },
    }),
  );
  out.push(
    probe('2842_bound_agent_unmutated', JSON.stringify({
      status: before.agent?.status ?? null,
      revoked_at: before.agent?.revoked_at ?? null,
      suspended_at: before.agent?.suspended_at ?? null,
      metadata: before.agent?.metadata ?? null,
    }), JSON.stringify({
      status: after.agent?.status ?? null,
      revoked_at: after.agent?.revoked_at ?? null,
      suspended_at: after.agent?.suspended_at ?? null,
      metadata: after.agent?.metadata ?? null,
    }), {
      detail: { agentId, seeded: Boolean(agentId) },
    }),
  );
  out.push(
    probe('2842_agent_api_keys_unmutated', JSON.stringify(before.keys), JSON.stringify(after.keys), {
      detail: 'Key enforcement is where access actually stops; a dark path must not touch is_active.',
    }),
  );

  return out;
}
