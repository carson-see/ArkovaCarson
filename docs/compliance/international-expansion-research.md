# International Regulatory Expansion: SE Asia & Latin America

**Date:** 2026-04-14 | **Status:** Research Complete

## Priority Tiers

### Tier 1 -- Start Now (2026)

| Country | Law | Regulator | Penalties | Transfer Mechanism | Why First |
|---------|-----|-----------|-----------|-------------------|-----------|
| **Brazil** | LGPD (2018) | ANPD | 2% revenue, cap BRL 50M (~$10M) | SCCs (mandatory Aug 2025) | Largest LatAm economy, BRL 98M+ in fines, GDPR-aligned, EU-Brazil adequacy |
| **Singapore** | PDPA (2012) | PDPC | 10% turnover or SGD 1M | Contractual + comparable standard | SE Asia financial hub, gateway to ASEAN, strong enforcement |

### Tier 2 -- Next (Late 2026 - Early 2027)

| Country | Law | Regulator | Penalties | Transfer Mechanism | Why Next |
|---------|-----|-----------|-----------|-------------------|----------|
| **Mexico** | LFPDPPP (2025 reform) | SABG | Up to ~$3.9M | Consent-based | 2nd largest LatAm, nearshoring boom, but regulatory transition |
| **Colombia** | Law 1581 (2012) | SIC | ~$650K | **US has adequacy** | Simplest compliance path, aggressive SIC enforcement |
| **Thailand** | PDPA (2019) | PDPC | THB 5M (~$140K) | SCCs / ASEAN MCCs | Escalating enforcement (THB 21.5M Aug 2025), GDPR-inspired |
| **Malaysia** | PDPA (2010, amended 2025) | PDPC | MYR 1M (~$220K) | Risk-based + SCCs | Major 2025 modernization, English-speaking market |

### Tier 3 -- Monitor (2027+)

| Country | Law | Regulator | Penalties | Notes |
|---------|-----|-----------|-----------|-------|
| **Philippines** | DPA (2012) | NPC | PHP 5M (~$90K) + criminal | Large market, mandatory registration, monitor for turnover-based fines |
| **Indonesia** | PDP Law (2022) | TBD (2026) | 2% revenue + criminal | 270M+ pop, but DPA not yet operational |
| **Chile** | Law 21,719 (2024) | New Agency | 20K UTM (~$1.4M) | Fully effective Dec 2026, Agency being established |
| **Peru** | Law 29733 (2011, updated 2025) | ANPDP | 100 UIT (~$149K) | Updated regulation positive, 48-hour breach window |

### Tier 4 -- Defer

| Country | Why Defer |
|---------|----------|
| **Argentina** | Outdated law (2000), max penalty ~$274, US lacks adequacy, reform stalled |
| **Vietnam** | Most restrictive: annual MPS inspections, national security framing, high operational risk |

## Key Details by Jurisdiction

### Brazil (LGPD) -- HIGH PRIORITY
- **Regulator:** ANPD (https://www.gov.br/anpd)
- **Registration:** No general registration. DPO details must be public.
- **Cross-border:** SCCs mandatory since Aug 2025 (must use unmodified). EU-Brazil mutual adequacy (Jan 2026).
- **Breach:** "Reasonable timeframe" (3 days for transferred data)
- **DPO:** Mandatory

### Singapore (PDPA) -- HIGH PRIORITY
- **Regulator:** PDPC (https://www.pdpc.gov.sg)
- **Registration:** DPO appointment notification mandatory (June 2025)
- **Cross-border:** Comparable standard + contractual agreements. ASEAN MCCs (Jan 2025).
- **Breach:** 3 calendar days after determining notifiable (500+ individuals or significant harm)
- **DPO:** Mandatory, must notify PDPC

### Mexico (LFPDPPP 2025) -- HIGH PRIORITY
- **Regulator:** SABG (replaced INAI March 2025)
- **Registration:** None. Records of processing required.
- **Cross-border:** Consent-based (must specify countries, recipients, purposes). Implementing regs pending.
- **Breach:** Not yet specified under reform
- **Penalties:** Up to ~$3.9M. Specialized federal courts for data protection disputes.

### Colombia -- MEDIUM-HIGH
- **Regulator:** SIC (https://www.sic.gov.co)
- **Registration:** Mandatory database registration within 2 months
- **Cross-border:** **US is on adequacy list** -- simplest path
- **Breach:** 15 business days to SIC
- **Key risk:** SIC shut down Worldcoin permanently (Oct 2025)

### Thailand -- MEDIUM
- **Regulator:** PDPC (https://www.pdpc.or.th)
- **Cross-border:** "Green Route" (adequacy) or "Safeguard Route" (SCCs aligned with ASEAN MCCs)
- **Breach:** 72 hours to PDPC
- **Enforcement:** THB 21.5M in fines in single month (Aug 2025)

### Malaysia -- MEDIUM
- **Regulator:** PDPC (https://www.pdp.gov.my)
- **Major 2025 amendments:** DPO mandatory (June 2025), breach notification mandatory, data portability
- **Cross-border:** Risk-based framework replaced whitelist (April 2025). Transfer Impact Assessments required.
- **Breach:** "Without undue delay" (fines up to MYR 250K + 2yr imprisonment)

### Philippines -- MEDIUM
- **Regulator:** NPC (https://privacy.gov.ph)
- **Registration:** Mandatory with NPC (annual renewal, changes within 10 days)
- **Cross-border:** Consent or adequate protection. NPC notification required.
- **Breach:** 72 hours to NPC + data subjects. Full report within 5 days.
- **Criminal penalties:** Up to PHP 2M + 3 years imprisonment

### Indonesia -- MEDIUM
- **Regulator:** PDP Agency (expected operational 2026)
- **Cross-border:** Adequacy, contractual safeguards, or consent. Must report transfer plans before transfer.
- **Breach:** 72 hours to data subjects
- **Penalties:** 2% revenue + criminal (4-6 years). Corporate = 10x.

## Architecture Recommendation

Group jurisdictions by transfer mechanism for efficient implementation:

1. **GDPR-aligned (SCCs):** Brazil, Chile, Thailand, Singapore
2. **US-adequate:** Colombia (simplest)
3. **Consent-based:** Mexico, Peru, Philippines
4. **Restricted:** Vietnam (defer), Indonesia (monitor)

## Implementation Roadmap

**H1 2026:** Brazil LGPD + Singapore PDPA compliance
**H2 2026:** Mexico + Colombia + Thailand
**H1 2027:** Malaysia + Philippines + Indonesia (if DPA operational)
**H2 2027:** Chile (law fully effective Dec 2026) + Peru
