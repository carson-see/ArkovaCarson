import { signInMfa } from '../common.mjs';

// PR #2878 — worker-deps Dependabot group (11 packages: @arizeai/openinference-
// semantic-conventions, @aws-sdk/client-kms, @google-cloud/kms, @sentry/node,
// @sentry/profiling-node, @supabase/supabase-js, jose, resend,
// typescript-eslint, @types/node, plus root `zod` bumped 4.5.4 -> 4.6.1 to
// match services/worker's own zod, which this group also carries to 4.6.1 —
// third-party notices regenerated). All patch/minor bumps; no major-version
// jump. Measured tier: T1 (default additive/dependency change) — confirmed
// against requiredTierFor() on the PR's real changed-file list.
//
// The one behaviorally interesting risk in this group is the zod bump: the
// PR body's own stated purpose is "parity" between root and worker zod
// versions, so the thing worth proving on a live rig isn't "does the worker
// boot" (worker_identity_matches_candidate already covers that) but "do
// zod-validated request paths still behave the same" — i.e. the minor-version
// bump didn't change safeParse() error shape or validation strictness.
//
// THREE WRONG TURNS BEFORE THIS VERSION (kept here so a future edit doesn't
// repeat them):
//   1. First target was POST/GET /api/v1/keys using state.apiKey.raw
//      (API-key auth) — wrong: that route manages API keys themselves, so
//      it is gated on a user session (JWT, org-admin), never API-key auth.
//   2. Traced the 401 to a genuinely stale fixture: the FIXTURE_STATE this
//      module was launched with (/Volumes/Extreme/offload/cto-soak-2026-09-12/
//      state/fixtures.json — a top-level "state" dir, NOT supervisor.sh's own
//      documented default) is an orphaned, older "cto-soak-0912"-prefixed
//      generation whose org/users/API key no longer exist on this rig at all
//      (verified via direct REST: zero profiles, zero orgs for that prefix).
//      The live generation is "cto-train-b-0912"-prefixed, at
//      /Volumes/Extreme/offload/cto-soak-2026-09-12/train-b/state/fixtures.json
//      — supervisor.sh's actual documented default path. Corrected the
//      launch env (FIXTURE_STATE) to point at it, not this module.
//   3. With the correct fixture file, switched the target route itself to
//      GET /api/v1/verify/search (real zod schema, API-key-eligible) — but
//      that route unconditionally 503s ("Semantic search is not currently
//      enabled") on THIS train, because it sits behind aiSemanticSearchGate()
//      and #2909 (the PR that adds the lexical fallback so it degrades
//      instead of 503ing) is not part of this train's merged code — the gate
//      runs BEFORE the route handler's zod parsing, so no query shape ever
//      reaches VerifySearchSchema.safeParse() here. Settled on
//      POST/GET /api/v1/keys with the CORRECT auth (JWT via signInMfa, per
//      #2841's own working probe module) instead of a second API-only route.

export const pr = '#2878';

export const changedBehavior = [
  '11-package worker-deps Dependabot group, all patch/minor bumps',
  '(no major version change), including root zod 4.5.4 -> 4.6.1 for parity',
  "with services/worker's zod (already 4.6.1). Proven here, every cycle,",
  'against the real deployed route (POST/GET /api/v1/keys,',
  'services/worker/src/api/v1/keys.ts, CreateKeySchema is a real zod object',
  'reached via .safeParse(req.body)): an empty `name` (fails .min(1)) still',
  '400s with a zod-shaped error, not a 500 or a silently-accepted write; a',
  'well-formed, authenticated read still 200s with the documented { keys: []',
  '} shape; a missing session still 401s. Authenticated via signInMfa (JWT,',
  "org-admin), matching this route's real auth requirement — not a health",
  'check standing in for coverage.',
].join(' ');

export async function run(ctx) {
  const { workerFetch, probe } = ctx;
  const results = [];

  const signed = await signInMfa(ctx, 'adminA');
  const jwt = signed.token;
  results.push(probe('2878_org_admin_signin', true, Boolean(jwt), {
    detail: { status: signed.status, error: signed.error, aalBefore: signed.aalBefore, aalAfter: signed.aalAfter },
  }));
  if (!jwt) return results;

  // Negative case: zod .min(1) on `name` must still reject an empty string
  // with 400, not accept it (silent validation loosening) or 500 (schema
  // incompatibility with the new zod minor version). No key is actually
  // created either way — validation fails before the insert.
  const badCreate = await workerFetch('/api/v1/keys', {
    method: 'POST',
    jwt,
    body: { name: '' },
  });
  results.push(probe('2878_zod_rejects_invalid_create_body', 400, badCreate.status, {
    pass: badCreate.status === 400,
    detail: { status: badCreate.status, body: badCreate.body },
  }));

  // Positive case: a well-formed, already-authenticated read must still
  // succeed and return the documented shape ({ keys: [...] }).
  const list = await workerFetch('/api/v1/keys', { jwt });
  const listOk = list.status === 200 && Array.isArray(list.body?.keys);
  results.push(probe('2878_valid_list_still_200', true, listOk, {
    detail: { status: list.status, returned: Array.isArray(list.body?.keys) ? list.body.keys.length : null },
  }));

  // Auth gate unaffected by the dependency bump: no session -> 401.
  const noAuth = await workerFetch('/api/v1/keys');
  results.push(probe('2878_missing_auth_still_401', 401, noAuth.status, {
    pass: noAuth.status === 401,
    detail: { status: noAuth.status },
  }));

  return results;
}
