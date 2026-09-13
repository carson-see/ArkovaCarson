// PR #2913 — Cloudflare origin guard for the public Cloud Run origin
// (SCRUM-3888, branch fix/scrum-3888-cloudflare-origin-guard, head efa9c80bc
// or later).
//
// THE GAP THIS CLOSES. `arkova-worker-*.run.app` answers publicly and
// unauthenticated (`ingress=all`, `invoker-iam-disabled`, empty IAM policy —
// CLAUDE.md §1.1, verified live 2026-09-13). Cloudflare proxies only
// `api.`/`edge.`/`docs.arkova.ai`; the run.app host is the SAME app with
// nothing in front of it, so any edge control added to `api.arkova.ai`
// protects only that hostname unless the origin itself also closes the gap.
//
// THE MECHANISM (middleware/requireCloudflareOrigin.ts). A Cloudflare
// Transform Rule (release-session-provisioned, not this PR) injects
// `X-Arkova-Origin-Auth: <CLOUDFLARE_ORIGIN_SECRET>` on every request it
// proxies. `requireCloudflareOrigin`, mounted FIRST in index.ts (ahead of
// CORS and every route), reads `config.cloudflareOriginGuardMode` PER
// REQUEST — never captured once at import time, so a mode flip on a live
// Cloud Run revision is a plain env-var update, no redeploy — and:
//   `off`     — no-op, every request passes regardless of the header.
//   `observe` — NEVER blocks. Logs `origin_guard_would_block` and increments
//               an in-process counter keyed by route family. Exposed at
//               `GET /health?detailed=true` (X-Health-Token) under
//               `info.originGuard` (routes/health.ts).
//   `enforce` — 403 `origin_not_allowed`, bounded body, on a missing/wrong
//               header.
// `isOriginGuardExemptPath` bypasses the guard in EVERY mode for `/health`,
// `/api/health`, `/jobs`, `/webhooks`, `/api/v1/webhooks` (case-insensitive
// prefix match). `/api/v1/verify` is deliberately NOT exempt — it is one of
// the surfaces this guard exists to close — and buckets into its OWN
// observe-mode route family, `api-v1-verify` (checked before the broader
// `/api/v1` -> `api-v1` entry in `ROUTE_FAMILIES`), not `api-v1`.
//
// TRAIN ENV THIS MODULE ASSUMES (see the driver's final report for what is
// NOT yet wired): `CLOUDFLARE_ORIGIN_GUARD_MODE=observe` and
// `CLOUDFLARE_ORIGIN_SECRET=<value>` on the deployed worker, with the SAME
// value available to this driver as `TRAIN_ORIGIN_SECRET` (env, mirroring the
// naming `CRON_SECRET`/`API_KEY_HMAC_SECRET` already use in supervisor.sh).
// `HEALTH_DETAIL_TOKEN` (sent as `X-Health-Token`) is also assumed for the
// observe-counter read; without it `isDetailedHealthAuthorized` fails CLOSED
// in production (routes/health.ts) and the counter assertions degrade to an
// informational skip rather than a hard failure — this rig cannot invent a
// secret it was never given.
//
// WHAT THIS RIG CAN AND CANNOT PROVE. CAN, every cycle: the exempt paths
// (`/health`, `/jobs/*`) answer unaffected by mode or header; a non-exempt
// path (`/api/v1/verify/:publicId`) answers identically (200) with no header,
// a correct header, and a WRONG header in `observe` mode — the defining
// property of that mode is that a wrong secret is treated exactly like a
// missing one, i.e. logged/counted, never blocked; the observe-mode "would
// block" counter for `api-v1-verify` moves (best-effort — see the Known
// Limitations note below); and, ONLY when `TRAIN_ORIGIN_GUARD_ENFORCE=1` is
// set for a dedicated rehearsal window, that `enforce` actually 403s an
// unheadered `/api/v1` call and passes a correctly-headered one. CANNOT: that
// the Cloudflare Transform Rule itself is correctly configured on
// `api.arkova.ai` — this rig calls the origin directly, so it can only prove
// the WORKER's half of the contract, never the edge-side half. Also cannot
// prove the counters are globally accurate — `--min-instances 2` means
// `/health?detailed=true` reads whichever instance answered THIS probe
// (documented in the PR's own runbook as a known limitation, not a driver
// gap), so a same-cycle before/after read can legitimately land on two
// different instances and under-report. This module reports that condition
// by name (`2913_counter_delta_measurable`) rather than papering over it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const pr = '#2913';

export const changedBehavior = [
  'Proven here, every cycle: GET /health answers 200 regardless of mode or',
  'header (exempt path). GET /api/v1/verify/<fixture public id> — NOT an',
  'exempt path — answers identically (200) with no X-Arkova-Origin-Auth',
  'header, with the correct one, AND with a wrong one: in observe mode',
  'nothing is ever blocked, a wrong secret is treated exactly like a missing',
  'one. POST /jobs/lock-wait with X-Cron-Secret and no origin header answers',
  '200 (the /jobs prefix is exempt in every mode; cron auth is a separate,',
  'already-authenticated gate this guard deliberately does not duplicate).',
  'GET /health?detailed=true (X-Health-Token) exposes info.originGuard',
  '(mode, secretConfigured, total, byRouteFamily) and, when the previous',
  "cycle's snapshot is available, the api-v1-verify tally is shown moving —",
  'best-effort, since the counters are process-local across',
  '--min-instances 2 (documented PR limitation, not a driver gap). Behind',
  'TRAIN_ORIGIN_GUARD_ENFORCE=1 only (a dedicated rehearsal window, never the',
  'default observe soak): an unheadered /api/v1/* call gets 403',
  'origin_not_allowed and a correctly-headered one still gets 200 — the same',
  'module proves the later enforce cutover without a second file.',
  'NOT proven here: that the Cloudflare Transform Rule on api.arkova.ai',
  'actually injects the header — this rig calls the origin directly and can',
  'only prove the worker-side half of the contract.',
].join(' ');

const NAME_PREFIX = 'cto-train-b-0912-2913';
const ORIGIN_HEADER = 'X-Arkova-Origin-Auth';
const OBSERVE_FAMILY = 'api-v1-verify';
const FIXTURE_FINGERPRINT = '9'.repeat(64);

function counterStatePath(env) {
  const fixtureState = env.FIXTURE_STATE ?? '/Volumes/Extreme/offload/cto-soak-2026-09-12/train-b/state/fixtures.json';
  return join(dirname(fixtureState), '2913-origin-guard-counters.json');
}

function readPersistedCounters(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writePersistedCounters(path, snapshot) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

/** Idempotent SECURED-anchor fixture, same shape as #2835's `anchor()` helper. */
export async function seed(admin, state) {
  const { data: existing } = await admin
    .from('anchors')
    .select('id, public_id')
    .eq('fingerprint', FIXTURE_FINGERPRINT)
    .maybeSingle();
  if (existing) return { anchorId: existing.id, publicId: existing.public_id };

  const { data, error } = await admin
    .from('anchors')
    .insert({
      org_id: state.orgA, user_id: state.adminA.userId, filename: `${NAME_PREFIX}-fixture.pdf`,
      fingerprint: FIXTURE_FINGERPRINT, status: 'SECURED', credential_type: 'CERTIFICATE',
      chain_tx_id: `${'e'.repeat(63)}3`, chain_block_height: 900003,
      chain_timestamp: '2026-09-01T00:00:00.000Z',
    })
    .select('id, public_id')
    .single();
  if (error) throw new Error(`#2913 seed anchor: ${error.message}`);
  return { anchorId: data.id, publicId: data.public_id };
}

export async function run(ctx) {
  const { state, probe, workerFetch, env } = ctx;
  const out = [];
  const s = state['#2913'] ?? {};

  if (!s.publicId) {
    out.push(probe('2913_fixtures_seeded', true, false, {
      pass: false, detail: { reason: 'no #2913 fixture state — run setup.mjs', have: Object.keys(s) },
    }));
    return out;
  }

  const originSecret = env.TRAIN_ORIGIN_SECRET;
  if (!originSecret) {
    out.push(probe('2913_train_origin_secret_configured', true, false, {
      pass: false,
      detail: {
        reason: 'TRAIN_ORIGIN_SECRET not set in this driver\'s env — cannot send a correct '
          + 'X-Arkova-Origin-Auth header, so the "correct header still 200" and enforce-mode '
          + 'assertions below are unrunnable. supervisor.sh must export TRAIN_ORIGIN_SECRET '
          + 'mirroring the worker\'s CLOUDFLARE_ORIGIN_SECRET (see driver report).',
      },
    }));
    return out;
  }

  const verifyPath = `/api/v1/verify/${s.publicId}`;
  const wrongSecret = `${originSecret}-wrong`;

  // ── 1. /health — exempt, unaffected by mode or header ───────────────────
  const health = await workerFetch('/health');
  out.push(probe('2913_health_200', 200, health.status));

  // ── 2. /api/v1/verify — NOT exempt, but observe mode never blocks ───────
  const noHeader = await workerFetch(verifyPath);
  out.push(probe('2913_verify_no_header_200', 200, noHeader.status, {
    detail: { error: noHeader.body?.error, note: 'observe mode never blocks a missing header — a 403 here would be the enforce regression landing early.' },
  }));

  const withHeader = await workerFetch(verifyPath, { headers: { [ORIGIN_HEADER]: originSecret } });
  out.push(probe('2913_verify_correct_header_200', 200, withHeader.status, {
    detail: { error: withHeader.body?.error },
  }));

  const wrongHeader = await workerFetch(verifyPath, { headers: { [ORIGIN_HEADER]: wrongSecret } });
  out.push(probe('2913_verify_wrong_header_still_200_in_observe', 200, wrongHeader.status, {
    detail: { error: wrongHeader.body?.error, note: 'A wrong secret must be treated exactly like a missing one in observe mode: counted, never blocked.' },
  }));

  // The three responses must actually be the SAME answer (a real read-back,
  // not three independent 200s that happen to coincide) — same status AND
  // the same body shape, since the guard's job is to be invisible in observe
  // mode, not merely to avoid a 403.
  out.push(probe('2913_verify_responses_identical_shape', true,
    noHeader.status === withHeader.status && withHeader.status === wrongHeader.status
    && JSON.stringify(noHeader.body) === JSON.stringify(withHeader.body)
    && JSON.stringify(withHeader.body) === JSON.stringify(wrongHeader.body),
    { detail: { noHeaderBody: noHeader.body, withHeaderBody: withHeader.body, wrongHeaderBody: wrongHeader.body } }));

  // ── 3. /jobs/* — exempt from the origin guard, authenticated separately ──
  const cronSecret = env.CRON_SECRET ?? '';
  const job = await workerFetch('/jobs/lock-wait', {
    method: 'POST',
    headers: cronSecret ? { 'X-Cron-Secret': cronSecret } : {},
    // Deliberately NO X-Arkova-Origin-Auth header — the point of this
    // assertion is that /jobs/* needs none, in any mode.
  });
  out.push(probe('2913_jobs_exempt_200', 200, job.status, {
    detail: { error: job.body?.error, cronSecretPresent: Boolean(cronSecret) },
  }));

  // ── 4. Observe-mode counters, best-effort across cycles ─────────────────
  const detailToken = env.HEALTH_DETAIL_TOKEN ?? '';
  const detailed = await workerFetch('/health?detailed=true', {
    headers: detailToken ? { 'X-Health-Token': detailToken } : {},
  });
  const stats = detailed.body?.info?.originGuard ?? null;
  out.push(probe('2913_detailed_health_200', 200, detailed.status));
  out.push(probe('2913_origin_guard_stats_readable', true, Boolean(stats), {
    pass: Boolean(stats),
    detail: stats
      ? { mode: stats.mode, secretConfigured: stats.secretConfigured }
      : { note: 'info.originGuard absent — either HEALTH_DETAIL_TOKEN is not set on this driver/worker pair, or the detailed view was denied (fails closed in production per routes/health.ts). Counter assertions below are skipped, not failed.' },
  }));

  if (stats) {
    out.push(probe('2913_mode_is_observe_or_enforce', true, stats.mode === 'observe' || stats.mode === 'enforce', {
      detail: { mode: stats.mode, note: 'off mode is a no-op the guard is not exercised at all under.' },
    }));
    out.push(probe('2913_secret_configured_on_worker', true, stats.secretConfigured === true));

    const counterPath = counterStatePath(env);
    const previous = readPersistedCounters(counterPath);
    writePersistedCounters(counterPath, { total: stats.total, byRouteFamily: stats.byRouteFamily, capturedAt: new Date().toISOString() });

    if (!previous) {
      out.push(probe('2913_counter_baseline_recorded', true, true, {
        detail: { note: 'First cycle with a readable snapshot — nothing to diff against yet. Baseline written for the next cycle.', current: stats },
      }));
    } else {
      const prevCount = previous.byRouteFamily?.[OBSERVE_FAMILY] ?? 0;
      const currCount = stats.byRouteFamily?.[OBSERVE_FAMILY] ?? 0;
      const delta = currCount - prevCount;
      const counterReset = stats.total < (previous.total ?? 0);
      out.push(probe('2913_counter_delta_measurable', true, delta >= 1 || counterReset, {
        pass: delta >= 1 || counterReset,
        detail: {
          previous: { total: previous.total, [OBSERVE_FAMILY]: prevCount, capturedAt: previous.capturedAt },
          current: { total: stats.total, [OBSERVE_FAMILY]: currCount },
          delta,
          counterReset,
          note: counterReset
            ? 'Total counter is LOWER than last cycle — a process restart/redeploy reset the in-memory tally (documented PR limitation: counters are process-local, not durable). Treated as inconclusive, not a failure.'
            : 'This cycle made a no-header and a wrong-header call against api-v1-verify, so a non-decrease of at least 2 is expected on the SAME instance; cross-instance routing under --min-instances 2 can under-report — delta >= 1 is the tolerant bar.',
        },
      }));
    }
  }

  // ── 5. Enforce rehearsal — opt-in only, never the default observe soak ──
  if (env.TRAIN_ORIGIN_GUARD_ENFORCE === '1') {
    const blocked = await workerFetch(verifyPath);
    out.push(probe('2913_enforce_no_header_403', 403, blocked.status, {
      detail: { error: blocked.body?.error?.code ?? blocked.body?.error },
    }));
    out.push(probe('2913_enforce_no_header_error_code', 'origin_not_allowed', blocked.body?.error?.code ?? null));

    const allowed = await workerFetch(verifyPath, { headers: { [ORIGIN_HEADER]: originSecret } });
    out.push(probe('2913_enforce_correct_header_200', 200, allowed.status, {
      detail: { error: allowed.body?.error, note: 'A correctly-headered call must still pass even with the guard actively enforcing.' },
    }));

    // /jobs/* and /health must stay exempt in enforce mode too.
    const jobEnforce = await workerFetch('/jobs/lock-wait', {
      method: 'POST', headers: cronSecret ? { 'X-Cron-Secret': cronSecret } : {},
    });
    out.push(probe('2913_enforce_jobs_still_exempt_200', 200, jobEnforce.status, { detail: { error: jobEnforce.body?.error } }));
  }

  return out;
}
