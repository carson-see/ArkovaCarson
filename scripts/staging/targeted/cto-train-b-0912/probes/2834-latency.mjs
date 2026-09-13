// PR #2834 — carry AI_EXTRACTION_LATENCY_BUDGET_MS=15000 into the deploy env
// (and onto staging rigs) so it survives a redeploy.
//
// This PR's entire content is a deployed env var, so the probe has to assert
// two different things that are easy to conflate:
//
//   (a) CONFIG — the serving revision actually carries the value. `gcloud run
//       deploy --set-env-vars` is authoritative (it replaces the whole set), so
//       a revision missing the var silently runs the 4500 ms code default in
//       services/worker/src/api/v1/ai-extract.ts. That is the regression the PR
//       exists to prevent, and it is invisible from any HTTP response.
//   (b) BEHAVIOR — a real extraction completes inside the budget instead of
//       degrading to the heuristic `fast-fallback` stub. Every prod extraction
//       since July hit the 4500 default and degraded, while real Gemini calls
//       measured 3.7-10.2 s.
//
// (b) is only meaningful against a REAL provider. On a mock/unreachable
// provider every call degrades for reasons that have nothing to do with the
// budget, so `2834_provider_is_gemini` would fail for the wrong reason. The
// config assertions are therefore unconditional, and the behavioral assertion
// is paired with `2834_zero_latency_budget_exceeded_this_cycle`, which is the
// discriminator that actually names the 4500-ms failure mode: the route writes
// `error_message = 'provider latency budget was exceeded'` to ai_usage_events
// on exactly that timeout and nothing else does.
//
// Two spec corrections, same as #2837 and for the same reasons:
//   1. /api/v1/ai/extract is JWT-ONLY — `requireAuth` rejects `Bearer ak_` with
//      401 before the route. Org A is authenticated with a GoTrue password
//      grant, not state.apiKey.
//   2. The EFF-1 result cache is keyed on `fingerprint` and returns
//      `provider:'cache'` before the provider is ever called. A reused
//      fingerprint would make `provider === 'gemini'` unreachable, so the
//      request below uses a fresh random 64-hex fingerprint.
import { execFileSync } from 'node:child_process';
import { SERVICE, REGION } from '../common.mjs';

export const pr = '#2834';

export const changedBehavior = [
  'AI_EXTRACTION_LATENCY_BUDGET_MS=15000 is now carried in deploy-worker.yml',
  "--set-env-vars (and in scripts/staging/deploy.sh + provision-isolated-rig.sh's",
  'BASE_ENV_VARS), so it survives a redeploy instead of reverting to the 4500 ms',
  'code default in api/v1/ai-extract.ts. At 4500 ms every real Gemini extraction',
  '(measured 3.7-10.2 s) overran the budget and was served from the heuristic',
  'fast-fallback stub with error_message "provider latency budget was exceeded"',
  'and its credit refunded. No code path changed — only the deployed value.',
].join(' ');

const EXPECTED_BUDGET_MS = '15000';
const EXPECTED_PROVIDER = 'gemini';
const LATENCY_ERROR_MESSAGE = 'provider latency budget was exceeded';

function freshFingerprint() {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return s.slice(0, 64);
}

async function signIn(supabaseUrl, anonKey, email, password) {
  const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, token: body?.access_token ?? null, error: body?.error_description ?? body?.msg ?? null };
}

function gcloudJson(args) {
  return JSON.parse(execFileSync('gcloud', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}

function envMapFromContainer(container) {
  const entries = container?.env ?? [];
  const map = {};
  for (const e of entries) if (e && typeof e.name === 'string' && 'value' in e) map[e.name] = e.value;
  return map;
}

/**
 * Read the env of the revision that actually SERVES traffic, not just the
 * service's latest template. They diverge whenever a deploy landed with
 * --no-traffic (which this repo's deploy-worker.yml does on purpose), and the
 * template would then describe a revision nobody is talking to.
 */
function readServingEnv() {
  const svc = gcloudJson(['run', 'services', 'describe', SERVICE, '--region', REGION, '--project', 'arkova1', '--format', 'json']);
  const serving = svc.status?.traffic?.find((t) => t.percent === 100)?.revisionName
    ?? svc.status?.latestReadyRevisionName
    ?? null;
  const templateEnv = envMapFromContainer(svc.spec?.template?.spec?.containers?.[0]);
  let revisionEnv = null;
  let revisionError = null;
  if (serving) {
    try {
      const rev = gcloudJson(['run', 'revisions', 'describe', serving, '--region', REGION, '--project', 'arkova1', '--format', 'json']);
      revisionEnv = envMapFromContainer(rev.spec?.containers?.[0]);
    } catch (e) { revisionError = String(e && e.message ? e.message : e); }
  }
  return { serving, templateEnv, revisionEnv, revisionError, env: revisionEnv ?? templateEnv, source: revisionEnv ? 'serving-revision' : 'service-template' };
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch, ANON_KEY, SUPABASE_URL } = ctx;
  const cycleStart = new Date().toISOString();
  const out = [];

  // ── 1. Config: the serving revision carries the budget ───────────────────
  let cfg = null;
  let cfgError = null;
  try { cfg = readServingEnv(); } catch (e) { cfgError = String(e && e.stack ? e.stack : e); }
  out.push(probe('2834_revision_env_readable', true, Boolean(cfg && cfg.env), {
    detail: { error: cfgError, serving: cfg?.serving ?? null, source: cfg?.source ?? null, revisionError: cfg?.revisionError ?? null },
  }));
  if (!cfg?.env) return out;

  out.push(probe('2834_latency_budget_env_is_15000', EXPECTED_BUDGET_MS, cfg.env.AI_EXTRACTION_LATENCY_BUDGET_MS ?? null, {
    detail: {
      serving: cfg.serving,
      source: cfg.source,
      note: 'Absent means the revision runs the 4500 ms code default — the exact redeploy regression this PR prevents.',
    },
  }));
  out.push(probe('2834_ai_provider_env_is_gemini', EXPECTED_PROVIDER, cfg.env.AI_PROVIDER ?? null, {
    detail: 'A mock provider makes the behavioral assertion below meaningless, so it is pinned as config.',
  }));
  out.push(probe('2834_ai_extraction_enabled', 'true', cfg.env.ENABLE_AI_EXTRACTION ?? null, {
    detail: 'The route is behind aiExtractionGate(); with this off every probe below 503s for an unrelated reason.',
  }));
  // The template and the serving revision disagreeing is how a --no-traffic
  // deploy silently looks correct while prod runs something else.
  if (cfg.revisionEnv) {
    out.push(probe('2834_template_matches_serving_revision',
      cfg.templateEnv.AI_EXTRACTION_LATENCY_BUDGET_MS ?? null,
      cfg.revisionEnv.AI_EXTRACTION_LATENCY_BUDGET_MS ?? null,
      { detail: 'Divergence means the next promote changes the budget without any deploy touching it.' }));
  }

  // ── 2. Behavior: a real extraction completes inside the budget ───────────
  const email = state.adminA?.email;
  const { status: authStatus, token: jwt, error: authError } = email
    ? await signIn(SUPABASE_URL, ANON_KEY, email, state.password)
    : { status: 0, token: null, error: 'state.adminA missing' };
  out.push(probe('2834_org_a_jwt_acquired', true, Boolean(jwt), { detail: { authStatus, error: authError, email: email ?? null } }));
  if (!jwt) return out;

  const t0 = Date.now();
  const res = await workerFetch('/api/v1/ai/extract', {
    method: 'POST',
    jwt,
    body: {
      strippedText:
        'DIPLOMA. The Board of Regents confers upon the named graduate the degree of '
        + 'Master of Science in Information Management, awarded 15 May 2026, with all '
        + 'rights and privileges appertaining thereto. Registrar reference BR-2026-88412.',
      credentialType: 'diploma',
      fingerprint: freshFingerprint(),
      issuerHint: 'Board of Regents',
    },
  });
  const elapsedMs = Date.now() - t0;

  out.push(probe('2834_extract_status_200', 200, res.status, {
    detail: { error: res.body?.error ?? null, elapsedMs },
  }));
  out.push(probe('2834_provider_is_gemini', EXPECTED_PROVIDER, res.body?.provider ?? null, {
    detail: {
      elapsedMs,
      degraded: res.body?.degraded ?? null,
      fallbackReason: res.body?.fallbackReason ?? null,
      note: "'fast-fallback' is the 4500-ms regression shape; 'cache' would mean the fingerprint was not fresh.",
    },
  }));
  out.push(probe('2834_not_fast_fallback', true, res.body?.provider !== 'fast-fallback', {
    detail: { provider: res.body?.provider ?? null, fallbackReason: res.body?.fallbackReason ?? null },
  }));
  out.push(probe('2834_not_degraded', false, res.body?.degraded ?? null, {
    detail: 'A degraded response refunds the credit and serves the heuristic stub.',
  }));
  // Sanity on the measurement itself: a call that returned in under a second
  // did not exercise the budget at all (mock provider, or a cache hit).
  out.push(probe('2834_call_exercised_a_real_provider', true, elapsedMs >= 500, {
    detail: { elapsedMs, note: 'Sub-500ms means no real model call happened — the behavioral assertions above are then vacuous.' },
  }));

  // ── 3. DB delta: nothing timed out on the budget this cycle ──────────────
  // `error_message = 'provider latency budget was exceeded'` is written by
  // exactly one branch (the ExtractionLatencyError catch in ai-extract.ts), so a
  // zero count over this cycle's window is a direct statement about the budget.
  const { count: latencyFailures, error: countErr } = await admin
    .from('ai_usage_events')
    .select('id', { count: 'exact', head: true })
    .eq('error_message', LATENCY_ERROR_MESSAGE)
    .gte('created_at', cycleStart);
  out.push(probe('2834_usage_events_readable', true, !countErr, { detail: countErr?.message ?? null }));
  out.push(probe('2834_zero_latency_budget_exceeded_this_cycle', 0, latencyFailures ?? null, {
    detail: { since: cycleStart, note: 'Any row here is a budget overrun — the 4500-ms failure mode, regardless of which org produced it.' },
  }));

  return out;
}
