# T2/T3 Rollout Status - 2026-06-08

This is an engineering coordination artifact. Confluence/Jira remain the story/documentation source of truth.

## Snapshot

- Checked at: `2026-06-08T14:31:46Z` / `2026-06-08 10:31 EDT`
- Current `origin/main`: `bf40e389fd1644aea94557366e367b7b66df7616`
- Production proof: Deploy Worker run `27112157154`, Revision Drift Alert run `27129992459`, `/health.git_sha=bf40e389fd1644aea94557366e367b7b66df7616`
- There is no `prod` branch/ref; use deploy/revision-drift/health evidence for prod-active proof.

## T2 State

Merged and prod-contained T2s:

| PR | Merge SHA | State |
|---|---|---|
| #1098 | `217a542d` | merged, contained in prod SHA |
| #1104 | `bf40e389` | merged, current prod SHA |
| #1108 | `b5110320` | merged, contained in prod SHA |
| #1110 | `f60ccef8` | merged, contained in prod SHA |
| #1119 | `68671aec` | merged, contained in prod SHA |
| #1123 | `37d46d59` | merged, contained in prod SHA |

Active T2:

| PR | Head | Base | Evidence | Expected end |
|---|---|---|---|---|
| #1121 | `7918753029aa9b8d761930e520695e44f29bc9af` | `bf40e389fd1644aea94557366e367b7b66df7616` | `/private/tmp/arkova-soaks/soak-pr-1121-mcp-context-redial-pvtqcpegmnoumsnklkvk-79187530-20260608T0517Z.jsonl` | `2026-06-08T17:17:41.305Z` |

Latest #1121 audit at `2026-06-08T14:31:46Z`: 1,546 rows; 515 health / 515 metadata / 515 `nessie_query_context`; zero bad rows; latest context HTTP 200, valid context true, 5 citations, confidence 0.79. Screen `arkova-t2-redial-1121-79187530` and child node runner are alive. Clock is not complete; finalization remains disallowed until `2026-06-08T17:17:41.305Z` plus final summary/rollback/check gates.

## Open PR Queue

| PR | Tier | Current bucket | Immediate blocker |
|---|---|---|---|
| #1122 | T3 | pending/stale | migration train B tail, base `68671aec`, no deploy/preflight/smoke/rollback |
| #1121 | T2 | active soak | waits for clock/final evidence/rollback/green soak gate |
| #1114 | T3 | pending/stale | migration train B, base `68671aec`, no deploy/preflight/smoke/rollback |
| #1112 | T3 | pending/stale | migration train B, base `68671aec`, no deploy/preflight/smoke/rollback |
| #1111 | T3 | pending/stale | migration train B, base `68671aec`, no deploy/preflight/smoke/rollback |
| #1107 | T3 | pending/stale | migration train B, base `68671aec`, no deploy/preflight/smoke/rollback |
| #1106 | T2 | dirty/stale | conflicting intentional red-test draft |
| #1105 | T0/T1 | human decision | not a T2/T3 soak candidate until risk is decided |
| #1101 | T3 | pending/stale | migration train B start, base `68671aec`, no deploy/preflight/smoke/rollback |
| #1100 | T3 | pending/stale | migration train B, base `68671aec`, no deploy/preflight/smoke/rollback |
| #1087 | T3 | do-not-merge | dependency bump, stale base `55e906cf` |
| #1055 | T3 | blocked/no-start | must wait for #1121 merged and prod-active, then refresh on post-#1121 main |
| #1047 | T3 | blocked/stale | old evidence stale, prod ledger 0327, after T2 lane closes |
| #1041 | T2 | pending/stacked | behind #1038/#1039/#1040, UAT pending |
| #1040 | T2 | pending/stacked | behind #1038/#1039 |
| #1039 | T2 | pending/stacked | behind #1038 |
| #1038 | T3 | dirty/stale | migration train A after #1047 -> #971 |
| #971 | T3 | blocked/stale | waits on #1047/0327 and fresh exact-head T3 evidence |

## Safe Synchronized T3 Launch

No T3 is eligible to start before #1121 is merged and prod-verified. Starting now would create evidence tied to stale `main` and stale PR bases.

After #1121:

1. Build #1121 prod proof: merged state, green current soak gate, post-#1121 `origin/main`, prod health SHA, production `nessie_query` smoke.
2. Freeze the post-#1121 main SHA for the T3 launch wave.
3. Refresh/restack each T3 candidate onto that frozen SHA or the required cumulative stack order.
4. Re-run GitHub checks and clean-mirror/isolated preflight before any soak clock.
5. Deploy exact heads and record tag URL, worker revision, image digest, deploy run/log, targeted smoke, and rollback/restore proof.
6. Start 48h clocks as close together as dependency order allows.
7. Do not update final PR/Jira/Confluence closeout until final evidence gates pass.

Launch grouping:

- Standalone first: #1055, after #1121 prod proof and #1055 refresh.
- Migration train A: #1047 -> #971 -> #1038. #1039/#1040/#1041 remain stacked T2s behind #1038.
- Migration train B: #1101 -> #1100 -> #1111 -> #1112 -> #1114 -> #1107 -> #1122.
- #1087 remains do-not-merge; #1105 remains T0/T1 human decision.

## Current Commands

Current #1055 prep:

- `RUN_LOCAL_TESTS=1 ./pr-1055-t3-runner.sh verify-local` passed typecheck and 6 focused worker test files / 258 tests at `2026-06-08T14:28:50Z`.
- Log: `/private/tmp/arkova-soaks/pr-1055-t3-prep/logs/local-focused-tests.20260608T142837Z.log`.
- Guard checks correctly fail before authorization/final proof: `start-soak` requires `PR1055_ALLOW_SOAK_START=1`; #1121 prod proof cannot build while #1121 is unmerged; placeholder proof text is rejected.

Read-only status:

```bash
bash /private/tmp/arkova-soaks/pr-1121-finalize/status-pr-1121.sh
gh pr list --state open --limit 100
screen -ls
curl -fsS https://arkova-worker-kvojbeutfa-uc.a.run.app/health | jq -c '{status,git_sha}'
```

Post-#1121 #1055 launch prep:

```bash
cd /private/tmp/arkova-soaks/pr-1055-t3-prep
PR1121_PROD_HEALTH_URL=https://arkova-worker-kvojbeutfa-uc.a.run.app/health \
PR1121_PROD_SMOKE_PROOF=/private/tmp/arkova-soaks/pr-1121-finalize/pr-1121-prod-nessie-query-smoke.json \
./build-pr-1121-prod-proof.sh
```

The #1055 runner intentionally refuses `start-soak` until `PR1055_T2_LANE_PROD_VERIFIED=1` and `PR1055_T2_LANE_PROD_PROOF` points at valid #1121 prod proof.
