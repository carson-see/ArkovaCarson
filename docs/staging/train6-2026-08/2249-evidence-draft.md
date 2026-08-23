<!--
DRAFT evidence block for PR #2249 — pre-staged 2026-08-23 while the T3 window was
still running. #2249 exits through the DEFERRED CONSOLIDATED SOAK manifest, so
this block REPLACES the PR body's current `## Staging Soak Evidence` section
(which is an honest all-NOT-RUN placeholder) with the RC-manifest reference plus
an informational soak summary. DO NOT paste until:
  (a) the window is sealed (close-capture run),
  (b) origin/main is merged into the branch (post-seal — a mid-soak push would
      have invalidated the frozen head),
  (c) the manifest roster move has MERGED to main (the gate loads the manifest
      from the PR's own checked-out tree, which contains main's copy), and
  (d) the manifest entry's head_sha equals the LIVE head after (b).

Gate mechanics verified against scripts/ci/check-staging-evidence.ts at pre-stage:
  - `RC manifest path:` in the body routes the whole check through
    rcManifestCoverage -> deferredConsolidatedSoakCoverage; the per-PR T3 field
    set is NOT evaluated on this path (the informational lines below are for
    humans and the audit trail, not the parser).
  - Hard precondition: vars.DEPLOY_WORKER_PAUSED must be POSITIVELY confirmed
    "true" on the run (it was `true` at pre-stage; the deferred path fails
    closed without it).
  - The manifest entry must carry the CURRENT head_sha (exact-head binding),
    risk_tier >= T3 (path detector: anchorExpirySweep.ts), owner, ci_summary,
    rollback_note; migration_files [] is correct (#2249 touches no migrations).
  - SOAK_GATE_DISABLED = false at pre-stage — the gate is live and will read this.
  - Labels below are UNBOLDED so the extractor reads clean values.
-->

## Staging Soak Evidence

- Tier: T3
- RC manifest path: docs/staging/rc-manifests/rc-deferred-2026-08-22.json
- PR head SHA: <<FILL-AT-READY: the live head AFTER the post-seal merge of origin/main — must equal the manifest entry's head_sha exactly>>

### TRAIN-6 window-2 soak summary (informational — the manifest + maturity record are the audited evidence)

- Soaked head: union `f0e4cfe2e375b838a6f164f7c15e23d6b981c34b` = this PR's frozen `df0e6fa932660d783fd5ca804b4c9c1dc5395684` on base `224cef8a99eaeacc8cf535890f0dbfca1730d382`, on `arkova-worker-wave2-2026-08-staging` rev `00006-gik`, tag `train-6`, Supabase `tkciooifwxwnkoizgalp` (isolated)
- Window: 2026-08-21T20:33:58Z -> <<FILL-AT-CLOSE: sealed close time>> (48 h T3; clock = revision creationTimestamp per FD-CLOCK-1, revision unchanged <<FILL-AT-CLOSE: confirm from close-capture §2/§3>>)
- Window 1 (18:54:36Z) is VOID — FD-SEED-1/FD-TRAIN6-1 (fixture self-reverted; preflight failed). Window 2 reseeded with the durable fixture (5 SUBMITTED with chain_tx_id + legal_hold; 100 staggered SECURED; positive control reclaimed at 20:32:10Z proving the reclaimer was live while Set A survived) and restarted the clock on a fresh revision.
- Preflight: environment_type=clean_mirror, exit 0, six checks, 2026-08-21T20:36:36Z (+ agreeing 20:26:30Z run — the two bracket the clock start; verbatim in docs/staging/train6-2026-08/soak-start-2026-08-21T2038Z.md)
- Changed-path coverage: every fixture id is a non-RFC uuid (the FD-15 defect shape), so every SECURED->EXPIRED transition (<<FILL-AT-CLOSE: final expired count>> across the window) drove both changed anchorExpirySweep sites, and the org-queue claim path accepted the non-RFC org id at window start and again at +24 h <<FILL-AT-CLOSE: second-claim timestamp from close-capture §6>>
- Driver: <<FILL-AT-CLOSE: cycles / ok / fail / 429 (must be 0) from driver-rollup>>; fixture invariant submitted=5 audited every cycle, min <<FILL-AT-CLOSE: must be 5>>; secured+expired=100 conserved <<FILL-AT-CLOSE: confirm conservation_violations=[]>>; single deviation: one non-recurring health 503 (2026-08-22T01:11Z cycle)
- 5xx: <<FILL-AT-CLOSE: non-declared total from close-capture §5; the /jobs/professional-education-extraction 503 stream is declared fail-closed behavior, itemized separately>>
- Rollback rehearsed: <<FILL-AT-CLOSE: from rollback-rehearsal.sh record — digest-executed main-head image, new revision healthy 3x200, traffic restored to 00006-gik. Worker-code-only PR: deploy rollback IS the rollback>>
- T3 residuals: <<FILL-AT-CLOSE: from the maturity T3 table — Trigger A/B / daily flush / per-org isolation, each FIRED-with-artifact or honestly NOT RUN; NOT-run rows are named residuals carried into the consolidated soak of merged main>>
- Maturity record: docs/staging/train6-2026-08/maturity-<<FILL-AT-CLOSE: closeUTC>>.md
- Post-seal head motion: origin/main merged into the branch AFTER the window sealed (merge commit only — `git rev-list <frozen>..<live> --not origin/main` must return exactly the merge commit; per-file audit in this PR body if anything else moved). The soak window is not re-claimed for the new head; merge-grade evidence for merged main is owed by the consolidated soak, per the manifest's pause_lift_obligation.
- Human approver: <<FILL-AT-READY: named approver for the T3 ready decision>>
