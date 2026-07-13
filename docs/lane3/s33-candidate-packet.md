# L3-S0 — Tuned-Candidate Selection Packet + Vertex Artifact Provenance (Sprint 3.3)

> **Status:** L3-S0 deliverable, Sprint 3.3 day 1 (2026-07-10). Internal engineering notes — the audited spec lives in Confluence (sprint 3.3 lane plan, pageId 96894977).
> **Decision authority:** CTO rulings R1/R14 (S3.3 CTO Decision Memo, 2026-07-10, BINDING). This packet executes R1; it does not re-litigate it.
> **Author:** Lane 3 (Credential Network & Intelligence / AI).

## 1. Recommendation (per CTO R1)

**PRIMARY: v6** — recreate an endpoint from model artifact `models/6611494259700793344` (`arkova-gemini-golden-v6`), served with `GEMINI_V6_PROMPT=true`.

**FALLBACK (in-sprint): v7.1 surgical retrain** — approved and funded (≤$40) per CTO R1, run unconditionally, but **gated for window entry**: v7.1 enters the 48h A/B window only if it clears the resurrected v7 DoD gates offline against the new leak-free corpus (L3-S1/L3-S2). Mandatory AC: the tuning job sets `exportLastCheckpointOnly: true` — the default exports every intermediate checkpoint to its own endpoint, which auto-violates CLAUDE.md §0 rule 7 on every retrain.

**v5-reasoning** = rollback lineage documentation only. Not an A/B arm.

**v7 as-is is NOT a candidate.** The in-tree eval verdict is FAIL: "DO NOT CUT OVER. Hold v5-reasoning in prod." (`services/worker/docs/eval/eval-gemini-golden-v7-vs-v6-2026-04-16.md:10`). v7 failed 11 of 16 DoD gates, including FINANCIAL −21.2pp (49.4%, `goodStandingStatus` boolean-vs-string Zod bug at `services/worker/src/ai/schemas.ts:45`), BUSINESS_ENTITY −18.8pp, p95 latency +69% (8,344ms), subType emission −14.9pp (73.1%), fraudSignals F1 7.4%. Redeploying a documented-failed artifact for a 48h window would re-litigate April.

Note the sprint question was never "did v7 cover licensing/education" — it did (LICENSE 90.0%, CLE 87.0%, DEGREE 82.0%, TRANSCRIPT 90.4% F1 at the April eval). The gap is CPE/CLE **completion-evidence** depth (the professional-education dataset landed 2026-05-20/22, a month after v7 trained) plus #1413's S3 fixtures. The question is candidate selection.

## 2. Vertex inventory (READ-ONLY, captured 2026-07-10 ~15:55Z)

### 2.1 What exists — verdicts

| Artifact | Resource | Status 2026-07-10 |
|---|---|---|
| v7 model artifact | `models/1576047663835512832` (`arkova-gemini-golden-v7`) | **EXISTS** (us-central1) |
| v6 model artifact | `models/6611494259700793344` (`arkova-gemini-golden-v6`) | **EXISTS** (us-central1) |
| v5-reasoning endpoint | `endpoints/8811908947217743872` | **NOT DEPLOYED — endpoint list is empty** |
| Any deployed endpoint | — | **ZERO endpoints deployed** in us-central1 AND us-east4 |
| v7 tuning job | `tuningJobs/5456125087591694336` | SUCCEEDED 2026-04-16 (base gemini-2.5-flash) |
| v6 tuning job | `tuningJobs/240015537143283712` | SUCCEEDED 2026-04-16 (base gemini-2.5-flash) |
| v5-reasoning model artifacts | `models/5221711562191929344`, `models/6939834820033773568` (`arkova-golden-v5-reasoning-pro-20260415`) | EXIST (redeploy path preserved) |

The empty endpoint list is consistent with §0 rule 7 steady-state and with the prod drift finding in §4 below: **nothing tuned is serving anywhere right now.** It also means the L3-S6 multimodal probe is blocked until the v6 endpoint is recreated (see `docs/lane3/s33-multimodal-spike-memo.md`).

### 2.2 Raw output

`gcloud ai models list --region=us-central1` (project `arkova1`):

```
MODEL_ID             DISPLAY_NAME
3053933678322253824  arkova-pe-extraction-v1-20260531
4896678332835299328  arkova-gemini-fraud-v1
1576047663835512832  arkova-gemini-golden-v7
6611494259700793344  arkova-gemini-golden-v6
7399201982025564160  arkova-gemini-fraud-v1
2307882603283218432  arkova-golden-v6-compliance-pro-20260415
5221711562191929344  arkova-golden-v5-reasoning-pro-20260415
3236750026428383232  arkova-golden-v5-extraction-deep-20260415
6939834820033773568  arkova-golden-v5-reasoning-pro-20260415
6498482056551464960  arkova-golden-v5-reasoning-20260415
3574519998481170432  arkova-golden-v5-20260415
1957727732255162368  arkova-golden-v5-20260415
5499808839182057472  arkova-gemini-golden-v4-combined-2026-04-15
5617465379447111680  arkova-gemini-golden-v4-2026-04-15
4332285820158345216  arkova-gemini-golden-2026-04-04
2452032975731163136  arkova-gemini-golden-2026-04-03
9197017842648612864  arkova-gemini-golden-2026-03-29
4315115846578995200  arkova-gemini-extraction-v1
```

`gcloud ai endpoints list --region=us-central1`:

```
Listed 0 items.
```

`gcloud ai endpoints list --region=us-east4` and `gcloud ai models list --region=us-east4`:

```
Listed 0 items.
Listed 0 items.
```

Tuning jobs: `gcloud ai tuning-jobs` is not a valid subcommand in the installed gcloud; inventoried via REST (`GET /v1/projects/arkova1/locations/us-central1/tuningJobs`), 20 jobs returned:

```
5799178900210712576 | arkova-pe-extraction-v1-20260531          | SUCCEEDED | 2026-05-31 | gemini-2.5-flash
1268557675075993600 | arkova-pe-extraction-v1-20260531          | CANCELLED | 2026-05-31 | gemini-2.5-flash
6387124463783116800 | arkova-gemini-fraud-v1                    | SUCCEEDED | 2026-04-27 | gemini-2.5-pro
5456125087591694336 | arkova-gemini-golden-v7                   | SUCCEEDED | 2026-04-16 | gemini-2.5-flash
240015537143283712  | arkova-gemini-golden-v6                   | SUCCEEDED | 2026-04-16 | gemini-2.5-flash
6469566945145389056 | arkova-golden-v6-compliance-pro-20260415  | SUCCEEDED | 2026-04-16 | gemini-2.5-pro
6279500967121518592 | arkova-gemini-fraud-v1                    | SUCCEEDED | 2026-04-16 | gemini-2.5-pro
8854843072396132352 | arkova-golden-v5-reasoning-pro-20260415   | SUCCEEDED | 2026-04-15 | gemini-2.5-pro
1572522474938040320 | arkova-golden-v5-extraction-deep-20260415 | SUCCEEDED | 2026-04-15 | gemini-2.5-pro
8131452382249746432 | arkova-golden-v5-reasoning-pro-20260415   | CANCELLED | 2026-04-15 | gemini-2.5-pro
1028290607467986944 | arkova-golden-v5-20260415                 | CANCELLED | 2026-04-15 | gemini-2.5-pro
1668786916973084672 | arkova-golden-v5-reasoning-20260415       | CANCELLED | 2026-04-15 | gemini-2.5-flash
6967412616062828544 | arkova-golden-v5-20260415                 | CANCELLED | 2026-04-15 | gemini-2.5-flash
8686556220695248896 | arkova-gemini-golden-v4-combined-2026-04-15| SUCCEEDED | 2026-04-15 | gemini-2.5-flash
5956389684090241024 | arkova-gemini-golden-v4-2026-04-15        | SUCCEEDED | 2026-04-15 | gemini-2.5-flash
8132553543144964096 | arkova-gemini-golden-2026-04-04           | SUCCEEDED | 2026-04-04 | gemini-2.5-flash
6192779736259756032 | arkova-gemini-golden-2026-04-03           | SUCCEEDED | 2026-04-03 | gemini-2.5-flash
3860978631903805440 | arkova-gemini-golden-2026-03-29           | SUCCEEDED | 2026-03-29 | gemini-2.5-flash
2918600409876529152 | arkova-gemini-extraction-v1               | CANCELLED | 2026-03-29 | gemini-2.5-flash
7113703462772146176 | test-probe                                | CANCELLED | 2026-03-29 | gemini-2.5-flash
```

## 3. v6 number reconciliation: 77.1/83.6 vs 79.3/81.3

Both figures are real, from the **same model, same endpoint (`endpoints/740332515062972416`), same prompt, same day (2026-04-16)**. What changed is the **sampling methodology**:

| Figure pair | Source | Eval design | Raw JSON |
|---|---|---|---|
| Macro **77.1%** / Weighted **83.6%** | `services/worker/docs/eval/eval-gemini-golden-v6-2026-04-16.md` (also quoted in `docs/plans/gemini-golden-v7-design-2026-04-16.md:6`) | **50-sample, proportional** to training-set distribution → rare types drew n=1–3 | `eval-gemini-2026-04-16T16-10-26.json` |
| Macro **79.3%** / Weighted **81.3%** | `services/worker/docs/eval/eval-gemini-golden-v6-stratified-2026-04-16.md` (this is the "v6 baseline" column in the v7-vs-v6 eval doc) | **Stratified n=10/type, 249 entries** | `eval-gemini-2026-04-16T17-08-23.json` |

Why the numbers move the way they do (per the stratified doc's own analysis, "The 50-sample eval was lying about weak types"):

- **Macro F1 rose 77.1 → 79.3 (+2.2pp)** because per-type F1 at n=1–3 was pure noise; several "weak" types (TRANSCRIPT 63.9→90.6, BADGE 68.0→89.1, REGULATION 57.8→86.5) were fine once measured at n=10.
- **Weighted F1 fell 83.6 → 81.3 (−2.3pp)** because proportional sampling over-weighted high-F1 common types; stratified sampling gives genuinely-lower-F1 rare types equal representation.

**Which number to use:** for any comparison against the v7 eval (or the S3.3 A/B), use the **stratified 79.3/81.3** — identical methodology to the v7-vs-v6 doc. The 77.1/83.6 pair is only comparable to other 50-sample proportional runs.

### Contamination caveat — attach to EVERY historical figure above

The stratified eval drew from `FULL_GOLDEN_DATASET`, which includes training data (90/10 enrichment split). Statistically **~224 of the 249 stratified entries were in the training corpus** (`eval-gemini-golden-v7-vs-v6-2026-04-16.md:171-173`). All absolute numbers here (v6 77.1/83.6, v6 79.3/81.3, v7 80.5/81.4, all per-type F1 incl. LICENSE 99.3/90.0, CLE 93.7/87.0) are **upper bounds for out-of-distribution production traffic**. The v6-vs-v7 *comparison* remains valid (identical sampling both arms). The S3.3 corpus (L3-S1) exists precisely to replace these contaminated absolutes with leakage-gated held-out numbers.

## 4. Prod drift note — what production actually runs (and which docs are stale)

**Live state (asserted by RTE in-session, 2026-07-10, per `memory/feedback_assert_prod_state_directly.md`):** prod extraction runs **public `gemini-2.5-flash` on the Developer-API key surface** (`GEMINI_API_KEY`); **`GEMINI_TUNED_MODEL` is unset**; no tuned endpoint is invoked. §2 corroborates: zero Vertex endpoints are deployed anywhere, so no tuned path *could* be serving.

**In-tree docs claiming v5-reasoning is the kept/current prod tuned path are STALE.** Do not cite them for current state:

| Stale doc | Stale claim |
|---|---|
| `services/worker/docs/eval/eval-gemini-golden-v7-vs-v6-2026-04-16.md:159` | "Prod remains v5-reasoning… `GEMINI_TUNED_MODEL=projects/.../endpoints/8811908947217743872` stays" |
| `docs/sprint-0/S0-E6-infra-hygiene-report.md:25` | endpoint `8811908947217743872` marked "keep (Gemini-Golden; gated per GEMB2)" |
| `docs/plans/gemini-golden-v6-design-2026-04-16.md:10` | "Current production Vertex tuned model… `endpoints/8811908947217743872`" |
| `docs/runbooks/v6-cutover.md:11` | describes cutover FROM v5-reasoning endpoint as the live baseline |
| `docs/stories/28_gemini_migration_evolution.md:9,18` | "Prod extraction runs on… the v5-reasoning tuned endpoint" |

These were accurate when written (April 2026). Somewhere between then and 2026-07-10 the v5-reasoning endpoint was undeployed (consistent with the end-of-sprint infra-cost sweeps) and prod fell back to the public-model path. Consequence for the A/B: **RIG-PUBLIC (the control arm) must mirror today's actual prod**: public `gemini-2.5-flash`, Developer-API key surface, v5 prompt (`EXTRACTION_SYSTEM_PROMPT`), no tuned var — NOT the v5-reasoning tuned path the stale docs describe.

## 5. Prompt pairing per candidate

v7/v7.1 share v6's inference prompt **by design** — there is no v7 prompt file (`docs/plans/gemini-golden-v7-design-2026-04-16.md:109`: `GEMINI_V6_PROMPT=true # v7 uses the same inference prompt as v6`).

| Arm | Model | Flags | Prompt served |
|---|---|---|---|
| RIG-PUBLIC (control = prod parity) | public `gemini-2.5-flash`, Developer-API key | `GEMINI_TUNED_MODEL` unset, `GEMINI_V6_PROMPT` unset | v5 `EXTRACTION_SYSTEM_PROMPT` (`extraction.ts`) |
| RIG-TUNED, v6 | recreated v6 endpoint | `GEMINI_TUNED_MODEL=<new-v6-endpoint>`, `GEMINI_V6_PROMPT=true` | `EXTRACTION_V6_SYSTEM_PROMPT` + `buildV6UserPrompt` |
| RIG-TUNED, v7.1 (if gate-cleared) | v7.1 endpoint | `GEMINI_TUNED_MODEL=<v7.1-endpoint>`, `GEMINI_V6_PROMPT=true` (unchanged) | same v6 prompt pair |

Code path: `services/worker/src/ai/featureFlags.ts:13-15` (`isV6PromptActive()` reads `GEMINI_V6_PROMPT === 'true'` at request time) and `services/worker/src/ai/gemini.ts:188-197` (tuned path selects `EXTRACTION_V6_SYSTEM_PROMPT`/`buildV6UserPrompt` when active; serving a v6-family endpoint with the v5 prompt regresses toward base behavior — documented regression mode). L3-S3 smoke must assert `GEMINI_V6_PROMPT`, `GEMINI_TUNED_MODEL`, and provider identity every round.

## 6. responseSchema fairness rule (CTO R6)

`services/worker/src/ai/gemini.ts:743-752`: the tuned path attaches `responseSchema` to `generationConfig` **only when `GEMINI_TUNED_RESPONSE_SCHEMA === 'true'` (default off)**; otherwise both tuned and base paths send `responseMimeType: 'application/json'` only. Google documents a known issue that controlled generation (responseSchema) against tuned Gemini models **can decrease model quality** — it can silently sink the tuned arm's F1.

**Rule: both headline A/B arms run with `GEMINI_TUNED_RESPONSE_SCHEMA` unset and identical `responseMimeType`.** Asserted per round in the gate runner. Schema-on may run only as a labeled side-experiment outside the headline window.

## 7. v6 endpoint-recreate steps (DOCUMENTED, NOT EXECUTED)

> Execution is out of scope for L3-S0 (day-1 packet is read-only; §0 rule 7 audit brackets any future run). Est. ~10 min (`eval-gemini-golden-v7-vs-v6-2026-04-16.md:160`).

1. Pre-audit: `gcloud ai endpoints list --region=us-central1` — record (expected: 0 items, as of this packet).
2. Create endpoint:
   `gcloud ai endpoints create --region=us-central1 --display-name=arkova-gemini-golden-v6-s33 --project=arkova1`
3. Deploy the preserved artifact:
   `gcloud ai endpoints deploy-model <ENDPOINT_ID> --region=us-central1 --model=6611494259700793344 --display-name=arkova-gemini-golden-v6 --project=arkova1`
   (If the gcloud path rejects a tuned-Gemini model, use the REST equivalent: `POST …/endpoints/<ENDPOINT_ID>:deployModel` with `{"deployedModel": {"model": "projects/arkova1/locations/us-central1/models/6611494259700793344"}}` — tuned Gemini deployments carry no machine-spec.)
4. Smoke: one synthetic `generateContent` via the endpoint with `GEMINI_V6_PROMPT` semantics; confirm `description` + `subType` emit.
5. Wire `GEMINI_TUNED_MODEL=projects/270018525501/locations/us-central1/endpoints/<ENDPOINT_ID>` + `GEMINI_V6_PROMPT=true` on RIG-TUNED only (never prod).
6. Post-audit: `gcloud ai endpoints list --region=us-central1` — target ≤2 deployed; endpoint torn down at window close (L3-S5 verifies before/after per §0 rule 7; CTO founder-decision 4: teardown-over-keep-hot).

Constraints inherited from the tuned-model serving surface: tuned models **cannot use the global endpoint** (regional capacity only), and tuned inference **shares base-model quota** — the endpoint is an addressing construct, not reserved capacity (no 429 relief; see CTO R2).

## 8. Decision asks (founder packet)

1. Ratify **v6-primary + gated v7.1** (CTO R1) — this packet confirms both artifacts exist and the recreate path is ~10 min.
2. Note the A/B control is **today's real prod** (public flash, Developer-API surface) — not the stale v5-reasoning baseline.
3. v7.1 run proceeds with `exportLastCheckpointOnly: true` and window entry gated on offline DoD vs the leak-free corpus.
