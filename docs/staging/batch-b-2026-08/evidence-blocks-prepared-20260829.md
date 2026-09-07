# Batch B — prepared T2 evidence blocks

Format validated against `scripts/ci/check-staging-evidence.ts` `missingFields(body,'T2')` -> ALL T2 FIELDS PARSE OK.
Fields are UNBOLDED on purpose: the parser is
`^[\s\-*]*(?:\[[ x]\]\s*)?<Field:>[^\S\n]*(.*)$` — a bolded label leaves the trailing `**` inside the
captured value and the field silently fails.

DO NOT paste a block into a PR body until that PR's window has closed and `Rollback rehearsed:` is real.
`Rollback rehearsed:` is the only field left as a placeholder; everything else below is verified.


---

## PR #2434 — fix(edge): stop oracle_batch_verify discarding the whole batch on one bad member [DI-038]

```markdown
## Staging Soak Evidence

Tier: T2
- Staging branch: fix/mcp-oracle-batch-verify-partial-results
- Worker revision: arkova-worker-staging-00354-wod
- PR head SHA: 1095e647e0d8df02ea38c3b41018b504680ad615
- Base SHA: 0f0eda6528728c051a7e62b785168ea3605d5021
- Staging project ref: fizyjojbebyalirtjjht
- Cloud Run service/tag URL: arkova-worker-staging / https://pr-2434---arkova-worker-staging-kvojbeutfa-uc.a.run.app
- Image digest: sha256:28fd519748a590911f4b0402cc4d957846373cf3f4a1c06dadee084cf994b8db
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-08-29T14:15:34.220Z
- Preflight result: environment_type=clean_mirror, 8/8 checks passed, ref fizyjojbebyalirtjjht (artifact docs/staging/batch-b-2026-08/preflight-20260829T141523Z.json; re-run at 2026-08-29T21:11:45.744Z also clean_mirror 8/8)
- Soak start: 2026-08-29T23:04:27Z
- Soak end: 2026-08-30T11:04:27Z
- E2E result: services/edge npm test 60 passed; CI green https://github.com/carson-see/ArkovaCarson/actions/runs/32677838876
- Migration applied: none
- Rollback rehearsed: FILL AT CLOSE — re-tag pr-2434 to the prior known-good revision, authenticated /health 200, re-tag forward, authenticated /health 200
- Staging deploy log id: 4
- Changed behavior: oracle_batch_verify returns per-member partial results when one member fails at the network layer instead of discarding the whole batch; envelope signing, ordering, Layer-A guards and the edge auth boundary stay intact
- Targeted evidence: per-cycle 27-check drive of oracle_batch_verify on a local workerd running THIS PR's services/edge/src/mcp-server.ts, with edge-fault-proxy.mjs stalling Supabase get_public_anchor for ARK-BBSTALL-000001 past the 10s SUPABASE_FETCH_TIMEOUT_MS — the only way to reach the per-member failure branch this PR isolates; asserts six results returned not discarded, envelope alg/sig/key_id/query_id, oversized-batch INVALID_ARGS rejection, and 401 + WWW-Authenticate on missing and bogus credentials
- Load/concurrency evidence: continuous 30s-gap cycles each issuing a mixed 6-member batch plus an all-bad batch plus an oversized batch under injected network-layer fault, with rate_limit_exceeded counted per cycle
- Rollback plan: re-tag `pr-2434` on arkova-worker-staging to the prior known-good revision; prod is untouched (this PR is not deployed to arkova-worker)
- Risk rationale: Cloudflare edge worker MCP contract surface -> T2 by path detector
- Approver: Claude Opus 5, acting CTO under delegated technical authority (Carson, 2026-08-28)
```

Deviations to disclose: see docs/staging/batch-b-2026-08/soak-status-20260829T2310Z.md; window restarted 23:04:27Z because the local edge was down for the earlier attempt

---

## PR #2435 — fix(webhooks): release the replay nonce before every post-nonce 5xx (SCRUM-3479)

```markdown
## Staging Soak Evidence

Tier: T2
- Staging branch: fix/checkr-webhook-nonce-release
- Worker revision: arkova-worker-staging-00356-qip
- PR head SHA: b7d4c30a9a3828c4fc246eb2d5debc4233e39658
- Base SHA: 0f0eda6528728c051a7e62b785168ea3605d5021
- Staging project ref: fizyjojbebyalirtjjht
- Cloud Run service/tag URL: arkova-worker-staging / https://pr-2435---arkova-worker-staging-kvojbeutfa-uc.a.run.app
- Image digest: sha256:b9992556c2fa5a8feface98cff064073177d6fc1dd2ec996f08e3585681b9661
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-08-29T14:15:34.220Z
- Preflight result: environment_type=clean_mirror, 8/8 checks passed, ref fizyjojbebyalirtjjht (artifact docs/staging/batch-b-2026-08/preflight-20260829T141523Z.json; re-run at 2026-08-29T21:11:45.744Z also clean_mirror 8/8)
- Soak start: 2026-08-29T14:53:37Z
- Soak end: 2026-08-30T02:53:37Z
- E2E result: webhooks folder 134 passed, api-e2e 35 passed; CI green https://github.com/carson-see/ArkovaCarson/actions/runs/32677892622
- Migration applied: none
- Rollback rehearsed: FILL AT CLOSE — re-tag pr-2435 to the prior known-good revision, authenticated /health 200, re-tag forward, authenticated /health 200
- Staging deploy log id: 6
- Changed behavior: the Checkr and ATS webhook handlers release the replay nonce before every post-nonce 5xx, so a transient downstream failure does not permanently burn the nonce and block a legitimate retry
- Targeted evidence: per-cycle drive of the checkr and ats webhook routes on tag pr-2435: poison payload must return 500 and the SAME delivery must then be retryable (nonce released), missing-signature must 401, the unconfigured-secret guard must 503 prod-faithfully, and the guard must precede both the signature check and the event-type filter
- Load/concurrency evidence: 281 in-window cycles at a ~112s cadence, each replaying poison and duplicate deliveries against the nonce store; an additional concurrent driver instance drove the same tag from 14:42Z to 23:03Z producing extra load but no artifacts (disclosed, not claimed)
- Rollback plan: re-tag `pr-2435` on arkova-worker-staging to the prior known-good revision; prod is untouched (this PR is not deployed to arkova-worker)
- Risk rationale: worker webhook handler + replay-nonce semantics -> T2 by path detector
- Approver: Claude Opus 5, acting CTO under delegated technical authority (Carson, 2026-08-28)
```

Deviations to disclose: 4 of 281 in-window cycles carried deviations, ALL with status=0 (dead socket, not a status code): ats_poison_2.500_not_200_duplicate, checkr.guard_precedes_signature_check, ats_missing_sig.401, checkr.unconfigured_503_prod_faithful, checkr.guard_precedes_event_type_filter x2. Discriminating signal: the guard check's own detail states 401 would be the alarming value and 401 was never observed

---

## PR #2437 — fix(sec): gate GET /api/queue/pending on ORG_ADMIN (SCRUM-3569)

```markdown
## Staging Soak Evidence

Tier: T2
- Staging branch: fix/queue-pending-org-admin-gate
- Worker revision: arkova-worker-staging-00358-yon
- PR head SHA: 6b7229f4b2d7faeb32bad0a0e3209430bd4c8243
- Base SHA: 0f0eda6528728c051a7e62b785168ea3605d5021
- Staging project ref: fizyjojbebyalirtjjht
- Cloud Run service/tag URL: arkova-worker-staging / https://pr-2437---arkova-worker-staging-kvojbeutfa-uc.a.run.app
- Image digest: sha256:0d49c0e48b90b488007fb5a4eeb844ad126398f1f968a58a8ef6f789fa9ec1cc
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-08-29T14:15:34.220Z
- Preflight result: environment_type=clean_mirror, 8/8 checks passed, ref fizyjojbebyalirtjjht (artifact docs/staging/batch-b-2026-08/preflight-20260829T141523Z.json; re-run at 2026-08-29T21:11:45.744Z also clean_mirror 8/8)
- Soak start: 2026-08-29T23:04:17Z
- Soak end: 2026-08-30T11:04:17Z
- E2E result: CI green https://github.com/carson-see/ArkovaCarson/actions/runs/32685732191
- Migration applied: none
- Rollback rehearsed: FILL AT CLOSE — re-tag pr-2437 to the prior known-good revision, authenticated /health 200, re-tag forward, authenticated /health 200
- Staging deploy log id: 8
- Changed behavior: GET /api/queue/pending is gated on ORG_ADMIN, enforces org isolation, and the OpenAPI document declares the 403 and cites SCRUM-3569
- Targeted evidence: per-cycle 20-check drive of GET /api/queue/pending on tag pr-2437: ORG_ADMIN allowed, non-admin member 403 with a role message, cross-org caller 403 with an org-boundary message, missing org header 400, plus the OpenAPI contract assertions that the 403 response is declared and cites SCRUM-3569
- Load/concurrency evidence: continuous 30s-gap cycles against the shared rig concurrently with four other batch-B soaks and batch-A traffic on the same adminRouter 10/min bucket; 429s counted per cycle and tolerated only as the named shared-bucket signal
- Rollback plan: re-tag `pr-2437` on arkova-worker-staging to the prior known-good revision; prod is untouched (this PR is not deployed to arkova-worker)
- Risk rationale: worker authorization gate on an admin API route -> T2 by path detector
- Approver: Claude Opus 5, acting CTO under delegated technical authority (Carson, 2026-08-28)
```

Deviations to disclose: window restarted 23:04:17Z; the earlier attempt produced no artifacts at all (sandboxed supervisor, EPERM at writeCycle) — see soak-status-20260829T2310Z.md

---

## PR #2439 — fix(api): enforce JWT-claims scopes on the FERPA/HIPAA/emergency-access PHI routes (SCRUM-3514)

```markdown
## Staging Soak Evidence

Tier: T2
- Staging branch: fix/jwt-scope-enforcement-phi-routes
- Worker revision: arkova-worker-staging-00364-qis
- PR head SHA: 279e276a27cf07ecc9244df63f65c3f6159aafec
- Base SHA: 0f0eda6528728c051a7e62b785168ea3605d5021
- Staging project ref: fizyjojbebyalirtjjht
- Cloud Run service/tag URL: arkova-worker-staging / https://pr-2439---arkova-worker-staging-kvojbeutfa-uc.a.run.app
- Image digest: sha256:914671b39a5e6bb84a209d21c6643c765ba16b4326daf962f50083d82852e791
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-08-29T14:15:34.220Z
- Preflight result: environment_type=clean_mirror, 8/8 checks passed, ref fizyjojbebyalirtjjht (artifact docs/staging/batch-b-2026-08/preflight-20260829T141523Z.json; re-run at 2026-08-29T21:11:45.744Z also clean_mirror 8/8)
- Soak start: 2026-08-29T15:34:50Z
- Soak end: 2026-08-30T03:34:50Z
- E2E result: CI green https://github.com/carson-see/ArkovaCarson/actions/runs/33257897396
- Migration applied: none
- Rollback rehearsed: FILL AT CLOSE — re-tag pr-2439 to the prior known-good revision, authenticated /health 200, re-tag forward, authenticated /health 200
- Staging deploy log id: 12
- Changed behavior: requireScopeAnyAuth(compliance:read) on the four PHI mounts: JWT-claim scope enforcement, the intersection rule, the API-key branch, and the role and org boundaries behind it
- Targeted evidence: per-cycle 24-check drive of the FERPA/HIPAA/emergency-access PHI routes on tag pr-2439: a downscoped caller must get 403 with error=insufficient_scope, required=compliance:read and granted=[]; an admin with the scope must get 200; a cross-org caller 403; a non-admin member 403 on the admin route and 200 on the member route; a missing org header 400
- Load/concurrency evidence: 79 in-window cycles at a ~5m45s cadence continuously exercising the scope-gated PHI mounts alongside four other concurrent batch-B soaks on the same rig
- Rollback plan: re-tag `pr-2439` on arkova-worker-staging to the prior known-good revision; prod is untouched (this PR is not deployed to arkova-worker)
- Risk rationale: worker auth middleware on PHI routes -> T2 by path detector
- Approver: Claude Opus 5, acting CTO under delegated technical authority (Carson, 2026-08-28)
```

Deviations to disclose: 4 of 79 in-window cycles carried deviations, ALL with status=0 (transport). ZERO authorization deviations. All 78 artifacted cycles show downscoped.403_not_200, downscoped.required_named, downscoped.granted_empty and downscoped.insufficient_scope as ok=true with a real 403 body

---

## PR #2441 — fix(ratelimit): give every limiter its own bucket and hand public verify its §1.10 100/min

```markdown
## Staging Soak Evidence

Tier: T2
- Staging branch: fix/ratelimit-per-limiter-bucket-scope
- Worker revision: arkova-worker-staging-00365-weh
- PR head SHA: 5b5ccea937c4c30363bf2435bdcd4d712c95b905
- Base SHA: f576e2f64ccbca93bdd39fd0764f7690532c69ad
- Staging project ref: fizyjojbebyalirtjjht
- Cloud Run service/tag URL: arkova-worker-staging / https://pr-2441---arkova-worker-staging-kvojbeutfa-uc.a.run.app
- Image digest: sha256:2d1bd68102523ef1fd26a888ac0624b6162df4d85731c6a26b2b39e7e304ae3b
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-08-29T14:15:34.220Z
- Preflight result: environment_type=clean_mirror, 8/8 checks passed, ref fizyjojbebyalirtjjht (artifact docs/staging/batch-b-2026-08/preflight-20260829T141523Z.json; re-run at 2026-08-29T21:11:45.744Z also clean_mirror 8/8)
- Soak start: 2026-08-29T15:34:50Z
- Soak end: 2026-08-30T03:34:50Z
- E2E result: e2e/verify-ratelimit-contract.spec.ts green; CI green https://github.com/carson-see/ArkovaCarson/actions/runs/33258422188
- Migration applied: none
- Rollback rehearsed: FILL AT CLOSE — re-tag pr-2441 to the prior known-good revision, authenticated /health 200, re-tag forward, authenticated /health 200
- Staging deploy log id: 13
- Changed behavior: every limiter gets its own bucket instead of sharing one, and public verify gets its §1.10 100/min cap with Retry-After on 429
- Targeted evidence: per-cycle 108-request burst against /api/v1/verify on tag pr-2441 asserting the first-429 index, X-RateLimit-Limit=100 after the window resets, Retry-After present on the 429, and that the uppercase path is counted by the verify bucket rather than a sibling limiter
- Load/concurrency evidence: 120 in-window cycles x 108-request concurrent bursts (~12,960 requests) against the verify bucket, with the first-429 index recorded every cycle and the limit re-read after each window reset
- Rollback plan: re-tag `pr-2441` on arkova-worker-staging to the prior known-good revision; prod is untouched (this PR is not deployed to arkova-worker)
- Risk rationale: worker rate-limit middleware on the public verify API contract -> T2 by path detector
- Approver: Claude Opus 5, acting CTO under delegated technical authority (Carson, 2026-08-28)
```

Deviations to disclose: 2 of 120 in-window cycles carried deviations. All but one are status=0. The exception, uppercase.counted_by_verify_bucket status=200, occurred in the SAME cycle (162732Z) whose health.200 failed status=0 and whose burst recorded first429=-1 of 108 burst_abort_status=null — the burst never completed so no counter existed to count against; the other 119 cycles pass it
