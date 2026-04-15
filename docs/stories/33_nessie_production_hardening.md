# NPH: Nessie Production Hardening — Story Group

> Epic: SCRUM-697 | Release: R-NPH-01
> Priority: HIGHEST | Status: 12/19 complete (3 in progress, 1 blocked, 3 to do)

## Goal

Transform Nessie from a prototype into a production-ready AI pipeline. Fix broken fetchers, expand training data, improve fraud detection from 0% F1, and ensure balanced golden dataset coverage across all credential types.

## Stories

| # | ID | Jira | Priority | Story | Status |
|---|-----|------|----------|-------|--------|
| 1 | NPH-01 | SCRUM-698 | HIGHEST | Fix Credential Type Mappings | DONE |
| 2 | NPH-02 | SCRUM-699 | HIGHEST | Fix USPTO Patent Fetcher | DONE |
| 3 | NPH-03 | SCRUM-700 | HIGHEST | Embed 1.34M Unembedded Records | DONE |
| 4 | NPH-04 | SCRUM-701 | HIGH | Pipeline Page Overhaul | DONE |
| 5 | NPH-05 | SCRUM-702 | HIGH | State SOS Business Entity Fetchers | DONE |
| 6 | NPH-06 | SCRUM-703 | HIGH | State Professional Licensing Board Fetchers | DONE |
| 7 | NPH-07 | SCRUM-704 | HIGH | Insurance License & Entity Fetchers | DONE |
| 8 | NPH-08 | SCRUM-705 | HIGH | CLE Credit & Compliance Fetchers | DONE |
| 9 | NPH-09 | SCRUM-706 | HIGH | Professional Certification Body Fetchers | DONE |
| 10 | NPH-10 | SCRUM-707 | HIGH | Education Verification Fetchers | DONE |
| 11 | NPH-12 | SCRUM-709 | HIGH | Fraud Signal Training Data Pipeline | IN PROGRESS |
| 12 | NPH-13 | SCRUM-710 | HIGH | Golden Dataset Expansion 1,919 -> 5,000+ | IN PROGRESS |
| 13 | NPH-14 | SCRUM-711 | HIGH | Nessie v8 Retrain | TO DO |
| 14 | NPH-15 | SCRUM-727 | MEDIUM | SEC IAPD Fetcher — API 403 | BLOCKED |
| 15 | NPH-16 | SCRUM-728 | HIGHEST | Deploy Missing API Keys to Cloud Run | TO DO (ops) |
| 16 | NPH-17 | SCRUM-729 | HIGH | FCC License Fetcher | IN PROGRESS |
| 17 | NPH-18 | SCRUM-730 | HIGHEST | Fix Embedding Provider | DONE |
| 18 | NPH-19 | SCRUM-731 | HIGHEST | USPTO Fetcher Rewrite | DONE |

## Key Metrics

- Golden dataset: 1,919 -> 5,000+ entries
- Fraud signal F1: 0% -> >30% (first milestone)
- All credential types: >= 50 golden entries each
- Pipeline sources: all fetchers running in production
