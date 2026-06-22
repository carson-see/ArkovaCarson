# Arkova ART — Lane Manifest & RACI (human-readable companion)

> **Sprint-0 deliverable S0-E1 / Story 1.1.** Status: **DRAFT** — pending CTO + Carson review.
> Machine-readable source of record: [`lane-manifest.yaml`](./lane-manifest.yaml). This page renders it for humans; if they ever disagree, the YAML wins and this page is fixed.
>
> **Sources:** PI-1 Master (Confluence 83296257) · 12-Month Roadmap v3 (Confluence 82444290) · Sprint 0 plan (Confluence 83329025). Referenced from CLAUDE.md + the session bootstrap read-list (pointer lands via the S0-E3 v-next draft — Carson merges).

## Operating principle

The 3 lanes are **Claude-operated role-personas under Carson's oversight and his sole T2/T3 merge gate** — *not* human headcount. **A working session = ONE lane.** Sprint 0 is the train-led exception: the train roles stand up the foundation; the lanes support + onboard.

## Lanes & standing ownership

| Lane | Lead | Personas | Standing ownership (whole-PI) |
|---|---|---|---|
| **L1 — Trust & Chain** | Architect | Architect · Sr Full-stack · Front-end · DBA · AI Eng · Bitcoin Dev | `services/worker/src/chain/**`; proof/Merkle (`batch-anchor.ts` proof-persist, `verify-proof.ts`, `utils/merkle.ts`); `machines/bitcoinAnchor.machine.ts`; MIT verifier OSS + TS/Python SDKs; security/Secret-Manager/IAM hardening |
| **L2 — Product & Growth** | Architect | Sr Full-stack · Front-end · DBA · Architect · API Engineer | product UI (upload/dashboards, billing/credits + admin); ops/SLO + alerting + status page; API-key-expiry + internal-visibility dashboards; `paymentGuard.ts`, `stripe/handlers.ts`, `x402PaymentGate.ts`; `mcp-server.ts`, `webhooks/delivery.ts`; abuse-floor |
| **L3 — Credential Network & Intelligence** | Sr Full-stack | Sr Full-stack · Front-end · DBA · Data Scientist · AI Eng | `ctdl-serializer.ts` + CE client; connectors (DocuSign/Drive); HakiChain; CPE/CLE; BigQuery; Nessie/Gemini extraction |

## Train roles (operated by the session under Carson)

**RTE** (soak serialization, rig assignment, milestone/tier hygiene, gate tracker) · **Scrum/Planning** (reconciliation, Jira/Confluence currency, filing) · **Tech Lead/CTO** (architecture, CLAUDE.md authorship, council seat) · **Release Manager** (pipeline, Mergify playbook, deploy gates, council seat) · **DBA** (migration ledger, ledger CI audit, `database.types.ts`) · **Business Stakeholder** (external gates, key custody).

## Tiered-merge council

- **T0/T1 → council** (Tech Lead + RTE + Release Manager) — routine CI-green auto-merges via Mergify.
- **T2/T3 → Carson only** — migrations, RLS/schema, chain/treasury, credits/billing, anchor lifecycle, security, public API/contract, CLAUDE.md.
- Tier is computed by the path detector (`scripts/ci/check-staging-evidence.ts`) and **fails closed to "needs Carson."** Claude never merges to `main`.

## WIP limits

One **P0 per lane per sprint**; one **T3 soak at a time per shared rig** (lifted by the S0-E4 isolated-rig automation).

## Guarded / shared surfaces

- **Migration ledger** (`supabase/migrations/**`) — one lane runs the single migration soak per sprint; RTE assigns. Numeric `NNNN` prefix; never modify an existing migration.
- **CLAUDE.md** — Carson-only merge. Lanes draft via PR.
- **`src/types/database.types.ts`** — regenerated only by the sprint's migration owner.

## RACI — roadmap Q1–Q4 epics → owning lane

> R = owning lane · A = Carson (merge gate on T2/T3) · C = consulted · `propose X` = net-new, Carson-gated to file (S0-2.2).

### Q1 — Stabilize, Monetize & Secure (Jul–Sep 2026)
| Epic | R | C | P · Tier | Jira |
|---|---|---|---|---|
| Q1.1 Production Ops & SLO maturity | L2 | L1 | P0·T2 | extends SCRUM-2401 |
| Q1.2 Close the revenue funnel | L2 | — | P0·T2 | SCRUM-2477/2385 (+2474) |
| Q1.3 Instant Secure GA | L1+L2 | — | P0·T3 | SCRUM-2354 |
| Q1.4 API-key/secret expiration monitoring | L2 | L1 | P0·T2 | propose **KEY-EXPIRY** |
| Q1.5 Self-serve abuse floor & billing integrity | L2 | — | P1·T2 | SCRUM-2478 + propose **ABUSE-FLOOR** |
| Q1.6 Open verifier & SDK GA | **L1** | — | P1·T2 | SCRUM-2340/2394 + propose **SDK-PY** *(arkova-py already Done SCRUM-1112 → scope as GA/proof-helpers)* |
| Q1.7 Chain resilience — kill mempool.space SPOF | **L1** | L2 | P1·T3 | propose **CHAIN-RESIL** |
| Q1.8 Internal visibility | L2 | L1 | P1·T2 | propose **VIS-01** |
| Q1.9 Credential Engine — secure trial-window value | L3 | — | P0·T2 | SCRUM-1867 |
| Q1.10 HakiChain hardening + East-Africa compliance | L3 | — | P0·T2 | SCRUM-1010 |

### Q2 — Enterprise Trust, Compliance & CE Publishing GA (Oct–Dec 2026)
| Epic | R | C | P · Tier | Jira |
|---|---|---|---|---|
| Q2.1 SOC 2 Type II | **L1** | L2,L3 | P0·T2 | SCRUM-1043/1072 |
| Q2.2 Security hardening completion | **L1** | — | P0·T3 | SCRUM-1041/1060 |
| Q2.3 Governance, roles & audit completeness | L1+L2 | — | P1·T3 | extends SCRUM-2388/2475 |
| Q2.4 CE Registry publishing GA | L3 | — | P0·T2 | SCRUM-1867 |
| Q2.5 GCP-MAX — analytics & ops platform | L3 | L2 | P1·T2 | SCRUM-1042 |
| Q2.6 East-Africa compliance deepening + CSA STAR L2 | **L1** | L3 | P2·T1 | SCRUM-712 |

### Q3 — Credential Network Scale (Jan–Mar 2027)
| Epic | R | C | P · Tier | Jira |
|---|---|---|---|---|
| Q3.1 Issuer partner network GA (CSI) | L3 | — | P0·T2 | SCRUM-1596 |
| Q3.2 W3C Verifiable Credential issuance | L3 | L1 | P1·T2 | propose **VC-W3C** *(follow-on to OPEN spike SCRUM-2296 — do not front-run)* |
| Q3.3 Professional education GA (CPE/CLE) | L3 | — | P1·T2 | SCRUM-1962/1963 |
| Q3.4 Connector expansion v3 | L3 | — | P1·T2/T3 | SCRUM-1048 |
| Q3.5 Public org pages & network discovery | L2 | L3 | P2·T2 | SCRUM-1046 |

### Q4 — AI Verification Moat & Expansion (Apr–Jun 2027)
| Epic | R | C | P · Tier | Jira |
|---|---|---|---|---|
| Q4.1 Nessie Verified Identity (NVI) — GATED on FCRA | L3 | — | P1·T3 | SCRUM-804 (gate SCRUM-883) |
| Q4.2 Nessie pipeline hardening + Gemini Golden un-gate | L3 | — | P1·T2 | SCRUM-697 (gated by GEMB2 SCRUM-1040) |
| Q4.3 Decentralized discovery & true offline SPV | L1+L3 | — | P2·T3 | propose **DISC-01..05** *(legal/CEO signoff gated)* |
| Q4.4 Agentic payments (x402 testnet, fail-CLOSED) | L2 | L1 | P2·T2/T3 | propose **PAY-03/04** |
| Q4.5 Expansion beyond East Africa | L3 | — | P2·T2 | SCRUM-713 |

## Reconciliation flags (from S0-E2 read; Carson-gated to action)

1. **PO Roadmap (Confluence 27591934) is SUPERSEDED** by 82444290 → banner it + re-point CLAUDE.md §5 and the `project_release_structure` memory.
2. **SDK-PY overlaps Done SCRUM-1112** (arkova-py) → file as GA/proof-helpers, not a rebuild.
3. **VC-W3C front-runs OPEN spike SCRUM-2296** → file as follow-on, or soften the roadmap's "DECIDED: build W3C VC."
4. **Possible-false-Done SCRUM-1044 & 1049** → child-rollup + resolver-changelog check before trusting Done (reporter=carson on both).
5. **Consider closing SCRUM-1045 (GH-CI-OPT)** → work effectively shipped; not carried into any Q.
