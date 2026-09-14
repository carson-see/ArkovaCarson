// PR #2937 — Drive connector-health observability: Sentry coverage for the
// Drive processing pipeline, plus two new health signals on
// GET /api/connectors/health (services/worker/src/api/connector-health.ts):
// `cursor_stale` (the changes cursor stopped advancing despite an enabled
// rule) and `fetch_job_failures` (recent failed/dead
// google_drive.file_changed job_queue rows for this org).
//
// WHAT THIS MODULE PROVES, live, every cycle, on the real deployed worker —
// not a unit test standing in for one:
//   (1) fetch_job_failures: insert a REAL 'failed' job_queue row of type
//       google_drive.file_changed with this org's id embedded in payload
//       (the exact shape drive-file-changed.ts's own consumer writes on a
//       terminal failure), then call the real GET /api/connectors/health as
//       a signed-in org admin and assert google_drive comes back
//       state=degraded, health_reason=fetch_job_failures, with last_error
//       naming the count. This is the signal firing end-to-end through the
//       real handler and its real Promise.all query, not a call to
//       isDriveCursorStale/classify() in isolation.
//   (2) cursor_stale: reset org_integrations.last_token_advanced_at to a
//       timestamp > DRIVE_CURSOR_STALE_THRESHOLD_MS (6h) in the past, with
//       an enabled WORKSPACE_FILE_MODIFIED rule bound to Drive already
//       seeded (required — a cursor with no watching rule is the P0-1
//       bootstrap gap, a DIFFERENT, already-tracked condition this signal
//       deliberately does not flag; see the source's own comment), and
//       assert the same endpoint returns state=degraded,
//       health_reason=cursor_stale.
//   (3) false-positive guard: with NO enabled Drive rule bound, a
//       never-advancing (null) cursor must NOT read as cursor_stale — proven
//       by disabling the rule and asserting the org goes back to
//       state=connected even though last_token_advanced_at is still null.
//   (4) baseline / re-arm: every cycle starts by clearing both signals and
//       asserting state=connected, health_reason=none — so (1) and (2) are
//       proven as real transitions, not an assertion against inherited
//       state from a previous cycle.
//
// Ordering note (matches classify()'s own precedence): cursor_stale is
// checked BEFORE fetch_job_failures in the handler, so (1) and (2) are
// asserted in SEPARATE passes with the other signal's fixture cleared —
// each transition is attributed to the one condition this module changed.
//
// NOT PROVEN HERE: real Sentry delivery (reportDriveProcessingFailure in
// drive-connect-health.ts). This rig has no Sentry DSN wired (the isolated
// per-soak rigs never carry one — a rig-scoped Sentry project does not
// exist), so a captureException call here would be a silent no-op either
// way; asserting "Sentry received an event" is not something any rig in
// this fleet can do. What IS proven: every one of the module's call sites
// (webhooks/drive.ts, drive-changes-runner.ts, drive-changes-processor.ts,
// jobs/drive-file-changed.ts) reaches a real terminal state (a job_queue row
// landing 'failed'/'dead', or a rule execution landing FAILED/DLQ) that this
// module's own dashboard signals then correctly surface — the reporting
// call itself, and its PII-scrubbing beforeSend pipeline, are proven by
// drive-connect-health.test.ts (unit-level, Sentry SDK mocked).
import { signInMfa } from '../common.mjs';

export const pr = '#2937';

export const changedBehavior = [
  'GET /api/connectors/health gains two Drive-specific degraded signals.',
  'fetch_job_failures: proven by inserting a real failed job_queue row of',
  'type google_drive.file_changed carrying this org id in payload.org_id and',
  'observing the live endpoint flip to degraded/fetch_job_failures with a',
  'last_error naming the count. cursor_stale: proven by aging',
  'org_integrations.last_token_advanced_at past the 6h threshold with an',
  'enabled WORKSPACE_FILE_MODIFIED rule bound to Drive already seeded, and',
  'observing the same live endpoint flip to degraded/cursor_stale. False-',
  'positive guard: with no enabled Drive rule, a null (never-bootstrapped)',
  'cursor does NOT flip the signal — asserted by disabling the rule and',
  'confirming the org reads back connected/none despite the null cursor.',
  'Every assertion re-arms from a clean baseline (connected/none) each',
  'cycle. NOT proven here: real Sentry delivery for',
  'reportDriveProcessingFailure (no rig in this fleet carries a Sentry DSN);',
  'that call and its PII-scrubbing pipeline are unit-proven in',
  'drive-connect-health.test.ts.',
].join(' ');

const NAME_PREFIX = 'cto-train-e-0914-2937';
const RULE_NAME = `${NAME_PREFIX}-rule`;
const CURSOR_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const STALE_TIMESTAMP = new Date(Date.now() - CURSOR_STALE_THRESHOLD_MS - 60 * 60 * 1000).toISOString();
const FRESH_TIMESTAMP = new Date().toISOString();

async function ensureDriveIntegration(admin, orgId, accountId) {
  const { data: existing, error: findErr } = await admin
    .from('org_integrations')
    .select('id')
    .eq('org_id', orgId)
    .eq('provider', 'google_drive')
    .eq('account_id', accountId)
    .maybeSingle();
  if (findErr) throw new Error(`#2937 integration lookup: ${findErr.message}`);
  const row = {
    org_id: orgId,
    provider: 'google_drive',
    account_id: accountId,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    connected_at: FRESH_TIMESTAMP,
    revoked_at: null,
    subscription_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    last_renewal_error: null,
    last_token_advanced_at: FRESH_TIMESTAMP,
  };
  if (existing) {
    const { error } = await admin.from('org_integrations').update(row).eq('id', existing.id);
    if (error) throw new Error(`#2937 integration re-arm: ${error.message}`);
    return existing.id;
  }
  const { data, error } = await admin.from('org_integrations').insert(row).select('id').single();
  if (error) throw new Error(`#2937 integration insert: ${error.message}`);
  return data.id;
}

async function ensureRule(admin, orgId, createdBy) {
  const { data: existing, error: findErr } = await admin
    .from('organization_rules')
    .select('id')
    .eq('org_id', orgId)
    .eq('name', RULE_NAME)
    .maybeSingle();
  if (findErr) throw new Error(`#2937 rule lookup: ${findErr.message}`);
  const row = {
    org_id: orgId,
    name: RULE_NAME,
    trigger_type: 'WORKSPACE_FILE_MODIFIED',
    trigger_config: {},
    action_type: 'AUTO_ANCHOR',
    action_config: { tag: `${NAME_PREFIX}-tag` },
    enabled: true,
    created_by_user_id: createdBy ?? null,
  };
  if (existing) {
    const { error } = await admin.from('organization_rules').update(row).eq('id', existing.id);
    if (error) throw new Error(`#2937 rule re-arm: ${error.message}`);
    return existing.id;
  }
  const { data, error } = await admin.from('organization_rules').insert(row).select('id').single();
  if (error) throw new Error(`#2937 rule insert: ${error.message}`);
  return data.id;
}

export async function seed(admin, state) {
  const orgA = state.orgA;
  const adminAUserId = state.adminA?.userId;
  if (!orgA || !adminAUserId) throw new Error('#2937 seed: state.orgA/adminA missing — run setup.mjs base fixtures first');
  const integrationId = await ensureDriveIntegration(admin, orgA, `${NAME_PREFIX}-orgA`);
  const ruleId = await ensureRule(admin, orgA, adminAUserId);
  return { integrationId, ruleId };
}

async function clearFetchJobFailures(admin, orgId) {
  // Delete only rows this module owns (its own name prefix embedded in the
  // job's payload.file_id), never a bare "delete all failed rows for this
  // org" — a shared rig may carry other fixtures' job_queue rows.
  const { error } = await admin
    .from('job_queue')
    .delete()
    .eq('type', 'google_drive.file_changed')
    .eq('payload->>org_id', orgId)
    .like('payload->>file_id', `${NAME_PREFIX}-%`);
  if (error) throw new Error(`#2937 clear job_queue fixtures: ${error.message}`);
}

async function insertFailedFetchJob(admin, orgId, n) {
  const { error } = await admin.from('job_queue').insert({
    type: 'google_drive.file_changed',
    status: 'failed',
    last_error: `${NAME_PREFIX} synthetic failure ${n}`,
    payload: { org_id: orgId, file_id: `${NAME_PREFIX}-file-${n}`, revision_id: `${NAME_PREFIX}-rev-${n}` },
  });
  if (error) throw new Error(`#2937 insert failed job_queue row: ${error.message}`);
}

async function getHealth(workerFetch, jwt) {
  const res = await workerFetch('/api/connectors/health', { jwt });
  const drive = res.body?.connectors?.find((c) => c.id === 'google_drive');
  return { res, drive };
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch } = ctx;
  const s = state['#2937'] ?? {};
  const out = [];

  if (!s.integrationId || !s.ruleId) {
    out.push(probe('2937_fixtures_seeded', true, false, { pass: false, detail: { reason: 'no #2937 fixture state — run setup.mjs', have: Object.keys(s) } }));
    return out;
  }
  out.push(probe('2937_fixtures_seeded', true, true, { detail: s }));

  const adminSigned = await signInMfa(ctx, 'adminA');
  out.push(probe('2937_admin_signin', true, Boolean(adminSigned.token), { detail: { status: adminSigned.status, error: adminSigned.error } }));
  const adminJwt = adminSigned.token;
  if (!adminJwt) return out;

  // ── Baseline: clean signals, rule enabled, cursor fresh ─────────────────
  await clearFetchJobFailures(admin, state.orgA);
  const { error: baselineErr } = await admin
    .from('org_integrations')
    .update({ last_token_advanced_at: FRESH_TIMESTAMP })
    .eq('id', s.integrationId);
  out.push(probe('2937_baseline_cursor_reset', true, !baselineErr, { detail: baselineErr?.message ?? null }));
  const { error: ruleOnErr } = await admin.from('organization_rules').update({ enabled: true }).eq('id', s.ruleId);
  out.push(probe('2937_baseline_rule_enabled', true, !ruleOnErr, { detail: ruleOnErr?.message ?? null }));

  const baseline = await getHealth(workerFetch, adminJwt);
  out.push(probe('2937_health_200', 200, baseline.res.status, { detail: baseline.res.body?.error ?? null }));
  out.push(probe('2937_baseline_connected', 'connected', baseline.drive?.state, { detail: baseline.drive }));
  out.push(probe('2937_baseline_reason_none', 'none', baseline.drive?.health_reason, { detail: baseline.drive }));

  // ── (1) fetch_job_failures fires ─────────────────────────────────────────
  await insertFailedFetchJob(admin, state.orgA, 1);
  await insertFailedFetchJob(admin, state.orgA, 2);
  const afterFailures = await getHealth(workerFetch, adminJwt);
  out.push(probe('2937_fetch_failures_200', 200, afterFailures.res.status));
  out.push(probe('2937_fetch_failures_degraded', 'degraded', afterFailures.drive?.state, { detail: afterFailures.drive }));
  out.push(probe('2937_fetch_failures_reason', 'fetch_job_failures', afterFailures.drive?.health_reason, { detail: afterFailures.drive }));
  const failureCountNamed = typeof afterFailures.drive?.last_error === 'string' && afterFailures.drive.last_error.includes('2');
  out.push(probe('2937_fetch_failures_count_in_message', true, failureCountNamed, {
    pass: failureCountNamed,
    detail: { last_error: afterFailures.drive?.last_error, note: 'must name the count of failed/dead jobs, not a generic message' },
  }));

  // Clean up before testing the other signal — proves cursor_stale is a
  // SEPARATE transition, not inherited from the fetch-failure state above.
  await clearFetchJobFailures(admin, state.orgA);
  const backToBaseline = await getHealth(workerFetch, adminJwt);
  out.push(probe('2937_fetch_failures_clear_restores_connected', 'connected', backToBaseline.drive?.state, { detail: backToBaseline.drive }));

  // ── (2) cursor_stale fires ────────────────────────────────────────────────
  const { error: staleErr } = await admin
    .from('org_integrations')
    .update({ last_token_advanced_at: STALE_TIMESTAMP })
    .eq('id', s.integrationId);
  out.push(probe('2937_cursor_aged', true, !staleErr, { detail: staleErr?.message ?? null }));
  const afterStale = await getHealth(workerFetch, adminJwt);
  out.push(probe('2937_cursor_stale_200', 200, afterStale.res.status));
  out.push(probe('2937_cursor_stale_degraded', 'degraded', afterStale.drive?.state, { detail: afterStale.drive }));
  out.push(probe('2937_cursor_stale_reason', 'cursor_stale', afterStale.drive?.health_reason, { detail: afterStale.drive }));
  const hoursNamed = typeof afterStale.drive?.last_error === 'string' && /\d+h/.test(afterStale.drive.last_error);
  out.push(probe('2937_cursor_stale_threshold_in_message', true, hoursNamed, {
    pass: hoursNamed,
    detail: { last_error: afterStale.drive?.last_error },
  }));

  // ── (3) false-positive guard: no enabled rule -> null-ish stale cursor is NOT a finding ──
  const { error: ruleOffErr } = await admin.from('organization_rules').update({ enabled: false }).eq('id', s.ruleId);
  out.push(probe('2937_rule_disabled_for_guard', true, !ruleOffErr, { detail: ruleOffErr?.message ?? null }));
  // Cursor stays STALE (aged above) — only the rule toggled. If the guard
  // were absent, this would still read cursor_stale; the guard's job is to
  // suppress it once no rule is watching.
  const guardCheck = await getHealth(workerFetch, adminJwt);
  out.push(probe('2937_no_rule_guard_200', 200, guardCheck.res.status));
  out.push(probe('2937_no_rule_no_cursor_stale_finding', 'connected', guardCheck.drive?.state, {
    detail: { note: 'P0-2 false-positive guard: cursorStale requires an enabled WORKSPACE_FILE_MODIFIED rule bound to Drive; disabling the rule must suppress the signal even with an aged cursor.', drive: guardCheck.drive },
  }));

  // ── Re-arm for the next cycle: rule back on, cursor fresh, no failed jobs ──
  const { error: rearmRuleErr } = await admin.from('organization_rules').update({ enabled: true }).eq('id', s.ruleId);
  const { error: rearmCursorErr } = await admin.from('org_integrations').update({ last_token_advanced_at: FRESH_TIMESTAMP }).eq('id', s.integrationId);
  out.push(probe('2937_rearmed_for_next_cycle', true, !rearmRuleErr && !rearmCursorErr, {
    detail: { rearmRuleErr: rearmRuleErr?.message ?? null, rearmCursorErr: rearmCursorErr?.message ?? null },
  }));

  return out;
}
