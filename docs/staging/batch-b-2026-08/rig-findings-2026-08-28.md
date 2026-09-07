# Batch B rig findings — 2026-08-28

Things that had to be corrected on the standing rig before any Batch B soak could
produce honest evidence, plus defects found while doing it. All verified against
prod `vzwyaatejekddvltxyye` before changing anything on rig `fizyjojbebyalirtjjht`.

## F-BB-1 (blocking, fixed) — `arkova-worker-staging` mounted a JWT secret that is not the rig's

`arkova-worker-staging` mounted Secret Manager `supabase-jwt-secret`, which does **not**
verify a token issued by rig project `fizyjojbebyalirtjjht` (checked by HMAC-verifying the
rig's own published anon key against it: `false`; against the rig's real secret: `true`).

Consequence: `verifyJwtLocally` fails on every request, `verifyAuthToken` falls through to the
network `auth.getUser()` path, and a **self-minted** token — the only kind a soak driver can
produce for a fixture user — fails that too, so every JWT probe returns a clean 401 that looks
exactly like an authorization result. Two of this batch's five PRs (#2437, #2439) are JWT
authorization changes, so this would have silently converted their entire boundary matrix into
noise.

Fixed by creating `supabase-jwt-secret-batchb-staging` from the rig's own signing secret (read
from the project's PostgREST config) and pointing the service template at it. This is the
prod-faithful configuration — prod mounts prod's own secret. Verified: an ORG_ADMIN token now
authenticates and `GET /api/queue/pending` returns 200.

**This is a shared-service template change.** Existing tagged revisions are immutable and were
verified unchanged afterwards (`pr-2264`, `pr-2398`, `pr-2400`, `train-migration-t3` all still
serve their own `git_sha`). Later deploys by any session inherit the corrected secret, which can
only make JWT auth more correct.

## F-BB-2 (blocking, fixed) — `private.api_key_settings` was empty on the rig

Prod has one row (`hmac_secret`, 64 chars). The rig had **zero**, so `validate_api_key()`
returned `NULL` for every key. The edge MCP server authenticates exclusively through that RPC,
so `POST /mcp` 401'd for every key on this rig regardless of how the key was created — the same
symptom recorded for deployed `edge.arkova.ai` in `fullsoak-2026-08/gap-closure-mcp-e2e-ratelimit.md`.

Seeded the row from the same `api-key-hmac-secret` the worker mounts, which is the configuration
prod has. `validate_api_key` now returns `{user_id, tier, api_key_id, scopes}` for all three
Batch B keys.

## F-BB-3 (blocking, fixed) — `ENABLE_MCP_SERVER` was absent from `switchboard_flags`

`get_flag` has `p_default boolean DEFAULT false`, so an **absent** row is `false`, not NULL.
`isMcpEnabled` therefore darkened the whole `/mcp` surface with `503 mcp_disabled`. Prod has the
flag enabled. Seeded it to `true` on the rig.

More broadly: prod carries 24 switchboard flags, the rig carried 3. Anything gated on a flag
that prod has and the rig lacks is dark on the rig and fails closed — worth a sweep before the
next rig rebuild, because the failure mode is a 503 that reads like a service fault.

## F-BB-4 (not fixed — reported) — PR #2435's Checkr branches are unreachable in production

`org_integrations_provider_check` is
`CHECK (provider = ANY (ARRAY['google_drive','microsoft_graph','docusign','adobe_sign']))`
— **identical on rig `fizyjojbebyalirtjjht` and prod `vzwyaatejekddvltxyye`**, and no migration
in `supabase/migrations/` alters it.

So no `org_integrations` row can ever have `provider='checkr'`, `findIntegration()` can never
match, and every Checkr delivery short-circuits to `200 {"ok":true,"orphaned":true}` **before**
the nonce is written. The two branches PR #2435 fixes in `checkr.ts` (C1 enqueue-failure,
C2 catch-all) are therefore dead code in production today.

Not repaired here: adding `'checkr'` to the CHECK on the shared rig would make the rig diverge
from prod and invalidate it as a clean mirror for every other PR soaking on it, including
Batch A's. The soak drives the reachable half of the same changed file plus the ATS branch (A1)
that PR #2435 also fixes and which **is** reachable. Discriminating signal for anyone re-checking:
`select pg_get_constraintdef(oid) from pg_constraint where conname='org_integrations_provider_check'`
on both projects.

## F-BB-5 (not fixed — reported) — `ENABLE_ATS_WEBHOOK` gates nothing

`api/v1/router.ts` states "Kill-switch is applied at the index.ts mount" for the ATS webhook.
It is not: `index.ts` applies `killSwitch()` only to the DocuSign and Microsoft Graph mounts.
`ENABLE_ATS_WEBHOOK` exists in the flag registry and in `config.ts` and controls nothing.
Convenient for this soak; a documented control that does not exist is a finding.

## F-BB-6 (environmental) — port 8799 on this host is held by a foreign process

The first PR #2434 edge-driver run pointed the local edge worker's `SUPABASE_URL` at
`127.0.0.1:8799`, which was already bound by an unrelated node process (pid 22913, not started
by this session). Every `/mcp` call 401'd because auth was being answered by a foreign server.
Moved the fault proxy to 8811 and the edge worker to 8795 and re-verified. The failed run is
kept under `evidence/pr-2434/pre-window/cycle-20260828T133321Z.json` — it is a driver-setup
artifact, not a worker signal.

---

# Added 2026-08-29 during Batch B soak re-launch

## F-BB-7 / BB-D1 (not fixed — reported) — the ATS attestation search filters a column that does not exist

`services/worker/src/api/v1/webhooks/ats.ts` scopes the attestation lookup with

    .eq('org_id', matchedIntegration.org_id)

but `public.attestations` has **no `org_id` column** — the org column is
`attester_org_id` (see the baseline: `idx_attestations_attester_org`,
`attestations_attester_org_id_fkey`, and every RLS policy on the table).

PostgREST answers `400 / 42703 "column attestations.org_id does not exist"`. The handler
swallows it (`if (!error && data)`), so `attestations` stays `[]` and **every** ATS delivery
returns `202 accepted` with `verification_results: []` and `summary.total: 0`. The vendor is
told the delivery succeeded and no verification ever runs.

Consequence: the SCRUM-1240 / AUDIT-0424-16 org-scoping fix this line implements is **inert in
production today** — not because scoping is wrong, but because the query it scopes always errors.

**This is pre-existing, NOT introduced by PR #2435.** The identical line is on `origin/main`
(`git show origin/main:…/ats.ts` line 202). PR #2435 touches `ats.ts` only to add the branch-A1
nonce release.

Discriminating signal, re-measured every soak cycle against rig `fizyjojbebyalirtjjht`:

| filter | result |
|---|---|
| `attestations?org_id=eq.<org b1>&or=(subject_identifier.ilike.*Soak Control*)` | `400` `{"code":"42703","message":"column attestations.org_id does not exist"}` |
| `attestations?attester_org_id=eq.<org b1>&or=(subject_identifier.ilike.*Soak Control*)` | `200` `[{"public_id":"ARK-ATT-BBORG1"}]` |

The fixture and the search term are good; the column name is the only fault. The #2435 driver
now pins this as **observed** behaviour (`ats_control.attestation_search_empty_PREEXISTING_DEFECT_BB_D1`)
with the two-way discriminator above, so it cannot pass vacuously and a future fix fails the
check loudly instead of sliding through. The two org-isolation assertions on that response are
renamed `..._VACUOUS_WHILE_BB_D1` — an always-empty result cannot leak, and that must never be
counted as isolation coverage.

## F-BB-8 / BB-D2 (not fixed — reported) — PR #2435's entire `checkr.ts` diff is unreachable, and the Checkr webhook is 503 in PRODUCTION

Two independent facts, each verified live on 2026-08-29:

1. **Prod `arkova-worker` mounts no `CHECKR_WEBHOOK_SECRET`** — 0 of its 68 container env vars
   match `/checkr/i` (`gcloud run services describe arkova-worker --region us-central1`).
   `POST /webhooks/checkr` therefore returns `503 {"error":{"code":"webhook_unconfigured"}}`
   in production, before any handler code runs. This is broader than F-BB-4: it is not only
   C1/C2 that are dead, it is the whole endpoint.
2. **Every changed line in `checkr.ts` (+88/-2) sits inside the `findIntegration()` success
   branch**, and `org_integrations_provider_check` excludes `'checkr'` identically on rig and
   prod (F-BB-4). So even *with* the secret configured, the branch is never entered.

Therefore configuring `CHECKR_WEBHOOK_SECRET` on the rig — which `fix-2435-checkr.sh` was written
to do — buys **zero** additional coverage of this PR's diff while making the rig diverge from
prod on a config surface. **It was deliberately not run.** `fix-2435-checkr.sh` is retained but
should not be used for this purpose.

The soak asserts the prod-faithful `503` instead, and its discriminating signal is that a
delivery carrying a **bogus** signature also returns `503` rather than `401` — proving the
unconfigured guard short-circuits ahead of all changed code. If anyone configures the secret,
`checkr.guard_precedes_signature_check` flips to a deviation and the window fails loudly, which
is the intended evidence-integrity alarm rather than a silent change in what the soak covers.

`#2435`'s cycle artifacts carry an explicit `coverage` map naming `checkr_diff: NOT COVERED`.
