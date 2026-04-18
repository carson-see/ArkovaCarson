# Trust Framework Expansion Roadmap

**Date:** 2026-04-14 | **Status:** Research Complete | **Author:** Engineering

## Current State

Arkova currently has:
- SOC 2 evidence collection in progress (`docs/compliance/soc2-evidence.md`)
- FERPA + HIPAA compliance controls (disclosure log, MFA, audit, session timeout)
- GDPR, eIDAS, Kenya DPA, Australia APP, POPIA, NDPA compliance
- RLS on all database tables, client-side document processing
- 24/24 audit findings + 9 pentest findings resolved
- Annual penetration testing

## Priority Matrix

| Priority | Certification | Est. Cost | Rationale |
|----------|--------------|-----------|-----------|
| **NOW** | SOC 2 Type II + SOC 3 | $35K-$60K | Table stakes for enterprise sales |
| **NOW** | CSA STAR Level 1 | Free | Self-assessment, high visibility on STAR Registry |
| **NOW** | Cyber liability insurance ($2-5M) | $3-7K/yr | Procurement checkbox + real protection |
| **NOW** | Annual CREST pen test | $20-35K | Already doing this; formalize cadence |
| **NOW** | EU-US Data Privacy Framework | Free | Self-certification, 2-3 weeks |
| **Next 12 mo** | ISO 27001 + 27701 | $50-100K | International trust signal, feeds everything else |
| **Next 12 mo** | CSA STAR Level 2 | $15-25K | Leverages SOC 2 Type II |
| **Next 12 mo** | Cyber Essentials Plus (UK) | $2-6.5K | Cheap UK market entry — readiness at `uk-cyber-essentials/readiness-checklist.md` (SCRUM-720) |
| **Next 12 mo** | HITRUST i1 | $55-105K | Only if healthcare vertical active |
| **Next 12 mo** | StateRAMP | $50-100K | Only if state gov education pipeline |
| **Future** | FedRAMP | $500K-2M | Post-Series B, federal pipeline required |
| **Future** | IRAP (Australia) | $35-100K | Only with Australian gov opportunity |
| **Future** | C5 (Germany) | $80-150K | Post-Series B, German market entry |
| **Skip** | ISO 27017/27018 | $8-15K ea | Low marginal value over 27001 |
| **Skip** | ENS (Spain) | $40-100K | Too niche |

## 12-Month Roadmap

### Q1 (Months 1-3): Foundations — $23K-$42K
- Complete SOC 2 Type II observation period (already underway)
- CSA STAR Level 1 self-assessment (free, 2-4 weeks)
- Cyber liability insurance $2-5M coverage (Coalition or At-Bay)
- Annual pen test with CREST-accredited firm
- EU-US Data Privacy Framework self-certification (free)

### Q2 (Months 4-6): SOC 2 Completion — $52K-$95K
- SOC 2 Type II audit (bundled with SOC 3)
- Compliance automation platform (Vanta/Drata/Secureframe, $12-20K/yr)
- Begin ISO 27001 gap analysis

### Q3 (Months 7-9): ISO Implementation — $30K-$62K
- ISO 27001 ISMS implementation (heavy SOC 2 overlap)
- ISO 27701 privacy extension (bundle with 27001)
- Cyber Essentials Plus (UK)
- CSA STAR Level 2 preparation

### Q4 (Months 10-12): Certification — $40K-$80K base
- ISO 27001 + 27701 certification audit (Stage 1 + Stage 2)
- CSA STAR Level 2 certification
- HITRUST i1 if healthcare pipeline justifies ($40-80K additional)
- StateRAMP if state gov pipeline justifies ($50-100K additional)

### 12-Month Total Investment

| Scenario | Investment | What You Get |
|----------|-----------|--------------|
| **Core (recommended)** | **$145K-$280K** | SOC 2 II + SOC 3 + ISO 27001 + 27701 + CSA STAR L1/L2 + CE+ + cyber insurance + pen test |
| **+ Healthcare** | **$185K-$360K** | Above + HITRUST i1 |
| **+ Government** | **$195K-$380K** | Above + StateRAMP |
| **Full enterprise** | **$275K-$540K** | All of the above |

## Key Strategic Insight

Arkova's **client-side processing boundary** (documents never leave the device) is a massive differentiator in trust conversations. It materially reduces attack surface and simplifies compliance scope. Auditors will note this favorably, and it may reduce audit costs since server-side document processing controls are out of scope.

## SOC 2 Type II — What's Different from Type I

| Aspect | Type I | Type II |
|--------|--------|---------|
| Observation | Point-in-time snapshot | 3-12 month monitoring period |
| Evidence | Controls are *designed* properly | Controls are *operating effectively* over time |
| Testing | Single date | Multiple points during observation window |
| Market acceptance | Acceptable for early deals | Required by mature enterprise buyers |
| Cost | $20-40K | $30-80K |

**Auditor recommendations for Arkova's stage:**
- Johanson Berenson (startup-friendly pricing)
- Prescient Assurance
- A-LIGN
- Schellman
- Avoid Big 4 at seed/Series A ($150K+ overkill)

## Trust Seals for Website

| Seal | Cost | Priority |
|------|------|----------|
| SOC 3 seal | ~$5K with SOC 2 | NOW (bundle) |
| CSA STAR Registry | Free | NOW |
| EU-US DPF badge | Free | NOW |
| TrustArc/TRUSTe | $5-15K/yr | Future |

## Cyber Insurance

- Coverage: $2-5M for $3-7K/yr
- Carriers: Coalition, At-Bay, Corvus (startup-friendly)
- Includes: breach response, business interruption, regulatory defense
- Priority: NOW (procurement requirement)
