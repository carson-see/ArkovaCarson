# Cron route exerciser — 2026-08-12

> Run `2026-08-12T16:58:34Z` · rig `arkova-worker-fullsoak-2026-08-staging` · Supabase `gnkuaywlpmsaezwvlvhk`
> Route source: **rig frozen SHA f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58** · rig `git_sha` `f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58` · uptime `6526s`
> Host `Arkovas-Mac-mini.local` · repo HEAD `49358d607b47217cfe81caf44d17b5e4a595cc88` · mode `run`
> Mgmt SQL reads: available

**What this measures.** Every cron route declared in `cron.ts` that Cloud Scheduler does *not*
bind on this rig, invoked once over the same authenticated HTTP path Scheduler uses, with its
status, latency, response body and (where a table is obvious from the handler) its row delta.

**What this does NOT assert.** That a 2xx means the job did useful work — most of these have
nothing to act on. It asserts reachability, auth, and the absence of a crash. A non-2xx is a
FINDING; a 2xx is evidence the route is not FD-2-class broken.

## Census

| | count |
|---|---|
| Routes declared in `cron.ts` | **110** |
| Scheduler-bound on this rig | **25** |
| Unbound (this script's scope) | **85** |
| Exercised OK | **1** (of which **1** are a documented gate answering non-2xx by design) |
| Findings | **0** |
| Denied (never invoked) | **0** |

## Cohort integrity

`anchors` 12 → 12 · `anchor_proofs` 12 → 12 — **intact**.
The exerciser is not permitted to move the BL-2 cohort; this row is the proof it did not.

## Results

| route | verdict | verb | http | ms | delta · body |
|---|---|---|---|---|---|
| `/professional-education-extraction` | BY-DESIGN | POST | 503 | 138 ms | `job_queue` 5 → 5 (0) · {"error":"professional_education_schema_unavailable","message":"Professional education schema is not ready in this environment; PR #841 CPE/CLE runtime paths are disabled until schema and migration-ledger reconciliation … |


---

`CRON_EXERCISER: 1 ok / 0 findings / 0 denied`

_Produced by `scripts/staging/fullsoak-cron-exerciser.sh`. No rig env, flag, secret, scheduler job,
revision or traffic split was modified; the soak clock was not touched._
