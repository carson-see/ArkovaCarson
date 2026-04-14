# NCX: Nessie Compliance Expert — Story Group

> Epic: SCRUM-732 | Release: R-NCX-01
> Priority: HIGHEST | Status: 0/7 complete

## Goal

Transform Nessie from a credential classifier into a compliance reasoning expert. Nessie must understand regulatory text, enforcement patterns, continuing education requirements, transcript formats, and business entity structures — not just label documents.

## Stories

| # | ID | Jira | Priority | Story | Phase | Status |
|---|-----|------|----------|-------|-------|--------|
| 1 | NCX-01 | SCRUM-735 | HIGHEST | eCFR Regulatory Text Fetcher | 1 | NOT STARTED |
| 2 | NCX-02 | SCRUM-736 | HIGH | Enforcement Action Fetchers (OCR/HHS/State AG) | 1 | NOT STARTED |
| 3 | NCX-03 | SCRUM-737 | HIGH | NASBA/CPE Continuing Education Registry | 1 | NOT STARTED |
| 4 | NCX-04 | SCRUM-738 | HIGH | CME/Medical CE Accreditor (ACCME) | 1 | NOT STARTED |
| 5 | NCX-05 | SCRUM-739 | HIGHEST | Golden Dataset Expansion — 200 compliance entries | 2 | NOT STARTED |
| 6 | NCX-06 | SCRUM-740 | HIGH | NCES/Clearinghouse Transcript Data | 1 | NOT STARTED |
| 7 | NCX-07 | SCRUM-741 | HIGH | Compliance Framework Ingest (SOC 2, ISO, NIST) | 2 | NOT STARTED |

## Dependencies

- NCX-05 depends on NCX-01 through NCX-04 (pipeline data informs golden entries)
- NCX-07 depends on NCX-01 (regulatory text provides framework context)

## Key Metrics

- Golden dataset: 1,905 → 2,100+ entries
- Compliance coverage: 0 → 5,000+ regulatory records
- CE coverage: 2 → 5,000+ records
- Transcript coverage: 2 → 5,000+ records
