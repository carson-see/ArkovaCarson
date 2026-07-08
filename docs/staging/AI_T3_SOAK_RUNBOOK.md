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

This tooling supplies the two missing pieces:

1. **`ai-soak-harness.ts`** — drives the LIVE AI endpoints at ≥ 5k req/hr.
2. **`ai-eval-gate-runner.ts`** — continuously scores the golden set through the
   LIVE `/extract` endpoint and enforces weighted F1 ≥ 0.80 during the soak.

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
(A single source IP is also capped at 100 req/min in the anon bucket — if you push
much past ~100/min aggregate, distribute egress across IPs.)

## Rig env checklist (in addition to the standard isolated-rig env)

| Env | Value | Why |
|---|---|---|
| `GEMINI_API_KEY` | real key (Secret Manager) | **real inference** — without it extract→mock, template/tags→500 |
| `AI_PROVIDER` | `gemini` | pin the provider explicitly |
| `ENABLE_AI_EXTRACTION` | `true` **and** `switchboard_flags` row `enabled=true` | else `aiExtractionGate` 503s (fresh env = flags empty → dark, per `project_switchboard_flags_dark_api`) |
| ingress | `--allow-unauthenticated` (or IAP/ESPv2) | resolve the JWT/IAM header collision |
| — | seed ≥ 4 users + mint their JWTs | shard under the 30/min per-user limit |

Leave `ENABLE_AI_FRAUD` / `ENABLE_AI_REPORTS` / training paths **off**.

## Run the soak (48 h)

Two long-running processes against the **same rig tag URL**. Run each under
`screen` / `nohup` and relaunch on worker restart — the durable soak clock is
**Cloud Run worker uptime**, not the harness process
(`memory/feedback_soak_clock_is_worker_uptime.md`).

```bash
export STAGING_API_BASE="https://s3-ai-eval---arkova-worker-<rig>.run.app"
export STAGING_AI_JWTS="u1:<jwt1>,u2:<jwt2>,u3:<jwt3>,u4:<jwt4>"   # never commit

# 0) validate the plan without firing (checks pool size vs rate)
npx tsx scripts/staging/ai-soak-harness.ts --duration 15 --rate 5000 --dry-run

# 1) AI-path load: 48 h @ 5000 req/hr across extract+template+tags
npx tsx scripts/staging/ai-soak-harness.ts \
  --duration 2880 --rate 5000 --endpoints extract,template,tags \
  --evidence-out docs/staging/evidence/ai-soak-<rig>-load.json

# 2) LIVE eval gate: sample the 48-entry golden set every 30 min for 48 h,
#    require real inference, append rolling JSONL evidence
npx tsx scripts/staging/ai-eval-gate-runner.ts \
  --duration 2880 --interval 30 --require-live \
  --evidence-out docs/staging/evidence/ai-soak-<rig>-eval.jsonl
```

- **Load evidence** (`ai-soak-*-load.json`): per-endpoint p50/p95/p99 latency,
  error rate, per-HTTP-status counts, `achievedRequestsPerHour`, `rateLimited429`,
  `transportErrors`. This is the ≥ 5k users/hr proof.
- **Eval evidence** (`ai-soak-*-eval.jsonl`): one record per 30-min round —
  `gate.passed`, `gate.weightedF1`, per-field precision/recall/F1, sample
  misclassifications, `extractionErrorCount`, observed `provider`, and `merited`.
  The runner exits non-zero if **any** round fails the gate.

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
