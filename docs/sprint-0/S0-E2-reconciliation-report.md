# S0-E2 — Source-of-Truth Reconciliation (READ-ONLY phase)

> **Sprint-0 deliverable S0-E2 / Story 2.1.** Status: **READ COMPLETE — all corrections are PROPOSALS, gated to Carson.**
> Method: every Jira ticket verified **per-key** with `getJiraIssue` (bulk JQL is unreliable here — drops/corrupts rows). Confluence/Drive/Gmail read-only via MCP. **No write/transition/comment/move/delete performed.** Date: 2026-06-17. Site: arkova.atlassian.net (space A / project SCRUM).
>
> The roadmap Q1–Q4 epic→lane structure extracted here is rendered as the RACI in [`../operating-model/lane-manifest.md`](../operating-model/lane-manifest.md).

## A. Canonical roadmap

**Confluence 82444290 — "12-Month Technical Roadmap v3"** (SOLIDIFIED baseline, modified 2026-06-17) is the canonical forward roadmap. It explicitly supersedes roadmap v1/v2 and the 2026-05-05 PO Roadmap. Q1–Q4 epic list with lane + tier + Jira is captured in the manifest RACI — not duplicated here.

## B. PO Roadmap 27591934 — SUPERSEDED (proposed banner, gated)

Page 27591934 ("Product Owner Roadmap", last modified 2026-05-05, 43 days stale) still self-asserts "Source of truth for execution order … this page wins" — a direct contradiction now that 82444290 is baseline. It is frozen at the R0–R4 recovery frame, and its "GitHub repo inaccessible" blocker is long-obsolete (211 PRs merged since).

**Proposed banner (DO NOT apply without Carson):**
> ⚠️ **SUPERSEDED 2026-06-17.** Frozen at the R0–R4 recovery frame (2026-05-05); no longer the execution source of truth. Canonical = **12-Month Technical Roadmap v3 (page 82444290)**. Per-story status: verify in Jira. Retained for historical/recovery-era context only.

**Knock-on:** CLAUDE.md §5 and the `project_release_structure` memory both still point here → re-point to 82444290 (handled in S0-E3 draft + a memory update).

## C. Confluence drift list

| Page | Title | Finding | Recommendation (gated) |
|---|---|---|---|
| 64258050 | SCRUM-1922 did:web | **No drift** — page = Done, did:web live in prod (PR #1043/#1061, 2026-06-02); Jira = Done. The "still says To Do — Blocked" premise was itself stale. | None. |
| 69828610 | SCRUM-1958 semantic search | **No drift** — page exists, honestly states "In Progress — code MERGED but feature DORMANT (`ENABLE_SEMANTIC_SEARCH=false`, table empty)"; matches Jira. | Optional: soften any HANDOFF wording that frames 1958 as plainly "merged/done" to match. |
| 426020 | "Product Roadmap March 2026" | Pre-baseline, still "Active". | Supersede banner → 82444290. |
| 9109505 | "P8 — AI Intelligence" | Repo-mirror (2026-03-16) claims semantic search 19/19 COMPLETE — contradicts dormant SCRUM-1958. | Mark stale-mirror. |

A full space-A `… — AUDIT` page sweep was scoped but not exhaustively run (priority was the two named items). Recommend a complete AUDIT-page reconciliation as a Planning follow-up.

## D. Jira status-correction list (all per-key verified)

**Net: no verified Jira status is actually false.** The "false-Done" smell concentrates in the stale PO-roadmap rows (doc fix, §B) and two epics worth a deeper check.

- **v1.0.0 epics:** 1040 GEMB2 = **Done**; 1041 SEC-HARDEN = **In Progress**; 1042 GCP-MAX = **To Do**; 1043 SOC2 = **To Do**; 1044 MCP-EXPAND = **Done**; 1045 GH-CI-OPT = **To Do**; 1046 PUBLIC-ORG = **To Do**; 1047 ADMIN-VIEW = **Done**; 1048 CONNECTORS-V2 = **In Progress**; 1049 API-V2 = **Done**.
- **Sprint-0 reuse:** 2313 RELEASE-OPS = **In Progress** (Epic); 2500 = **To Do** (Story under 2334, *not* an epic); 1867 CE/CTDL = **In Progress** (Epic); 1010 CIBA = **In Progress** (Epic); 883 FCRA counsel = **Needs Human** (Task under 804).
- **Recent PRD stories** 2490/2491/2492/2500/2501 — all **To Do**, all launch-blockers, consistent.

**Proposals (gated):**
1. **SCRUM-1044 & 1049** — possible-false-Done. Pull each one's **changelog** to confirm a non-Carson resolver (reporter=carson on both) and run a **child-rollup** before trusting Done.
2. **PO-roadmap rows for 1010/1048/1049** are stale (it lists them Done; Jira says In-Progress/In-Progress/Done) → fixed by the §B banner, no Jira change.
3. **SCRUM-1045 (GH-CI-OPT)** — work effectively shipped, not carried into any Q → consider close as Done/Won't-Do.

## E. Filing readiness (S0-2.2 — Carson-gated write phase)

All 7 proposed Sprint-0 epics (S0-OPS-MODEL, S0-RECON, S0-CLAUDEMD, S0-PIPELINE, S0-VISIBILITY, S0-HYGIENE, S0-GATES) and the Sprint-1 lane epics are **net-new** — zero naming collisions. Two scoping cautions:

- **SDK-PY** overlaps **Done SCRUM-1112** (`arkova-py`) + subtask 1565 → file as **GA/proof-helpers**, link 1112, don't rebuild.
- **VC-W3C** front-runs **OPEN decision spike SCRUM-2296** (+subtask 2305) → file as **follow-on**, or close 2296 to ratify, or soften roadmap "DECIDED".
- New Q1 epics that "extend" Train-D stories (2401/2477/2478/2354/2479 — all Stories under MVP-D epics 2328/2332/2334) should **link/re-parent** those, not re-create a third copy.

`SCRUM-2126 [CSI-S0] Sprint 0 Triage` is a **CSI-specific** task — do not conflate with the cross-cutting Sprint-0 epics.

## F. Drive stale-doc PURGE CANDIDATES (LIST ONLY — gated, nothing moved/deleted)

Live PI-1 set lives in Drive folder `1hIE6DH9-hVkNPFx8ugK5M7g-YPpzi3j0` ("v2 Roadmap" — misnomer, holds the v3-era live docs). Confirmed-superseded copies sit in the **"PRDs & Release Plans"** drafts folder (`1-Wp5vLSJJmVONkXRs974Bz3cRZ9ceoG_`):

| File | ID | Why superseded |
|---|---|---|
| 12-Month Roadmap **v2** | `1FTfpYUCFgBgWfkH5of8awsQ8BqOohHazetK2bKib-qQ` | v3 supersedes v1+v2 |
| Sprint 0 (Pre-Execution) — old "Sprint 0 plan" | `1PyR8Vt_dEk_49a3ix6SSVQNxTX2LyjYFBkCQnPIILGo` | folded into consolidated Sprint 0 |
| Sprint 0 Jira Backlog — old separate backlog | `1aZ4kwteVt9HKp2sTGtI7PsXKSI5xQJsVSpBW6KT7zoM` | folded into Sprint 0 Part B |
| Sprint 0 — the "\&"-typo copy | `1aRJe3jXqV94fcaszY_m3EJ8JYw4MqKLLEdd6F0JVM1A` | HTML-entity-corrupted intermediate; its own body says trash it |

Lower-confidence: older same-day Sprint 1/4/7 drafts in the same folder. **Roadmap "v1"** has no distinctly-titled doc — do not auto-purge the legacy "Arkova Product Roadmap"/"x402-Plan"/"Phase 3 Backlog" without Carson confirming which is the "v1 draft." **All moves/deletes are Carson's.**

## G. Partnership state — one current note

- **Credential Engine (CE)** — most advanced. Trial agreement **eSigned 2026-06-09** (Carson + Jeanne Kitchens, CTSO); **temporary API keys LIVE** (account approved 2026-06-09; Jeanne email 2026-06-10). Approved publishing roles: QA Org + Competency Framework Org; consuming: Graph Search API + Download-for-Offline. Org profile `67d71073-…`. **Permanent key + sandbox = still pending** (the S0-7.2 / Q1.9 action; **~Sept-2026 trial-key expiry is the hard PI-1 clock**). CTDL track (SCRUM-1867): Jeanne reviewing Arkova's mapping in shared doc; corrections on creditValue/expirationDate/OB3 alignment, Jeff coordinating. **⚠ Claim risk:** CE approved Arkova *to publish*, NOT "listed in the Registry" — keep that out of UI/marketing (R-7 claims-review).
- **CSI (issuer partnership, SCRUM-1596)** — cold outreach only; one-shot Feb-2026 emails to Credly/Accredible unanswered; no Udemy thread. Effectively un-started partner-side.
- **CPE/CLE** — discovery/advisory via Jenny Parks' network (Kris Maul call 2026-06-22; Melanie Booth; Bryan Ashton/Trellis). Targets: CAEL, UPCEA. No signed partner.
- **HakiChain** — **LIVE Kenya launch pilot** on Arkova's webhook + API. Contacts Mercy Wairimu / Kevin Isom. Beta account provisioned; HMAC lifecycle webhooks (anchor.secured/revoked) under test; latest substantive thread "Legal/Ops" 2026-06-04. **Kenya cross-border flag:** Arkova metadata hosted US (Supabase us-east-2 + GCP us-central1) → Kenyan personal data is a documented cross-border transfer needing SCC + transfer-impact analysis vs Kenya DPA/ODPC (feeds the Kenya/EAC gate).

## H. CSA STAR / CAIQ

Folder "CSA Star 1" (`1ZhNB3MCB6UAJe4P6VTRT9pM87-5TOaz_`). **v2 regenerated CAIQ sheets exist** (2026-06-17, Parts 1–3). **Superseded v1 sheets (2026-06-11) still sit in the same folder**, flagged for archiving; the **"Archive — superseded CAIQ v1" folder was created but is EMPTY** — the 3 v1 sheets are flagged-not-yet-moved. Moving them is the open housekeeping action (Carson — Drive MCP cannot move existing files anyway).

## Gated-action summary (nothing executed)

1. Banner PO Roadmap 27591934 as superseded; re-point CLAUDE.md §5 + memory → 82444290.
2. Banner pages 426020 + 9109505 as stale.
3. Changelog + child-rollup check on SCRUM-1044 & 1049; consider closing 1045.
4. File Sprint-0 + Sprint-1 epics (S0-2.2) with the SDK-PY/VC-W3C scoping cautions; link existing Train-D stories.
5. Move 3 superseded CAIQ v1 sheets to the Archive folder (manual — Drive MCP can't move).
6. Decide on the Drive purge-candidate list (F).
