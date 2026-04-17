# Cyber Liability Insurance Procurement Checklist (TRUST-02)

> **Version:** 1.0 | **Date:** 2026-04-17 | **Classification:** CONFIDENTIAL
> **Story:** TRUST-02 | **Owner:** Arkova Security Team
> **Review Cadence:** Annually (at policy renewal)
> **Cross-references:** `trust-framework-roadmap.md`, `vendor-register.md`, `incident-response-plan.md`

---

## 1. Objective

Procure cyber liability insurance with $2-5M aggregate coverage. This is a procurement checkbox for enterprise customers and provides real financial protection against breach costs, regulatory defense, and business interruption. Target premium: $3-7K/year based on Arkova's risk profile.

---

## 2. Carrier Comparison

### 2.1 Shortlisted Carriers

| Criterion | Coalition | At-Bay | Corvus |
|-----------|-----------|--------|--------|
| **Specialization** | Cyber-only, tech-forward | Cyber-only, AI-driven underwriting | Cyber-only, data-driven |
| **Target market** | Startups and SMBs | SMBs, strong SaaS focus | Mid-market, growing SMB |
| **Coverage limits** | Up to $15M | Up to $10M | Up to $10M |
| **Minimum premium** | ~$1,500/yr | ~$2,000/yr | ~$2,500/yr |
| **Est. premium ($3M)** | $3,000-5,000/yr | $3,500-5,500/yr | $4,000-6,000/yr |
| **Binding speed** | Same-day possible | 2-5 business days | 3-7 business days |
| **Proactive security** | Coalition Control (free vulnerability scanning) | At-Bay Stance (continuous monitoring) | Smart Cyber Assistant (risk alerts) |
| **Incident response** | In-house IR team | Partner IR firms | Partner IR firms |
| **Breach coach** | Included | Included | Included |
| **Retroactive date** | Full prior acts | Full prior acts | Full prior acts |
| **Regulatory defense** | Included | Included | Included |
| **Crypto/blockchain** | Generally covered | Case-by-case | Case-by-case |
| **SaaS-specific clauses** | Standard | Strong SaaS endorsement | Available |
| **Claims experience** | Excellent (public data) | Good | Good |
| **Supabase/GCP familiarity** | High (cloud-native underwriting) | High | Moderate |

### 2.2 Recommendation

**Primary: Coalition** -- Best fit for Arkova's profile due to same-day binding, free Coalition Control monitoring, strong SaaS/startup underwriting experience, and competitive premiums. Coalition's cloud-native underwriting process understands modern architectures (serverless, managed databases, edge compute).

**Alternative: At-Bay** -- Strong second choice if Coalition pricing is unfavorable. At-Bay's AI-driven underwriting may reward Arkova's strong security posture (RLS, client-side processing, formal verification) with lower premiums.

---

## 3. Required Policy Coverage

### 3.1 First-Party Coverage (Must-Have)

| Coverage | Minimum Limit | Rationale |
|----------|--------------|-----------|
| **Breach response costs** | $2M | Forensics, notification, credit monitoring, legal counsel |
| **Business interruption** | $1M | Lost revenue during outage (Cloud Run, Supabase, or Vercel down) |
| **Data restoration** | $500K | Rebuilding database, re-anchoring credentials if needed |
| **Cyber extortion/ransomware** | $1M | Ransomware defense and negotiation costs |
| **Bricking coverage** | $250K | Hardware/infrastructure replacement if compromised |
| **Reputational harm** | $500K | PR and crisis communications |
| **Fraudulent funds transfer** | $250K | Social engineering wire fraud protection |
| **PCI fines & assessments** | Excluded OK | Stripe handles PCI compliance; Arkova never touches card data |

### 3.2 Third-Party Coverage (Must-Have)

| Coverage | Minimum Limit | Rationale |
|----------|--------------|-----------|
| **Regulatory defense** | $2M | GDPR, FERPA, HIPAA, Kenya DPA, POPIA, NDPA regulatory actions |
| **Privacy liability** | $2M | Third-party claims from credential data exposure |
| **Network security liability** | $2M | Claims arising from security failure (RLS bypass, API key leak) |
| **Media liability** | $500K | Content-related claims (verification reports, attestations) |
| **Technology E&O** | $2M | Errors in credential verification, false positives/negatives |
| **Contractual liability** | Included | Enterprise customer contract claims |

### 3.3 Coverage Exclusions to Negotiate

| Exclusion | Action |
|-----------|--------|
| **Cryptocurrency exclusion** | Negotiate removal or carve-out -- Arkova uses Bitcoin OP_RETURN for timestamping only (no value transfer, no custody) |
| **Unencrypted device exclusion** | Acceptable -- FileVault/BitLocker enforced (`endpoint-security.md`) |
| **Prior known incidents** | Standard -- no known incidents to disclose |
| **War/terrorism** | Standard -- accept typical exclusion |
| **Intentional acts** | Standard -- accept |
| **Infrastructure provider outage** | Clarify scope -- Supabase/GCP/Vercel outages should trigger BI coverage |

---

## 4. Underwriting Documentation Checklist

### 4.1 Application Requirements

| Document | Status | Location |
|----------|--------|----------|
| Completed carrier application | TODO | Carrier portal |
| Annual revenue / ARR | TODO | Finance records |
| Number of employees | TODO | HR records |
| Number of records stored | Available | 1.41M+ public records, 1.41M+ SECURED anchors |
| Types of data processed | Available | `data-classification.md` |
| Industry / SIC code | Available | SaaS / Credential Verification |
| Geographic scope of operations | Available | US primary, international (Kenya, Australia, South Africa, Nigeria, EU) |

### 4.2 Security Controls (Favorable Underwriting Factors)

| Control | Status | Evidence |
|---------|--------|----------|
| Multi-factor authentication | ENABLED | Supabase Auth with MFA (HIPAA REG-05) |
| Endpoint encryption | ENABLED | FileVault on all dev machines (`endpoint-security.md`) |
| Vulnerability scanning | ENABLED | npm audit (CI), TruffleHog, Gitleaks |
| Incident response plan | DOCUMENTED | `incident-response-plan.md` |
| Disaster recovery plan | DOCUMENTED & TESTED | `disaster-recovery.md`, `dr-test-results/` |
| Penetration testing | ANNUAL | 9 findings resolved (most recent pen test complete) |
| Data encryption at rest | ENABLED | AES-256 (Supabase, GCP) |
| Data encryption in transit | ENABLED | TLS 1.2+ (all services), TLS 1.3 (Cloudflare, GCP) |
| Backup frequency | DAILY | Supabase Pro daily snapshots, continuous WAL |
| RTO / RPO documented | YES | RTO: 4 hours, RPO: 24 hours (0 for anchored data) |
| Security awareness training | DOCUMENTED | `security-training.md` |
| Vendor risk management | DOCUMENTED | `vendor-register.md` (10 vendors assessed) |
| Access control | ENFORCED | RLS on all tables, branch protection, least-privilege |
| Change management | ENFORCED | PR-required, 5 CI gates, no direct pushes to main |
| Formal verification | ENABLED | TLA+ model checking on anchor lifecycle |
| SOC 2 readiness | IN PROGRESS | `soc2-evidence.md`, `soc2-type2-decision.md` |

### 4.3 Arkova-Specific Underwriting Advantages

These factors should result in favorable underwriting terms:

| Factor | Impact on Risk |
|--------|---------------|
| **Client-side processing boundary** | Documents never leave user's device -- eliminates server-side document breach risk entirely. No document storage on Arkova servers. |
| **No raw PII in server data** | Only PII-stripped metadata + SHA-256 fingerprints transmitted. Breach of server data exposes no documents. |
| **Immutable audit trail** | Append-only `audit_events` table with RLS. Tamper-evident by design. |
| **Bitcoin anchoring** | Cryptographic proofs on Bitcoin blockchain survive total database loss. |
| **No credit card handling** | Stripe handles all payment card data. Arkova never sees card numbers. |
| **Managed infrastructure** | Supabase, GCP, Vercel, Cloudflare all SOC 2 Type II certified. No self-managed servers. |
| **Zero Trust ingress** | Cloudflare Tunnel -- no public ports, no direct server access. |
| **Row-Level Security** | Database-level tenant isolation prevents cross-tenant data access even in application-layer compromise. |

---

## 5. Procurement Timeline

| Step | Target Date | Owner | Status |
|------|------------|-------|--------|
| Identify broker or direct carrier contact | TBD | Operations | NOT STARTED |
| Complete carrier application(s) | TBD + 1 week | Operations | NOT STARTED |
| Provide security documentation package | TBD + 1 week | Engineering | READY (docs exist) |
| Receive quotes (2-3 carriers) | TBD + 2 weeks | Operations | NOT STARTED |
| Compare terms, negotiate exclusions | TBD + 3 weeks | Operations + Legal | NOT STARTED |
| Bind policy | TBD + 4 weeks | Operations | NOT STARTED |
| File certificate of insurance | TBD + 4 weeks | Operations | NOT STARTED |
| Add to vendor register | TBD + 4 weeks | Engineering | NOT STARTED |

---

## 6. Annual Renewal Checklist

- [ ] Review claims history (if any)
- [ ] Update revenue, employee count, record count
- [ ] Provide updated pen test report
- [ ] Provide updated SOC 2 report (when available)
- [ ] Review policy limits against growth (increase if ARR > $5M or records > 5M)
- [ ] Verify cryptocurrency/blockchain exclusion status
- [ ] Check regulatory defense limits against international expansion scope
- [ ] File updated certificate of insurance

---

## 7. Cost-Benefit Analysis

| Coverage Level | Est. Annual Premium | Coverage | Cost per $1M Coverage |
|----------------|-------------------|----------|----------------------|
| $2M aggregate | $3,000-4,500 | Basic -- adequate for current stage | $1,500-2,250 |
| $3M aggregate | $4,000-5,500 | **Recommended** -- covers regulatory multi-jurisdiction | $1,333-1,833 |
| $5M aggregate | $5,500-7,000 | Enterprise -- required for large customer contracts | $1,100-1,400 |

**Recommendation:** Start with $3M aggregate. Increase to $5M when enterprise pipeline requires it or when ARR exceeds $2M. The incremental cost of $5M over $3M is typically only $1,500-2,000/year -- worth it if even one enterprise deal requires it.

---

_Document version: 1.0 | 2026-04-17 | TRUST-02_
