# SOC 2 Type II — Framework Selection Decision Document

> **Version:** 1.0 | **Date:** 2026-04-12 | **Classification:** CONFIDENTIAL
> **Jira:** SCRUM-516 | **Owner:** Carson
> **Epic:** SCRUM-502 (Security Remediation — BIA Assessment)

---

## 1. Decision

**Selected Framework: SOC 2 Type II**

**Rationale:** SOC 2 Type II is the industry standard for SaaS companies handling sensitive data. It is the most frequently requested compliance certification by enterprise procurement teams, staffing agencies, and educational institutions evaluating Arkova. Type II (vs Type I) provides evidence of controls operating effectively over a period (typically 6-12 months), which is stronger assurance than a point-in-time snapshot.

### Why SOC 2 Type II Over Alternatives

| Framework | Fit for Arkova | Decision |
|-----------|---------------|----------|
| **SOC 2 Type II** | Primary certification for SaaS handling sensitive data; trusted by US enterprise buyers | **SELECTED** |
| SOC 2 Type I | Point-in-time snapshot only; weaker than Type II; typically a stepping stone | Stepping stone to Type II |
| ISO 27001 | International standard; strong in EU/APAC markets; already evidenced on compliance dashboard | Future add-on (Year 2) |
| SOC 1 (SSAE 18) | Financial reporting controls only; not relevant to Arkova's service | NOT APPLICABLE |
| HIPAA | Sector-specific; no standalone certification; addressed via BAA + controls | Addressed in REG-05 through REG-10 |
| FedRAMP | US federal government; extremely expensive ($500K+); premature for startup | Future (if federal contracts) |
| PCI DSS | Payment card data handling; Stripe handles PCI compliance for Arkova | NOT APPLICABLE (Stripe is PCI compliant) |

---

## 2. Gap Analysis — Current State vs SOC 2 Type II Requirements

### Trust Service Criteria Assessment

| Category | Criteria | Current State | Gap | Priority |
|----------|----------|--------------|-----|----------|
| **CC1** | Control Environment | Documented policies, defined roles | Formal risk assessment needed | MEDIUM |
| **CC2** | Communication & Information | Incident response plan, security training doc | Need regular training cadence evidence | LOW |
| **CC3** | Risk Assessment | BIA completed 2026-04-06, vendor register maintained | Formal annual risk assessment process | MEDIUM |
| **CC4** | Monitoring Activities | Sentry, Cloud Logging, Cloudflare analytics | SIEM decision pending (SCRUM-518) | MEDIUM |
| **CC5** | Control Activities | RLS on all tables, CI/CD pipeline, branch protection | All in place | NONE |
| **CC6** | Logical & Physical Access | RLS, API key HMAC, FileVault, OIDC auth | Physical access N/A (no offices/DCs) | NONE |
| **CC7** | System Operations | Monitoring, incident response plan, DR tested | Tabletop exercise needed (SCRUM-515) | HIGH |
| **CC8** | Change Management | CI/CD, PR reviews, automated testing, TLA+ verification | All in place | NONE |
| **CC9** | Risk Mitigation | Vendor register, DPA/BAA templates, data classification | Vendor SOC 2 report collection needed (SCRUM-520) | MEDIUM |
| **A1** | Availability | Cloud Run autoscaling, Cloudflare CDN, DR plan + tested | All in place | NONE |
| **PI1** | Processing Integrity | TLA+ formal verification, golden dataset eval, Merkle proofs | All in place | NONE |
| **C1** | Confidentiality | Encryption at rest (AES-256), in transit (TLS 1.2+), RLS | All in place | NONE |
| **P1** | Privacy | GDPR erasure RPC, PII scrubbing, client-side processing boundary | Privacy notice updates for FERPA/HIPAA | LOW |

### Summary

| Status | Count | Details |
|--------|-------|---------|
| No Gap | 6 | CC5, CC6, CC8, A1, PI1, C1 |
| Low Gap | 2 | CC2, P1 |
| Medium Gap | 3 | CC1, CC3, CC9 |
| High Gap | 1 | CC7 (pending tabletop) |
| Pending Decision | 1 | CC4 (SIEM — SCRUM-518) |

**Overall Readiness: ~75%** — Most controls already implemented through existing engineering practices. Primary gaps are process documentation and evidence collection, not technical controls.

---

## 3. Control Mapping — Arkova Controls to SOC 2 Criteria

| SOC 2 Criteria | Arkova Control | Evidence Location |
|----------------|---------------|-------------------|
| CC5.1 — Control activities | Automated CI/CD pipeline with 5 gates | `.github/workflows/ci.yml` |
| CC5.2 — General IT controls | TypeScript strict mode, ESLint, copy lint | `tsconfig.json`, `.eslintrc.cjs` |
| CC6.1 — Logical access | RLS on all tables, branch protection, API key HMAC | `supabase/migrations/`, `docs/compliance/soc2-evidence.md` |
| CC6.1 — Access provisioning | Supabase Auth + org_members + role-based policies | `supabase/migrations/0087_org_members.sql` |
| CC6.3 — Access removal | Account deletion RPC, key revocation, session invalidation | `supabase/migrations/0065_account_deletion.sql` |
| CC6.6 — Boundaries | Cloudflare WAF + Tunnel, rate limiting, CORS | `services/worker/src/middleware/` |
| CC6.7 — Encryption | AES-256 at rest (Supabase/GCP), TLS 1.2+ in transit, FileVault | `docs/compliance/endpoint-security.md` |
| CC6.8 — Vulnerability mgmt | Dependency scanning (npm audit), secret scanning (TruffleHog + Gitleaks) | CI pipeline |
| CC7.2 — Monitoring | Sentry error tracking, Cloud Logging, Cloudflare analytics | Sentry dashboard, GCP console |
| CC7.3 — Detection | Anomaly alerts (Sentry), rate limiting (429s), audit events | `supabase/migrations/0006_audit_events.sql` |
| CC7.4 — Response | Incident response plan with severity levels, escalation paths | `docs/compliance/incident-response-plan.md` |
| CC7.5 — Recovery | DR plan tested, RTO/RPO documented, automated backups | `docs/compliance/disaster-recovery.md` |
| CC8.1 — Change management | PR-required main branch, automated test gates, code review | GitHub branch protection rules |
| CC9.2 — Vendor management | Vendor risk register with 9 vendors assessed | `docs/compliance/vendor-register.md` |
| A1.1 — Availability commitment | 99.9% SLA target, Cloud Run autoscaling | Architecture docs |
| A1.2 — Recovery objectives | RTO: 4hr, RPO: 24hr (tested) | `docs/compliance/dr-test-results/2026-04-05.md` |
| PI1.1 — Processing integrity | TLA+ formal verification of anchor lifecycle | `machines/bitcoinAnchor.machine.ts` |
| PI1.4 — Output completeness | Golden dataset eval (98% type accuracy), Merkle proof verification | `data/golden/` |
| C1.1 — Confidentiality | Client-side processing boundary (docs never leave device), PII scrubbing | Constitution 1.6 |
| P1.1 — Privacy notice | Privacy policy, GDPR rights, data classification | `docs/compliance/data-classification.md` |

---

## 4. Timeline & Cost Estimate

### Phase 1: Readiness (Current — Q2 2026)

| Task | Jira | Status | ETA |
|------|------|--------|-----|
| FileVault + key rotation | SCRUM-514 | DONE | 2026-04-12 |
| SOC 2 framework selection | SCRUM-516 | DONE (this doc) | 2026-04-12 |
| Incident response tabletop | SCRUM-515 | IN PROGRESS | 2026-04-12 |
| SIEM decision | SCRUM-518 | IN PROGRESS | 2026-04-15 |
| Vendor risk assessment completion | SCRUM-520 | IN PROGRESS | 2026-04-15 |
| FERPA compliance (REG-01–04) | SCRUM-561+ | IN PROGRESS | 2026-04-20 |
| HIPAA compliance (REG-05–08) | SCRUM-564+ | PLANNED | 2026-04-30 |

### Phase 2: Observation Period (Q3-Q4 2026)

- **Duration:** 6 months minimum for Type II
- **Start:** When all controls documented and operating
- **Target start:** 2026-06-01
- **Target end:** 2026-11-30

### Phase 3: Audit (Q4 2026 / Q1 2027)

| Item | Estimated Cost | Notes |
|------|---------------|-------|
| SOC 2 Type II audit (startup tier) | $15,000 — $30,000 | Vanta/Drata-assisted reduces cost |
| Compliance automation platform | $5,000 — $12,000/yr | Vanta, Drata, or Secureframe |
| Remediation engineering | Internal | Already budgeted in sprint work |
| **Total estimated** | **$20,000 — $42,000** | First year; renewals ~60% of initial |

### Recommendation

Use a compliance automation platform (Vanta or Drata) to:
1. Continuously monitor controls (replaces manual evidence collection)
2. Auto-collect evidence from GitHub, GCP, Supabase, Cloudflare
3. Generate auditor-ready reports
4. Reduce audit cost by 30-40%

---

## 5. Next Steps

1. Complete remaining BIA action items (SCRUM-515, 518, 520)
2. Complete FERPA/HIPAA compliance stories (REG-01 through REG-10)
3. Evaluate compliance automation platforms (Vanta vs Drata vs Secureframe) — see SCRUM-964 TRUST-06
4. Begin 6-month observation period (target: 2026-06-01)
5. Engage SOC 2 auditor (target: Q4 2026)

---

## 6. Observation Window — SOC 2 Type II (TRUST-01 / SCRUM-959)

> Appended 2026-04-21 as part of TRUST-01 to record the observation-window
> dates + cadence. Paired with `soc2-evidence-cadence.md`.

### Window dates

| Item | Value |
|------|-------|
| Observation window — start | **2026-06-01** (Monday) |
| Observation window — end | **2026-11-30** (Sunday) |
| Window length | 183 days (6 months) |
| Auditor kickoff (Type II fieldwork) | **2026-12-15** |
| Report delivery target | **2027-02-28** |
| Cut-off for observation changes | **2026-05-25** (one week freeze before window opens) |

### What must be true on 2026-06-01

- [ ] All in-scope controls documented in `soc2-type2-evidence-matrix.md`
- [ ] Evidence-collection cadence live in `soc2-evidence-cadence.md`
- [ ] Compliance automation platform selected (SCRUM-964 TRUST-06)
- [ ] Pentest report on file from within 90 days (SCRUM-962 TRUST-04)
- [ ] Cyber insurance policy bound (SCRUM-961 TRUST-03)
- [ ] Access-review log has a minimum of one historical entry per quarter

### How to apply

- On the Monday of each calendar month, run through the cadence in
  `docs/compliance/soc2-evidence-cadence.md`. Missed cadence = evidence
  gap for the auditor — log each miss in the Bug Tracker spreadsheet.
- At day 90 of the window, run a mid-window control self-assessment;
  gaps surfaced here still have time to remediate without restarting
  the window.
- At day 180 (2026-11-30), freeze all control changes for 7 days, export
  the evidence binder, and hand to auditor at kickoff.
