# Gemini Contracts Expert v1 Design

**Jira:** SCRUM-859  
**Purpose:** GME10.1 design doc for a Contracts Expert Gemini Golden vertical.  
**Status:** Engineering design complete; legal counsel review of the risk-flag catalog remains the human gate before Done.

## Scope

Contracts Expert v1 covers 21 contract classes:

| Class | Dataset key | Primary extraction emphasis |
|---|---|---|
| Master services agreement | `master_services_agreement` | parties, scope, payment terms, liability cap, indemnity, termination |
| Statement of work | `statement_of_work` | deliverables, acceptance, dependencies, master-agreement reference |
| Non-disclosure agreement | `nondisclosure_agreement` | confidentiality term, residuals, compelled disclosure, return/destroy |
| Employment agreement | `employment_agreement` | role, compensation, restrictive covenants, assignment, termination |
| Sales agreement | `sales_agreement` | purchase terms, title/risk transfer, warranty, shipment |
| Commercial lease | `commercial_lease` | premises, term, rent, CAM/NNN expenses, assignment |
| Residential lease | `residential_lease` | rent, deposit, statutory notice, habitability, move-out |
| Contractor/consultant | `contractor_consultant` | classification, authority, work product, payment |
| IP assignment | `ip_assignment` | chain of title, excluded IP, further assurances, recordation |
| Software license | `software_license` | license scope, restrictions, audit rights, support, super-cap |
| LLC/partnership | `llc_partnership` | governance, capital, transfers, deadlock, tax matters |
| Data processing addendum | `data_processing_addendum` | controller/processor duties, subprocessors, transfers, security exhibit |
| Business associate agreement | `business_associate_agreement` | PHI uses, safeguards, breach notice, subcontractors |
| Service level agreement | `service_level_agreement` | uptime, response time, credits, sole remedy |
| Subscription agreement | `subscription_agreement` | SaaS access, usage limits, renewal, data export |
| Real estate purchase | `real_estate_purchase` | property, title, contingencies, closing, risk of loss |
| Loan/promissory note | `loan_promissory_note` | principal, interest, default, acceleration, collateral |
| Settlement agreement | `settlement_agreement` | release, payment, confidentiality, enforcement |
| Franchise agreement | `franchise_agreement` | FDD receipt, territory, royalties, brand standards |
| IP license | `ip_license` | field of use, royalties, sublicensing, quality control |
| Adversarial/fraud | `adversarial_fraud` | mismatched parties, impossible dates, missing authority, one-sided terms |

Out of scope for v1: executing the tuning job, parsing raw e-signature vendor payloads, non-English contracts, handwritten contracts, and live legal advice. Dataset authoring is covered by SCRUM-860 and SCRUM-861.

## Dependencies

- **SCRUM-828 / GME8 infrastructure:** recommendation registry, golden dataset wiring, evaluation harness, and Gemini Golden release gates.
- **SCRUM-834 / GME3 Legal pattern:** legal-document classification style, reasoning output shape, and jurisdiction-aware caveat style.
- **Client-side privacy boundary:** source contract text remains PII-stripped before server-side AI evaluation. No raw names, emails, taxpayer IDs, bank details, or addresses are included in the golden datasets.

## Contract Schema

Contracts Expert v1 adds optional `GroundTruthFields` fields so existing eval scoring remains compatible:

| Field | Type | Notes |
|---|---|---|
| `contractType` | string | One of the dataset contract keys. |
| `contractReasoningType` | string | Reasoning category for SCRUM-861 entries. |
| `parties` | string[] | Redacted legal parties where known. |
| `signatories` | string[] | Redacted signer identities or authority placeholders. |
| `effectiveDate`, `expiryDate`, `issuedDate` | ISO date string | Normalized date fields. |
| `termLength`, `autoRenewalTerms`, `noticeDeadline` | string | Renewal and deadline extraction targets. |
| `paymentTerms` | string | Fee cadence, invoice terms, milestone terms, or no-payment statements. |
| `deliverables` | string[] | Scope items, outputs, or regulated obligations. |
| `liabilityCap`, `indemnificationScope`, `terminationRights` | string | Core commercial risk allocation. |
| `governingLaw`, `venue`, `arbitrationClause`, `jurisdiction` | string | Dispute and enforceability fields. |
| `confidentialityTerm` | string | Survival and confidentiality duration. |
| `riskFlags`, `fraudSignals`, `concerns` | string[] | Risk and adversarial markers. |
| `recommendationUrls` | string[] | Registry-validated recommendation references. |
| `templateDeviation`, `crossDocumentReference`, `signatoryAuthority`, `regulatoryGap` | string | Reasoning-specific evidence fields. |

## Reasoning Modules

The reasoning layer is intentionally separate from extraction so field recall can improve without conflating legal judgment:

1. **Auto-renewal analysis:** renewal trigger, notice window, renewal fee uplift, reminder requirement.
2. **Unusual clause detection:** one-sided discretion, nonstandard remedies, overbroad restrictive covenants.
3. **Missing clause detection:** missing privacy, HIPAA, IP assignment, security, acceptance, or notice terms.
4. **Cross-document references:** missing exhibits, stale master agreements, conflicting priority clauses.
5. **Party authority:** entity mismatch, title mismatch, authority evidence, e-sign envelope consistency.
6. **Jurisdictional enforceability:** venue conflicts, statutory notice gaps, local law conflicts.
7. **Template deviation:** removed control clauses, unapproved fallback changes, missing approval metadata.
8. **Recommendation chains:** multi-step remediations involving filings, disclosures, or external evidence.
9. **Regulatory gaps:** franchise, HIPAA, GDPR, lending, employment, fair-housing, and consumer notice gaps.

## Risk-Flag Catalog

Initial catalog for legal review:

| Category | Flags |
|---|---|
| Parties and authority | `mismatched_party_names`, `entity_name_mismatch`, `signatory_authority_gap`, `unauthorized_binding_power`, `missing_counterparty_capacity`, `related_entity_substitution` |
| Dates and term | `impossible_dates`, `future_effective_after_expiry`, `short_nonrenewal_window`, `renewal_fee_escalation`, `notice_method_unclear`, `statutory_notice_gap` |
| Commercial terms | `scope_creep`, `acceptance_window`, `dependency_risk`, `warranty_limit_review`, `incoterms_review`, `sole_remedy_review` |
| Remedies and liability | `liability_cap_review`, `security_supercap_review`, `one_sided_waiver`, `nonstandard_remedy`, `default_interest_review`, `usury_review` |
| Employment and labor | `worker_classification`, `classification_review`, `overbroad_restrictive_covenant`, `restrictive_covenant_review`, `missing_required_terms` |
| Real estate | `assignment_consent`, `cam_reconciliation`, `habitability_review`, `title_objection_review`, `contingency_deadline`, `fair_housing_gap` |
| Privacy and healthcare | `subprocessor_notice`, `transfer_mechanism_review`, `phi_safeguards`, `breach_notice_review`, `privacy_transfer_gap`, `security_exhibit_missing` |
| IP and technology | `chain_of_title`, `excluded_ip_review`, `quality_control_review`, `royalty_audit_review`, `audit_rights_review`, `open_source_notice_gap` |
| Governance and template | `deadlock_review`, `transfer_restriction_review`, `template_clause_removed`, `fallback_language_changed`, `unapproved_redline` |
| Regulatory | `fdd_timing_review`, `territory_exclusivity_review`, `consumer_notice_gap`, `regulatory_terms_missing`, `evidence_package_incomplete` |

## E-Signature Touchpoints

- Capture package completeness before sending: base agreement, exhibits, order forms, addenda, and authority evidence.
- Compare e-sign envelope party names, signer titles, and entity names against extracted `parties[]` and `signatories[]`.
- Preserve envelope completion certificate as an external evidence reference, not as raw training text.
- Flag counter-signature gaps, stale drafts, out-of-order signing, and missing signer authority.
- Record approved template version and deviation approval metadata for template-deviation reasoning.

## Vertex Tuning Configuration

The v1 tuning plan should use the existing Gemini Golden training harness:

| Setting | v1 recommendation |
|---|---|
| Base model | Gemini Golden current production candidate after GME8 gate |
| Dataset split | 80% train, 10% validation, 10% holdout, stratified by contract type and reasoning category |
| Target examples | Phase 23 extraction + Phase 24 reasoning after human review samples pass |
| Privacy | PII-stripped text only; no raw contract data or customer identifiers |
| Stopping gate | Holdout extraction F1, risk-flag recall, and recommendation URL validity |
| Regression guard | Existing non-contract golden dataset must not regress more than 1 percentage point macro-F1 |

## Bitcoin Anchor Pipeline

Contracts Expert v1 does not change anchoring schema. The expected pipeline is:

1. Browser performs fingerprinting and PII stripping.
2. Contract metadata and extracted fields are evaluated without raw document text leaving the device.
3. Approved results attach to the existing anchor evidence model as structured metadata.
4. The anchor receipt proves the secured document fingerprint and timestamp, not the legal correctness of the AI interpretation.
5. Any recommendation or risk-flag output is evidence-adjacent metadata and must carry legal-review caveats.

## Definition Of Done Targets

- Phase 23 dataset wired into `FULL_GOLDEN_DATASET` with exact Jira distribution.
- Phase 24 reasoning dataset wired into `FULL_GOLDEN_DATASET` with exact 600-entry distribution.
- Recommendation URLs validate against `CONTRACT_RECOMMENDATION_URL_REGISTRY`.
- Field-presence stats report published in `docs/plans/gme10-contracts-dataset-stats-2026-04-24.md`.
- Tests cover distribution, ID ranges, PII stripping, ISO dates, field density, fraud entries, registry URL validation, and human-review sample markers.
- Human gates: legal counsel reviews this risk-flag catalog; 10% Phase 23 hand-review and 20% Phase 24 reasoning review are completed before Jira Done.
