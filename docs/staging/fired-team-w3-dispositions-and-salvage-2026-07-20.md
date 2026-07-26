# Fired-Team W3 PR Dispositions + Salvage Inventory

**Owner:** Release/Train lane (RTE). **Date:** 2026-07-20 (watch window). **Queue impact:** none — all PRs below are on dead `codex/agent` bases (not `main`) or are do-not-merge; closing them advances nothing on `main` and re-entangles nothing.

Rationale: these are the dismissed AI/Lane-4 team's Wave-3 PRs. Per `feedback_never_close_functional_prs`, PRs with real code are closed only after their value is captured. This doc **is** that capture. The corpus tranches (1556/1563/1566) contain ~7k lines each of independently-authored held-out corpus data that Lane 3 will need — recorded here so it is recoverable by branch/blob after the PRs close.

---

## Salvage inventory (recover these before/after close by branch or blob)

### PR #1556 — top-15 held-out tranche 01-05 (base `agent/s33-wave2-lane4-v71` = CTO-killed v7.1)
| File | Size | Salvage value |
|---|---|---|
| `docs/lane4/s33-wave2-batches/top15-01-05/datasheet.json` | +3974 | Per-entry datasheet, Wave-2 top-15 slice 01-05 |
| `docs/lane4/s33-wave2-batches/top15-01-05/manifest.json` | +1285 | Batch manifest w/ pinned SHAs |
| `services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-01-05-heldout.ts` | +1595 | Held-out eval corpus (authored, not generator-derived) |
| `services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-01-05-heldout.test.ts` | +284 | Golden eval test |
| `.sonarcloud.properties` | +4/-3 | Producer-support config (do NOT salvage — belongs outside Lane-4 packet per §1/SCRUM-2777 AC8) |

### PR #1563 — top-15 held-out tranche 06-10 (base `codex/s33-w3-l4-accepted-union-01-05`)
| File | Size | Salvage value |
|---|---|---|
| `docs/lane4/s33-wave2-batches/top15-06-10/datasheet.json` | +3974 | Datasheet slice 06-10 |
| `docs/lane4/s33-wave2-batches/top15-06-10/manifest.json` | +1285 | Manifest |
| `services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-06-10-heldout.ts` | +1151 | Held-out corpus |
| `services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-06-10-heldout.test.ts` | +344 | Test |

### PR #1566 — top-15 corpus tranche 11-15 (base `codex/s33-w3-l4-top15-01-10-registry-chain`)
| File | Size | Salvage value |
|---|---|---|
| `docs/lane4/s33-wave2-batches/top15-11-15/datasheet.json` | +3974 | Datasheet slice 11-15 |
| `docs/lane4/s33-wave2-batches/top15-11-15/manifest.json` | +1285 | Manifest |
| `services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-11-15-heldout.ts` | +1151 | Held-out corpus |
| `services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-11-15-heldout.test.ts` | +293 | Test |

**Recovery method (for Lane 3, post-close) — head SHAs pinned (AI review):** the branches remain on the remote after PR close (GitHub does not delete a closed PR's head branch automatically). Head commits verified on the remote 2026-07-20: **#1556 `codex/s33-w3-l4-top15-01-05` = `0a3caf09`**, **#1563 `codex/s33-w3-l4-top15-01-10-...06-10` = `b8ff95be`**, **#1566 `...11-15` = `5ffd68e8`**, **#1557 `agent/s33-w3-t0-batch-gate-compat` = `4134d41c`**. Recover with `git fetch origin <headRef>` (or `git fetch origin <sha>`). **Durable fallback if a branch is later swept:** `git fetch origin refs/pull/<N>/head` keeps the closed PR's commit fetchable regardless of branch deletion (e.g. `git fetch origin pull/1556/head`). If Lane 3 formally accepts this Wave-2 top-15 data, it must be **re-submitted on a `main`-based branch** with a clean isolated soak — NOT merged from these dead codex/agent bases (which re-entangle CTO-killed v7.1 lineage). Cross-ref the accepted Wave-1 corpus (`docs/lane4/s33-corpus-datasheet.md`, 81 rows) and the T7 corpus-coverage audit; the top-15-per-domain gap feeds SCRUM-2997.

---

## Dispositions

| PR | Base | Disposition | Reason |
|---|---|---|---|
| **#1556** | `agent/s33-wave2-lane4-v71` (killed v7.1) | **CLOSE** (salvage captured above) | Dead base; merging advances nothing on main + re-entangles v7.1. |
| **#1563** | `codex/s33-w3-l4-accepted-union-01-05` | **CLOSE** (salvage captured) | Stacked on a dead codex base. |
| **#1566** | `codex/s33-w3-l4-top15-01-10-registry-chain` | **CLOSE** (salvage captured) | Stacked on a dead codex base. |
| **#1557** | `main` | **CLOSE-OR-RE-ANCHOR memo (below)** — no close this session | Targets main; T0 gate-compat. Has independent value; needs a decision, not a reflex close. |
| **#1565** | `codex/s33-w3-l2-2703-2705` | **HOLD-AUDIT note (below)** — no close this session | Contains rig-safety/teardown tooling that overlaps in-flight SCRUM-2977/2978 work; audit before disposing. |

### #1557 — close-or-re-anchor memo (targets `main`)
"[S3.3][W3][T0] Fix batch acceptance gate compatibility", base `main`, +259/-21, 7 files:
`scripts/ci/check-sonar-quality-gate.test.ts`, `services/worker/src/ai/eval/{heldout-leakage.ts,heldout-leakage.test.ts,s33-wave2-batch-acceptance.ts,s33-wave2-batch-acceptance.test.ts,agents.md}`, `.sonarcloud.properties`.
- This is the ONLY fired-team W3 PR based on `main`, and it touches the **leakage scanner + batch-acceptance evaluator** — the exact machinery the corpus tranches above depend on for acceptance. It is NOT pure fired-team dross.
- **Recommendation: do NOT close. Re-anchor.** Decision owed to Lane 3 / CTO: either (a) rebase onto current main and re-run as a fresh T0 (it's eval-tooling, likely T0/T1), or (b) fold its leakage/acceptance changes into the Lane-3 Wave-2 acceptance work. Closing it would drop the acceptance-gate fix that the salvaged corpus needs to be evaluable. Parked for a Lane-3 owner; flagged to founder/CTO in the window report.

### #1565 — hold-audit note
"S3.3 L2 W3-C: freeze teardown and rig activation safety", base `codex/s33-w3-l2-2703-2705`, +1700/-113, 10 files under `scripts/staging/` incl. `provision-isolated-rig.sh`, `s33-drain-invariant.ts`, `s33-teardown-inventory.ts`, `batch-drain-admission-adapter.ts`.
- **HOLD — do not close yet.** This PR's `s33-teardown-inventory.ts` + `s33-drain-invariant.ts` + `provision-isolated-rig.sh` **directly overlap** the anti-hollow-soak guard set now being authored (SCRUM-2977) and the B1 teardown checklist (SCRUM-2978). There may be reusable invariant logic here that the clean SCRUM-2977 guards should absorb rather than re-derive.
- **Action owed:** audit `s33-drain-invariant.ts` and `s33-teardown-inventory.ts` against the new `scripts/ci/anti-hollow-soak/` guards; salvage any non-hollow drain-invariant logic; THEN close on a dead base. Do not merge (dead codex base). Owner: RTE post-train, cross-ref SCRUM-2977. Left open this window deliberately.
