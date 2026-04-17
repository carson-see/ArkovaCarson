# TRUST Framework Expansion — Q1 Child Stories

**Jira epic:** [SCRUM-712](https://arkova.atlassian.net/browse/SCRUM-712)
**Source roadmap:** [docs/compliance/trust-framework-roadmap.md](../compliance/trust-framework-roadmap.md)
**Last updated:** 2026-04-17
**Owner:** Compliance (Carson) + Engineering (enablement)
**Existing shipped:** TRUST-07 Cyber Essentials Plus readiness checklist (SCRUM-720, PR #413). External IASME assessor engagement tracked in SCRUM-891.

---

## How to use this document

The TRUST epic is too abstract to work. This doc decomposes Q1 into 7 concrete, ticketable child stories (engineering + compliance), so a sprint-planning session can pull work directly without re-reading the roadmap.

Five concrete steps for the scrum master:

1. **Skim** §Q1 child-story inventory to confirm story shape before carving tickets.
2. **Create** each of the 7 tickets in Jira under SCRUM-712 as child stories; paste §Story template into each, fill summary / description / AC.
3. **Label** each with `TRUST`, `compliance`, `q1-2026`.
4. **Prioritise** in this order: TRUST-01 → TRUST-02 → TRUST-03 → TRUST-04 → TRUST-05 → TRUST-06 → (TRUST-07 already shipped).
5. **Confluence mirror** — each story needs a Confluence page per CONFLUENCE MANDATE; the description links to the relevant roadmap section.

---

## Q1 child-story inventory

7 child stories; 1 already shipped (TRUST-07).

### TRUST-01 — CSA STAR Level 1 self-assessment (FREE)

**As a** enterprise buyer, **I want** Arkova listed on the [CSA STAR Registry](https://cloudsecurityalliance.org/star/registry/), **so that** procurement teams can verify our cloud-security posture against the CAIQ v4.0 without a direct call.

**Engineering deliverables:**

- ✅ CAIQ self-assessment already drafted at [docs/compliance/csa-star-caiq-self-assessment.md](../compliance/csa-star-caiq-self-assessment.md).
- [ ] Upload CAIQ to STAR Registry via CSA portal.
- [ ] Surface "CSA STAR Level 1 (self-assessed)" badge on the `/compliance` page via `JurisdictionPrivacyNotices` or a sibling `TrustBadges` component.

**Effort:** Small | **Priority:** High | **Dependencies:** none | **Cost:** $0

---

### TRUST-02 — EU-US Data Privacy Framework self-certification (FREE)

**As a** EU customer, **I want** Arkova to be EU-US DPF certified, **so that** cross-border transfers of EU personal data have a valid adequacy basis.

**Engineering deliverables:**

- [ ] Verify eligibility (US company, not financial/insurance, DPA compliance in place).
- [ ] Self-certify at [dataprivacyframework.gov](https://www.dataprivacyframework.gov/).
- [ ] Add DPF notice to [docs/compliance/gdpr-chain-limitation.md](../compliance/gdpr-chain-limitation.md) + `JurisdictionPrivacyNotices` for EU tenants.
- [ ] Annual re-certification calendar entry (12 months forward).

**Effort:** Small | **Priority:** High (EU procurement blocker) | **Dependencies:** none | **Cost:** $0

---

### TRUST-03 — Cyber liability insurance ($2M–$5M coverage)

**As a** enterprise procurement reviewer, **I want** Arkova to carry $2M+ cyber-liability insurance, **so that** the vendor-risk checklist item is satisfied and breach-response costs are covered.

**Engineering deliverables:**

- [ ] Quote from ≥3 carriers (Coalition, At-Bay, Corvus).
- [ ] Score against [docs/compliance/cyber-insurance-checklist.md](../compliance/cyber-insurance-checklist.md) + 100-point rubric (same shape as pentest rubric).
- [ ] Policy binds with $2M–$5M per-claim coverage.
- [ ] Policy cover sheet filed in `docs/compliance/vendor-register.md`.

**Effort:** Small (ops) | **Priority:** High (procurement) | **Dependencies:** none | **Cost:** $3K–$7K/yr

---

### TRUST-04 — SOC 2 Type II readiness (engagement)

**As a** enterprise buyer, **I want** to see a signed SOC 2 Type II readiness letter from a licensed auditor, **so that** I can validate the Arkova control environment before sales commits to a Type II report.

**Engineering deliverables:**

- ✅ Shortlist at [docs/compliance/soc2-auditor-shortlist.md](../compliance/soc2-auditor-shortlist.md).
- ✅ RFP emails at [docs/compliance/soc2-rfp-email-draft.md](../compliance/soc2-rfp-email-draft.md).
- [ ] Matthew sends 3 RFPs; scores; signs readiness SOW (referenced in SCRUM-522).
- [ ] Readiness gap report received; gap items added to `docs/BACKLOG.md`.

**Effort:** Medium | **Priority:** High | **Dependencies:** SCRUM-522 | **Cost:** $8K–$18K

---

### TRUST-05 — Annual CREST-accredited penetration test

**As a** SOC 2 auditor, **I want** evidence of annual penetration testing by a CREST-accredited firm, **so that** CC4.1 is satisfied without a compensating control.

**Engineering deliverables:**

- ✅ Scope at [docs/compliance/pentest-scope.md](../compliance/pentest-scope.md).
- ✅ Shortlist at [docs/compliance/pentest-vendor-shortlist.md](../compliance/pentest-vendor-shortlist.md).
- ✅ RFP emails at [docs/compliance/pentest-rfp-email-draft.md](../compliance/pentest-rfp-email-draft.md).
- [ ] Engage vendor via SCRUM-517.
- [ ] Execute test; remediate critical + high findings.
- [ ] Retest; final report filed in `docs/compliance/soc2-evidence.md`.

**Effort:** Large | **Priority:** High | **Dependencies:** SCRUM-517 | **Cost:** $25K–$55K

---

### TRUST-06 — Trust seals on marketing + app

**As a** marketing-site visitor, **I want** to see trust seals prominently on the site, **so that** I have confidence before I sign up.

**Engineering deliverables:**

- [ ] Render dynamic `TrustBadges` component on `/compliance` page in `arkova-marketing` (not main app).
- [ ] Badges: CSA STAR L1, EU-US DPF, Cyber-insurance carrier badge (once issued), SOC 2 Type I or II (once issued), Kenya ODPC (once issued).
- [ ] Badges conditionally render from a single source-of-truth `TRUST_BADGES` array; avoid hardcoding image paths in JSX.
- [ ] Test coverage for the conditional rendering (Vitest).
- [ ] Re-validate Google Rich Results Test with new `Organization.hasCredential` claims.

**Effort:** Medium | **Priority:** Medium (unblocks SoV in sales motion) | **Dependencies:** TRUST-01, TRUST-02, TRUST-03, TRUST-04 | **Cost:** $0

---

### TRUST-07 — Cyber Essentials Plus readiness (UK) — **SHIPPED**

**Jira:** [SCRUM-720](https://arkova.atlassian.net/browse/SCRUM-720) — status **Blocked** on IASME assessor engagement (SCRUM-891).

Already landed: [docs/compliance/uk-cyber-essentials/readiness-checklist.md](../compliance/uk-cyber-essentials/readiness-checklist.md) (2026-04-17, PR #413).

---

## Story template (paste into Jira for TRUST-01 through TRUST-06)

```markdown
## User Story
As a <role>, I want <goal>, so that <reason>.

## Description
<from §Q1 child-story inventory in docs/stories/34_trust_framework.md>

## Definition of Ready (DoR)
- [ ] Story description reviewed
- [ ] Dependencies identified (TRUST-xx or SCRUM-xxx)
- [ ] Plan outlined
- [ ] Acceptance criteria defined
- [ ] Owner assigned

## Acceptance Criteria
- [ ] <criterion 1 from §inventory>
- [ ] <criterion 2>
- [ ] ...

## Definition of Done (DoD) — Mandatory Gates
**GATE 1 — Tests (TDD MANDATE)** — npx tsc --noEmit + npm run lint + npm run test + npm run lint:copy all green; tests added for any component render
**GATE 2 — Jira (JIRA MANDATE)** — DoR/DoD checklists complete; status → Done only after deliverables ship
**GATE 3 — Confluence (CONFLUENCE MANDATE)** — Confluence page authored; linked in Jira description
**GATE 4 — Bug Log (BUG LOG MANDATE)** — Any bugs found/fixed logged
**GATE 5 — agents.md** — Updated in modified folders
**GATE 6 — CLAUDE.md** — TRUST table status updated in Section 5

## Effort / Priority / Dependencies
Effort: <Small/Medium/Large> | Priority: <High/Medium/Low> | Dependencies: <list>
```

---

## Status tracking

Update this table as each TRUST-xx transitions. Current state 2026-04-17:

| Story | Summary | Status | PR |
|-------|---------|--------|----|
| TRUST-01 | CSA STAR L1 self-assessment | To Do | — |
| TRUST-02 | EU-US DPF self-certification | To Do | — |
| TRUST-03 | Cyber liability insurance | To Do | — |
| TRUST-04 | SOC 2 Type II readiness (engagement) | Blocked (SCRUM-522) | — |
| TRUST-05 | Annual CREST pen test | Blocked (SCRUM-517) | — |
| TRUST-06 | Trust seals on marketing + app | To Do (depends 01–04) | — |
| TRUST-07 | UK Cyber Essentials Plus readiness | **Shipped** (engineering); Blocked on IASME | [#413](https://github.com/carson-see/ArkovaCarson/pull/413) |

---

## Manual-followup email

Per CLAUDE.md MANUAL-FOLLOWUP EMAIL MANDATE, the scrum master emails `carson@arkova.ai` on ticket-creation day with: list of ticket IDs + summaries + priorities, link back to this doc, and proposed Q1 sprint slotting.

---

## Definition of Done for SCRUM-712 (epic)

- [ ] 6 child stories (TRUST-01..06) created in Jira, each with Confluence page.
- [ ] Q1 sprint slotted with TRUST-01, TRUST-02, TRUST-03 (all low-cost, high-value).
- [ ] TRUST-04, TRUST-05 slotted but dependent on SCRUM-522 / SCRUM-517 closure.
- [ ] CLAUDE.md Section 5 `TRUST` row updated from `1/7 ship` to `7/7 planned` (shipped count changes as tickets close).
