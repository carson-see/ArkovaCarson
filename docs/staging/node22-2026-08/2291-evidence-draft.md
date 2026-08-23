<!--
DRAFT evidence block for PR #2291 — pre-staged 2026-08-23 while the T2 window was
still running. DO NOT paste into the PR body until every <<FILL-AT-CLOSE>> marker
is replaced with a close-time value (close-capture.sh summary + rollback-rehearsal
record + CI E2E run URL). An unfilled marker deliberately fails the gate's
timestamp/field parsing — that is the correct failure mode.

Field labels are the exact literals from scripts/ci/check-staging-evidence.ts
TIER_SPECS.T2 (line-anchored match), UNBOLDED on purpose: the extractor takes
everything after the label on the line, so `**Tier:** T2` would extract `** T2`.

Constraints that survive until merge:
  - #2291 stays DRAFT until this block is complete AND readiness is decided per
    process — a green non-draft PR on main IS the merge authorization (Mergify).
  - Any push to chore/worker-node-22 after 2026-08-22 invalidates this entire
    block (exact-head evidence, §1.11A) — the head below must still be the head.
  - Soak end must be >= 2026-08-23T09:27:29Z and the gate computes end-start >= 12 h.
-->

## Staging Soak Evidence

- Tier: T2
- Staging branch: chore/worker-node-22 (isolated rig deployed from this branch's frozen head by pinned digest — manual isolated-rig pattern, not a shared-staging branch push)
- Worker revision: arkova-worker-node22-staging-00001-8md
- PR head SHA: f41192e061d72ef8866f19dbd50c16593ccbca23
- Base SHA: 253c9999613110761231d5a86e1df0a4c3e208b4
- Staging project ref: yklabujmzhzbvnhovcjt (isolated project arkova-node22-2026-08, us-east-2, provisioned 2026-08-22 for this window; schema replayed to numeric head 0414 = main)
- Cloud Run service/tag URL: https://pr-2291---arkova-worker-node22-staging-kvojbeutfa-uc.a.run.app (service arkova-worker-node22-staging, us-central1, tag pr-2291 at 100%)
- Image digest: sha256:c6f51425d50744c8aeecf439dafae2b5055567ad440b9e891dae617f9d652556 (sole linux/amd64 manifest of pushed index sha256:0d087223f3ec16a66fd08caa2dfd80c2f65f6d9f4202f6ce468f2bbcbba1da43; digest-executed at stand-up: node v22.23.1)
- Evidence scope: merge-grade isolated staging
- Preflight timestamp: 2026-08-22T21:30:27Z
- Preflight result: environment_type=clean_mirror, exit 0, 8/8 checks (post-#2319 checker run from the PR-head worktree so the repo migration set is #2291's own; prod ref vzwyaatejekddvltxyye; verbatim JSON in docs/staging/node22-2026-08/soak-start-2026-08-22T2127Z.md)
- Soak start: 2026-08-22T21:27:29Z
- Soak end: <<FILL-AT-CLOSE — the revision-unchanged confirmation time from close-capture summary.md, at/after 2026-08-23T09:27:29Z>>
- E2E result: <<FILL-AT-CLOSE — CI E2E run URL at head f41192e0…, must be green at this exact head>>
- Migration applied: N/A — #2291 touches no supabase/migrations file (runtime-only: node:20-alpine -> node:22-alpine both stages, engines >=22.19.0, .node-version, CI to Node 22). The rig's 112-file schema replay is environment provisioning, logged in docs/staging/node22-2026-08/replay-log-2026-08-22.json
- Rollback rehearsed: <<FILL-AT-CLOSE — run rollback-rehearsal.sh AFTER close-capture (post-close only: the deploy creates a new revision and moves latestRevision — clock already sealed); paste rehearsal record path + the three PASS lines: rollback digest executes v20.x, rollback /health 3/3x200, restore 00001-8md@100% + digest re-executes v22.23.1>>
- Staging deploy log id: N/A — public.staging_deploy_log does not exist in the replayed chain (verified empty information_schema readback on this rig at stand-up) and this was the manual isolated-rig deploy pattern, not scripts/staging/deploy.sh (hard-scoped to shared arkova-worker-staging). Deploy artifact in its place: the digest chain above + revision 00001-8md createTime 2026-08-22T21:27:29.654107Z

### Soak evidence detail

- Clock (FD-CLOCK-1): revision 00001-8md creationTimestamp 2026-08-22T21:27:29.654107Z -> close <<FILL-AT-CLOSE>>; revision at close <<FILL-AT-CLOSE: unchanged + only revision that served in-window, from close-capture §2/§3>>
- Load: ~19 req/min offered for 12 h (core health+2 verify shapes @10 s, member 404/401/cron block @5 min) under the code-enforced 60/min/IP apiIpShadowGuard ceiling; driver totals <<FILL-AT-CLOSE: ok/fail, status_200/404/401/429/other, coldStartRetries, deviations — from close-capture driver-rollup.json>>
- 5xx in-window: <<FILL-AT-CLOSE: close-capture §5 total + per-path counts, or "zero">>
- Runtime proof: deployed digest executed -> v22.23.1; fingerprint {node v22.23.1, undici 6.27.0, openssl 3.5.7, v8 12.4.254.21-node.56}; index->manifest->revision digest chain byte-identical (stand-up doc §"Node 22 runtime PROOF")
- Verification API live on rig: switchboard ENABLE_VERIFICATION_API=true seeded + read back; /api/v1/verify serves both projection shapes with content (0.74 s first-hit), not a fail-closed 503
- What this window does NOT cover (recorded in the maturity record): prod-shaped load/concurrency, multi-org behavior (single-org rig), anchoring/chain/treasury paths (ENABLE_PROD_NETWORK_ANCHORING=false, no WIF), batch triggers, long-horizon memory behavior, connector document paths
- Maturity record: docs/staging/node22-2026-08/maturity-<<FILL-AT-CLOSE: closeUTC>>.md
- Human approver: <<FILL-AT-CLOSE — named approver for the T2 ready decision>>
