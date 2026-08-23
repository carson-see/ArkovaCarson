<!--
DRAFT evidence block for PR #2314 — pre-staged 2026-08-23 while the T3 window was
still running. This REPLACES the PR body's current `## Staging Soak Evidence`
section wholesale: the current block predates the soak (every field "NOT RUN")
AND uses labels the gate does not parse (`Soak start → end:` is one line — the
gate requires separate `Soak start:` / `Soak end:` lines; `Trigger A fired:` is
not the required literal `Trigger A fires:`; bolded labels corrupt value
extraction). DO NOT paste until every <<FILL-AT-CLOSE>> / <<FILL-AT-READY>>
marker is replaced. An unfilled marker deliberately fails the gate's parsing —
that is the correct failure mode.

Field labels below are the exact literals from scripts/ci/check-staging-evidence.ts
TIER_SPECS.T3 (line-anchored match), UNBOLDED on purpose: the extractor takes
everything after the label on the line, so `**Tier:** T3` would extract `** T3`
and the Soak start/end timestamps would stop parsing.

Gate facts verified at pre-stage (2026-08-23):
  - SOAK_GATE_DISABLED = false — the gate is LIVE; this block will actually be read.
  - `PR head SHA:` is compared against the LIVE PR head at gate time
    (shaEvidenceErrors) — it must carry the live head, NOT the soaked head. The
    soaked-head deviation is disclosed in its own labeled line + the maturity
    record, per §1.11A.
  - `Worker revision:` and `Staging deploy log id:` reject a BARE "N/A" but accept
    "N/A — <explanation>" (NOT_APPLICABLE_VALUE_RE is anchored to the whole value).
  - Soak start/end must parse as timestamps and differ by >= 48 h for T3.

Constraints that survive until merge:
  - #2314 stays DRAFT until this block is complete AND the exact-head deviation
    has a named ruling — a green non-draft PR on main IS the merge authorization
    (Mergify embarks it).
  - Any FURTHER push to fix/fd-ferpa-1-directory-opt-out-public-projections
    invalidates the `PR head SHA:` below and re-opens the §1.11A question.
  - T3 rows honestly marked NOT RUN below are residuals: they need the named
    approver line, not silent rounding-up.
-->

## Staging Soak Evidence

- Tier: T3
- Staging branch: fix/fd-ferpa-1-directory-opt-out-public-projections (isolated rig deployed from the frozen soaked head 93747a6aa451991476ab0b00d58c3fb0754f2e2d by pinned digest — manual isolated-rig pattern, not a shared-staging branch push)
- Worker revision: arkova-worker-ferpa2314-staging-00001-cit
- PR head SHA: <<FILL-AT-READY: the LIVE head at ready time — 99ea75fbfda0d0fa800b3e7871fb1becf4327ecd at pre-stage. The gate compares this against the live head; the soak ran at 93747a6aa… — deviation disclosed below and in the maturity record>>
- Base SHA: <<FILL-AT-READY: `git merge-base origin/main <live-head>` at ready time>>
- Staging project ref: wjuelohtpklodpjklvqy (isolated project arkova-ferpa-2314-2026-08, us-east-2, provisioned 2026-08-21 for this window; schema replayed to numeric head 0409 + 0415 applied byte-exact, ledger head 0415)
- Cloud Run service/tag URL: https://pr-2314---arkova-worker-ferpa2314-staging-kvojbeutfa-uc.a.run.app (service arkova-worker-ferpa2314-staging, us-central1, tag pr-2314 at 100%)
- Image digest: sha256:be79097dc3fcf9b755d45ad301cd55abb28f33a8726226386fdcb8986e5ef518
- Evidence scope: merge-grade isolated staging
- Preflight timestamp: 2026-08-21T19:26:09Z
- Preflight result: environment_type=clean_mirror, exit 0, 7/7 checks (FD-PREFLIGHT-1-fixed checker, run from the PR-head checkout so the repo migration set is #2314's own; a 6/6 run 16 s earlier agreed; verbatim JSON in docs/staging/pr2314-ferpa-2026-08/soak-start-2026-08-21T1924Z.md)
- Soak start: 2026-08-21T19:24:30Z
- Soak end: <<FILL-AT-CLOSE: the revision-unchanged confirmation time from close-capture summary.md, at/after 2026-08-23T19:24:30Z>>
- E2E result: <<FILL-AT-READY: CI E2E run URL at the live head, must be green at that exact head>>
- Migration applied: 0415_ferpa_directory_info_opt_out_public_projections.sql — applied byte-exact to the rig (file md5 = payload md5 = 192e5797b9fc052ae0e8dbbeb3d4bd9a; all three function bodies md5-verified from pg_proc.prosrc post-apply; ledger confirmed numeric head 0415 via list_migrations, §0-rule-10 UPDATE ran as verification: 0 rows). NOT applied to prod — prod apply is the RTE's post-merge action
- Rollback rehearsed: <<FILL-AT-CLOSE: run rollback-rehearsal.sh AFTER close-capture and AFTER stopping the supervisor (it overruns close by ~4 h — -u-less end-epoch parse). Paste: prod-md5 gate PASS (prod pre-0415 bodies 83770cae…/6c2d77e1…), rig rollback md5s + search match-set 1→2 PASS, 0415 re-apply md5s + match-set 2→1 PASS, digest-executed deploy rollback + 3x200 health PASS, traffic restored to 00001-cit PASS; record path>>
- Staging deploy log id: N/A — public.staging_deploy_log does not exist in this rig's replayed chain and this was the manual isolated-rig deploy pattern (digest-pinned gcloud run deploy), not scripts/staging/deploy.sh (hard-scoped to shared staging). Deploy artifacts in its place: revision 00001-cit createTime 2026-08-21T19:24:30.248332Z + the image digest above
- Trigger A fires: <<FILL-AT-CLOSE: from the maturity T3 table — FIRED with artifact path, or "NOT RUN — ambient load cannot reach 10,000 (FD-TRIGGER-1); volume run not executed this window; residual accepted by <approver>">>
- Trigger B fires: <<FILL-AT-CLOSE: same shape as Trigger A>>
- Daily flush observation: <<FILL-AT-CLOSE: what the 03:00Z captures show on 2026-08-22 and 2026-08-23 (close-capture §6) — an observation over a ~1–2 row PENDING population, stated as such, or "NOT OBSERVED — residual accepted by <approver>">>
- Per-org isolation check: <<FILL-AT-CLOSE: single-org rig — either the second-org check that was actually run, or "NOT DONE — single-org rig, isolation not claimable from this window; residual accepted by <approver>">>

### Soak evidence detail

- Clock (FD-CLOCK-1): revision 00001-cit creationTimestamp 2026-08-21T19:24:30.248332Z -> close <<FILL-AT-CLOSE>>; revision at close <<FILL-AT-CLOSE: unchanged + only revision that served in-window, from close-capture §2/§3>>
- Soaked head vs PR head (§1.11A disclosure): the rig soaked head 93747a6aa451991476ab0b00d58c3fb0754f2e2d for the full window (BUILD_SHA + /health git_sha + digest all pin it). The live head above differs by exactly two test-only commits (37414cd3f, fed9ff08b — tests/rls fixture ownership) plus two merges of origin/main (c47c471ad, 99ea75fbf). No runtime/migration/worker file differs from (soaked head + main). Ruling: <<FILL-AT-READY: named CTO/Carson acceptance of the live head on this evidence, or a re-soak decision — this block is not merge-grade without it>>
- Load: ~18 req/min offered for 48 h minus one disclosed 3h34m fail-loud gap (2026-08-22T11:30:06Z cold-start 503 -> supervisor stop by design -> 15:04:01Z restart with bounded, counted cold-start retry); loaded coverage <<FILL-AT-CLOSE: expected ≈92.6%>>; driver totals <<FILL-AT-CLOSE: ok/fail, status_200/404/429/other, coldStartRetries, deviations — from close-capture driver-rollup.json>>; the 2026-08-21T19:30:56Z verification run that discovered the real 60/min ceiling (10x429) is kept in evidence deliberately and excluded from sustained totals
- 5xx in-window: <<FILL-AT-CLOSE: close-capture §5 total + per-path counts; at least the one 11:30:06Z cold-start 503 is expected>>
- Changed-path coverage: every core pass asserts the defect path AND the survival invariant in one probe (suppressed record still verifies with directory fields null); member+anon blocks walk the fixture matrix (control, NULL-type fail-closed, CPE boundary, declared 404s, provenance-on-suppressed, anon fingerprint projection, search match-set)
- Maturity record: docs/staging/pr2314-ferpa-2026-08/maturity-<<FILL-AT-CLOSE: closeUTC>>.md
- Human approver: <<FILL-AT-READY: named approver for the T3 ready decision>>
