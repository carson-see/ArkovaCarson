# Arkova — Session Operating Model

> **Sprint-0 deliverable S0-E1 / Story 1.2.** Status: **DRAFT** — pending CTO + Carson review.
> Encodes how every working session starts aligned and self-routes the full SDLC. The CLAUDE.md pointer to this model lands via the S0-E3 v-next draft (Carson merges).

## 1. Bootstrap sequence (every session, in this order)

1. **CLAUDE.md** — the directive/rules. Then run `scripts/agent/ack-claude-bootstrap.sh` from the repo root. The ack records the current CLAUDE.md hash; `.claude/hooks/check-claude-bootstrap.sh` **blocks** staging/prod-sensitive Bash, linked Supabase ops, Cloud Run staging changes, and PR ready/merge/body edits until the hash is acknowledged.
2. **HANDOFF.md** — the live state snapshot. **Identify every ACTIVE SOAK and frozen/locked worktree — never disrupt or invalidate one.** (A staging service on a SHA not on the branch tip is an in-flight soak, not a teardown candidate.)
3. **[`lane-manifest.yaml`](./lane-manifest.yaml)** — identify the **lane-of-session**, its standing ownership, the guarded/shared surfaces, and the tiered-merge council.
4. **`agents.md`** — in every folder you intend to touch.
5. **The current sprint doc's lane block** (Confluence/Drive) — load the lane mission + the cross-lane brief + the named handoffs. You do NOT need the other lanes running.
6. **The referenced Jira ticket + its Confluence page** — if the task names a story/epic.

## 2. Success-preconditions surfaced at session start (roadmap Part VIII)

- specialists are constrained per-lane personas (not unbounded);
- isolated-rig automation lands before parallel soak volume;
- every external gate is owned + started early (CE/Haki are Q1);
- cross-runtime parity + config-drift detection precede more client features;
- claims-review + publishing-safety gates are mechanical;
- WIP is limited (one P0/lane/sprint; one T3 soak/shared rig).

## 3. Lane-of-session selection

**One lane per session.** Execute only that lane's surfaces; do not modify another lane's. Need a change elsewhere? **File a handoff — the owning lane makes it.** Sprint 0 is the train-led exception: the train roles (RTE/Planning/CTO/Release-Mgr/DBA/Biz) own the foundation epics; lanes support + onboard.

## 4. SDLC self-routing

```
plan ──▶ TDD (red → green → refactor; test-first, no test.skip)
     ──▶ soak tier  (path detector §1.12 → T0/T1/T2/T3; fails closed to "needs Carson")
     ──▶ review     (security scan every changed file; terminology lint:copy; claims-review)
     ──▶ merge per tier  (T0/T1 council via Mergify · T2/T3 Carson)
```

Every task closes the **7 task-execution gates** (tests · Jira · Confluence · bug log · agents.md · HANDOFF/CLAUDE.md · workflow validators) and respects the **staging-soak tier matrix** for any prod-bound change. No prod/soak mutation outside an approved lane.

## 5. Handoffs

A cross-lane need is a **handoff**, not a reach-in. Produce/consume handoffs are named per lane in the sprint doc. The owning lane implements; the requesting lane consumes the result.

---

## 6. Dry-run — 2026-06-17 (this session) + gaps captured

This Lane-1 Sprint-0 session **is** the required operating-model dry-run. Walk-through outcome:

| Step | Result |
|---|---|
| 1. CLAUDE.md + ack | ✅ ran `ack-claude-bootstrap.sh` → hash `6e34e985…` acknowledged at 18:00:02Z; subsequent staging-sensitive Bash unblocked. |
| 2. HANDOFF.md | ✅ identified ACTIVE soaks (Train C #1154 on `arkova-worker-staging`/`bwkskvbmcjodwxklpzyl`; Train D rigs) → left untouched all session. |
| 3. manifest | ✅ authored this session (S0-E1) — did not exist yet; **gap: CLAUDE.md has no pointer to it** → fix in S0-E3 v-next. |
| 4. agents.md | ✅ recon'd `services/worker/`, `services/edge/`, `scripts/`, `supabase/` agents.md. |
| 5. sprint lane block | ✅ read Lane-1 block (Confluence 83329025 + Drive). |
| 6. Jira/Confluence | ✅ read PI-1 master + Sprint 0 + roadmap; read-only S0-E2 audit. |

### Gaps found (feed S0-E3 + the RTE)

1. **Scope ambiguity train-vs-lane.** The kickoff brief simultaneously said "operate as the 3 lanes / S0-E1→E7" *and* "YOUR team is Lane 1." The one-lane-per-session rule resolved it, but the operating model should state explicitly: *Sprint 0 = train-led; a normal sprint = one lane.* (Encoded in §3 above.)
2. **CLAUDE.md ↔ manifest link missing.** The bootstrap read-list in CLAUDE.md §0.1 does not yet include the manifest. S0-E3 must add it.
3. **Stale source-of-truth pointers.** CLAUDE.md §5 + the `project_release_structure` memory still point at the superseded PO Roadmap 27591934 (now 82444290). S0-E3 + memory update.
4. **Tooling reliability notes for sessions:** Atlassian bulk-JQL drops/corrupts rows → verify per-key with `getJiraIssue`. Two PI-1 Drive doc IDs cited in the brief were inaccessible (DLP/trashed) → resolve PI-1 docs by folder + title, not by hard-coded ID.
5. **No Sprint-0 GitHub milestone** existed at session start → RTE to create `Sprint 0 — Foundation & Hardening` and tag S0 PRs to it (PI-1 feature milestones remain L{1-3}-S{1-7}).
