# SCC Annex — South Africa POPIA

> **Parent:** `base-template.md` | **Jira:** SCRUM-573 (REG-12)

## Applicable Law
Protection of Personal Information Act 4 of 2013 (POPIA); Sections 19-22, 72, 55-58.

## Supervisory Authority
Information Regulator (South Africa) — https://www.justice.gov.za/inforeg/

## Cross-Border Transfer Basis
POPIA Section 72: Transfer permitted where (a) recipient is subject to law providing adequate protection substantially similar to POPIA, or (b) binding agreement provides adequate protection.

US does NOT have Section 72 adequacy status. These SCCs serve as the binding agreement required under Section 72(1)(a)(ii).

## Jurisdiction-Specific Requirements

### Operator Obligations (Section 21)
- Process only with knowledge or authorization of the responsible party
- Treat personal information as confidential
- Establish and maintain security measures (Section 19)
- Notify the responsible party immediately of any security compromise

### Data Subject Rights (Sections 23-25)
| Right | Section | Arkova Implementation |
|-------|---------|----------------------|
| Access to personal information | 23 | Self-service data export |
| Correction or deletion | 24 | Data correction request form |
| Objection to processing | 11(3) | Objection via Information Officer |

### Special Personal Information (Section 26-33)
- Health information = special personal information requiring additional safeguards
- Processing only allowed with consent or where necessary for establishment of a right/obligation
- Arkova's client-side processing architecture provides additional protection (no server-side health data)

### Breach Notification (Section 22)
- Notification to Information Regulator and data subjects: **as soon as reasonably possible** after discovery
- Must include: nature of compromise, identity of unauthorized person (if known), steps taken

### Penalties (Section 107)
- Fine of up to **ZAR 10,000,000** (~$550,000 USD)
- Imprisonment of up to **10 years** (for knowing or reckless interference)

### Information Officer
- Must be designated per Section 55
- Contact details published in privacy notice
- Same person as DPO where feasible (REG-28)
