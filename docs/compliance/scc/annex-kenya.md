# SCC Annex — Kenya Data Protection Act 2019

> **Parent:** `base-template.md` | **Jira:** SCRUM-573 (REG-12)

## Applicable Law
Kenya Data Protection Act, No. 24 of 2019 (DPA 2019); Data Protection (General) Regulations, 2021.

## Supervisory Authority
Office of the Data Protection Commissioner (ODPC) — https://odpc.go.ke

## Cross-Border Transfer Basis
Kenya DPA Section 48: Transfer allowed where adequate safeguards exist, including binding contractual clauses between controller and processor.

US does NOT have ODPC adequacy status. These SCCs serve as the binding contractual clause required under Section 48(1)(d).

## Jurisdiction-Specific Requirements

### Processor Obligations (Section 41)
- Process data only on documented instructions of the controller
- Ensure personnel authorized to process data are under confidentiality obligations
- Implement appropriate technical and organizational security measures
- Engage sub-processors only with prior written authorization
- Assist controller in responding to data subject requests (Sections 31-38)
- Delete or return all personal data upon termination
- Submit to audits and inspections by the controller

### Data Subject Rights (Sections 31-38)
| Right | Section | Arkova Implementation |
|-------|---------|----------------------|
| Right to be informed | 31 | Privacy notice in copy.ts |
| Right of access | 32 | Self-service data export |
| Right to rectification | 33 | Data correction request form |
| Right to erasure | 34 | Account deletion + anonymization |
| Right to data portability | 35 | JSON + human-readable export |
| Right to object | 36 | Objection request via DPO contact |

### Breach Notification (Section 43)
- Controller notification to ODPC: **72 hours** from discovery
- Processor (Arkova) to Controller: **48 hours** from discovery (per Clause 5 of base SCCs)
- Notification to data subjects: required if breach likely results in high risk

### Penalties
- Up to KES 5,000,000 (~$39,000 USD) or 1% of annual turnover, whichever is lower
- Criminal liability for knowing or reckless violations

### ODPC Registration
Arkova's ODPC registration: _[Pending — REG-15]_
Registration number to be inserted upon issuance.
