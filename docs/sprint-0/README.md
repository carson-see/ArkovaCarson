# PI-1 Sprint 0 — Foundation & Hardening (Lane-1 session artifacts)

> Engineering working-docs for the PI-1 Sprint 0 run. **These are draft artifacts, not the canonical record** — Confluence remains the documentation source of truth (§4); these mirror to Confluence on Carson's OK. Jira remains story status. Authored 2026-06-17 in a Lane-1 (+ train-roles) session.

## What's here

| Doc | Epic | Status |
|---|---|---|
| [`../operating-model/lane-manifest.yaml`](../operating-model/lane-manifest.yaml) + [`.md`](../operating-model/lane-manifest.md) | S0-E1 / 1.1 | manifest + RACI (machine + human) |
| [`../operating-model/session-operating-model.md`](../operating-model/session-operating-model.md) | S0-E1 / 1.2 | bootstrap + SDLC self-routing + dry-run |
| [`S0-E2-reconciliation-report.md`](./S0-E2-reconciliation-report.md) | S0-E2 / 2.1 | read-only audit; corrections are proposals (gated) |
| [`S0-E6-infra-hygiene-report.md`](./S0-E6-infra-hygiene-report.md) | S0-E6 / 6.1 | inventory; deletes gated; 1 paid orphan flagged |
| [`S0-E7-external-gate-tracker.md`](./S0-E7-external-gate-tracker.md) | S0-E7 / 7.1 | gate tracker; kickoffs gated |
| [`lane1/chain-resilience-predesign.md`](./lane1/chain-resilience-predesign.md) | Q1.7 pre-design | kill mempool.space SPOF |
| [`lane1/verifier-oss-sdk-predesign.md`](./lane1/verifier-oss-sdk-predesign.md) | Q1.6 pre-design | MIT verifier + SDK proof-helpers |
| [`lane1/visibility-signal-inventory.md`](./lane1/visibility-signal-inventory.md) | S0-5.1 support | Lane-1 chain-signal input + review |

The **config↔reality drift + parity gate spike (S0-5.2)** ships as a separate code PR (Lane-1 owned, T1). The **CLAUDE.md v-next draft (S0-E3)** ships as a separate Carson-review PR.

## What is NOT done here (gated to Carson / other lanes / other sessions)

- S0-2.2 **Jira filing** (epics/stories) — write phase, Carson-gated.
- Confluence page **creates/edits** (PO-roadmap supersede banner, mirroring these docs) — gated.
- S0-E4 **release-pipeline** parallel-safe automation — RTE/RelMgr/DBA train epic, not this session.
- S0-5.1 **visibility spec authorship** — Lane 2.
- S0-7.2 **CE key → Secret Manager** + external outreach — Lane 3 / Biz, gated.
- Infra **deletes** (orphan project `xrefmwydaatppieoxfxn`, SSD reclaim) — gated.
