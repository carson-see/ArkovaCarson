# ART 24-Hour Slice — Ceremony Record (2026-07-20 → 07-21)

**Facilitator:** RTE (Release/Train lane). **Ceremony set:** slice review → pre-mortem (soak/release) → post-mortem (slice) → next-slice refine/plan/pre-mortem → per-lane SM sessions → reconvene. **Standing rule this window:** nothing soaks; everything stays Draft until all lanes finish + the running train (deps, chain) clears. No new code in the ceremonies.

**Roles represented:** RTE / Release Manager, CTO-delegate, Lane 1 SM (Trust & Chain), Lane 2 SM (Product & Growth), Lane 3 SM (Credential Network), Business stakeholder (founder/CPO proxy).

---

## 1. SLICE REVIEW (F4) — what shipped, per lane

The 24h slice is **13 Draft PRs** (all Draft, none queued, none soaking — verified). "fail" checks below are the **Staging Soak Evidence Gate deliberately RED** (Draft + no soak by design), not code failures; the underlying typecheck/lint/unit suites pass.

### Lane 1 — Trust & Chain
| PR | What | Size | Checks | Review status |
|---|---|---|---|---|
| #1611 | 24h deliverables docs + **KPI-3 external "clean-room" verifier** (`scripts/kpi3/*.mjs`, node-builtins only, 20/20 tests) | +1388, 16 files | 26✓/3✗ | Standalone CONFIRMED (clean-room CI passed); the 3 reds = Staging gate + T0-detector miss (below) |

**Value:** an independent, dependency-free verifier that re-proves an anchor's hash→tx→block chain — the evidentiary backbone for the HakiChain KPI-3 proof-bundle check. Chain-verified 4 live Haki anchors end-to-end during authoring.

### Lane 2 — Product & Growth
| PR | What | Size | Review flag |
|---|---|---|---|
| #1598 | `SENTRY_ENVIRONMENT` from `K_SERVICE` (MT-1) — correct per-service Sentry env | +192 | Confirm no PII in env derivation; §1.1 scrubbing intact |
| #1600 | CSP: allow `mempool.space` in `connect-src` — unblocks treasury fee/price cards | +79 | Must be scoped to `connect-src` + exact host only (no CSP broadening) |
| #1604 | Scheduler codification + **dead-man** (SCRUM-2900) + chain bits | +832 | **Must be inert while Draft** — dead-man alerting/cron wiring is a separate gated op; verify no live scheduler mutation baked in |
| #1606 | Partner-account provisioning **skeleton** (SCRUM-2990) | +798 | **Must be gated/inert** — no live provisioning, no secret handling, no partner side effects |
| #1608 | Health-exposure lockdown **spec** (SCRUM-2653/2643), docs-only | +160 | Docs-only; verify no endpoint actually changed |

**Value:** observability correctness (Sentry env), a deterministic fix for the treasury dashboard cards (CSP), the scheduler dead-man that closes the "silent pause" incident class, and the scaffolding for partner onboarding.

### Lane 3 — Credential Network
| PR | What | Size | Review flag |
|---|---|---|---|
| #1602 | Delete dead fraud code + DOM regression test (SCRUM-2910, P0 BUG-009/010) | +154/-330 | Verify ALL fraud surfaces gone (banner + `fraud_*` on owner AND public); no dead imports |
| #1603 | **CTDL JSON-LD importer/parser** (SCRUM-2913) — CE pre-demo blocker | +1578 | Zod on the write path (§1.2); no injection via imported `@graph`; test coverage |
| #1605 | Soft-fail HEIC/TIFF instead of hard-fail (SCRUM-2911) | +392 | §1.6 client-side boundary: soft-fail must not leak document bytes |
| #1607 | 24h deliverables docs (SCRUM-2999 memo) | +248 | Docs accuracy |
| #1609 | Terminology scrub — "Imported Records" (SCRUM-2938) | +215/-19 | §1.3: `lint:copy` passes; SCRUM-1672 "Issue Credential" exception respected; no banned term reintroduced |

**Value:** removes the last live fraud-display surfaces (a launch honesty P0), teaches the importer to read Credential Engine's own CTDL format (unblocks the Jeanne demo), widens real document-format support for the Kenya pilot, and continues the terminology cleanup.

### RTE — Release/Train
| PR | What | Review status |
|---|---|---|
| #1601 | Anti-hollow-soak CI guards (SCRUM-2977) | **Specialist-reviewed** (Architect APPROVE-WITH-NITS; Perf O(n) sub-ms; 30/30 tests). 4 hollow signatures to add before wiring. |
| #1612 | RTE docs slice (9 memos incl. 1552 waiver, rig ledger, corpus audit, review findings) | Self + 5-specialist reviewed; corrections folded in. |

**Value:** the guard set that makes the Jul-19 hollow-soak class un-repeatable; the corrected 1552 re-soak decision; the full window evidence trail.

### Code-review status (honest)
RTE PRs (#1601/#1612) + the cross-cutting infra items (0358/#1570/#1584) were **specialist-reviewed this window** (Architect/DBA/Bitcoin/AI/Perf) with corrections applied. A **lane-level code-review pass** on the 11 lane PRs was commissioned; the key per-PR risk flags are captured in the tables above and must be cleared before any Ready-flip. **No lane PR is approved for merge** — all stay Draft.

---

## 2. PRE-MORTEM (F5a) — "It's Aug 4 and the release of this slice went wrong. Why?"

| # | Failure mode | Likelihood | Mitigation (owned) |
|---|---|---|---|
| P1 | **1552 chain rail merged on isolated-soak evidence** without the integration re-soak → 0358 runs in prod alongside main's un-co-soaked `utils/db.ts` and something breaks under the 3am flush | Med | Memo already flips to B2 (re-soak integrated head); CTO ruling gated; monitor watches. **Do not merge on isolated evidence** (founder already stated this). |
| P2 | **T0-detector gap makes Draft PRs un-readyable** — #1611 (`scripts/kpi3/*.mjs`) + others RED on the Staging gate at Ready time → scramble to hand-write evidence blocks or an emergency detector change during the release | High | **Next-slice item: `scripts/ci/check-staging-evidence.ts` path-detector tweak** to treat `scripts/kpi3/**`, `**/*.mjs` clean-room tools, and doc-only bundles as T0. Land it BEFORE the Ready wave. |
| P3 | **HakiChain 15-anchor entitlement not spendable** (quota=15 but balance=0, cycle expired, is_test=true) → pilot can't use anchors, Aug 9 first-invoice basis is wrong | High | Escalated on SCRUM-2912. Founder/CTO fund balance + open fresh cycle + decide is_test, and **fund before enabling credit enforcement** (#1570). |
| P4 | **Credit enforcement (#1570) turned on before Haki funded** → Haki hard-blocked at 4 | Med | Sequencing note on SCRUM-2912 + rail-verification-log: fund first, enforce second. |
| P5 | **0358 apply stalls the 255k drain** (SHARE ROW EXCLUSIVE on `anchors` at CREATE TRIGGER) | Med | DBA/Perf guardrails in the 1552 memo: `lock_timeout='3s'` + pause feeders + drain-quiet window. |
| P6 | **Migration `0359` collision** — a parallel session takes it because the reservation lives only in a memo, not canonical `agents.md` (W3-frozen) | Med | Registry flags it as a live risk; land the numbered `agents.md` row post-window. |
| P7 | **Sibling doc-merges DIRTY the stacked slice PRs** (agents.md union not honored by GitHub) at Ready time | Med | Title per-PR migration/agents.md blocks by PR#; local union-resolve; the 2026-07-20 RM learnings apply. |
| P8 | **Fired-team salvage lost** if closed-PR branches are GC'd before Lane 3 recovers the Wave-2 corpus | Low | Head SHAs pinned + `refs/pull/N/head` fallback recorded in the salvage doc. |

## 3. POST-MORTEM (F5b) — how the 24h slice actually went

**What went well**
- Every lane's slice landed in a Draft PR; **nothing soaked, nothing hit main** — the freeze held.
- Independent review caught **two decision-grade errors before they shipped**: the 1552 no-re-soak waiver (disproven empirically) and the #1570 credit-check rubric (0-rows, not 2-rows).
- Cross-lane coordination worked: Lane 1's PR-open question answered with the real `do-not-merge` label gotcha; HakiChain shortfall verified by two sessions independently and re-framed correctly (quota vs balance) on founder input.
- Jira hygiene done live once connectors came online (13 stories re-parented, 3 bugs reconciled).

**What went wrong / to improve**
- **The T0 path detector doesn't recognize clean-room tooling** (`scripts/kpi3/*.mjs`) → false Staging-gate RED on Draft PRs. Friction now, blocker at Ready time. → P2 above, next-slice.
- **The facilitator (RTE) stalled the ceremony chain waiting on sub-agents** instead of driving synthesis with available information. Correction: time-box delegated reviews; synthesize on the evidence in hand and fold late results in.
- **HakiChain readiness was assumed, not verified** until this window — the "15 exist today" record was stale/mis-framed. Continuous prod-vs-spec reconciliation should be a standing pre-launch check, not an ad-hoc catch.
- **`ENABLE_ORG_CREDIT_ENFORCEMENT` isn't even in the switchboard** — the credit-gate work (#1570) has no live flag to gate it; that must be created + defaulted deliberately, not discovered at enforcement time.

**Action items (owners):** P2 detector tweak (RTE/Lane 2 CI), SCRUM-2912 funding + is_test decision (founder/CTO), create + default `ENABLE_ORG_CREDIT_ENFORCEMENT` flag (Lane 2/DBA), land `0359` canonical reservation (RTE post-window), CTO ruling on 1552 B2 re-soak.

---

## 4. NEXT 24-HOUR SLICE — refine + plan + pre-mortem, per lane (F6)

**Theme:** turn "Draft + verified" into "merged + live" as the train clears, and close the launch-critical gaps this slice surfaced. Still no soaking of *new* work until the current train (deps tonight, chain tomorrow) lands.

### Lane 1 — Trust & Chain
- **Plan:** wire the KPI-3 verifier into the Haki proof-bundle check; census the ~2.97M SECURED anchors with ≤6,110 stored proofs (SCRUM-2916/2917 proof cron unfreeze + backfill design); support the 1552 integration re-soak evidence.
- **Pre-mortem:** proof-backfill materializer is UPDATE-only today (needs an insert-capable path); backfill under the 3am drain competes for `anchors` locks → schedule off-peak, additive-only, compare vs the 6,110 known-good first.

### Lane 2 — Product & Growth
- **Plan:** land the T0 path-detector tweak (P2); create + default the `ENABLE_ORG_CREDIT_ENFORCEMENT` flag; finish the scheduler dead-man wiring (gated op) and partner-provisioning behind a flag; treasury dashboard end-to-end (CSP + status API budget).
- **Pre-mortem:** enabling credit enforcement without funding Haki (P4) → gate behind explicit founder go + a funded-balance precondition check; dead-man mis-fires on legitimate maintenance pauses → actor-attribution + allowlist.

### Lane 3 — Credential Network
- **Plan:** complete the CTDL importer to a demo-able state (Jeanne); extend format support (scanned-PDF OCR soft-fail is the top real-Kenya gap); finish the terminology scrub remainder (228-occurrence purge → S2).
- **Pre-mortem:** CTDL `@graph` edge cases crash the importer on CE's real registry record → fuzz against the actual CE JSON-LD before the demo; terminology scrub reintroduces a banned term → `lint:copy` in CI is the backstop.

### RTE — Release/Train
- **Plan:** drive the deps + chain rails to merged/verified as they clear; execute the 1552 B2 integration re-soak per CTO ruling; wire the anti-hollow-soak guards into `ci.yml` (post-train) with the 4 added signatures + the #1565 drain-invariant reconciliation; land the `0359` canonical reservation.
- **Pre-mortem:** the Ready wave collides on agents.md (P7) → per-PR blocks + local union; guards' clean-mirror check needs the preflight output plumbed → verify the interface before wiring.

## 5. PER-LANE SM REFINEMENT + PRE-MORTEM (F7)

Each lane's Scrum Master ran a focused refinement of the next-slice stories + a lane-specific pre-mortem. Consolidated outputs:

- **Lane 1 SM:** top story = insert-capable proof materializer (unblocks KPI-3 at scale). Pre-mortem risk: "we backfill proofs that don't match the on-chain header" → verify against a header sample before bulk. Definition-of-ready added: census dry-run count + known-good comparison baseline.
- **Lane 2 SM:** top story = the credit-enforcement flag + funded-balance precondition (protects the pilot). Pre-mortem risk: "flag defaults wrong and silently blocks all orgs" → default OFF, explicit per-env enable, integration test for the fail-closed path. DoR: the flag exists in switchboard + a test asserting off-by-default.
- **Lane 3 SM:** top story = CTDL demo-readiness against CE's real record. Pre-mortem risk: "importer renders junk at 35% like today" → acceptance = CE's own registry record parses clean end-to-end. DoR: a fixture of the real CE JSON-LD in the test suite.
- **RTE SM:** top story = the T0-detector tweak (unblocks every lane's Ready wave). Pre-mortem risk: "detector tweak itself needs soak evidence" → it's CI/tooling-only (T0), lands fast; but must not loosen the gate for real prod-affecting paths — add a test that a migration/worker path still forces T3.

## 6. FINAL RECONVENE (F8) — decisions + standing actions

**Decisions ratified:**
1. **Nothing soaks; everything stays Draft** until the current train clears (deps ~9:36 PM ET tonight, chain integration soak ~1:13 PM ET tomorrow). Chain does **not** merge on isolated-soak evidence.
2. **1552 → B2** (re-soak integrated head); CTO to scope/schedule; likely slips 17:13Z maturity — accepted, founder calendar flag raised.
3. **The T0-detector tweak (P2) is the gating pre-req for the Ready wave** — first item of the next slice.
4. **SCRUM-2912 is launch-critical and founder/CTO-owned:** fund Haki balance + fresh cycle + is_test decision, and fund **before** enabling credit enforcement.

**Standing actions:** rail monitor stays armed (T2/T3/T5 auto-resume); window-close HANDOFF (T12) commits when the queue drains; the layman's-terms lane reports (F9) are the companion deliverable to this record.

_This record is docs-only, Draft-safe, no new code. Companion: `art-24h-slice-laymans-report-2026-07-20.md`._
