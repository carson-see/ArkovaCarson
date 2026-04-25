# GME10 Contracts Dataset Stats

**Jira:** SCRUM-860, SCRUM-861  
**Generated from:** `services/worker/src/ai/eval/golden-dataset-phase23-contracts.ts` and `golden-dataset-phase24-contract-reasoning.ts`  
**Status:** Engineering stats complete; human hand-review gates remain before Jira Done.

## SCRUM-860 Phase 23 Extraction Dataset

Total entries: **1,040**. The Jira subtype counts sum to 1,040, so the story's "~1,000 entries" target is implemented as the exact acceptance distribution below.

| Contract subtype | Count |
|---|---:|
| `master_services_agreement` | 100 |
| `statement_of_work` | 80 |
| `nondisclosure_agreement` | 80 |
| `employment_agreement` | 80 |
| `sales_agreement` | 60 |
| `commercial_lease` | 80 |
| `residential_lease` | 60 |
| `contractor_consultant` | 60 |
| `ip_assignment` | 40 |
| `software_license` | 60 |
| `llc_partnership` | 40 |
| `data_processing_addendum` | 40 |
| `business_associate_agreement` | 30 |
| `service_level_agreement` | 30 |
| `subscription_agreement` | 40 |
| `real_estate_purchase` | 30 |
| `loan_promissory_note` | 20 |
| `settlement_agreement` | 20 |
| `franchise_agreement` | 15 |
| `ip_license` | 15 |
| `adversarial_fraud` | 60 |

### Field-Presence Histogram

| Ground-truth field | Present entries |
|---|---:|
| `credentialType` | 1,040 |
| `subType` | 1,040 |
| `contractType` | 1,040 |
| `issuerName` | 1,040 |
| `issuedDate` | 1,040 |
| `effectiveDate` | 1,040 |
| `expiryDate` | 1,040 |
| `parties` | 1,040 |
| `signatories` | 1,040 |
| `termLength` | 1,040 |
| `autoRenewalTerms` | 1,040 |
| `noticeDeadline` | 1,040 |
| `paymentTerms` | 1,040 |
| `deliverables` | 1,040 |
| `liabilityCap` | 1,040 |
| `indemnificationScope` | 1,040 |
| `terminationRights` | 1,040 |
| `governingLaw` | 1,040 |
| `jurisdiction` | 1,040 |
| `venue` | 1,040 |
| `arbitrationClause` | 1,040 |
| `confidentialityTerm` | 1,040 |
| `riskFlags` | 1,040 |
| `reasoning` | 1,040 |
| `fraudSignals` | 60 |

Every Phase 23 entry has at least 8 non-null ground-truth fields. The generated corpus currently provides 24 non-empty fields on clean entries and 25 on adversarial/fraud entries.

### Hand-Review Sample

Required 10% hand-review sample for SCRUM-860: **104 entries**.

Recommended sample:

- 5 entries from each of the 20 non-adversarial contract subtypes = 100 entries.
- 4 entries from `adversarial_fraud` = 104 entries.
- Review checks: PII stripping, field truth correctness, parties/signatories presence, ISO dates, and risk flag reasonability.

## SCRUM-861 Phase 24 Reasoning Dataset

Total entries: **600**.

| Reasoning category | Count |
|---|---:|
| `auto_renewal` | 120 |
| `unusual_clause` | 100 |
| `missing_clause` | 80 |
| `cross_document_reference` | 60 |
| `party_authority` | 60 |
| `jurisdictional_unenforceability` | 60 |
| `template_deviation` | 40 |
| `recommendation_chain` | 40 |
| `regulatory_gap` | 40 |

### Recommendation Registry

`CONTRACT_RECOMMENDATION_URL_REGISTRY` includes **16** validated registry entries covering:

- State contract-law summaries.
- FTC Franchise Rule and eCFR 16 CFR Part 436.
- HHS HIPAA Privacy Rule and business associate agreement provisions.
- GDPR data-processing agreement references.
- USPTO assignment and patent assignment resources.
- DOL independent contractor guidance.
- EEOC worker-rights reference.
- HUD Fair Housing overview.
- CFPB Regulation Z.
- AAA commercial arbitration rules.
- E-SIGN Act overview.

Every Phase 24 entry has one or more `recommendationUrls`, and tests assert every URL belongs to the registry and parses as a URL.

### Hand-Review Sample

Required 20% human reasoning review sample for SCRUM-861: **120 entries**.

The dataset marks exactly 120 entries with `human-review-sample`. Review checks:

- Reasoning conclusion matches the cited contract excerpt.
- `riskFlags[]` align with the issue.
- `concerns[]` are specific enough for reviewer action.
- `recommendationUrls[]` are appropriate for the category.
- Recommendation text avoids legal-advice overclaiming and routes counsel review where needed.
