# CTO merge-scope decision for the RC-3 window
Date: 2026-09-01. Verified, not assumed — every claim below was checked with
`git merge-base --is-ancestor` and content hashing against the soaked tree
`2302e815e61fca5af449ba53a7ccca2fac49606e` (the SHA the rig's `/health` actually served).

## Merging this cycle — soak-covered
| PR | Tier | Head | Coverage |
|---|---|---|---|
| **#2472** DocuSign metadata write-authority guard (migration `0423`) | T3 | `b89fdd6ac` | **COVERED** — head is an ancestor of the soaked tree |
| **#2485** rule-event payload under the 16KB CHECK | T2 | `ed42ea3bc` | **COVERED** — head is an ancestor of the soaked tree |

#2472 is the one that matters: `connector_source` is guarded **unconditionally** in `0423`,
so it closes the write side of both the authenticated deep-link forgery vector and
SCRUM-3862's public-API inaccuracy.

## NOT merging this cycle
| PR | Why |
|---|---|
| **#2474** signer capture | **Head drifted past the soak.** A merge-from-main brought **31 worker runtime files**, and `services/worker/src/jobs/connector-artifact-drain.ts` — squarely in this feature's own execution path — **differs** from the soaked version (`041e5682` vs `54ada573`). The soak did not exercise the code that would ship. This is a real coverage gap, not a paperwork one, and it does **not** qualify for a residual-risk note. |
| **#2476** inbound + migration `0424` | Head drifted (`ce3b7f98`), and independently blocked: SCRUM-3818 carries a **failing TLA invariant** (`anchorNeverMintedFromSupersededFingerprint`) with a machine-checked counterexample. Flag-OFF, gated. |
| **#2489, #2518, #2520, #2566** | Stacked inside #2476; land only when it does. |
| **#2565** backfill v2 | Stacked on #2474; no independent soak. |

## Consequence, stated plainly
With #2474 held back, the already-merged frontend (#2473) renders account/envelope deep
links but **no signer rows** — nothing populates `_signers` until #2474 ships. That is the
correct degradation: `DocusignSignerRows` returns null on absent `_signers`, covered by test.
Better a missing row than a row backed by unexercised code.

## Why #2474 was not waved through
It would have been easy to argue "the merge only pulled main, the feature files are
identical." Four of five feature files ARE identical — but `connector-artifact-drain.ts` is
not, and that file is where this feature's `_signers` metadata is spread onto the anchor.
Approving it on a "mostly identical" basis is exactly the reasoning that makes soak evidence
decorative.

## Re-qualifying #2474 and #2476
Both need a fresh window on their current heads. Cheapest correct path: cut a new RC from
their live heads, provision a rig **through `scripts/staging/provision-isolated-rig.sh`** so
the `clean_mirror` preflight runs BEFORE the feature migrations (the process error recorded
in E8), and soak 48 h.
