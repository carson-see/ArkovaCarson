# HANDOFF.md - Arkova Living State Snapshot

> **Purpose:** Current state of the project. Updated at the end of every session. Keep this short; historical detail belongs in git log, Jira, Confluence, Drive archives, or Supermemory.
>
> **Source-of-truth layering:**
> - **Jira** = story status, scope, acceptance criteria -> https://arkova.atlassian.net/jira/software/projects/SCRUM
> - **Confluence** (space "A") = topic docs + per-epic audit pages -> https://arkova.atlassian.net/wiki/spaces/A
> - **Bug tracker** = Confluence [Bug Tracker - Master Log](https://arkova.atlassian.net/wiki/spaces/A/pages/88768514)
> - **HANDOFF.md** = rolling snapshot of now, not a session transcript
> - **CLAUDE.md** = operating directive / rules
> - **git log** = what changed, by whom, when

---

## Now

### 2026-07-06 (tooling) — lint:copy multi-line-JSX blind spot CLOSED (SCRUM-2666, PR #1440, T0)

The `lint:copy` per-line scan short-circuited raw JSX text lines (no quote char + no same-line `<`/`>` pair) — the blind spot that shipped "Bitcoin blockchain" in `PublicVerification.tsx:658` (copy removal owned by open PR #1433). Fixed with a cross-line **context-stack** JSX state machine (`scanFileContent()` in `scripts/check-copy-terms.ts`) that also tracks copy inside `{cond && (…)}` renders, `.map()` callbacks, and fragments; 28 red-first tests + fixture (`scripts/fixtures/`). Round-2 adversarial review (parallel refuter agent) killed the round-1 flat machine — closing-tag guard bug had put 1,932 code lines into force-scan mode; all 8 confirmed findings fixed + test-locked; post-fix census: 0 code-shaped force-scanned lines. Fixed-scanner sweep of the full 356-file scope found exactly 3 pre-existing hits, all grandfathered with retirement conditions in `copy-terms-baseline.json`: PublicVerification 658 ×2 (retire on #1433 merge) + `PipelineAdminPage.tsx:1196` "worker service" (UX-03; reword-vs-ops-exclusion follow-up session spawned). Also allowlisted `scripts/check-copy-terms*.ts` + `scripts/fixtures/` as T0 tooling in `check-staging-evidence.ts` (was falling through to T1 "default frontend"). Bug row BUG-2026-07-06-004 in the master log; Jira SCRUM-2666 In Progress; Confluence page 96108545.

_Verified via: `npx vitest run scripts/check-copy-terms.test.ts` (115/115) + `scripts/ci/check-staging-evidence.test.ts` (165/165); `npm run lint:copy` (0 new, 11 grandfathered, 0 stale); `tsc --noEmit` (0); `requiredTierFor(<changed files>)` → T0; instrumented repo census (4,855 continuation lines, 0 code-shaped); PR https://github.com/carson-see/ArkovaCarson/pull/1440. No prod/staging/schema state asserted or changed._

### 2026-07-06 (RTE/ART) - Final Sprint 3.25/3.5/3.75/3.8/3.85/3.9 artifact packet

Use this clean final-artifacts folder for founder review: https://drive.google.com/drive/folders/1ItbVr6LtLMzif20hCUwEClYhcHYUsddd.

It intentionally contains only the current final sprint artifacts:
- Sprint 3.25 ART Launch Bug Sprint Report: https://docs.google.com/document/d/1r4_OSv0_5XlD2Lp0mJ8DcCPHR2xqEB3UtoF7haQJqIk/edit?usp=drivesdk
- Sprint 3.5 Release Confidence ART Plan: https://docs.google.com/document/d/1_JkNoMBjthykcS7fPTSmpFhme9ttfVS6H2BGQA_SOEc/edit?usp=drivesdk
- Corrected Sprint 3.75 / PI-1 CE-Haki Critical Path + 12-Hour Release Priority: https://docs.google.com/document/d/1wze9aOe-A4yNoW4tSqWjzC-VtwjEupTy5DAcsQPOFos/edit?usp=drivesdk
- Sprint 3.8 Program Administrator Provisioning & Internal Controls ART Plan: https://docs.google.com/document/d/1cqv_rOc-YnGo0w3ri6VVrsHUIGoHKxd1M4rDaPwoYfI/edit?usp=drivesdk
- Sprint 3.85 Launch Trust / Security / Privacy / Usability Gap Sweep ART Plan: https://docs.google.com/document/d/19ptuJWHViaCe8y4F6_zgwrmAPAmsdL6c65D9W_F79RY/edit?usp=drivesdk
- Sprint 3.9 Sprint 4 Readiness Evidence / UAT / Founder Go-No-Go ART Plan: https://docs.google.com/document/d/17Qyd4kBEJWWdyZbZLSWTtgV9YhCHNHNQCiDFnm-NyK4/edit?usp=drivesdk

Current sprint interpretation:
- **3.25:** launch-blocker hardening sprint. Lane 2 first for security/privacy/legal risk; Lane 1 second for proof/chain integrity; Lane 3 third for public verification/API trust. Planning/report/story packet is done; this does **not** assert the underlying bugs are fixed/live.
- **3.5:** Release Confidence / CI-CD / staging parity after 3.25. Supabase work remains a supporting workstream, not the whole sprint.
- **3.75:** corrected PI-1 S1-S7 Credential Engine + HakiChain critical-path reconciliation. This is not a standalone "make CE/Haki done" sprint and does not replace the PI-1 sequencing.
- **3.8:** program administrator provisioning and internal controls sprint. Lane 2 leads; CTO/RM/Security review required; Lane 1 consults on evidence integrity; Lane 3 consults on CE/Haki/program account scope.
- **3.85:** launch trust/security/privacy/usability closure-evidence sprint. Lane 2 has top priority for operational/user-visible risk; Lane 1 second for security/privacy/proof gates; Lane 3 third for public verification, AI/PII, and CE/Haki smoke evidence. This does **not** replace Sprint 3.0 or 3.5.
- **3.9:** Sprint 4 readiness evidence sprint after 3.85. It packages founder go/no-go, current UAT, CE/Haki acceptance bridge evidence, incident/support/rollback proof, backup/restore proof, API onboarding, privacy ops, and status/config-drift evidence. It is not a hiding place for unresolved 3.85 P0s.

Sprint 3.0 active execution state - do not erase:
- Sprint 3.0 is still active. The 3.25/3.5/3.75/3.8 planning packet does **not** mean Sprint 3.0 is complete, merged, live, or soaked.
- As of the 2026-07-06 PR check, open S3 story PRs remain draft/blocked/dirty across all lanes. Nothing in this documentation cleanup accepts launch soak or replaces lane-level delivery evidence.
- Lane 1 still has open proof/chain/verifier work: `#1408` chain resilience, `#1410` back-catalogue classifier, `#1411` verifier parity, `#1416` web extension vendor fix, `#1417` batch anchoring producer, `#1427` proof completeness migration/write path, and `#1433` proof-surface disclaimer.
- Lane 2 still has launch-critical queue/security follow-through: `#1434` QUEUE-10 drain hardening / SCRUM-2625 is open and blocked; OPS-03 dashboards and QUEUE-08 instant-secure remain Sprint-4 entry criteria unless Jira/PR evidence explicitly closes them.
- Lane 3 still has CE/Haki/public-trust S3 work open: `#1412` CE mapping/fail-closed claims gate, `#1413` AI golden set/eval/template review, and `#1415` CPE/CLE secured export/dashboard.
- Release/CI management still has open support PRs: `#1428` prod-tables snapshot refresh is unstable/dequeued and `#1429` TLA jar/handoff-claims hotfix is blocked.
- Do not start clean Sprint 4 / 3.25 integration as "post-S3" work until these S3 inputs are merged, closed as intentionally deferred, or explicitly risk-accepted by CTO/RM/ART. No 48-hour launch proving soak is asserted here.

Jira / Confluence trace:
- Sprint 3.25 trace: `SCRUM-2483` comment `16785`
- Sprint 3.5 trace: `SCRUM-2312` comment `16786`
- Sprint 3.75 CE trace: `SCRUM-1867` comment `16787`
- Sprint 3.75 Haki trace: `SCRUM-1010` comment `16788`
- Sprint 3.8 anchor: `SCRUM-2637`, comment `16789`
- Sprint 3.85 epic: `SCRUM-2638`, comment `16790`; Confluence page `95944705`
- Sprint 3.9 epic: `SCRUM-2639`, comment `16791`; Confluence page `95977473`
- Sprint 3.85/3.9 JQL: https://arkova.atlassian.net/issues?jql=project%20%3D%20SCRUM%20AND%20labels%20in%20(sprint-3-85%2C%20sprint-3-9)%20ORDER%20BY%20key%20ASC
- Confluence roadmap trace: page `82444290` footer comment `95780866`
- Confluence program-board trace: page `85622786` footer comment `95715332`

Archive / stale guidance:
- Legacy session packet folder: https://drive.google.com/drive/folders/1cQ5rbbFStwDRI870su-gpm-Ud7Aq_JrB
- Founder-provided Archive root: https://drive.google.com/drive/folders/1uA7CQZohx50gHTAX9cFjQvg8hBg3Raq0
- Session archive subfolder: https://drive.google.com/drive/folders/1smgQGFggH5vLpk02AiUWFdrMVP4VG6Vb
- Do not use the superseded 3.75 report, old 12-hour arbitration report, original Bug Hunt report, original Sprint 4 prioritization report, or Supabase meeting notes as current guidance.

Known loose ends:
- SSD backup remains pending; no Crucial SSD backup state changed in this session.
- No production, schema, deploy, runtime, or database state changed by the documentation/refinement pass.
- Two older pre-existing lane docs still appear in the legacy S3 folder because Drive returned `appNotAuthorizedToFile` even after Archive access was granted: `1OAltgtonRD39SvHYh-9foTk7zj8lY5YxZX5tUO9GuXI` and `1jl7KoMryRrmgWM9afFvXjmmPbfpwnzx6hwOcG7fOE68`.

_Last refreshed: 2026-07-06 by Codex - verified against Drive readback for final folder `1ItbVr6LtLMzif20hCUwEClYhcHYUsddd`, docs `1r4_OSv0_5XlD2Lp0mJ8DcCPHR2xqEB3UtoF7haQJqIk`, `1_JkNoMBjthykcS7fPTSmpFhme9ttfVS6H2BGQA_SOEc`, `1wze9aOe-A4yNoW4tSqWjzC-VtwjEupTy5DAcsQPOFos`, `1cqv_rOc-YnGo0w3ri6VVrsHUIGoHKxd1M4rDaPwoYfI`, `19ptuJWHViaCe8y4F6_zgwrmAPAmsdL6c65D9W_F79RY`, and `17Qyd4kBEJWWdyZbZLSWTtgV9YhCHNHNQCiDFnm-NyK4`; Jira/Confluence trace above; GitHub PR check restored Sprint 3.0 active state; Supermemory saves `CKbwLFbkWtWtDgLRS5ofb6`, `57e6zJKR4SgazS1gKPZrj1`, `ihUSJZ8Tv15MMYxfyhzA3u`, `BZTruDzwRqg29Vcm3QL1qE`, `me9Tr3Qpdx1KkDAuPkywL7`, `AS8CbDkqRGyRUMeoWKG55D`, and `t4D2F5KyrY2YhbdMwzypLV`._
