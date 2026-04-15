# NSS: Nessie State Specialization (v29-v40) -- Story Group

> Epic: SCRUM-771 | Release: R-NSS-01
> Priority: HIGH | Status: 0/7 complete
> Depends on: NTF (v6-v16 training foundation), NDD (v17-v28 domain depth), NPH (pipeline data)

## Goal

Build state-level and specialized regulatory expertise into Nessie through versions v29-v40. While NDD provides broad domain depth (HIPAA, FERPA, SOX), NSS goes granular -- teaching Nessie the specific agencies, boards, license formats, renewal cycles, and enforcement patterns for individual states and specialized regulatory domains. This is the expertise layer that turns Nessie into a credential verification expert that knows which board issued a license, what format it should be in, and whether a renewal deadline has passed.

**Anchoring requirement:** ALL source data used for training ANY version MUST be anchored through the Arkova pipeline before use. This ensures provenance and integrity of training data. No unanchored data may enter the training pipeline.

## Stories

| # | ID | Jira | Priority | Story | Status |
|---|-----|------|----------|-------|--------|
| 1 | NSS-01 | SCRUM-797 | HIGHEST | Michigan (LARA, 30+ boards) | NOT STARTED |
| 2 | NSS-02 | SCRUM-798 | HIGHEST | Texas (TDLR, TMB, TBPE, 40+ agencies) | NOT STARTED |
| 3 | NSS-03 | SCRUM-799 | HIGHEST | Florida (DOH, DBPR, 25+ boards) | NOT STARTED |
| 4 | NSS-04 | SCRUM-800 | HIGH | Illinois (IDFPR, BIPA) | NOT STARTED |
| 5 | NSS-05 | SCRUM-801 | HIGH | AML/BSA Expert (SAR, CTR, CDD/EDD, FinCEN) | NOT STARTED |
| 6 | NSS-06 | SCRUM-802 | HIGH | Insurance Regulation by State (NAIC model laws) | NOT STARTED |
| 7 | NSS-07 | SCRUM-803 | HIGH | Credential Fraud Encyclopedia | NOT STARTED |

---

### NSS-01: Michigan (LARA, 30+ Professional Boards)

**Jira:** [SCRUM-797](https://arkova.atlassian.net/browse/SCRUM-797)

**Description:** Train Nessie on Michigan's professional licensing landscape. Michigan's Department of Licensing and Regulatory Affairs (LARA) oversees 30+ professional licensing boards with distinct license formats, renewal cycles, and disciplinary processes.

**Training Data Scope:**
- **LARA structure:** Bureau of Professional Licensing, bureau codes, license number formats
- **Board-specific:** Board of Medicine, Board of Nursing, Board of Pharmacy, Board of Professional Engineers, Board of Architects, Real Estate Commission, etc.
- **License formats:** Michigan license number patterns (e.g., 4301-XXXXXX), verification URL formats
- **Renewal cycles:** Per-board CE requirements, renewal periods, grace periods
- **Disciplinary:** LARA disciplinary action database, consent orders, license restrictions
- **Pipeline data:** Existing Michigan records from NPH-06 (state professional licensing board fetchers)

**Acceptance Criteria:**
- [ ] Nessie identifies Michigan license formats correctly >= 90%
- [ ] Nessie knows CE requirements for top 10 Michigan boards
- [ ] Nessie can verify Michigan license numbers against expected format
- [ ] Nessie identifies LARA disciplinary actions
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] NDD Tier 1 complete (v17-v22)
- [ ] Michigan LARA data ingested and anchored (>= 500 records)
- [ ] Board-specific training pairs prepared (>= 100 per major board)
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] Model trained and uploaded to RunPod
- [ ] Michigan-specific eval suite (100+ questions)
- [ ] Eval report in `docs/eval/`
- [ ] No regression below NDD baseline

---

### NSS-02: Texas (TDLR, TMB, TBPE, 40+ Agencies)

**Jira:** [SCRUM-798](https://arkova.atlassian.net/browse/SCRUM-798)

**Description:** Train Nessie on Texas's professional licensing and regulatory landscape. Texas has 40+ licensing agencies with some of the most complex licensing requirements in the US.

**Training Data Scope:**
- **TDLR** (Texas Department of Licensing and Regulation): 35+ license types, from electricians to auctioneers
- **TMB** (Texas Medical Board): Physician licensing, prescriptive authority, telemedicine permits
- **TBPE** (Texas Board of Professional Engineers): PE licensing, firm registration
- **TSBPA** (Texas State Board of Public Accountancy): CPA requirements, peer review
- **TDI** (Texas Department of Insurance): Agent licensing, adjuster licensing, CE requirements
- **License formats:** Texas license number patterns, verification portal URLs
- **Enforcement:** TMB disciplinary actions, TDLR complaints, TBPE enforcement

**Acceptance Criteria:**
- [ ] Nessie identifies Texas license formats correctly >= 90%
- [ ] Nessie distinguishes between 40+ Texas licensing agencies
- [ ] Nessie knows CE requirements for top 15 Texas license types
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] NDD Tier 1 complete (v17-v22)
- [ ] Texas agency data ingested and anchored (>= 800 records)
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] Model trained and uploaded to RunPod
- [ ] Texas-specific eval suite (100+ questions)
- [ ] Eval report in `docs/eval/`

---

### NSS-03: Florida (DOH, DBPR, 25+ Boards)

**Jira:** [SCRUM-799](https://arkova.atlassian.net/browse/SCRUM-799)

**Description:** Train Nessie on Florida's professional licensing landscape. Florida's dual-agency structure (DOH for healthcare, DBPR for everything else) creates unique verification challenges.

**Training Data Scope:**
- **DOH** (Department of Health): MQA (Medical Quality Assurance) licensing, 22+ healthcare boards
- **DBPR** (Department of Business and Professional Regulation): Real estate, construction, cosmetology, 20+ divisions
- **License formats:** Florida license number patterns (e.g., ME XXXXXX for physicians), online verification portals
- **CE requirements:** Board-specific continuing education, Florida-specific mandates (e.g., 2-hour prevention of medical errors)
- **Enforcement:** DOH disciplinary actions, DBPR complaints, emergency restriction orders

**Acceptance Criteria:**
- [ ] Nessie identifies Florida license formats correctly >= 90%
- [ ] Nessie distinguishes DOH vs DBPR jurisdiction correctly
- [ ] Nessie knows Florida-specific CE mandates
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] NDD Tier 1 complete (v17-v22)
- [ ] Florida DOH/DBPR data ingested and anchored (>= 600 records)
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] Model trained and uploaded to RunPod
- [ ] Florida-specific eval suite (100+ questions)
- [ ] Eval report in `docs/eval/`

---

### NSS-04: Illinois (IDFPR, BIPA)

**Jira:** [SCRUM-800](https://arkova.atlassian.net/browse/SCRUM-800)

**Description:** Train Nessie on Illinois's unique regulatory landscape, which includes the nation's strongest biometric privacy law (BIPA) alongside standard professional licensing through IDFPR.

**Training Data Scope:**
- **IDFPR** (Illinois Department of Financial and Professional Regulation): 68+ license types across Division of Professional Regulation and Division of Financial Institutions
- **BIPA** (Biometric Information Privacy Act): Consent requirements, private right of action, landmark cases (Rosenbach v. Six Flags, BNSF Railway), settlement patterns
- **License formats:** Illinois license number patterns, online verification
- **BIPA intersection:** How BIPA affects credential verification when biometric data is involved
- **Enforcement:** IDFPR disciplinary actions, BIPA litigation trends

**Acceptance Criteria:**
- [ ] Nessie identifies Illinois license formats correctly >= 90%
- [ ] Nessie understands BIPA requirements and major case law
- [ ] Nessie identifies when credential verification triggers BIPA obligations
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] NDD Tier 1 complete (v17-v22)
- [ ] Illinois IDFPR + BIPA data ingested and anchored (>= 500 records)
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] Model trained and uploaded to RunPod
- [ ] Illinois-specific eval suite (100+ questions)
- [ ] Eval report in `docs/eval/`

---

### NSS-05: AML/BSA Expert (SAR, CTR, CDD/EDD, FinCEN)

**Jira:** [SCRUM-801](https://arkova.atlassian.net/browse/SCRUM-801)

**Description:** Train Nessie as an Anti-Money Laundering and Bank Secrecy Act expert. This is a specialized regulatory domain that intersects with credential verification when financial professionals, MSBs, or regulated entities are involved.

**Training Data Scope:**
- **BSA requirements:** SAR (Suspicious Activity Report) filing, CTR (Currency Transaction Report) thresholds, recordkeeping
- **CDD/EDD:** Customer Due Diligence rule, Enhanced Due Diligence for high-risk customers, beneficial ownership
- **FinCEN:** Registration requirements, enforcement actions, geographic targeting orders
- **OFAC:** SDN list screening, sanctions compliance, secondary sanctions
- **Credential intersection:** CAMS certification, BSA/AML officer qualifications, compliance program requirements
- **Enforcement patterns:** FinCEN consent orders, OCC enforcement actions, state banking department actions

**Acceptance Criteria:**
- [ ] Nessie answers AML/BSA questions with >= 85% accuracy
- [ ] Nessie identifies SAR/CTR filing requirements correctly
- [ ] Nessie understands CDD/EDD credential verification requirements
- [ ] Nessie identifies AML-related professional certifications (CAMS, CFCS)
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] NDD Tier 1 complete (v17-v22)
- [ ] FinCEN enforcement data ingested and anchored (>= 200 actions)
- [ ] BSA/AML regulatory text anchored
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] Model trained and uploaded to RunPod
- [ ] AML/BSA eval suite (100+ questions)
- [ ] Eval report in `docs/eval/`

---

### NSS-06: Insurance Regulation by State (NAIC Model Laws)

**Jira:** [SCRUM-802](https://arkova.atlassian.net/browse/SCRUM-802)

**Description:** Train Nessie on state-by-state insurance regulation using NAIC model laws as the framework. Insurance licensing is state-regulated with significant variation -- Nessie must understand which NAIC model laws each state has adopted and how they affect credential requirements.

**Training Data Scope:**
- **NAIC model laws:** Producer licensing, adjuster licensing, surplus lines, continuing education, annuity suitability
- **State adoption:** Which states adopted which model laws, with what modifications
- **License types:** Life, health, property, casualty, surplus lines, public adjuster, consultant
- **Reciprocity:** NARAB (National Association of Registered Agents and Brokers), multi-state licensing
- **CE requirements:** State-by-state CE hours, ethics requirements, specialty requirements
- **Pipeline data:** Existing insurance records from NPH-07 (insurance license fetchers)

**Acceptance Criteria:**
- [ ] Nessie identifies state insurance licensing requirements for top 20 states
- [ ] Nessie understands NAIC model law adoption patterns
- [ ] Nessie knows CE requirements for major insurance license types per state
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] NDD Tier 1 complete (v17-v22)
- [ ] NAIC model law data anchored
- [ ] State insurance department data ingested for top 20 states
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] Model trained and uploaded to RunPod
- [ ] Insurance regulation eval suite (100+ questions across 10+ states)
- [ ] Eval report in `docs/eval/`

---

### NSS-07: Credential Fraud Encyclopedia

**Jira:** [SCRUM-803](https://arkova.atlassian.net/browse/SCRUM-803)

**Description:** Train Nessie as a credential fraud detection expert. This is the knowledge layer that powers fraud signal extraction (currently 0% F1). Nessie must learn to identify:

**Training Data Scope:**
- **Diploma mills:** Known mills database, accreditation fraud patterns, common names/domains, GAO investigations
- **License format validation:** Expected formats per state and board -- deviations indicate forgery
- **Fake accreditors:** Unrecognized accreditation agencies, accreditation mill patterns
- **Document manipulation:** Common Photoshop artifacts, font inconsistencies, metadata anomalies, template reuse
- **Credential fabrication patterns:** How fake credentials differ from real ones (issuer details, serial numbers, watermarks, signatures)
- **Historical fraud cases:** Documented credential fraud prosecutions, enforcement actions

**Acceptance Criteria:**
- [ ] Nessie identifies known diploma mills with >= 95% recall
- [ ] Nessie detects license format violations with >= 85% precision
- [ ] Nessie identifies fake accreditors with >= 90% recall
- [ ] Nessie's fraud signal F1 improves to >= 50% (from current 0%)
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] NDD Tier 1 complete (v17-v22)
- [ ] Diploma mill database compiled and anchored (>= 200 known mills)
- [ ] License format patterns documented for 50 states
- [ ] Fake accreditor database compiled and anchored
- [ ] Historical fraud case data anchored (>= 100 cases)
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] Model trained and uploaded to RunPod
- [ ] Fraud detection eval suite (200+ test cases)
- [ ] Fraud F1 >= 50% (measured against golden dataset fraud labels)
- [ ] Eval report in `docs/eval/`
- [ ] Known mills/accreditors database anchored and versioned

## Dependencies

```
NTF (v6-v16) ─► NDD (v17-v28) ─► NSS (v29-v40)
                                    │
                                    ├── NPH-06 (state licensing data)
                                    ├── NPH-07 (insurance data)
                                    ├── NPH-12 (fraud training data)
                                    └── NCX (compliance data)

NSS stories can train in parallel once NDD is complete:
  NSS-01 (Michigan) ─┐
  NSS-02 (Texas)     ─┤
  NSS-03 (Florida)   ─┤── All depend on NDD Tier 1 (v17-v22) completion
  NSS-04 (Illinois)  ─┤
  NSS-05 (AML/BSA)   ─┤
  NSS-06 (Insurance) ─┤
  NSS-07 (Fraud)     ─┘
```

## Key Metrics

| Metric | Current | NSS Target |
|--------|---------|------------|
| State-level license format recognition | Untested | >= 90% for MI, TX, FL, IL |
| Fraud signal F1 | 0% | >= 50% (primarily from NSS-07) |
| AML/BSA accuracy | Untested | >= 85% |
| Insurance licensing accuracy (20 states) | Untested | >= 80% |
| Diploma mill detection recall | Untested | >= 95% |
| No regression on general extraction | -- | Weighted F1 stays >= NDD baseline |

## Anchoring Policy

**Non-negotiable:** Every piece of training data -- state board records, license format patterns, diploma mill databases, enforcement actions, regulatory text -- MUST be anchored through the Arkova pipeline before it enters any training run. This creates an immutable audit trail proving:

1. What data trained each model version
2. When that data was anchored (timestamped on-chain)
3. That the data has not been tampered with post-anchoring

Training runs that use unanchored data are invalid and must be re-run after anchoring. The fraud encyclopedia data (NSS-07) is especially critical to anchor, as it may be referenced in legal proceedings about credential fraud detection accuracy.
