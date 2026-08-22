# Uncontrolled change on day 6: dependabot PR #2277 auto-merged; main locked in response

**2026-08-18T17:39:38Z: PR #2277 (dependabot, github_actions ecosystem) merged to main via
the normal Mergify queue, moving main `92ed61cb6` → `f374aca97` during the freeze window.**

## What changed

One line in `.github/workflows/ci.yml`: the trufflehog secret-scan action version pin
3.96.0 → 3.97.0. Zero runtime surface — no worker code, no frontend, no migrations, no
config. The frozen rig (`00013-mrw`), the prod worker revision, and all soak evidence are
unaffected in substance.

## Why it happened

The six pre-existing dependabot PRs were held with `do-not-merge` labels (Mergify respects
the label). #2277 was NEWLY minted at ~17:30Z in a different ecosystem (github_actions,
not npm), opened non-draft, passed all gates as a T0 CI-only change, and the queue merged
it 9 minutes after creation — faster than any labeling watch can race. The freeze had no
structural enforcement against new automated PRs, only against the known set.

## Assessment

Change control did operate: the merge went through the full gated queue (CI green, evidence
gate T0-satisfied, audit trail complete). What failed was the freeze *intent* — no
automated change should land during the observation window. SOC2 posture: documented
uncontrolled-but-inert change; the observation target (the worker under soak) was never
touched.

## Containment (17:5xZ)

`main` branch protection `lock_branch: true` — the branch is read-only until the soak
clock closes (2026-08-19T15:51:30Z), when the lock is removed. Prior protection state
backed up (lock was the only field changed; no required checks / reviews existed at the
protection layer — gating lives in Mergify). This closes the race for the remaining window;
the durable post-freeze fix is a freeze-mode Mergify condition or dependabot pause during
declared windows.
