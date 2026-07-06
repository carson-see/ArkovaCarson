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

### 2026-07-06 (RTE/ART) - Final Sprint 3.25/3.5/3.75/3.8 artifact packet

Use this clean final-artifacts folder for founder review: https://drive.google.com/drive/folders/1ItbVr6LtLMzif20hCUwEClYhcHYUsddd.

It intentionally contains only the current final sprint artifacts:
- Sprint 3.25 ART Launch Bug Sprint Report: https://docs.google.com/document/d/1r4_OSv0_5XlD2Lp0mJ8DcCPHR2xqEB3UtoF7haQJqIk/edit?usp=drivesdk
- Sprint 3.5 Release Confidence ART Plan: https://docs.google.com/document/d/1_JkNoMBjthykcS7fPTSmpFhme9ttfVS6H2BGQA_SOEc/edit?usp=drivesdk
- Corrected Sprint 3.75 / PI-1 CE-Haki Critical Path + 12-Hour Release Priority: https://docs.google.com/document/d/1wze9aOe-A4yNoW4tSqWjzC-VtwjEupTy5DAcsQPOFos/edit?usp=drivesdk
- Sprint 3.8 Program Administrator Provisioning & Internal Controls ART Plan: https://docs.google.com/document/d/1cqv_rOc-YnGo0w3ri6VVrsHUIGoHKxd1M4rDaPwoYfI/edit?usp=drivesdk

Current sprint interpretation:
- **3.25:** launch-blocker hardening sprint. Lane 2 first for security/privacy/legal risk; Lane 1 second for proof/chain integrity; Lane 3 third for public verification/API trust. Planning/report/story packet is done; this does **not** assert the underlying bugs are fixed/live.
- **3.5:** Release Confidence / CI-CD / staging parity after 3.25. Supabase work remains a supporting workstream, not the whole sprint.
- **3.75:** corrected PI-1 S1-S7 Credential Engine + HakiChain critical-path reconciliation. This is not a standalone "make CE/Haki done" sprint and does not replace the PI-1 sequencing.
- **3.8:** program administrator provisioning and internal controls sprint. Lane 2 leads; CTO/RM/Security review required; Lane 1 consults on evidence integrity; Lane 3 consults on CE/Haki/program account scope.

Jira / Confluence trace:
- Sprint 3.25 trace: `SCRUM-2483` comment `16785`
- Sprint 3.5 trace: `SCRUM-2312` comment `16786`
- Sprint 3.75 CE trace: `SCRUM-1867` comment `16787`
- Sprint 3.75 Haki trace: `SCRUM-1010` comment `16788`
- Sprint 3.8 anchor: `SCRUM-2637`, comment `16789`
- Confluence roadmap trace: page `82444290` footer comment `95780866`

Archive / stale guidance:
- Legacy session packet folder: https://drive.google.com/drive/folders/1cQ5rbbFStwDRI870su-gpm-Ud7Aq_JrB
- Founder-provided Archive root: https://drive.google.com/drive/folders/1uA7CQZohx50gHTAX9cFjQvg8hBg3Raq0
- Session archive subfolder: https://drive.google.com/drive/folders/1smgQGFggH5vLpk02AiUWFdrMVP4VG6Vb
- Do not use the superseded 3.75 report, old 12-hour arbitration report, original Bug Hunt report, original Sprint 4 prioritization report, or Supabase meeting notes as current guidance.

Known loose ends:
- SSD backup remains pending; no Crucial SSD backup state changed in this session.
- No production, schema, deploy, runtime, or database state changed by the documentation/refinement pass.
- Two older pre-existing lane docs still appear in the legacy S3 folder because Drive returned `appNotAuthorizedToFile` even after Archive access was granted: `1OAltgtonRD39SvHYh-9foTk7zj8lY5YxZX5tUO9GuXI` and `1jl7KoMryRrmgWM9afFvXjmmPbfpwnzx6hwOcG7fOE68`.

_Last refreshed: 2026-07-06 by Codex - verified against Drive readback for final folder `1ItbVr6LtLMzif20hCUwEClYhcHYUsddd`, docs `1r4_OSv0_5XlD2Lp0mJ8DcCPHR2xqEB3UtoF7haQJqIk`, `1_JkNoMBjthykcS7fPTSmpFhme9ttfVS6H2BGQA_SOEc`, `1wze9aOe-A4yNoW4tSqWjzC-VtwjEupTy5DAcsQPOFos`, and `1cqv_rOc-YnGo0w3ri6VVrsHUIGoHKxd1M4rDaPwoYfI`; Jira/Confluence trace above; Supermemory saves `CKbwLFbkWtWtDgLRS5ofb6`, `57e6zJKR4SgazS1gKPZrj1`, `ihUSJZ8Tv15MMYxfyhzA3u`, `BZTruDzwRqg29Vcm3QL1qE`, and `me9Tr3Qpdx1KkDAuPkywL7`._
