# Pre-Mortem — The Soak as SOC 2 Type II Evidence (2026-08)

_Written 2026-08-11. Supersedes nothing: [`PREMORTEM-72h-soak-2026-08.md`](./PREMORTEM-72h-soak-2026-08.md) still governs whether the soak is technically sound. This one governs whether its output survives an auditor._

**The premise.** A Type I audit asks "is the control designed correctly, today?" A **Type II** asks "did the control *operate* effectively across a period, and can you prove it for the whole population, not the samples you liked?" Almost everything below is a way of passing the first question and failing the second.

**How to read this.** Each section is written as a post-mortem from a future where the soak ran, we called it green, and the auditor rejected it. TSC references are to the 2017 Trust Services Criteria (with 2022 points of focus).

---

## 1. The population is undefined, so no sample can be representative — CC4.1, PI1.1

**How it fails.** We produce 72 hours of anchors, proofs and audit rows and hand over "the soak evidence." The auditor asks: *how many anchor attempts occurred in the period, and how do you know that number is complete?* We answer from a dashboard that reads `pipeline_dashboard_cache` — a `reltuples` estimate refreshed every 2 minutes. An estimate is not a population. Every subsequent sample is unanchored, and the entire period is thrown out.

**Why it is likely here.** `fetchAnchorStats()` deliberately uses `reltuples` because `count: 'exact'` on a 2.9M-row table times out. That was the right *availability* decision and it is the wrong *evidence* decision. We already carry the sentinel `-1` convention for unavailable counts — an auditor reads a `-1` as "the control has no output."

**Prevent.** Before the clock starts, freeze a population definition in writing: exact `anchors` rows `WHERE created_at BETWEEN start AND end`, captured by an **exact** count against the primary (not the cache), taken once at open and once at close, both stored. Reconcile: `closing_count - opening_count == attempts_observed`. If those disagree, the period is not evidential — say so rather than reconciling by hand.

**Detect.** A reconciliation query run at close, output archived alongside the soak record.

---

## 2. Evidence is mutable, so it proves nothing — CC7.2, CC7.3

**How it fails.** The soak record lives in `HANDOFF.md`, a Confluence page and some Cloud Run logs. All three are editable by the party asserting the control. The auditor cannot distinguish "recorded at the time" from "written afterwards to match the desired conclusion," so the evidence is treated as management assertion, not evidence.

**Why it is likely here.** Our entire evidence culture is markdown files edited by the same agent that ran the work. The `handoff-claims` CI job exists precisely because claims drifted from reality before.

**Prevent.** Every evidential artifact must be **externally timestamped and immutable**: GitHub Actions run URLs (immutable logs, retained), Cloud Run revision IDs + image digests (immutable), Supabase `audit_events` rows (append-only, RLS-protected), and — the one we uniquely can offer — **anchor the soak evidence bundle's SHA-256 to Bitcoin using our own product**. A Type II auditor who can independently verify the evidence bundle predates the report is a materially different conversation.

**Detect.** At close, hash the bundle, anchor it, record the fingerprint + txid in the report. If we will not use our own product as our audit trail, that is worth knowing before we sell it as one.

---

## 3. Controls "operated" only because nothing exercised them — CC7.1, PI1.2

**How it fails.** Zero control exceptions across 72 hours. The auditor asks how many times the payment guard denied, the confidence gate blocked, the fee ceiling deferred, or RLS refused a cross-tenant read. Answer: zero — not because the controls worked, but because **no negative case was ever generated**. A control with no exercise has no operating-effectiveness evidence. Zero exceptions from zero attempts is indistinguishable from a disabled control.

**Why it is likely here.** This is finding **F-8** repeating in a new costume: forced-flush cadence meant batches never reached real scale, and we nearly recorded that as a pass. Synthetic loadgen traffic is happy-path by construction.

**Prevent.** The soak plan must include a **negative-path matrix** with a target count per control, and each must fire at least once with an archived artifact:

| Control | Negative case to force | Evidence |
|---|---|---|
| RLS tenant isolation | Org A reads Org B's anchor | denied query + `audit_events` row |
| Payment guard | Unpaid user submits | `revertToPending` + reason |
| Confidence gate | Sub-threshold extraction | blocked + `_review_reason` |
| Fee ceiling (ECON-1) | Rate above `BITCOIN_MAX_FEE_RATE` | deferral log |
| API key auth | Revoked key replay | 401 + no data |
| Rate limiter | Burst past per-key cap | 429 + `Retry-After` |
| Webhook signature | Forged Stripe signature | rejected, no state change |
| Idempotency | Duplicate submission | single anchor, not two |

**Detect.** Close-out asserts *per control*: exercised N times, M exceptions, all M dispositioned.

---

## 4. An exception occurred and we fixed it mid-run instead of recording it — CC7.4, CC7.5

**How it fails.** Something breaks at hour 30. We fix it, redeploy, and the soak "continues." At audit, the period contains an undisclosed control failure **and** an undisclosed change. Both are exceptions. Concealing them is worse than either.

**Why it is near-certain here.** It has already happened twice and is disclosed in `SOAK-FINDINGS-2026-08.md`: migration 0378 applied to the legacy rig mid-soak, and the F-2 fix deployed mid-soak. Both were handled honestly, as residual-risk notes. Under Type II, an in-period change to a control **restarts** the operating-effectiveness period for that control — a residual-risk note is not sufficient.

**Prevent.** Decide *before* the clock starts: any in-period change to a soaked control either (a) stops the clock and restarts that control's period, or (b) is recorded as a control exception with remediation date, and that control is reported as **not** operating effectively for the period. There is no third option where it silently continues.

**Detect.** Cloud Run revision list for each rig at close: more than one revision in the window is an in-period change. That check is mechanical — run it, do not eyeball it.

---

## 5. Change management cannot be evidenced because the merge trail is broken — CC8.1

**How it fails.** The auditor samples five changes and asks to see, for each: authorization, test evidence, review, and deployment record. We produce PRs. One of them is **#2180 — reported `MERGED`, code never on `main`**. Another is #2168, whose child merged into it rather than into `main`. The trail does not reconcile, and CC8.1 is the criterion auditors probe hardest.

**Why it is likely here.** It is already true today (2026-08-11), which is why this section is not hypothetical. Contributing conditions, all real:
- `SOAK_GATE_DISABLED=true` means a green *Staging Soak Evidence Gate* proves nothing — a bypassed control that still reports green is the textbook Type II finding.
- Stacked PRs don't run `ci.yml` at all (base-branch trigger filter), so "CI green" was never true for them.
- Two independent sessions opened the same fix nine seconds apart (#2197/#2198), which reads as uncontrolled change origination.

**Prevent.** Before the soak: reconcile every change in the audit period against `origin/main` by content, not by badge — `git ls-tree origin/main <signature path>` per change. Turn `SOAK_GATE_DISABLED` back off, or document it as a compensating-control period with named approver and end date. **Do not stack PRs during the audit period.**

**Detect.** A close-out script that walks merged PRs in the window and asserts each one's signature file exists on `main`.

---

## 6. Availability is asserted from the thing being measured — A1.1, A1.2

**How it fails.** We report uptime from our own `/health` and our own logs. Both are inside the boundary. The auditor asks for the monitoring that would have caught an outage we did not notice — and for evidence it was *operating* the whole period, not just installed.

**Why it is likely here.** `revision-drift.yml` runs every 10 minutes and fires Sentry on drift, which is real independent monitoring. But the 2026-08-11 P0 (`/api/v1/verify` down 11m39s from a lock-queue barrier) was root-caused *after the fact*. Detection latency is itself an availability control and it is currently unevidenced.

**Prevent.** Nominate the external observer before the clock starts (Sentry + the drift cron + Cloud Monitoring uptime checks), and prove **the observer ran for the whole period** — gaps in the observer are gaps in the evidence. Define the SLO and the measurement source in advance; measuring after the fact against a target chosen after the fact is not a control.

**Detect.** Count expected observer executions vs actual (72h ÷ 10min = 432 drift-cron runs). Missing runs are period gaps, and must be disclosed.

---

## 7. Processing integrity: we prove the happy path and skip conservation — PI1.4, PI1.5

**How it fails.** Anchors get created and confirmed; we call processing integrity proven. The auditor asks the only question that matters for a ledger: **is anything lost, duplicated, or created from nothing?** Inputs must reconcile to outputs.

**Why it is likely here.** We already know of a real conservation gap: **2.97M `SECURED` anchors but only ~6,110 `STORED` proofs.** Explainable, but an auditor will not accept "explainable" without the reconciliation that explains it. Credits are the sharper case — a credit is money; ledger conservation is directly in scope.

**Prevent.** Run and archive conservation queries at open and close:
- `anchors` created == submitted + deferred + failed (no silent drops)
- every `SECURED` anchor has a chain txid that resolves on-chain (sample with a defined confidence)
- credits: `allocated == consumed + remaining` per org, no negatives
- no duplicate fingerprint→txid mappings, no txid reuse

**Detect.** These are queries, not opinions. If one fails, that is a processing-integrity exception and must be reported as one.

---

## 8. Confidentiality: the evidence bundle itself leaks — C1.1, C1.2, P-series

**How it fails.** We hand over logs, DB dumps and screenshots. Somewhere in them: a customer email, a document fingerprint tied to an identifiable person, a JWT, an API key, an IP. The evidence package becomes the incident.

**Why it is likely here.** Load-testing fixtures create realistic-looking data, and screenshots are pasted into PRs by habit. §1.6 keeps documents client-side, but *metadata* about real orgs is in scope, and the UAT account is a **prod** org.

**Prevent.** Treat the bundle as a customer-data export: PII-scrub before packaging, redact tokens, use synthetic orgs for anything screenshotted, and have a second reader check the bundle before it leaves. `pii-scrub.ts` exists — run it over the bundle, don't assume the log-time scrubbers caught everything.

**Detect.** Grep the assembled bundle for the PII regexes we already maintain, plus `sk_`, `eyJ`, `@`, and treasury addresses. Do it as a gate, not a courtesy.

---

## 9. Logical access: the reviewer and the operator are the same agent — CC6.1, CC6.2, CC6.3

**How it fails.** Every commit, review, approval, deploy and evidence write in the period traces to one identity. Segregation of duties is unevidenced, so the auditor discounts *self-attested* evidence across the board — which is most of it.

**Why it is likely here.** Structurally true: I author, verify and record. The Jira rule *reporter ≠ resolver* exists, but I authenticate **as carson**, so it does not bind. Claude is hook-blocked from merging and Mergify merges — that is a genuine separation, and it is the one to lean on and evidence.

**Prevent.** Name the separation explicitly and evidence it: automated gates (CI, Mergify, hooks) are the independent control; a human approver signs the go/no-go. Where a human did not independently review, **say so** rather than implying review. Also: the founder-reserved items (API-key provisioning, GCP IAM) must stay founder-executed — an agent performing them collapses the only segregation we have.

**Detect.** For each merged change in the period, record who authorized and who executed. If they are the same for a change touching a soaked control, disclose it.

---

## 10. The period ends and nobody can reproduce the conclusion — CC2.1, CC3.2

**How it fails.** Three months later the auditor asks how we concluded "green." The reasoning lived in a chat session that no longer exists. What remains is a summary nobody can re-derive. Type II is about repeatability of the *conclusion*, not just the result.

**Prevent.** One artifact, written as the soak runs, containing: population definition + counts, per-control exercise/exception counts, every in-period change, the go/no-go decision with named approver and timestamp, and every disclosed exception with disposition. If it cannot be reconstructed from that file alone, it is not audit evidence.

---

## Go / no-go — must ALL be true before the clock starts

- [ ] **Audit period declared** in writing: start, end, controls in scope, TSC mapping.
- [ ] **Population defined and counted exactly** at open (primary DB, not `reltuples`, not the cache).
- [ ] **Change freeze on soaked controls.** In-period change ⇒ restart that control's period or report it as not effective. Agreed *before*, not litigated after.
- [ ] **`SOAK_GATE_DISABLED` turned off**, or documented as a compensating-control period with named approver and end date. It expires 2026-08-16 regardless — do not let expiry be the thing that ends it.
- [ ] **No stacked PRs.** Every change branches from `main`, so `ci.yml` actually runs. (#2180 is the standing proof of why.)
- [ ] **Merge trail reconciled by content**: every change in the window verified present on `origin/main` via `git ls-tree`, not via the merged badge.
- [ ] **Negative-path matrix agreed**, with a target exercise count per control.
- [ ] **Conservation queries written and dry-run** before the clock starts.
- [ ] **External observer confirmed running** (Sentry, drift cron, uptime checks) with expected execution counts recorded.
- [ ] **Rig is a clean mirror** — `staging-honesty-preflight.ts` reports `environment_type=clean_mirror` against the exact project ref the worker will use.
- [ ] **Evidence bundle handling agreed**: PII scrub, second reader, and the bundle hash anchored to Bitcoin at close.
- [ ] **Named human approver** for go/no-go who is not the operator.

---

## The honest part

Two things below are true right now and are the reason this document exists rather than a checklist edit.

**`SOAK_GATE_DISABLED=true` is a bypassed control that reports green.** Any Type II period covering today includes a control that was administratively disabled while its check displayed as passing. That is disclosable regardless of what the soak shows. It expires 2026-08-16; ending it deliberately is a much better story than letting it lapse.

**The change trail is currently broken in a demonstrable way.** #2180 shows `MERGED` with its code absent from `main` — recovered in #2195, but the recovery is itself the evidence that the badge is not trustworthy. Any period that includes 2026-08-11 must disclose it. Reconcile by content before declaring an audit period, or the first sample the auditor pulls will find it.

Neither is fatal. Both are far cheaper to disclose now than to be found.
