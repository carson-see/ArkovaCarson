// PR #2838 — security response headers on every worker response (SCRUM-4987).
//
// WHAT THIS RIG PROVES. The change is additive response headers set by a global
// Express middleware mounted second (after correlationId, before CORS), plus a
// route-aware CSP that gives /api/docs a swagger-compatible policy and gives
// everything else `default-src 'none'`. The risk is NOT "the header is missing"
// — it is "a browser consumer we did not enumerate loses a resource to the CSP
// or to X-Frame-Options". So every probe below drives a REAL route class on the
// rig and asserts the EXACT header values, including on the response shapes a
// unit test cannot reach: a 404 from the catch-all, a 401 from requireAuth, and
// a 204 CORS preflight that never reaches a route handler at all.
//
// Two negative assertions carry as much weight as the positives:
//   1. NO `Cross-Origin-Embedder-Policy` / `-Opener-Policy` / `-Resource-Policy`
//      is set. The frontend on app.arkova.ai fetches this worker cross-origin;
//      a CORP/COEP value added later would break those fetches silently, and
//      this probe is the tripwire.
//   2. The docs CSP is scoped. `/api/docs*` — and only `/api/docs*` — may carry
//      DOCS_CSP; any other route answering with it means the prefix guard
//      widened and the JSON surface lost `default-src 'none'`.
//
// NOT proven here: that a real browser renders /api/docs with zero CSP
// violations. That needs a headless Chromium load, which the train driver does
// not run; it is a separate one-shot in the soak plan.
export const pr = '#2838';

export const changedBehavior = [
  'Every worker response now carries Strict-Transport-Security, X-Content-Type-Options,',
  'X-Frame-Options: DENY, Referrer-Policy: no-referrer, a deny-all Permissions-Policy and',
  'a Content-Security-Policy. The CSP is route-aware: /api/docs and its assets get a',
  'swagger-compatible policy (self + unsafe-inline script/style, the favicon host in',
  'img-src, frame-ancestors none); every other route gets default-src none. The',
  'middleware is mounted before corsMiddleware and before all routers, so 4xx, 5xx and',
  'OPTIONS preflights carry the set too. No Cross-Origin-* policy is introduced.',
].join(' ');

/** Must match services/worker/src/middleware/securityHeaders.ts exactly. */
const HSTS_VALUE = 'max-age=63072000; includeSubDomains; preload';
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https://app.arkova.ai",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');
const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

/** Headers that must be byte-identical on EVERY response, whatever the status. */
const INVARIANT = {
  'strict-transport-security': HSTS_VALUE,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': PERMISSIONS_POLICY,
};

/** Set by nothing today; a value here would break app.arkova.ai -> api.arkova.ai. */
const CROSS_ORIGIN_HEADERS = [
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
];

/**
 * One route class -> one probe per invariant header + one for the CSP variant.
 * `label` names the class, `expectCsp` is the policy that class must carry.
 */
function assertHeaderSet(probe, label, res, expectCsp, extraDetail = {}) {
  const out = [];
  const detail = { status: res.status, ...extraDetail };

  // A transport failure returns status 0 with no headers — that would make
  // every "header absent" check below pass vacuously. Fail loudly instead.
  out.push(
    probe(`2838_${label}_reachable`, true, res.status !== 0, {
      detail: { ...detail, text: res.status === 0 ? res.text : undefined },
    }),
  );

  for (const [name, expected] of Object.entries(INVARIANT)) {
    out.push(
      probe(`2838_${label}_${name.replace(/-/g, '_')}`, expected, res.headers[name] ?? null, { detail }),
    );
  }
  out.push(
    probe(`2838_${label}_content_security_policy`, expectCsp, res.headers['content-security-policy'] ?? null, {
      detail: { ...detail, variant: expectCsp === DOCS_CSP ? 'DOCS_CSP' : 'API_CSP' },
    }),
  );
  return out;
}

/** Cross-Origin-* must stay absent; asserted on the classes the frontend calls. */
function assertNoCrossOriginPolicy(probe, label, res) {
  return CROSS_ORIGIN_HEADERS.map((name) =>
    probe(`2838_${label}_no_${name.replace(/-/g, '_')}`, null, res.headers[name] ?? null, {
      detail: 'The frontend fetches this worker cross-origin; a CORP/COEP value here breaks it.',
    }),
  );
}

export async function run(ctx) {
  const { probe, workerFetch } = ctx;
  const out = [];
  // Unknown ids on purpose: this probe is about headers, and a 404 body is a
  // perfectly good carrier. No seed, no DB write, nothing to clean up.
  const UNKNOWN_ID = 'ARK-2026-HEADERS-PROBE-0000';

  // ── 1. Liveness: the plainest JSON response ───────────────────────────────
  const health = await workerFetch('/health');
  out.push(...assertHeaderSet(probe, 'health', health, API_CSP));
  out.push(...assertNoCrossOriginPolicy(probe, 'health', health));

  // ── 2. The public verification API — the partner-facing surface ───────────
  const verify = await workerFetch(`/api/v1/verify/${UNKNOWN_ID}`);
  out.push(...assertHeaderSet(probe, 'verify', verify, API_CSP));
  out.push(...assertNoCrossOriginPolicy(probe, 'verify', verify));

  // ── 3. The badge SVG — the one non-JSON body on the API surface ───────────
  // nosniff + default-src 'none' must not stop it being consumed as an <img>.
  // (An <img> load ignores the image's own CSP; this asserts the headers are
  // right, and the soak's embed check covers the rendering claim.)
  const badge = await workerFetch(`/api/badge/${UNKNOWN_ID}`);
  out.push(...assertHeaderSet(probe, 'badge', badge, API_CSP, {
    contentType: badge.headers['content-type'] ?? null,
  }));

  // ── 4. The docs surface — the ONLY route class allowed the wider policy ───
  const specJson = await workerFetch('/api/docs/spec.json');
  out.push(...assertHeaderSet(probe, 'docs_spec', specJson, DOCS_CSP));
  const docsRoot = await workerFetch('/api/docs/');
  out.push(...assertHeaderSet(probe, 'docs_root', docsRoot, DOCS_CSP));
  // Express routing is case-insensitive, so this serves the real swagger HTML
  // and must get the same policy — if it gets API_CSP the page renders blank.
  const docsUpper = await workerFetch('/API/docs/spec.json');
  out.push(...assertHeaderSet(probe, 'docs_uppercase', docsUpper, DOCS_CSP));
  // ...and a prefix that merely LOOKS like docs must not inherit it.
  const notDocs = await workerFetch('/api/docsx');
  out.push(
    probe('2838_docs_prefix_not_widened', API_CSP, notDocs.headers['content-security-policy'] ?? null, {
      detail: { path: '/api/docsx', status: notDocs.status },
    }),
  );

  // ── 5. A 404 from the catch-all — after every router, before the error handler ──
  const notFound = await workerFetch('/definitely-not-a-route-2838');
  out.push(...assertHeaderSet(probe, 'not_found', notFound, API_CSP));
  out.push(probe('2838_not_found_status', 404, notFound.status, { detail: notFound.body }));

  // ── 6. A 401 from requireAuth — proves the middleware runs ahead of auth ──
  // /api/audit is mounted as rateLimiters.api + requireAuthMw; with no
  // Authorization header it short-circuits long before any handler runs.
  const unauthorized = await workerFetch('/api/audit', { method: 'POST', body: { probe: '2838' } });
  out.push(...assertHeaderSet(probe, 'unauthorized', unauthorized, API_CSP));
  out.push(
    probe('2838_unauthorized_status', [401, 403], unauthorized.status, {
      detail: { body: unauthorized.body, note: 'Any 4xx carries the headers; 401/403 is the expected shape.' },
    }),
  );

  // ── 7. The CORS preflight — a 204 that never reaches a route handler ──────
  // securityHeaders is mounted BEFORE corsMiddleware precisely so this carries
  // the set; if the mount order is ever swapped, this is the probe that reds.
  const origin = 'https://app.arkova.ai';
  const preflight = await workerFetch(`/api/v1/verify/${UNKNOWN_ID}`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
  });
  out.push(...assertHeaderSet(probe, 'preflight', preflight, API_CSP, { origin }));
  out.push(probe('2838_preflight_status', 204, preflight.status, { detail: { origin } }));
  out.push(
    probe('2838_preflight_allows_app_arkova_ai', origin, preflight.headers['access-control-allow-origin'] ?? null, {
      detail: {
        note: 'CORS_ALLOWED_ORIGINS is built from the rig env (FRONTEND_URL et al). A null here on a rig whose FRONTEND_URL omits app.arkova.ai is a RIG CONFIG gap, not a regression — set it and re-run before reading it as a failure.',
      },
    }),
  );
  out.push(...assertNoCrossOriginPolicy(probe, 'preflight', preflight));

  // ── 8. The pre-existing contract this must not have disturbed ─────────────
  // §1.10 rate-limit headers on every response, and no Express fingerprint.
  out.push(
    probe('2838_ratelimit_headers_intact', true, Object.keys(verify.headers).some((h) => h.startsWith('x-ratelimit-')), {
      detail: { headers: Object.keys(verify.headers).filter((h) => h.startsWith('x-ratelimit-')) },
    }),
  );
  out.push(probe('2838_no_x_powered_by', null, health.headers['x-powered-by'] ?? null, { detail: 'app.disable("x-powered-by")' }));

  return out;
}
