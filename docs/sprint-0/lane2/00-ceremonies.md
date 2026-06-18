# Lane 2 (Product & Growth) — PI-1 Sprint 0 Ceremonies

> **Lane:** L2 — Product & Growth. **Sprint:** PI-1 Sprint 0 (Foundation & Hardening). **Date:** 2026-06-18.
> **Operated by:** Claude under Carson's (CPO) oversight + sole T2/T3 merge gate. **Personas this lane:** Senior Full-stack, Front-end, DBA, Architect, API Engineer.
> **Tier:** T0 (read-only specs/designs; no running-surface change). **Branch:** `lane2/s0-visibility-predesign`. **Milestone:** Sprint 0 — Foundation & Hardening (GitHub #24).
> **Guardrails honored:** no merge to main; no prod/staging/Supabase/soak mutation; Train C #1154 + Train D rigs untouched; no edits to existing PRs (#1208–#1211); no Drive/Confluence destruction. All external/irreversible actions gated to Carson.
> **Sources:** PI-1 Master (Confluence 83296257), Sprint 0 plan (83329025), lane manifest (`docs/operating-model/lane-manifest.yaml`, from PR #1208 — read-only consume), Lane-1 visibility-signal inventory (`docs/sprint-0/lane1/visibility-signal-inventory.md`, from #1208).

---

## 1. Sprint Refinement (Lane 2)

### 1.1 Scope (from the Sprint 0 plan, Lane 2 block)
**Mission:** "Be onboarded and deliver the internal-visibility spec + the API-key-expiry dashboard design; pre-design the revenue funnel + Instant Secure so Sprint 1 starts coding."

**OWNED Sprint-0 story:** S0-5.1 — internal-visibility dashboard spec (DOUBLE_BILLING_RISK / fail-open flags / key & secret expiries). T0.
**Pre-design (feeds Sprint 1+):** API-key-expiry dashboard design (→ SCRUM-2507 KEY-EXPIRY); revenue funnel (→ S3 monetization); Instant Secure UX + flag flip (→ S4–S7, gated by the DOUBLE_BILLING_RISK alarm).
**Onboarding:** read-list covered ✓, bootstrap-ack passing ✓, first PR is a low-risk T0 docs PR.

### 1.2 Definition of Ready (each item, before build)
- Real source surfaces identified (file path + symbol), not invented names.
- Cross-lane dependencies named as explicit handoffs (consume/produce).
- "Implementation deferred to Sprint 1+" stated where the item is a spec (no code lands this sprint).
- Terminology gate (CLAUDE.md §1.3) + claims-review gate pre-checked for any user-visible copy / partnership claim.

### 1.3 Refined backlog (deliverables → AC → subtasks)

| ID | Deliverable | Acceptance criteria | Subtasks | Persona | Tier |
|---|---|---|---|---|---|
| **L2-A** | **S0-5.1 internal-visibility dashboard spec** (OWNED) | Spec defines data sources/metrics/admin-only surfacing for the 3 signals; read-only; implementation = Sprint 1 (VIS-01/KEY-EXPIRY); named owner; DBA + Bitcoin-Dev review captured | [Build] signal inventory + sources; [Build] dashboard spec + thresholds; [Verify] DBA + Bitcoin-Dev review; [Close-out] file Jira/Confluence | Architect + API Engineer | T0 |
| **L2-B** | **API-key-expiry dashboard design** (KEY-EXPIRY pre-design) | Design covers `api_keys.expires_at` + secret-rotation clocks + the CE ~Sept-2026 headline; T-30 alarm mechanism; admin-only dashboard; alert routing; feeds SCRUM-2507 | [Build] expiry/secret inventory; [Build] T-30 alarm + dashboard design | API Engineer + Full-stack | T0 |
| **L2-C** | **Revenue-funnel pre-design** | verified_individual pricing/sell (Stripe), credit-pack purchase + ledger UI, self-serve org signup + domain verification designed so Sprint 1 codes not scopes; design-only (any real billing change is T2 → Carson) | [Build] funnel + data/Stripe touchpoints; [Build] ledger UI + entitlement gates | Full-stack + Front-end + DBA | T0 |
| **L2-D** | **Instant-Secure pre-design** (Lane-2 product side) | UX + flag-flip design; money path fail-CLOSED; gated by DOUBLE_BILLING_RISK alarm; depends on Lane-1 chain-side atomic debit+anchor RPC (S4, Train D); Sprint-1 entry list | [Build] UX + flag + fail-closed design; [Build] cross-lane dependency map | Architect + Full-stack | T0 |
| **L2-E** | **Onboarding + ceremonies + filing** | read-list ✓, bootstrap-ack ✓, first T0 PR (this docs set) to milestone #24; Jira S0-5.1 filed; Confluence spec page; agents.md updated; HANDOFF entry prepared | this doc + README + agents.md + Jira/Confluence | RTE/Planning (lane) | T0 |

### 1.4 Definition of Done (Lane 2 Sprint-0, from the plan)
- internal-visibility spec **approved with named owner** (data sources/metrics/admin-only for the 3 signals; read-only; impl deferred to Sprint 1+);
- revenue funnel + Instant Secure **pre-designed so Sprint 1 codes not scopes**;
- onboarding complete (read list, bootstrap-ack, first T0/T1 PR);
- STANDARD STORY DoD: AC met; tests written-first + green **where code is involved** (N/A — specs only this sprint); Confluence current; Jira transitioned with subtasks closed; agents.md/HANDOFF updated; reviewed + merged per tiered-merge (Carson merges); no prod/soak mutation outside an approved lane.

---

## 2. Sprint Planning (Lane 2)

### 2.1 Team & assignment (parallel specialist personas)
- **Agent A — Architect + API Engineer →** L2-A (S0-5.1 visibility spec). The flagship; longest.
- **Agent B — API Engineer + Full-stack →** L2-B (API-key-expiry dashboard design).
- **Agent C — Full-stack + Front-end + DBA →** L2-C (revenue-funnel pre-design).
- **Agent D — Architect + Full-stack →** L2-D (Instant-Secure pre-design).
- **Lane lead (this session) →** L2-E: ceremonies, recon, QA/assembly, Jira/Confluence filing, draft PR, report.

Disjoint output files under `docs/sprint-0/lane2/`; agents read-only on code, write exactly one doc each, run **no git** (the worktree is private to this Lane-2 run). Lane lead owns all git + external writes.

### 2.2 Boundary to avoid A/B overlap
A covers Signal 3 (key/secret expiry) only at the **dashboard-surface/inventory** level (one of three signals on the unified VIS-01 board). B owns the **deep KEY-EXPIRY mechanism** (T-30 alarm, rotation clocks, alert routing). A links to B for the deep dive.

### 2.3 Order, tier, milestone
All T0. One draft PR → milestone #24. Branch `lane2/s0-visibility-predesign` off `origin/main` (`5b7111e5`). Independent of #1208 (disjoint files: my `docs/sprint-0/lane2/**` vs their `docs/sprint-0/{README,S0-E2,...}` + `lane1/**`); cross-references to the manifest resolve once #1208 merges (merge order #1208 first is already the plan).

### 2.4 Handoffs
- **CONSUME ←** lane manifest + session operating model (#1208, S0-E1); CLAUDE.md v-next pointer (#1210, S0-E3); Lane-1 visibility-signal inventory + Bitcoin-Dev review (#1208); DBA review (in-lane persona).
- **PRODUCE →** S0-5.1 spec + key-expiry design feed Sprint-1 VIS-01 (SCRUM-2510) + KEY-EXPIRY (SCRUM-2507); the 3-signal inventory + thresholds feed Lane-1's S0-5.2 drift/parity gate (shared threshold definition); revenue-funnel + Instant-Secure pre-designs feed S3–S7.

### 2.5 WIP / capacity
One owned P0 (S0-5.1); 3 pre-designs in parallel. No T2/T3 in this slice (none touched). No migration ledger touch (RTE did not assign Lane 2 the single migration soak).

---

## 3. Pre-Mortem (Lane 2 Sprint 0)

**Frame:** "It is the end of Sprint 0 and the Lane-2 slice failed / had to be redone. What went wrong?"

| # | Failure mode | Likelihood | Impact | Mitigation (in force this sprint) | Trip-wire |
|---|---|---|---|---|---|
| P1 | **Scope creep beyond Lane 2** (touch chain/proof, CE client, CLAUDE.md, migrations) — the exact over-step that halted the prior session twice | Med | High | Agents are read-only on code + write only `docs/sprint-0/lane2/**`; DO-NOT-TOUCH list in every agent prompt; lane lead reviews every file path before commit | Any write outside `docs/sprint-0/lane2/**` |
| P2 | **Overclaiming / spec asserts prod state** (e.g., "the atomic debit RPC exists", "CE listed in Registry") | Med | High (R-7 trust) | claims-review gate; specs say what is *measured/asserted/NOT asserted*; `debit_and_enqueue_anchor` flagged as **Train D, not yet on main**; CE = "approved to publish, not listed" | Any unhedged prod/partnership claim |
| P3 | **HANDOFF.md merge collision with #1208** (both append to "Now") | High if attempted | Med (churn) | **Do NOT put HANDOFF.md in this PR**; ship the entry as ready-to-paste text for Carson to land after #1208 merges (CLAUDE.md §6) | HANDOFF.md in `git diff` |
| P4 | **Spec not implementable** — VIS-01 team in Sprint 1 still has to scope | Med | High (defeats the point) | Cite real files/symbols/RPCs; "reuse existing collection" per Lane-1 (emitRpcFallback, db-health-monitor, switchboard_flags) — no new collection paths; concrete metrics + thresholds + query sketches | A reviewer asks "where does this data come from?" with no answer |
| P5 | **Terminology-gate breach** in admin copy (Wallet/Hash/Transaction/Bitcoin visible) | Low | Med (CI red / brand) | Dashboards are admin-only/internal (technical names allowed internally) but any user-visible string routes through `src/lib/copy.ts`; flag, don't inline | Banned term in a proposed user-facing label |
| P6 | **PII / treasury exposure in the visibility surface** | Low | High (§1.4/§1.6) | admin-only (platform-admin, per 2026-04-21 treasury decision); no PII; Sentry scrubbing; counts/states not raw rows | Spec surfaces a raw email / document fingerprint / USD to non-admins |
| P7 | **Green-washing the DoD** (tick boxes that aren't truly done) | Low | Med | DBA review in-lane; Bitcoin-Dev (Lane-1) formal review = **pending publication** (flagged, not faked); no premature Jira Done (gates need code-on-main + prod-green) | A DoD box ticked with a "pending" reality |
| P8 | **Shared-checkout / soak contention** | Low | High | Private worktree off main; no git in agents; Train C #1154 + Train D rigs read-only-untouched; no Mergify/branch-protection touch | Any operation on the main checkout or a soak rig |
| P9 | **Token/ceremony bloat** without delivery (the prior token-AC miss) | Med | Low | Specs are the deliverable; ceremonies are bounded; no CLAUDE.md edit (not my lane) | Ceremony docs > the specs they wrap |

**Top-3 to watch:** P1 (scope), P2 (overclaim), P4 (implementability). All three are addressed by: tight agent boundaries, the claims-review framing, and real-surface grounding.

---

## 4. Retrospective (end of Lane-2 Sprint-0 execution)

### What went well
- **Scope held cleanly** — the top-3 pre-mortem risk (P1, scope-creep beyond Lane 2) did not materialize: `git status` confirmed only `docs/sprint-0/lane2/**` added, zero modifications to tracked files, no chain/CE/CLAUDE.md/migration touch. The read-only-code + write-one-file agent boundaries worked.
- **Parallel specialists delivered top-of-range** — 4 disjoint specs (1303 spec lines total) grounded in real files with line numbers, not invented names; the flagship S0-5.1 is directly implementable by the Sprint-1 VIS-01 team.
- **The grounding paid off in findings** — reading the real surfaces surfaced 11 candidate issues (F1–F11), incl. 4 bug-shaped money/auth ones, that a paper-only spec would have missed.
- **Honesty discipline held** — Train D's `debit_and_enqueue_anchor` flagged as incoming (never asserted in prod); Bitcoin-Dev review marked pending-publication (not faked); no premature Jira Done.

### What went badly / watch-items
- **Two metrics (M1c, M2b) depend on Lane-1 telemetry confirmation** — rendered as "source pending Lane-1" rather than blocking. Real, but a clean handoff, not a miss.
- **HANDOFF.md** had to be kept OUT of the PR to dodge a collision with #1208 (both append to "Now") — entry is provided as paste-ready text instead. Correct per CLAUDE.md §6, but it means the DoD "HANDOFF updated" box is satisfied via a flagged deferral, not an in-PR edit.
- **Findings can't be auto-filed** — soak-window cascade discipline + assert-prod-state + security-sensitivity (F1) mean F1–F7 are flagged for Carson, not turned into bug-tracker rows or spin-off tasks here.

### Action items
- Carson triage of F1–F7 → bug-tracker entries (canonical Confluence log) once verified against prod.
- On #1208 merge: land the HANDOFF entry; obtain the Bitcoin-Dev formal sign-off on S0-5.1; resolve the shared-threshold-module home so VIS-01 + S0-5.2 import one definition.
- Sprint-1 VIS-01 must wire the two residual live cases (env↔DB split; 100%-fallback SPOF) the spec calls out.
