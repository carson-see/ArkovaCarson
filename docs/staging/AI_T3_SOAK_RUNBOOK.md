# AI T3 Soak Runbook — SCRUM-2383 (AI-03 extraction-decision / template-review)

> **Status:** tooling runbook for standing up a GENUINE AI T3 soak. This document
> describes procedure; it does **not** assert any soak has run. Internal
> engineering note (not Confluence-grade).
>
> **Owner surface:** `scripts/staging/ai-soak-harness.ts`,
> `scripts/staging/ai-eval-gate-runner.ts`, `scripts/staging/ai-eval/**`
> (branch `tooling/s3-ai-soak-harness`). T0 tooling — no soak of its own.

## Why this exists

The AI PR **#1413** (`lane3/s3-ai`) was under a soak that did **not exercise the
AI path**: the generic `load-harness.ts` has modes `anchor / burst / oscillate /
webhooks / events / cron / reads / mixed` — **none hit `/api/v1/ai/*`** — and no
eval gate ran during the load. The founder re-tiered **AI-03 T2 → T3**: 48 h,
≥ 5k users/hr, **with the SCRUM-2382 eval gate run LIVE during the load**.

This tooling supplies the two missing pieces, and — per founder direction — must
**characterize and help fix the REAL Gemini reliability problems** seen in prod
(continual 429 "too many requests", timeouts, and false readings), not merely
prove the endpoint gets hit:

1. **`ai-soak-harness.ts`** — drives the LIVE AI endpoints at ≥ 5k req/hr across
   **multiple document shapes + sizes** (pdf/scan-OCR/docx text, large near-limit,
   oversized-past-limit, malformed) and **measures the 429 / timeout /
   false-reading rate as a first-class result**.
2. **`ai-eval-gate-runner.ts`** — continuously scores the golden set through the
   LIVE `/extract` endpoint, enforces weighted F1 ≥ 0.80, and records per-round
   reliability (429/timeout/false-reading) alongside the F1.

## 🔴 ROOT-CAUSE FINDING — prod routes extraction to the QUOTA-LIMITED PUBLIC Gemini API

The 429 "too many requests" storms have a concrete, code-confirmed cause:

**Prod's worker does NOT set `GEMINI_TUNED_MODEL`, so extraction routes to the
public `gemini-2.5-flash` API — NOT the dedicated provisioned Vertex tuned
endpoint** (`projects/270018525501/locations/us-central1/endpoints/6659012403474202624`).
The public API is per-minute quota-limited; sustained load hits that quota → 429.

Evidence (committed config + docs — a live `gcloud run services describe
arkova-worker` env check is the final confirmation):

- **Routing mechanism** — `services/worker/src/ai/gemini.ts:159`
  `this.tunedModelPath = process.env.GEMINI_TUNED_MODEL ?? null`. Set → Vertex
  provisioned endpoint (`callTunedModel`, `gemini.ts:670`); unset → public API via
  `getGenerativeModel({ model: GEMINI_GENERATION_MODEL })`.
- **`GEMINI_GENERATION_MODEL` default = `gemini-2.5-flash`** (`gemini-config.ts:28,49`).
- **`GEMINI_TUNED_MODEL` is absent from the prod deploy** — `.github/workflows/deploy-worker.yml`
  `--set-env-vars` sets `AI_PROVIDER=gemini, GEMINI_MODEL=gemini-2.5-flash,
  ENABLE_AI_EXTRACTION=true` but **no `GEMINI_TUNED_MODEL`**; `config.ts` has no
  default; the v6 cutover was rolled back with `--remove-env-vars GEMINI_TUNED_MODEL`.
- **Two 2026-05-31 eval reports state it directly**: `services/worker/docs/eval/pe-gates-gemini-2026-05-31T*.md`
  — "`GEMINI_TUNED_MODEL` is unset on `arkova-worker`; prod uses the stock model …
  Public Gemini API path".

**The fix (see Mitigations below): route extraction to the provisioned Vertex
tuned endpoint** by setting `GEMINI_TUNED_MODEL` to the endpoint resource path.
On Cloud Run this needs no key management — `callTunedModel` authenticates via the
service account's ADC (metadata server) and hits
`https://us-central1-aiplatform.googleapis.com/v1beta1/{GEMINI_TUNED_MODEL}:generateContent`.
The provisioned endpoint has dedicated throughput, so it should not 429 under the
same load. The soak is the instrument to PROVE this: run it against the public
path first (baseline 429 rate), then against the tuned path, and compare.

## The AI endpoints under test

All mounted `aiExtractionGate()` → `requireAuth` → `aiRateLimiter` in
`services/worker/src/api/v1/router.ts`. All are **metadata-only** (Constitution
§1.6 / §1.6A — no document bytes):

| Endpoint | Body | Purpose | Provider call |
|---|---|---|---|
| `POST /api/v1/ai/extract` | `{ strippedText, credentialType, fingerprint(64-hex), issuerHint? }` | Extract structured fields — **the eval-scored path** | `createExtractionProvider()` |
| `POST /api/v1/ai/template` | `{ fields, confidence }` | AI-03 template reconstruction | `new GeminiProvider()` (direct) |
| `POST /api/v1/ai/tags` | `{ fields }` | Tag/classification | `new GeminiProvider()` (direct) |

## ⚠️ Real-vs-mock — the single most important prerequisite

The eval is **worthless unless the rig runs REAL Gemini inference.**

- `/ai/extract` selects its provider by env
  (`services/worker/src/ai/factory.ts:getProviderName`): **`GEMINI_API_KEY` set →
  real `GeminiProvider`; unset → `MockAIProvider`** (deterministic garbage).
  `USE_MOCKS` does **not** appear in this factory — only the key does.
- `/ai/template` + `/ai/tags` call `new GeminiProvider()` **directly**, which
  **throws** (`GEMINI_API_KEY is required`) when the key is unset → HTTP 500.

**The existing isolated-rig recipe is mock-only.** `provision-isolated-rig.sh`
deploys with `USE_MOCKS=true` and does **not** set `GEMINI_API_KEY`, so extract
would score a mock and template/tags would 500. **A real AI soak MUST add
`GEMINI_API_KEY` (and `AI_PROVIDER=gemini`) to the rig.** The eval runner's
`--require-live` flag records the server-reported `provider` per round and
**refuses to certify** a round merge-grade if it sees `mock` / `fast-fallback`.

> Gemini is fraud-gated and GEMB2 blocks **training** — but **inference /
> extraction is allowed**. This soak runs inference only. Do not enable any
> tuning/training path (`GEMINI_TUNED_MODEL`, fraud training) for the soak.

## Rig recommendation: **fresh isolated rig — NOT the existing one**

**Use a fresh isolated Supabase project + a dedicated `*-staging` Cloud Run
service. Do not reuse `arkova-worker-s3-ai-staging` (the #1413 soak rig).**

Reasoning:

- **#1413 is FROZEN soak evidence** (`memory/feedback_dont_touch_soaking_prs.md`).
  Writing AI load or eval samples to its live rig contaminates its evidence and
  its Supabase state (extract writes usage rows, cache rows, audit rows). §1.11A:
  a Cloud Run tag isolates the revision, **not** the DB.
- The existing rig has been taking **generic** load (anchor/webhook/cron), so its
  DB is **not clean for AI evidence** — §1.11A requires the soak DB be clean for
  *that* PR's evidence. A rig that already absorbed unrelated writes is not a
  clean mirror for the AI eval.
- The AI soak needs env the existing rig lacks (`GEMINI_API_KEY`,
  `ENABLE_AI_EXTRACTION=true`) and an **ingress model that lets a Supabase JWT
  through** (see next section) — cleaner to provision fresh than to mutate a
  live soak rig.

Provision with `scripts/staging/provision-isolated-rig.sh --name s3-ai-eval
--apply` (Carson-gated: needs `--apply` + `CONFIRM_PROVISION=s3-ai-eval`), then
apply the AI-specific deltas below. Isolated-rig standup gotchas
(config.ts Zod, Scheduler-driven cron, secret drift) are in
`memory/project_isolated_rig_deploy_env.md` and
`memory/project_isolated_soak_standup_procedure.md`.

## Auth + ingress — resolve the header collision before you start

`/api/v1/ai/*` `requireAuth` demands a **Supabase user JWT** in
`Authorization: Bearer <jwt>` — it **rejects** API keys and any `ak_`-prefixed or
IAM bearer. But a `--no-allow-unauthenticated` Cloud Run service ALSO reads the
`Authorization` header for **ingress** (expecting a gcloud IAM token). **The two
collide in one header.** Pick one:

- **Recommended:** deploy the AI eval rig **`--allow-unauthenticated`**. App-layer
  `requireAuth` still gates every AI call (a random caller with no JWT gets 401),
  so this is not an open door — it just moves auth entirely to the app layer.
  The harness then sends only the Supabase JWT.
- **Alternative:** front the rig with an IAP / ESPv2 proxy that injects ingress
  auth separately from the app `Authorization` header.

Mint the **Supabase user JWTs** (`STAGING_AI_JWTS`): sign short-lived user JWTs
with the rig's `SUPABASE_JWT_SECRET` for ≥ 4 seeded staging users, or capture
them from staging logins. **≥ 4 distinct users** because `aiRateLimiter` = 30
req/min **per user**; 5k/hr ≈ 83/min → ≥ 3 users bare-minimum, 4 with headroom.

**Per-IP limiter (the other rate wall):** the anon bucket caps 100 req/min **per
IP**. AI calls carry no API key, so at ≥ 5k/hr (~83/min) a single egress IP would
also 429 here — independent of the per-user AI limiter. The worker runs
`app.set('trust proxy', …)` and keys the per-IP limiter on `req.ip`, so the
harness **rotates `X-Forwarded-For` per request** (on by default; `--no-rotate-ip`
to disable) — each request reads as a distinct IP, exactly the documented
single-host high-rate technique (`memory/project_isolated_soak_standup_procedure.md`).
JWT sharding (per-user limit) and XFF rotation (per-IP limit) are **both**
required — they solve different limiters.

**`STAGING_API_BASE` URL guard (isolated-rig gotcha):** `load-harness-env.ts` only
accepts `pr-N---<host>` / `train-*---<host>` **tag-routed** URLs and REJECTS a
dedicated isolated-rig service hostname (e.g. `arkova-worker-s3-ai-eval-staging-…run.app`).
Do NOT patch the guard — instead add a tag to the isolated service and use its
tag URL (stays fully isolated, one service):
```bash
gcloud run services update-traffic arkova-worker-s3-ai-eval-staging \
  --region us-central1 --update-tags pr-9999=$(latest-revision)
# → STAGING_API_BASE=https://pr-9999---arkova-worker-s3-ai-eval-staging-…run.app
```

## Rig env checklist (in addition to the standard isolated-rig env)

| Env | Value | Why |
|---|---|---|
| `GEMINI_API_KEY` | real key (Secret Manager) | **real inference** — without it extract→mock, template/tags→500 |
| `AI_PROVIDER` | `gemini` | pin the provider explicitly |
| `ENABLE_AI_EXTRACTION` | `true` **and** `switchboard_flags` row `enabled=true` | else `aiExtractionGate` 503s (fresh env = flags empty → dark, per `project_switchboard_flags_dark_api`) |
| ingress | `--allow-unauthenticated` (or IAP/ESPv2) | resolve the JWT/IAM header collision |
| — | seed ≥ 4 users + mint their JWTs | shard under the 30/min per-user limit |
| `GEMINI_TUNED_MODEL` | **run A:** UNSET (public API — reproduce the 429 baseline). **run B:** `projects/270018525501/locations/us-central1/endpoints/6659012403474202624` (route to the provisioned Vertex endpoint — the fix) | the A/B that PROVES the routing root-cause. Run B needs the rig's Cloud Run SA to hold Vertex `aiplatform.endpoints.predict` and the endpoint deployed in `us-central1` |

Leave `ENABLE_AI_FRAUD` / `ENABLE_AI_REPORTS` / training paths **off**. Do not
set `GEMINI_TUNED_MODEL` to a *training* job — only to the deployed inference
endpoint (inference is allowed; GEMB2 blocks training only).

## Run the soak (48 h)

Two long-running processes against the **same rig tag URL**. Run each under
`screen` / `nohup` and relaunch on worker restart — the durable soak clock is
**Cloud Run worker uptime**, not the harness process
(`memory/feedback_soak_clock_is_worker_uptime.md`).

```bash
# Tag-routed URL of the isolated rig (see the URL-guard note above — a bare
# service hostname is rejected; add a pr-<N> tag to the isolated service).
export STAGING_API_BASE="https://pr-9999---arkova-worker-s3-ai-eval-staging-<hash>-uc.a.run.app"
export STAGING_AI_JWTS="u1:<jwt1>,u2:<jwt2>,u3:<jwt3>,u4:<jwt4>"   # never commit

# 0) validate the plan without firing (checks pool size vs rate)
npx tsx scripts/staging/ai-soak-harness.ts --duration 15 --rate 5000 --dry-run

# 1) AI-path load: 48 h @ 5000 req/hr across extract+template+tags, ALL doc
#    variants (multi-doctype + size stress). --doc-variants defaults to all six.
npx tsx scripts/staging/ai-soak-harness.ts \
  --duration 2880 --rate 5000 --endpoints extract,template,tags \
  --doc-variants pdf-clean,scan-ocr,docx-text,large,oversized,malformed \
  --timeout-ms 10000 \
  --evidence-out docs/staging/evidence/ai-soak-<rig>-load.json

# 2) LIVE eval gate: sample the 48-entry golden set every 30 min for 48 h,
#    require real inference, append rolling JSONL evidence
npx tsx scripts/staging/ai-eval-gate-runner.ts \
  --duration 2880 --interval 30 --require-live --timeout-ms 10000 \
  --evidence-out docs/staging/evidence/ai-soak-<rig>-eval.jsonl
```

- **Load evidence** (`ai-soak-*-load.json`): per-endpoint p50/p95/p99 latency,
  per-HTTP-status counts, `achievedRequestsPerHour`, **`byVariant`** (per
  document-shape request counts), and the **first-class `reliability` block**:
  `rate429`, `timeoutRate`, `falseReadingRate`, `serverErrorRate`,
  `unreliableRate` + per-class `counts`. **This reliability block IS the founders'
  headline result** — report `rate429` / `timeoutRate` / `falseReadingRate` at ≥ 5k/hr.
- **Eval evidence** (`ai-soak-*-eval.jsonl`): one record per 30-min round —
  `gate.passed`, `gate.weightedF1`, per-field precision/recall/F1, sample
  misclassifications, `extractionErrorCount`, **`falseReadingCount`**, per-round
  `reliability`, observed `provider`, and `merited`. The runner exits non-zero if
  **any** round fails the gate.

## Reliability characterization — what the numbers mean

Each AI call is classified into a reliability bucket (`scripts/staging/ai-eval/reliability.ts`):

| Bucket | What it is | Prod pain it measures |
|---|---|---|
| `rate_limited` | HTTP 429 | **"too many requests"** — the public-API quota being hit |
| `false_reading` | 2xx but `degraded:true` / `provider:'fast-fallback'` | the extract endpoint's **4.5s latency budget expired** and it returned a low-confidence regex guess that LOOKS like an answer — **the "false reading"** |
| `client_timeout` | our request deadline elapsed | Gemini/worker **hung** past the client timeout |
| `server_unavailable` | HTTP 503 | Gemini **circuit breaker open** (5 consecutive failures → 60s cooldown) or gate closed |
| `server_error` | other 5xx | extraction failure |
| `client_error` | 4xx (e.g. 400 on the `oversized` variant) | size-limit enforcement working |
| `ok` | clean 2xx from a real provider | healthy inference |

**Document coverage** (`--doc-variants`): `pdf-clean` / `scan-ocr` / `docx-text`
exercise text-shape diversity; `large` pads near the 50,000-char `strippedText`
limit (big-file latency stress); `oversized` pushes past it (**must 400** — limit
enforcement); `malformed` sends control-char garbage (robustness). `oversized` +
`malformed` are load-only (not eval-scored) and are always routed to `/extract`.

## Mitigations for the 429 / timeout / false-reading problem (concrete)

In priority order, and what the soak proves for each:

1. **Route extraction to the provisioned Vertex tuned endpoint (the root-cause fix).**
   Set `GEMINI_TUNED_MODEL=projects/270018525501/locations/us-central1/endpoints/6659012403474202624`.
   The provisioned endpoint has dedicated throughput → the public-API per-minute
   quota (the 429 source) no longer applies. **Prove it:** the A/B run (public vs
   tuned) should show `rate429` collapse on the tuned run. On Cloud Run this needs
   no key — ADC via the metadata server + the SA holding Vertex predict.
2. **If staying on the public API: request a quota increase AND pace to stay under it.**
   The harness already paces at a fixed interval; add worker-side **request pacing
   / a concurrency cap** so aggregate Gemini calls stay under the granted QPM.
   Quantify the ceiling from the soak's `rate429` vs achieved rate.
3. **Backoff/retry with jitter is already present but insufficient at scale.**
   `gemini.ts:withRetry` does 3 attempts, exponential backoff, 0.5–1.0× jitter
   (`gemini.ts:850`). Under sustained 429 it exhausts retries and the circuit
   breaker opens (503). Mitigation: honor the 429 `Retry-After`, widen backoff, and
   raise `MAX_RETRIES` only if paired with pacing (more retries without pacing just
   amplifies the quota storm). The soak's `rate429` + `server_unavailable` rates
   show whether retry is absorbing or amplifying.
4. **Reduce false readings by widening the latency budget on the tuned path.**
   The 4.5s `AI_EXTRACTION_LATENCY_BUDGET_MS` turns a slow Gemini call into a
   degraded fast-fallback (the false reading). A faster/dedicated endpoint makes
   the budget bite less often; if it still bites, raise the budget on the tuned
   path (dedicated throughput has predictable latency). The soak's
   `falseReadingRate` quantifies this before and after.
5. **The fallback path (`@cloudflare/ai`)** is gated by `ENABLE_AI_FALLBACK`
   (default false, Constitution §1.1). It is NOT a 429 fix — it is a separate
   provider for hard outages, and is off in prod. Do not enable it to mask a quota
   problem; fix the routing instead.

**First-class result to report** (from the load evidence `reliability` block, at
≥ 5k req/hr): the observed `rate429`, `timeoutRate` (client_timeout +
server_unavailable), and `falseReadingRate` on the **public** path (baseline),
and the same three on the **tuned** path (post-fix). The delta is the proof that
the routing fix resolves the founders' Gemini reliability problem.

## How F1 ≥ 0.80 becomes merge-grade evidence

- The vendored scorer (`ai-eval/scoring.ts`) is a behaviour-equivalent port of
  `services/worker/src/ai/eval/scoring.ts` + the SCRUM-2382 gate config from
  #1413's `eval-gates.ts` — so **the weighted F1 the runner records equals the F1
  the SCRUM-2382 merge gate computes** on the same field maps (parity is pinned by
  `ai-eval/scoring.test.ts`).
- A round is **merited** only when: 48-entry coverage met **AND** aggregate
  weighted F1 ≥ 0.80 **AND** per-field floors met (creditHours ≥ 0.85, issuedDate
  ≥ 0.80, credentialType ≥ 0.80) **AND** (`--require-live`) the observed provider
  was a real model.
- **Merge-grade** = every 30-min round across the full 48 h window merited, WHILE
  the load harness sustained ≥ 5k req/hr (correlate the two evidence files by
  timestamp). Attach both files + the isolated-rig identity block (§1.11A: project
  ref, Cloud Run service/tag URL, worker revision, image digest, PR head SHA,
  deploy log id, soak start/end, tier, preflight result) to the #1413 evidence
  block or an `docs/staging/rc-manifests/rc-*.json`.

## Honest limitations (read before trusting the number)

- **`/extract` under-covers PE-gated fields.** The prod extract path
  (`provider.extractMetadata`) does **not** emit `deliveryMethod` / `nasbaStatus`
  / `ethicsHours` / `courseId`, so those score as misses over HTTP. The three
  **SCRUM-2382 gate-floored fields** (`creditHours`, `issuedDate`,
  `credentialType`) **are** emitted, so the gate is scorable — but the aggregate
  weighted F1 over HTTP is a **floor**, dragged down by the un-emitted fields,
  not the in-process eval's ceiling. If the founder wants the PE-gate-field F1
  measured live too, a `/extract` variant that routes the PE prompt (as
  `pe-eval-extraction.ts` does in-process) is a follow-up.
- **`missing_both` inflates aggregate F1** (upstream caveat carried into the
  port) — the per-field floors are the guard; do not compare this weighted F1 to
  externally-reported extraction F1.
- The **golden set is a vendored snapshot** of #1413 @ `b95851d5`. If #1413's
  golden set or gate config changes, re-vendor (`ai-eval/golden.ts` header) and
  re-run `scoring.test.ts` before trusting new evidence.
