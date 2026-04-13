# SCC Annex — Nigeria Data Protection Act 2023

> **Parent:** `base-template.md` | **Jira:** SCRUM-573 (REG-12)

## Applicable Law
Nigeria Data Protection Act 2023 (NDPA); General Application and Implementation Directive 2025.

## Supervisory Authority
Nigeria Data Protection Commission (NDPC) — https://ndpc.gov.ng

## Cross-Border Transfer Basis
NDPA requires adequate protection or binding contractual clauses for cross-border transfers.

US does NOT have NDPC adequacy status. These SCCs serve as the binding contractual clause.

## Jurisdiction-Specific Requirements

### Data Controller/Processor Obligations
- Process data only in accordance with documented instructions
- Implement appropriate technical and organizational measures
- Ensure persons authorized to process data are under confidentiality obligations
- Assist controller in responding to data subject rights requests
- Delete or return data upon termination

### Data Subject Rights
| Right | Arkova Implementation |
|-------|----------------------|
| Right of access | Self-service data export |
| Right to rectification | Data correction request form |
| Right to erasure | Account deletion + anonymization |
| Right to data portability | JSON + human-readable export |
| Right to object | Objection via DPO contact |
| Right to restrict processing | Processing restriction request |

### Breach Notification
- Controller notification to NDPC: **72 hours** from discovery
- Processor (Arkova) to Controller: **48 hours** from discovery (per Clause 5 of base SCCs)
- Notification to data subjects: required where breach likely results in high risk

### Registration
- "Data controller of major importance": 200+ data subjects in 6 months threshold
- If threshold met: register with NDPC, appoint DPO with local expertise
- Arkova registration: _[Pending assessment — REG-23]_

### Penalties
- Administrative fines up to **NGN 10,000,000** (~$6,500 USD) or **2% of annual gross revenue** (whichever is greater)
- Criminal sanctions for persistent non-compliance
