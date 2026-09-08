# PR #2441 — window 2 (re-soak on current base)

Window 1 (head `5b5ccea937c4c30363bf2435bdcd4d712c95b905`) is **VOID**: the Staging Soak
Evidence Gate ruled under FD-GATE-3 carve-out (a) that main had edited
`services/worker/src/api/v1/router.ts` — a file this PR itself soaked — at T2, so the
completed soak described code that no longer exists. Same-file T2+ drift is unclearable by
attestation by design. Window 1 artifacts are preserved, unused, under
`evidence/pr-2441/window-1-5b5ccea93-VOID/`.

## Window 2 identity

| Field | Value |
|---|---|
| PR head SHA | `3da7677d73dc0c3ee7baed58ace5633c8e02ea81` (merge of `5b5ccea93` + `a6f297f73`) |
| Base SHA | `a6f297f73f462a373282e3c68d4b05b3da8488e9` |
| Image tag (Artifact Registry) | `arkova-worker:3da7677d73dc0c3ee7baed58ace5633c8e02ea81` |
| Image digest | `sha256:2db3d675caefabaaf604f9e1f7c331f7516789a8e7cd56c321334c1c3cef5736` |
| Cloud Build id | `3f7a3ad9-9e2f-4597-bef3-aa2917dfc790` (us-central1) |
| Cloud Run revision | `arkova-worker-staging-00376-yuh` |
| Tag / URL | `pr-2441` / https://pr-2441---arkova-worker-staging-kvojbeutfa-uc.a.run.app |
| Supabase rig | `fizyjojbebyalirtjjht` (shared standing rig) |
| staging_deploy_log id | 14 |
| Preflight | `environment_type=clean_mirror`, 8/8, 2026-08-30T15:24:45.290Z |
| LOAD window | 2026-08-30T15:42:49Z -> 2026-08-31T03:42:49Z |
| Driver | `driver-2441-r2.mjs` |

## Three-way image provenance check

1. Artifact Registry: tag `3da7677d73dc0c3ee7baed58ace5633c8e02ea81` resolves to digest
   `sha256:2db3d675ca...` — i.e. the registry tag IS the head SHA.
2. Cloud Run: revision `00376-yuh` `status.imageDigest` = the same digest, and it was
   deployed BY digest, not by tag.
3. Runtime: `/health` returns `git_sha=3da7677d73dc0c3ee7baed58ace5633c8e02ea81` (40 chars).
   The service template had `BUILD_SHA` pinned to the OLD head `5b5ccea93`, so the deploy
   passed `--update-env-vars BUILD_SHA=<new head>`; the revision spec was re-read to confirm
   the env var, not just the `/health` echo.

## Pre-window verification (clock NOT started until clean)

- `pre-window-2-3da7677d7/verification-cycle-clean.json` — first run of the hardened driver,
  26/26 checks, 0 deviations.
- `pre-window-2-3da7677d7/aborted-misaligned-launch/` — a first supervisor launch at
  15:32:55Z was **stopped after cycle 1** and its clock discarded. Cycle 1 recorded
  `admitted=108 first429=-1`: the added reverse-direction phase lengthened the cycle enough
  that the next 108-request burst STRADDLED the anon limiter's 60s fixed-window reset, so the
  counter restarted mid-burst and the cap never bound. That is a harness timing artifact, not
  a limiter defect — but it is indistinguishable from one in an artifact, which is worse than
  a real failure. Fixed by an explicit 62s window-alignment sleep before the burst, plus
  recording the first burst response's `X-RateLimit-Remaining` (`rem1`) so alignment is
  observable per cycle rather than assumed.
- `pre-window-2-3da7677d7/aligned-verification/` — TWO back-to-back cycles at the supervisor's
  own 30s cadence, both `admitted=100 first429=101 rem1=99`, 26/26 checks, 0 deviations. Two
  consecutive cycles is the test that matters: one cycle cannot reveal an inter-cycle
  alignment bug.

## What the driver proves (bucket ISOLATION, not "a limiter returns 429")

Forward direction — drain the anon bucket, show the neighbours are untouched:
1. 108-request burst on `/api/v1/verify/<id>` -> `admitted=100`, `first429=101`,
   `X-RateLimit-Limit: 100`, `Retry-After` present. The anon tier binds at its OWN §1.10
   cap (pre-fix it first-429'd at ~31 on the shared bare-IP entry).
2. With that bucket exhausted: keyed verify (`v1-keyed`) still 200 and names 1000;
   `/api/badge/<id>` (the 60/min `api-ip-shadow-guard`) still 200; `/api/queue/pending`
   (the 10/min `checkout` bucket on adminRouter) still 200.
3. Positive control: `/API/v1/verify/<id>` (uppercase — Express routes case-insensitively)
   MUST 429 naming 100. This is what makes step 2 non-vacuous: it proves the burst really
   did exhaust a bucket, so the neighbours' 200s are isolation and not a no-op.

Reverse direction (added for window 2) — drain a NEIGHBOUR, show the anon tier is untouched:
4. Drain the 10/min `checkout` bucket with 12 requests -> `admitted=10`, `first429=11`,
   `X-RateLimit-Limit: 10`. Positive control asserted explicitly: if this bucket never binds,
   the checks below are vacuous and the cycle says so.
5. Then anon verify must still be 200 naming 100, `/api/badge` still 200, keyed verify still
   200 naming 1000.

A single shared bare-per-IP Map entry fails in one direction or the other. Both directions
passing is the property SCRUM-3418 actually claims.

Also covered by re-soaking on the current base: main's `requireScopeAnyAuth` layer on the
FERPA/HIPAA routes in the same file, which window 1 never ran.

## Close procedure (armed, and runnable by hand)

An **auto-close is already armed and detached** (`auto-close-2441.sh`, log
`~/arkova-soak/batch-b/pr-2441/auto-close.log`). It waits for `CLOCK_END`, waits for the
supervisor's own read-only close-capture seal (it does not race it — two seals on one window
is an ambiguous record), and only THEN runs the rollback rehearsal, because the rehearsal
creates revisions and moves a tag and would otherwise contaminate the seal.

If it has to be driven by hand instead:

```
bash ~/arkova-soak/batch-b/close-2441-window2.sh          # refuses before CLOCK_END
bash ~/arkova-soak/batch-b/compose-2441-block.sh <seal>   # prints the roll-up numbers
```

Rehearsal moves ONLY the `pr-2441` tag, via `--update-tags`. `--set-tags` would clobber every
other tag on the shared rig and break other agents' live windows; the script snapshots the
full tag topology before and after and diffs it.

### What still needs an agent after the auto-close

1. Compose the T2 block: fields UNBOLDED, `PR head SHA:` the full 40 chars of
   `3da7677d73dc0c3ee7baed58ace5633c8e02ea81`, `Base SHA:` `a6f297f73f462a373282e3c68d4b05b3da8488e9`,
   `Preflight result:` containing the literal `environment_type=clean_mirror` with the
   2026-08-30T15:24:45.290Z timestamp (before window start), `Evidence scope: merge-grade shared
   staging`, `Staging deploy log id: 14`, plus `Changed behavior:`, `Targeted evidence:`,
   `Load/concurrency evidence:`, `Rollback rehearsed:`, `Rollback plan:`, `Risk rationale:`,
   `Approver:`. Note the existing block's fields carry a `- ` list prefix — a `^PR head SHA:`
   regex will not match them.
2. Validate by IMPORTING the real `check()` — `/private/tmp/soak-2441-validate/validate-2441.mts`
   already does this against `origin/main`'s copy of the script, resolving live `.head.sha` and
   `.base.sha` exactly as `staging-evidence.yml` does. Never validate by eye.
3. Disclose every deviation in full with its discriminating signal named.
4. Update the PR body, then mark the PR Ready.

### Base-drift outlook

`Base SHA: a6f297f73f462a373282e3c68d4b05b3da8488e9` is the base this head actually merged.
Checked with the real `baseDriftImpactErrors()`: drift from that base to the current main tip
(`b2a65edd`) is **disjoint** from this PR's soak surface, so no attestation is required even if
GitHub advances `.base.sha`. The residual exposure is a NEW main commit during the window that
edits a file this PR owns (`services/worker/src/**`) at T2+ — that is FD-GATE-3 carve-out (a)
again and is unclearable by attestation. Re-validate at close before touching the body.

### Gate is genuinely live

`gh variable get SOAK_GATE_DISABLED` -> `false`, and the compiled bypass expiry
(`SOAK_GATE_BYPASS_EXPIRES_AT`) passed on 2026-08-16 regardless. A green Staging Soak Evidence
Gate on this PR therefore means evidence, not a bypass.
