# NDD: Nessie Domain Depth (v17-v28) -- Story Group

> Epic: SCRUM-770 | Release: R-NDD-01
> Priority: HIGH | Status: 0/12 complete
> Depends on: NTF (v6-v16 training foundation), NCX (compliance data), KAU (Kenya/AU data)

## Goal

Build deep jurisdiction and domain expertise into Nessie through versions v17-v28. Each version specializes Nessie in a specific legal/regulatory domain, transforming it from a generalist compliance assistant into a jurisdiction-aware expert system. Training is tiered by demand -- Tier 1 covers US domestic high-demand domains, Tier 2 covers international jurisdictions.

**Anchoring requirement:** ALL source data used for training ANY version MUST be anchored through the Arkova pipeline before use. This ensures provenance and integrity of training data. No unanchored data may enter the training pipeline.

## Tier Structure

### Tier 1 -- US Domestic (Highest Demand)

| Version | Domain | Why First |
|---------|--------|-----------|
| v17 | NY Privacy (SHIELD Act, DFS) | NYC financial services concentration |
| v18 | CA Privacy (CCPA/CPRA, CalOPPA) | Largest state economy, strictest consumer privacy |
| v19 | HIPAA Deep | Healthcare is #1 credential volume vertical |
| v20 | SOX/SEC Deep | Public company compliance is enterprise deal prerequisite |
| v21 | FERPA Deep | Education is core vertical (transcripts, degrees) |
| v22 | Employment/Background Check | ATS integrations (Bullhorn, Clio) drive this demand |

### Tier 2 -- International

| Version | Domain | Why |
|---------|--------|-----|
| v23 | Kenya DPA (2019) | Early clientele, ODPC registration in progress |
| v24 | Australia Privacy Act (APP) | Early clientele, NDB procedure needed |
| v25 | GDPR (EU) | Required for any EU-facing business |
| v26 | Nigeria NDPR / South Africa POPIA | African expansion path |
| v27 | UK Data Protection Act | Post-Brexit UK-specific requirements |
| v28 | Contract Law Fundamentals | Cross-cutting -- needed for all jurisdictions |

## Stories

| # | ID | Jira | Priority | Story | Version | Tier | Status |
|---|-----|------|----------|-------|---------|------|--------|
| 1 | NDD-01 | SCRUM-780 | HIGHEST | NY Privacy (SHIELD Act, DFS Cybersecurity) | v17 | 1 | NOT STARTED |
| 2 | NDD-02 | SCRUM-781 | HIGHEST | CA Privacy (CCPA/CPRA, CalOPPA) | v18 | 1 | NOT STARTED |
| 3 | NDD-03 | SCRUM-782 | HIGHEST | HIPAA Deep Specialization | v19 | 1 | NOT STARTED |
| 4 | NDD-04 | SCRUM-783 | HIGHEST | SOX/SEC Deep Specialization | v20 | 1 | NOT STARTED |
| 5 | NDD-05 | SCRUM-784 | HIGHEST | FERPA Deep Specialization | v21 | 1 | NOT STARTED |
| 6 | NDD-06 | SCRUM-785 | HIGH | Employment & Background Check Law | v22 | 1 | NOT STARTED |
| 7 | NDD-07 | SCRUM-786 | HIGH | Kenya DPA 2019 Specialization | v23 | 2 | NOT STARTED |
| 8 | NDD-08 | SCRUM-787 | HIGH | Australia Privacy Act (APP) | v24 | 2 | NOT STARTED |
| 9 | NDD-09 | SCRUM-788 | HIGH | GDPR Specialization | v25 | 2 | NOT STARTED |
| 10 | NDD-10 | SCRUM-789 | MEDIUM | Nigeria NDPR / South Africa POPIA | v26 | 2 | NOT STARTED |
| 11 | NDD-11 | SCRUM-790 | MEDIUM | UK Data Protection Act | v27 | 2 | NOT STARTED |
| 12 | NDD-12 | SCRUM-791 | MEDIUM | Contract Law Fundamentals | v28 | 2 | NOT STARTED |

---

### NDD-01: NY Privacy (SHIELD Act, DFS Cybersecurity) -- v17

**Jira:** [SCRUM-780](https://arkova.atlassian.net/browse/SCRUM-780)

**Description:** Train Nessie v17 as a New York privacy and cybersecurity regulation expert. Covers:
- **SHIELD Act** (Stop Hacks and Improve Electronic Data Security): Data breach notification, reasonable safeguards, expanded PII definition
- **DFS Cybersecurity Regulation** (23 NYCRR 500): MFA requirements, CISO designation, incident response, penetration testing, encryption standards
- **NY Financial Services**: Banking, insurance, and financial credential requirements specific to NY DFS jurisdiction
- **NY Labor Law**: Credential verification requirements for NY employers

**Training Data Sources:**
- NY State Legislature (full text of SHIELD Act, amendments)
- DFS enforcement actions and guidance letters
- NY Attorney General data breach reports
- NY court decisions on privacy violations

**Acceptance Criteria:**
- [ ] v17 answers NY SHIELD Act questions with >= 85% accuracy
- [ ] v17 identifies DFS 23 NYCRR 500 requirements correctly
- [ ] v17 understands NY-specific breach notification timelines
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] v16 model available as training base (NTF-07 complete)
- [ ] NY regulatory text ingested and anchored
- [ ] NY enforcement action data collected (>= 100 cases)
- [ ] Q&A training pairs prepared (>= 200)
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] v17 model trained and uploaded to RunPod
- [ ] NY privacy eval suite created (100+ questions)
- [ ] Eval report in `docs/eval/`
- [ ] No regression below v16 baseline

---

### NDD-02: CA Privacy (CCPA/CPRA, CalOPPA) -- v18

**Jira:** [SCRUM-781](https://arkova.atlassian.net/browse/SCRUM-781)

**Description:** Train Nessie v18 as a California privacy expert. Covers:
- **CCPA/CPRA:** Consumer rights (access, delete, opt-out), service provider obligations, data broker registration, CPPA enforcement
- **CalOPPA:** Online privacy policy requirements
- **CA Labor Code:** Background check restrictions (ban-the-box), salary history bans
- **BIPA comparisons:** How CA privacy compares to Illinois BIPA for biometric data

**Acceptance Criteria:**
- [ ] v18 answers CCPA/CPRA questions with >= 85% accuracy
- [ ] v18 distinguishes CCPA vs CPRA changes correctly
- [ ] v18 understands California-specific credential requirements
- [ ] All training data anchored through pipeline before use

---

### NDD-03: HIPAA Deep Specialization -- v19

**Jira:** [SCRUM-782](https://arkova.atlassian.net/browse/SCRUM-782)

**Description:** Train Nessie v19 as a deep HIPAA expert beyond the basics covered in NTF-03. Covers:
- **Privacy Rule:** Minimum necessary standard, TPO exceptions, research waivers, psychotherapy notes
- **Security Rule:** Administrative/physical/technical safeguards, risk analysis methodology
- **Breach Notification Rule:** 60-day timeline, state AG notification, media notification thresholds
- **Enforcement:** OCR investigation procedures, settlement patterns, CMPs, state AG concurrent enforcement
- **HITECH Act:** Business associate direct liability, breach notification expansion
- **Medical credential verification:** NPDB queries, state medical board licensing, DEA registration

**Acceptance Criteria:**
- [ ] v19 answers advanced HIPAA questions with >= 90% accuracy
- [ ] v19 understands OCR enforcement patterns
- [ ] v19 identifies HIPAA-specific credential types and verification requirements
- [ ] All training data anchored through pipeline before use

---

### NDD-04: SOX/SEC Deep Specialization -- v20

**Jira:** [SCRUM-783](https://arkova.atlassian.net/browse/SCRUM-783)

**Description:** Train Nessie v20 as a SOX/SEC compliance expert. Covers:
- **SOX Sections 302/404:** Internal controls, management assessment, auditor attestation
- **SEC Filing Types:** 10-K, 10-Q, 8-K, proxy statements, beneficial ownership
- **PCAOB Standards:** Audit standards, independence requirements
- **SEC Enforcement:** Wells notices, consent decrees, disgorgement, debarment
- **Credential implications:** CPA license requirements for auditors, SEC registration for advisors

**Acceptance Criteria:**
- [ ] v20 answers SOX/SEC questions with >= 85% accuracy
- [ ] v20 identifies SEC filing credential requirements
- [ ] v20 understands PCAOB auditor credential standards
- [ ] All training data anchored through pipeline before use

---

### NDD-05: FERPA Deep Specialization -- v21

**Jira:** [SCRUM-784](https://arkova.atlassian.net/browse/SCRUM-784)

**Description:** Train Nessie v21 as a deep FERPA expert. Covers:
- **Education records:** Definition scope, directory information opt-out, legitimate educational interest
- **Disclosure rules:** Consent requirements, health/safety emergency exception, judicial order/subpoena
- **Transcript verification:** Institutional accreditation, transfer credit evaluation, NCES data
- **State supplements:** State-level student privacy laws (CA SOPIPA, NY Ed Law 2-d, CO HB 16-1423)
- **Enforcement:** FPCO complaint procedures, institutional funding risk

**Acceptance Criteria:**
- [ ] v21 answers advanced FERPA questions with >= 90% accuracy
- [ ] v21 identifies state-level FERPA supplements
- [ ] v21 understands transcript verification workflows
- [ ] All training data anchored through pipeline before use

---

### NDD-06: Employment & Background Check Law -- v22

**Jira:** [SCRUM-785](https://arkova.atlassian.net/browse/SCRUM-785)

**Description:** Train Nessie v22 on employment verification and background check law. Covers:
- **FCRA:** Consumer reporting agency obligations, adverse action procedures, dispute resolution
- **Ban-the-box laws:** State and local variations (35+ jurisdictions)
- **I-9 verification:** E-Verify, document acceptance, anti-discrimination
- **State-specific:** NY Article 23-A, CA Labor Code 432.7, IL BIPA employment context
- **ATS integration context:** How background check law applies to Bullhorn/Clio workflows

**Acceptance Criteria:**
- [ ] v22 answers FCRA questions with >= 85% accuracy
- [ ] v22 identifies state-specific ban-the-box requirements
- [ ] v22 understands I-9/E-Verify credential verification
- [ ] All training data anchored through pipeline before use

---

### NDD-07: Kenya DPA 2019 Specialization -- v23

**Jira:** [SCRUM-786](https://arkova.atlassian.net/browse/SCRUM-786)

**Description:** Train Nessie v23 as a Kenya data protection expert. Builds on KAU-01/02 data.
- **Kenya DPA 2019:** Data controller/processor obligations, consent requirements, cross-border transfer rules
- **ODPC regulations:** Registration requirements, compliance certificates, enforcement powers
- **Kenya credential types:** KNEC, TSC, KMPDC, LSK certifications
- **Kenya court decisions:** Data protection case law from kenyalaw.org

**Acceptance Criteria:**
- [ ] v23 answers Kenya DPA questions with >= 80% accuracy
- [ ] v23 identifies Kenya-specific credential types
- [ ] v23 understands ODPC registration requirements
- [ ] All training data anchored through pipeline before use

---

### NDD-08: Australia Privacy Act (APP) -- v24

**Jira:** [SCRUM-787](https://arkova.atlassian.net/browse/SCRUM-787)

**Description:** Train Nessie v24 as an Australian privacy expert. Builds on KAU-03/04 data.
- **Privacy Act 1988 + APPs:** 13 Australian Privacy Principles, APP entity obligations
- **NDB scheme:** Notifiable Data Breaches, OAIC notification, 30-day assessment
- **Australian credential types:** AHPRA, TEQSA, ASQA, ACNC, CPA Australia
- **OAIC enforcement:** Determinations, enforceable undertakings, civil penalty proceedings

**Acceptance Criteria:**
- [ ] v24 answers Australian privacy questions with >= 80% accuracy
- [ ] v24 identifies Australian credential types
- [ ] v24 understands NDB notification requirements
- [ ] All training data anchored through pipeline before use

---

### NDD-09: GDPR Specialization -- v25

**Jira:** [SCRUM-788](https://arkova.atlassian.net/browse/SCRUM-788)

**Description:** Train Nessie v25 as a GDPR expert.
- **GDPR Articles:** Lawful basis, data subject rights, DPO requirements, DPIA, SCCs
- **EU credential types:** Professional qualifications directive, mutual recognition
- **EDPB guidelines:** Binding decisions, consistency mechanism
- **DPA enforcement:** Notable fines, enforcement patterns by country

**Acceptance Criteria:**
- [ ] v25 answers GDPR questions with >= 85% accuracy
- [ ] v25 understands SCC and cross-border transfer mechanisms
- [ ] All training data anchored through pipeline before use

---

### NDD-10: Nigeria NDPR / South Africa POPIA -- v26

**Jira:** [SCRUM-789](https://arkova.atlassian.net/browse/SCRUM-789)

**Description:** Train Nessie v26 on Nigerian and South African data protection frameworks.
- **Nigeria NDPR/NDPA:** NDPC registration, consent requirements, data protection impact assessment
- **South Africa POPIA:** Information Regulator, Section 72 cross-border transfers, prior authorization
- **African credential types:** Professional bodies in Nigeria and South Africa

**Acceptance Criteria:**
- [ ] v26 answers Nigeria/SA data protection questions with >= 75% accuracy
- [ ] All training data anchored through pipeline before use

---

### NDD-11: UK Data Protection Act -- v27

**Jira:** [SCRUM-790](https://arkova.atlassian.net/browse/SCRUM-790)

**Description:** Train Nessie v27 on UK data protection post-Brexit.
- **UK GDPR + DPA 2018:** UK-specific derogations, adequacy decisions, UK-EU data flows
- **ICO enforcement:** Enforcement notices, monetary penalties, audits
- **UK credential types:** SRA (solicitors), GMC (doctors), HCPC (health professionals)

**Acceptance Criteria:**
- [ ] v27 answers UK data protection questions with >= 80% accuracy
- [ ] v27 distinguishes UK GDPR from EU GDPR correctly
- [ ] All training data anchored through pipeline before use

---

### NDD-12: Contract Law Fundamentals -- v28

**Jira:** [SCRUM-791](https://arkova.atlassian.net/browse/SCRUM-791)

**Description:** Train Nessie v28 on contract law fundamentals relevant to credential verification.
- **Formation:** Offer, acceptance, consideration, capacity -- how they apply to credential agreements
- **Data processing agreements:** Standard clauses, liability allocation, sub-processor obligations
- **NDAs and confidentiality:** How credential data is handled under confidentiality obligations
- **Service agreements:** SLA terms relevant to verification services

**Acceptance Criteria:**
- [ ] v28 answers contract law questions with >= 75% accuracy
- [ ] v28 understands DPA standard clauses
- [ ] All training data anchored through pipeline before use

## Dependencies

```
NTF (v6-v16) must complete before NDD begins

Tier 1 (can train in parallel):
  NDD-01 (v17 NY) ─┐
  NDD-02 (v18 CA) ─┤
  NDD-03 (v19 HIPAA) ─┤── All depend on NTF-07 (v16) completion
  NDD-04 (v20 SOX) ─┤
  NDD-05 (v21 FERPA) ─┤
  NDD-06 (v22 Employment) ─┘

Tier 2 (can train in parallel, after Tier 1):
  NDD-07 (v23 Kenya) ── depends on KAU-01, KAU-02
  NDD-08 (v24 Australia) ── depends on KAU-03, KAU-04
  NDD-09 (v25 GDPR) ── depends on REG (international compliance data)
  NDD-10 (v26 Nigeria/SA) ── depends on REG-23, REG-20
  NDD-11 (v27 UK) ── depends on REG (UK data)
  NDD-12 (v28 Contract) ── no special data dependency
```

## Key Metrics

| Metric | Target |
|--------|--------|
| Tier 1 domain accuracy | >= 85% per domain |
| Tier 2 domain accuracy | >= 75% per domain |
| Cross-jurisdiction comparison | >= 80% accuracy |
| No regression on general extraction | Weighted F1 stays >= v16 baseline |
| Training data per domain | >= 200 anchored Q&A pairs + >= 100 regulatory text excerpts |

## Anchoring Policy

**Non-negotiable:** Every piece of training data -- regulatory text, court decisions, enforcement actions, Q&A pairs, credential samples -- MUST be anchored through the Arkova pipeline before it enters any training run. This creates an immutable audit trail proving:

1. What data trained each model version
2. When that data was anchored (timestamped on-chain)
3. That the data has not been tampered with post-anchoring

Training runs that use unanchored data are invalid and must be re-run after anchoring. This is especially important for international data sources (Kenya, Australia, EU, UK) where data provenance may be challenged.
