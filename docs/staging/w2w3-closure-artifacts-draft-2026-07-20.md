# W2/W3 Closure Artifacts — DRAFT (finalize after railb2 closes 2026-07-21T17:13Z)

**Owner:** Release/Train lane (RTE). **Status:** DRAFT — three closure artifacts staged during the watch window. The CTO release verdict on **W2 question 2** signs only once railb2 (chain rail #1552 / 0358) evidence closes at 17:13Z Jul 21; until then these are skeletons with the verifiable parts filled and the soak-dependent parts marked ⏳.

---

## Artifact 1 — Final RC-manifest (release-candidate roll-up) skeleton

Consolidates the four Jul-19/20 rails into one auditable release record. Per-PR authorization/tier/head-SHA is preserved (RC manifests are audited evidence, not a bypass — CLAUDE.md §1.12).

| Rail | Rig | Supabase ref | PRs | Tier | Window | Status |
|---|---|---|---|---|---|---|
| wave3 (rca) | rca20260719 | mhbtgihvjoazwxuypado | #1568 #1569 #1571 #1573 #1549 #1570 | T2 | 2026-07-19T16:45→07-20T05:15Z, 749/749 200s | ✅ merged/verified (1573/1570 landing) — manifest `rc-2026-07-20-wave3.json` |
| airail (rcd) | rcd20260719 | icworykrfztdhmhidtim | #1550 #1555 | T2 | 17:12→05:42Z, 720/720 200s | ✅ 1550 merged; ⏳ 1555 retarget/merge in flight — manifest `rc-2026-07-20-airail.json` |
| deps (rcb) | rcb20260719 | aqvlmkjfvpywdwjykcic | #1515 #1517 #1524→superseded #1526 #1543→superseded | T1/T2 | clock 07-20T13:06:26Z → matures 01:06–01:36Z Jul 21 | ⏳ maturing — close-out ~02–04Z (release-ops). Note: #1524/#1543 auto-closed by dependabot 16:47–16:48Z as "updatable another way"; #1572 to close as superseded. |
| chain (railb2) | railb220260719 | vmulcebjpoawajnetntw | #1552 (0358) | T3 | matures 07-21T17:13Z | ⏳ SOAKING — 0358 prod-apply precedes merge; DIRTY-conflict + Policy-Lints blockers per `1552-policy-lints-diagnosis-and-waiver-memo-2026-07-20.md` |

**To finalize (post-17:13Z):** fill railb2 exact head/base SHA, deploy_log id, Trigger-A/B + daily-flush + per-org-isolation evidence, rollback rehearsal; append deps-rail merge SHAs; write `docs/staging/rc-manifests/rc-2026-07-21-release.json` with per-PR coverage. Gate `staging-evidence` re-checks the same fields — no stale heads/dirty preflight.

---

## Artifact 2 — 45-type corpus coverage audit (gaps → SCRUM-2997)

**Target (ART plan §4 exit criteria):** top-15 credential types per domain × 3 domains {LEGAL, FINANCIAL, EDUCATION} = **45 types**, floor **≥12 held-out entries each**, curated-before-seed, domain-aggregate paired-bootstrap gate + no-covered-type-regresses->5pp floor + scored abstention.

### What is ACCEPTED on `main` today (Wave-1, `docs/lane4/s33-corpus-datasheet.md`, 81 rows)
| Slice | Entries | Maps to 45-type grid? |
|---|---|---|
| Professional licensing (nursing/CME, CPA/CPE, bar/CLE, PE/PDH) | 50 | Partial — covers the **licensing depth-first** axis, NOT the LEGAL/FINANCIAL/EDUCATION top-15 grid. Bar/CLE touches LEGAL; CPA/CPE touches FINANCIAL adjacency. |
| Australia + Kenya (Ahpra/NCK/KMPDC/LSK/TSC/KRA/KNEC…) | 22 | Jurisdiction variants, not domain-grid types. |
| OOD negatives | 9 | Abstention truth (OTHER/other/[]). |

**Verdict: the 45-type LEGAL/FINANCIAL/EDUCATION top-15 grid is NOT covered on `main`.** Wave-1 is licensing-depth + jurisdiction breadth; the datasheet itself marks the three top-15 domain slices as *"remaining scope, next Lane-4 wave (floor ≥12 each)."*

### What EXISTS but is NOT on `main` (Wave-2 top-15 tranches — now in salvage limbo)
The fired-team PRs #1556/#1563/#1566 (closed this window, salvaged in `fired-team-w3-dispositions-and-salvage-2026-07-20.md`) carried Wave-2 **top-15 tranches 01-05 / 06-10 / 11-15** — the attempt at exactly the 45-type grid. They were on dead codex/agent bases, never accepted by Lane 3, never soaked on main. **Coverage from them is 0 until re-authored on a main-based branch + formally L3-accepted.**

### Gap register (feeds SCRUM-2997)
| Gap | Detail | Owner |
|---|---|---|
| LEGAL top-15 (≥12 each) | Not on main; Wave-2 tranche exists only in closed-PR salvage | Lane 3 re-accept + re-soak, or Lane 4 re-author on main |
| FINANCIAL top-15 (≥12 each) | Same | " |
| EDUCATION top-15 (≥12 each) | Same | " |
| Acceptance machinery — CORRECTED (AI review) | The registry + envelope + batch-acceptance + coverage-auditor + leakage scanner are **already on `main`** (landed under SCRUM-2777 on 2026-07-15, commits `041f05e7`/`86fa3898`/`6319752f`, tests green). #1557 is a **+259/-21 MODIFY** — a self-exclusion/CPD-exclusion prerequisite (append the planned tranche paths to the leakage scanner's `SELF_EXCLUSION_EXACT_PATHS` so the fail-closed scanner doesn't self-match each held-out file) + a small batch-acceptance gate-compat tweak. The evaluator **runs on main today** — it is NOT the missing machinery. | Lane 3 / CTO — re-anchor #1557 *before landing any tranche* so the leakage gate doesn't false-positive |
| EDUCATION latent coverage (AI review note) | Wave-1's AU/KE slice carries latent, sub-floor, un-curated data touching all three domains (LEGAL: 11 CLE + 1 bar-admission; FINANCIAL: CPA + AU tax_return; EDUCATION: degrees/transcripts/TSC/KNEC exam certs). None reaches the ≥12-per-cell curated floor so **0/45 stands**, but Lane 3/4 should **reuse and cross-check** this data when re-authoring EDUCATION rather than starting cold. | Lane 4 |
| 13 non-depth-first professions | Synthetic-only by design this sprint; held-out N/A | out of scope (deferred) |
| Audio/image modalities | Out of corpus scope (L3-S6 spike) → see Artifact 3 | multimodal spike |

**SCRUM-2997 seed (corrected per AI review):** "45-type corpus coverage: main has licensing-depth (Wave-1, 81 rows) but **0/45** accepted LEGAL/FINANCIAL/EDUCATION top-15 grid cells. The **acceptance machinery is already on main** (SCRUM-2777) — the gap is (i) 0/45 accepted top-15 entries, and (ii) #1557's self-exclusion/CPD prerequisite + gate-compat fix is parked (re-anchor before landing any tranche). Wave-2 top-15 tranches exist only in closed-PR salvage (1556/1563/1566). **Re-acceptance controls (mandatory ACs, AI review):** (a) rebuild the acceptance-digest chain fresh against the CURRENT main registry digest in production order (the closed PRs' stacked manifests anchor to dead-base state and cannot be replayed by the single-root auditor); (b) re-run leakage + the L3 embedding diagnostic against the current full main corpus (do NOT trust the closed PRs' self-reported PASS — those ran on a dead-base snapshot); (c) re-verify `provenance:authored` / curate-before-seed (not generator-derived) on re-intake. Re-author/re-accept on main-based branches with clean isolated soaks; never merge from the codex/agent bases." Wire into SCRUM-2997 when triaged.

---

## Artifact 3 — Multimodal memo skeleton (audio/image extraction)

**Purpose:** frame the audio/image modality decision the corpus datasheet defers to "L3-S6 spike governs." Skeleton only — CTO/CPO own the go/no-go.

1. **Scope question:** do we extend held-out corpus + extraction to audio (voice attestations?) and image-only documents (scanned/photographed credentials) for the launch, or defer post-8/10?
2. **Current state (verify before filling):** client-side OCR (PDF.js + Tesseract.js) exists for on-device text extraction (§1.6); scanned-PDF "No text found" is the top real-Kenya gap (per ART 07-17 findings); .heic/.tiff currently hit the §1.6 fail-closed screen (soft-fail fix in SCRUM-2911 Phase A). Image → OCR path partially exists; audio path does not.
3. **Privacy constraint:** §1.6 client-side boundary applies — audio/image bytes never leave device except connector-sourced (§1.6A). Any server-side modality work must respect the fingerprint-only carve-out.
4. **Corpus impact:** multimodal held-out would be a NEW corpus axis beyond the 45-type grid — do not conflate with the Artifact-2 gap.
5. **Decision inputs owed:** L3-S6 spike result, Gemini multimodal capability + cost, real-Kenya scanned-doc volume.
6. **Recommendation placeholder:** ⏳ pending spike — RTE view is defer audio, prioritize the scanned-image OCR soft-fail (SCRUM-2911) as the launch-relevant slice.

---

_All three finalize after 17:13Z Jul 21 with railb2 evidence + the CTO W2-Q2 verdict. Draft published as W2 docs carve-out, queue-state-checked._
