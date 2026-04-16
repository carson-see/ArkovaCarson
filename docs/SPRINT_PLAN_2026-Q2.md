# Arkova Sprint Plan — 2026-Q2

> **Created:** 2026-04-16 | **Horizon:** 4 × 2-week sprints (~8 weeks)
> **Source:** Senior-dev audit `docs/BACKLOG.md` + Jira reconciliation + API surface audit
> **Principle:** shortest path from today's shipped work to user-visible value, weighted by blast radius.

---

## Why this plan

Five parallel threads converged on 2026-04-16 and the backlog was not reflecting it:

1. **Gemini Golden v6** trained + eval'd + code wired — but uncommitted and not flipped in prod. Ships +3.5pp F1 / -70% latency / -95% tokens-per-request the day we flip.
2. **Nessie FCRA v27.3 / HIPAA v28.0 / FERPA v29.0** deployed in parallel. Full-day arc: FCRA citation 0% → 57%.
3. **NVI epic (SCRUM-804)** just landed — pauses NDD / NSS / NTF until FCRA passes an attorney-reviewed gold-standard benchmark. Redirects all further regulation training.
4. **API surface audit** found 30+ DB fields stored per anchor but only ~15 exposed in `/verify/{publicId}`. "Responses aren't worth using" is now actionable with 5 backwards-compat nullable additions.
5. **3 HIGH-severity UAT5 bugs** in production (public search broken, treasury page failing, pipeline monitoring zeros) have been open since 2026-04-05 Click-Through.

This plan sequences the Top 20 stories to land v6 + API richness + the 3 user-visible bugs in Sprint 1, then ship NVI FCRA gate + Audit-My-Org MVP in Sprints 2-4.

---

## The Top 20

### Sprint 1 (Apr 16 – Apr 30) — Ship v6 + unlock API value + close user-visible bugs

| # | Story | Jira | Effort | Priority |
|---|---|---|---|---|
| 1 | **v6 prod env-var flip** — `GEMINI_V6_PROMPT=true` + `GEMINI_TUNED_MODEL=endpoints/740332515062972416` on Cloud Run. Monitor 15 min. Rollback doc: `docs/runbooks/v6-cutover.md`. | Child under SCRUM-772 | 0.5d | Highest |
| 2 | **Isotonic confidence calibration retrain** — fit knots on v6 eval; ship as `services/worker/src/ai/eval/calibration-v6.json`. Target Pearson r ≥ 0.4. | SCRUM-794 (GME2-03) | 0.5d | Highest |
| 3 | **API-RICH-01** — add `compliance_controls`, `chain_confirmations`, `parent_anchor_id`, `revocation_tx_id/block`, `file_mime/size` to `GET /verify/{publicId}`. Zod + route + OpenAPI + TS SDK + Python SDK. Backwards-compat. | _new story under SCRUM-772_ | 2d | High |
| 4 | **Fix UAT5-01** public search broken — "Search failed" on all tabs. Silent catch in `src/pages/SearchPage.tsx:164`. TDD. | SCRUM-455 | 1d | High |
| 5 | **Fix UAT5-02** treasury page "Unable to fetch balance/fee". Worker admin stats endpoints. | SCRUM-456 | 1d | High |

**Sprint 1 exit gate:** v6 active in prod with logs `tunedModelActivated=true`, new API fields visible via `curl /verify/ARK-...`, public search returns results, treasury shows 1.41M+ SECURED.

---

### Sprint 2 (Apr 30 – May 14) — NVI FCRA verification gate

| # | Story | Jira | Effort | Priority |
|---|---|---|---|---|
| 6 | **NVI-01 Statute-quote validator** — diff every FCRA source quote vs 15 U.S.C. authoritative text (Cornell LII / eCFR). Fail any quote with >10% char divergence. | SCRUM-804 child | 2d | Highest |
| 7 | **NVI-02 Case-law citation validator** — resolve every case cite to real published opinion via Google Scholar Case Law API + PACER. | SCRUM-804 child | 2d | Highest |
| 8 | **NVI-03 Agency-bulletin validator** — verify every CFPB / FTC / HHS OCR / DoE cite against authoritative docket. | SCRUM-804 child | 2d | Highest |
| 9 | **NVI-05 FCRA source registry audit** — run validators across all 89 sources; quarantine failures; document provenance for every source. | SCRUM-804 child | 1d | Highest |
| 10 | **Fix UAT5-03** pipeline monitoring zeros — worker stats endpoint returning empty data. | SCRUM-457 | 1d | High |

**Sprint 2 exit gate:** Every FCRA source in the registry has been run through all three validators. Quarantine list published. Attorney-review can start on the verified subset.

---

### Sprint 3 (May 14 – May 28) — NVI chain-of-thought + distillation + benchmark

| # | Story | Jira | Effort | Priority |
|---|---|---|---|---|
| 11 | **NVI-06 Chain-of-thought retrofit** — every FCRA scenario gets explicit reasoning steps (classify → statutes → exceptions → state overlays → risks → recommendations → confidence → escalation). AI-assisted. | SCRUM-804 child | 2d | Highest |
| 12 | **NVI-07 Claude Opus distillation** — generate 5,000+ verified FCRA Q&A with Opus as teacher; human-review 5% random sample. ~$200 API. | SCRUM-804 child | 2d | Highest |
| 13 | **NVI-12 LLM-as-judge benchmark runner** — Claude / GPT-4o / Gemini 2.5 Pro score Nessie against 50-Q benchmark. | SCRUM-816 | 2d | High |
| 14 | **API-RICH-02** — add per-field `confidenceScores`, `subType`, `description`, `fraudSignals` to `POST /ai/extract` and `GET /verify/{publicId}` responses. (Requires v6 cutover to have landed in Sprint 1 to populate these.) | _new story under SCRUM-772_ | 1d | High |
| 15 | **API-RICH-03** — new `GET /anchor/{publicId}/lifecycle` returning chain-of-custody event log from `audit_events`. Roles scrubbed (no email / user_id in response). | _new story_ | 1d | High |

**Sprint 3 exit gate:** 5K verified FCRA Q&A in training set; LLM-judge benchmark shows Nessie ≥ base Gemini 2.5 Pro on at least one dimension; API-RICH-02/03 live.

---

### Sprint 4 (May 28 – Jun 11) — "Audit My Organization" MVP + INT close + risk reduction

| # | Story | Jira | Effort | Priority |
|---|---|---|---|---|
| 16 | **NCA-01 Jurisdiction rule engine** — MVP rule engine for 3 US states (CA, NY, FL) + federal (FCRA / HIPAA / FERPA). Leverages migration 0194-0196 (jurisdiction_rules). | SCRUM-756 | 3d | High |
| 17 | **NCA-02 Org compliance scoring engine** — compare org's anchored docs vs NCA-01 rules; return 0-100 score. | SCRUM-757 | 3d | High |
| 18 | **NCA-04 Gap detection** — "what's missing, what's expired, what's expiring" with Nessie-generated plain-English explanations (gated on NVI FCRA readiness — pause if not passed). | SCRUM-759 | 2d | High |
| 19 | **NCA-07 "Audit My Organization" dashboard button** — first user-facing entry point, loading state, calls NCA-02. | SCRUM-762 | 0.5d | High |
| 20 | **INT-09 Webhook CRUD route** — `services/worker/src/routes/webhooks.ts` — last gap before INT epic closes. | SCRUM-645 | 1d | High |

**Sprint 4 exit gate:** "Audit My Organization" button on dashboard works end-to-end with at least one regulation. INT-09 lands → SCRUM-641 epic closed. All 3 UAT5 HIGH bugs resolved.

---

## After the Top 20 (queued, not in-sprint yet)

Ordered roughly by value-per-hour:

- **NCA-05 recommendation engine** — after NVI FCRA gate passes. Uses Nessie RAG for citation-grounded actions.
- **NCA-08 Compliance Scorecard page** — UI for NCA-02 score + NCA-04 gaps + NCA-05 recs.
- **SCRUM-711 NPH-14 reframed:** FCRA v27.4 retrain with 302 scenarios (already compiled; gated on NVI)
- **v7 Gemini Golden training** — 190-entry dataset + `responseSchema`. ~$40, ~1 day.
- **GME3 Legal / GME4 Financial / GME5 Trades** — gated on v7 + GME8 router infra.
- **API-RICH-04/05** — attestation evidence array, extraction-manifest endpoint (ZK proofs).
- **DEP-01 Supabase DR + DEP-02 CF Tunnel failover** — P0 risk reduction.
- **REG-05/06/07/08 HIPAA dashboard bundle** — MFA enforce, session timeout, audit-report gen, BAA template. Required for healthcare pilot.
- **REG-01/02/03 FERPA dashboard bundle** — disclosure log, directory opt-out, DUA template. Required for education pilot.
- **OPS-03/04** — Sentry DSN + source-map upload env vars in Vercel + Cloud Run.

## Deliberately not in this plan (per NVI decree)

- All NDD child stories (SCRUM-770 + 13 children) — **PAUSED**
- All NSS child stories (SCRUM-771 + 8 children) — **PAUSED**
- All NTF beyond v6 (SCRUM-769 + remaining children) — **PAUSED**
- New regulation training (SOX, GDPR, Kenya DPA Deep, Australian Privacy Act Deep, state-specific privacy) — **PAUSED**
- GME3 Legal / GME4 Financial / GME5 Trades — gated on v7 + GME8 router; wait
- TRUST epic children (SOC 2 Type II audit, ISO 27001, cyber insurance) — external-vendor-gated
- INTL epic children (Brazil LGPD, Singapore PDPA, etc.) — customer-gated (no LOIs in those geos)

---

## Definition of Ready (applies to every Top-20 story)

- [ ] Story description references this plan and a parent epic
- [ ] Acceptance criteria enumerated (testable)
- [ ] Dependencies listed and met (or explicitly blocked)
- [ ] Effort sized (d/w) agreed in planning
- [ ] For any AI work: eval metric + target threshold specified upfront
- [ ] For any API work: response schema diff written before code
- [ ] For any UI work: mobile viewport check required by CLAUDE.md UAT mandate

## Definition of Done (applies to every Top-20 story)

All six gates per `CLAUDE.md` Section 3:

1. **Tests** — TDD red→green→refactor; `typecheck`+`lint`+`test`+`lint:copy` all green; coverage thresholds met.
2. **Jira** — status transitioned; DoR/DoD checked; AC checked off; Confluence link attached.
3. **Confluence** — doc updated per Doc Update Matrix.
4. **Bug log** — any bug found/fixed logged in bug-tracker spreadsheet.
5. **agents.md** — updated in every modified folder.
6. **CLAUDE.md** — if the task introduced new rules, env vars, migrations, or status changes: update CLAUDE.md.

---

## Risks

| Risk | Mitigation |
|---|---|
| v6 regression in prod after flip | Documented 1-command rollback in `docs/runbooks/v6-cutover.md`. Monitor Sentry + Cloud Run latency for 15 min post-flip. |
| NVI attorney review slips | Bundle work: Sprint 2 builds validators even before attorney finds available, so when they're engaged the queue is ready. |
| API-RICH-01 SDK drift | Same-PR update required for TS + Python SDK; snapshot-test existing response shape to guarantee no regressions. |
| NCA-01 rule engine over-scope | Ship 3 states + 3 federal regs only; resist expansion pressure until validated by a real user workflow. |
| Context switching across 5 workstreams | Sprint 1 is narrow (v6 + API + bugs); Sprint 2-3 is NVI-focused; Sprint 4 is NCA+INT focused. Stack, don't thrash. |
