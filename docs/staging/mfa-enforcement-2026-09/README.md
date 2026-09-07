# MFA enforcement — soak evidence, 2026-09-03 windows (isolated rig `nesuwjlscilzzbhpvbkt`)

Rig: isolated Supabase project `nesuwjlscilzzbhpvbkt` (`arkova-soak-mfa-3167`, us-east-2; schema replayed from origin/main,
baseline fixture seeded, TOTP enroll/verify on). Preflight `clean_mirror` at open (`preflight-open-20260903T063740Z.json`)
and mid-window at 2026-09-03T10:44:42Z (`preflight-midwindow-20260903T104437Z.json`). No closing preflight was captured at
the end of these windows (the driving session was interrupted); the release session re-preflighted the same rig
`clean_mirror` on 2026-09-05T16:32Z before its own PR #2637 window. Pre-clock validation runs are not included.

## `break-glass-2026-09-03/` — PR #2635 (merged 2026-09-05T00:33Z at head `bccc24a09f274484f0079afac0ab7f30905d7233`)

12 h exercise of `scripts/ops/mfa-break-glass.ts`, 2026-09-03T07:05:22Z → 19:05:23Z, 10-min cycles: **71 cycles, 0 failing**
(each `bg-*.json` carries `pr_head`, `supabase_ref`, `ok`/`fail`, per-step exit codes). Cycle = disposable user → enrol + verify →
dry run (no writes) → negative probes (CONFIRM mismatch, foreign factor id, `--all` without `CONFIRM_MFA_BREAK_GLASS_ALL`, each
exit 1 with no audit rows) → apply with CONFIRM → factor gone → INTENT + COMPLETION audit rows ordered → re-enrol → cleanup.

## `enforcement-2026-09-03/` — PR #2637 at head `1a24af93e6c132597005796861ffc2657d14f33f` (SUPERSEDED)

12 h frontend-only T2 window, 2026-09-03T12:51:11Z → 2026-09-04T00:51:12Z: API-leg driver **72 cycles, 0 failing** (`load/`),
Playwright spec against a `vite preview` build of the head **24 runs, 24 pass** (`ui/`, 6 scenarios each; one preview process
for the whole window). Superseded: on 2026-09-05 the release session added commits to PR #2637 (head `7016f0aa7…`), re-tiered it
T3 and started a 48 h window on the same rig from 16:32:46Z; that window's evidence lands with the PR. This directory is the
audit trail for the 09-03 head only and is not merge evidence for the current head.
