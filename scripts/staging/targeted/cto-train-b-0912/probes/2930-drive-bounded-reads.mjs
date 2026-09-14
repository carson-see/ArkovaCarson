// PR #2930 — bound every Google Drive response-body read (F-D0-5,
// memory/feedback_bounded_body_reads.md). services/worker/src/integrations/
// oauth/drive.ts's readDriveJson() wraps every `res.json()` call in the file
// (exchangeCode, refreshAccessToken, createChangesWatch, stopDriveChannel,
// revokeOAuthToken, getFileMetadata, listChanges, getSharedDriveName) with a
// DRIVE_BODY_READ_TIMEOUT_MS=10_000 deadline via readJsonBounded — a PARKED
// body (headers received, body trickling or silent) now surfaces as a
// bounded DriveApiError 408 instead of hanging the caller forever, which is
// exactly the failure shape that disabled SUBMITTED->SECURED promotion for
// every tenant for 35+ minutes on 2026-08-12 (a different cron, same class
// of bug this PR closes for Drive).
//
// WHAT THIS RIG CAN AND CANNOT PROVE, stated as plainly as #2846/#2912's
// modules state their own limits.
//
// NOT PROVEN HERE: the timeout actually firing (a body that parks past 10s).
// Forcing that needs control over the REMOTE endpoint's response timing.
// Every reader this PR touches calls a REAL Google endpoint
// (oauth2.googleapis.com, www.googleapis.com/drive/v3) with no test seam at
// the HTTP layer in production — `fetchImpl` is only swappable in tests.
// This rig also holds no real Google OAuth grant (SCRUM-5082, the same gap
// #2846's and #2912's modules document), so even a real-credential call
// cannot be driven from here. The one live-reachable single-org trigger for
// this code (the OAuth callback's `exchangeCode` call) requires a correctly
// HMAC-signed `state` parameter minted with a server-only secret
// (INTEGRATION_STATE_HMAC_SECRET) this probe has no way to construct — and
// the one trigger that needs no signed state, `POST /cron/drive-
// subscription-renewal`, fans out over EVERY org on the rig with an
// expiring subscription (runDriveSubscriptionRenewal), which is the exact
// "do not force a rig-wide cron from a single PR's probe" line #2846's
// module already drew for a DIFFERENT rig-wide drain. The actual timeout
// mechanism (a body stream that never resolves, driven by an injected fake
// reader) is proven by services/worker/src/integrations/oauth/drive-body-
// timeout.test.ts — 229 assertions across all eight call sites, including
// the malformed-body degrade-to-null path and the getSharedDriveName
// cosmetic-fallback path — run locally against this train's merged head
// before launch (see the RC manifest's ci_summary for #2930).
//
// PROVEN HERE instead: a liveness/latency-floor smoke check that the code
// path this PR touches is deployed and does not regress the fast/normal
// case. GET /api/v1/integrations/google_drive/oauth/callback with a
// deliberately INVALID `state` parameter fails the state-signature check
// BEFORE reaching exchangeCode (readDriveJson is never called on this path),
// but the request must still resolve promptly — proving the callback route
// itself is live, mounted, and returns a real bounded response rather than
// hanging on this deployed revision. This is a floor check on the request
// pipeline, not a proof of DRIVE_BODY_READ_TIMEOUT_MS; it would pass
// identically whether or not this PR's change was present, which is exactly
// why it is not conflated with the real proof above.
export const pr = '#2930';

export const changedBehavior = [
  'services/worker/src/integrations/oauth/drive.ts wraps every Drive API',
  'res.json() read (8 call sites) in a DRIVE_BODY_READ_TIMEOUT_MS=10s',
  'deadline (readJsonBounded); a parked body now surfaces as a bounded',
  'DriveApiError 408 instead of hanging the caller indefinitely (the same',
  'failure class that disabled SUBMITTED->SECURED promotion for 35+ minutes',
  'on 2026-08-12, for a different cron). NOT provable on this or any current',
  'rig: this rig holds no real Google OAuth grant (SCRUM-5082) and has no',
  'safe single-org trigger for the code path (exchangeCode needs an HMAC-',
  'signed state this probe cannot construct; the one no-state trigger,',
  'POST /cron/drive-subscription-renewal, fans out over every org on the rig',
  'and is out of scope for a single PR probe, same line #2846 already drew',
  'for a different rig-wide drain). The timeout mechanism itself is unit-',
  'proven: 229 assertions in drive-body-timeout.test.ts across all eight',
  'call sites, run locally against this train’s merged head before launch.',
  'This module instead runs a liveness/latency-floor smoke check on the',
  'OAuth callback route (invalid-state path, which never reaches',
  'readDriveJson) proving the route is live and responds promptly on this',
  'revision — explicitly NOT asserted as coverage of the bounded-read fix',
  'itself.',
].join(' ');

const CALLBACK_PATH = '/api/v1/integrations/google_drive/oauth/callback';
const LATENCY_FLOOR_MS = 10_000; // same bound the fix itself uses, for scale — not the same code path.

export async function seed() {
  return { ok: true };
}

export async function run(ctx) {
  const { probe, workerFetch, state } = ctx;
  const out = [];

  if (!state.orgA) {
    out.push(probe('2930_fixtures_seeded', true, false, { pass: false, detail: { reason: 'no base fixture state — run setup.mjs' } }));
    return out;
  }

  // Deliberately garbage state/code — must fail the signature check before
  // ever reaching exchangeCode/readDriveJson, and must do so promptly.
  const t0 = Date.now();
  const res = await workerFetch(`${CALLBACK_PATH}?code=${encodeURIComponent('2930-probe-not-a-real-code')}&state=${encodeURIComponent('2930-probe-not-a-real-signed-state')}`);
  const elapsedMs = Date.now() - t0;

  out.push(probe('2930_callback_route_live', true, res.status !== 0, {
    pass: res.status !== 0,
    detail: { status: res.status, note: 'status 0 means the request itself failed/aborted client-side (network/DNS), not a worker response' },
  }));
  out.push(probe('2930_callback_rejects_invalid_state', true, res.status >= 300 && res.status < 500, {
    pass: res.status >= 300 && res.status < 500,
    detail: { status: res.status, body: res.body, note: 'an invalid/unsigned state must be rejected (redirect or 4xx), never a 2xx' },
  }));
  out.push(probe('2930_callback_resolves_within_latency_floor', true, elapsedMs < LATENCY_FLOOR_MS, {
    pass: elapsedMs < LATENCY_FLOOR_MS,
    detail: { elapsedMs, floorMs: LATENCY_FLOOR_MS, note: 'liveness floor only — this path never reaches readDriveJson, so this does not exercise DRIVE_BODY_READ_TIMEOUT_MS itself (see module doc comment)' },
  }));

  return out;
}
