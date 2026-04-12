# SIEM Decision — SOC 2 CC7.2 Compliance

> **Version:** 1.0 | **Date:** 2026-04-12 | **Classification:** CONFIDENTIAL
> **SOC 2 Controls:** CC7.2 (Monitoring Infrastructure)
> **Jira:** SCRUM-518 | **Owner:** Matthew (decision), Carson (documentation)
> **Epic:** SCRUM-502 (Security Remediation — BIA Assessment)

---

## 1. Decision

**Current monitoring stack is sufficient for SOC 2 CC7.2 compliance.** A dedicated SIEM is not required at this stage. The combination of Sentry + Google Cloud Logging + Cloudflare analytics + Supabase audit events provides adequate monitoring and alerting capabilities for Arkova's current scale.

**Revisit trigger:** If Arkova reaches 50+ employees, processes regulated healthcare data at scale (HIPAA BAA count > 10), or a SOC 2 auditor explicitly requires SIEM capabilities.

---

## 2. SOC 2 CC7.2 Requirements

CC7.2 states: "The entity monitors system components and the operation of those components for anomalies that are indicative of malicious acts, natural disasters, and errors affecting the entity's ability to meet its objectives; anomalies are analyzed to determine whether they represent security events."

**Key requirements:**
1. Monitor system components for anomalies
2. Analyze anomalies to determine if they are security events
3. Log security-relevant events for investigation
4. Alert on events requiring response

---

## 3. Current Monitoring Stack Analysis

### 3.1 Sentry (Application Error Tracking)

| Capability | Status | CC7.2 Coverage |
|-----------|--------|---------------|
| Real-time error tracking | ACTIVE | Anomaly detection for application errors |
| Error grouping + trending | ACTIVE | Pattern analysis for recurring issues |
| Release tracking | ACTIVE | Correlate errors to deployments |
| Performance monitoring | ACTIVE | Response time anomalies |
| Alert rules | ACTIVE | Notification on error rate spikes |
| PII scrubbing | ACTIVE | No user emails/keys in events |

**What it covers:** Application-layer anomalies, crash detection, performance degradation.
**What it doesn't cover:** Infrastructure-level events, network traffic analysis, authentication anomalies.

### 3.2 Google Cloud Logging (Infrastructure Logs)

| Capability | Status | CC7.2 Coverage |
|-----------|--------|---------------|
| Cloud Run request/error logs | ACTIVE | Worker service monitoring |
| Cloud Scheduler execution logs | ACTIVE | Cron job monitoring |
| IAM audit logs (Admin Activity) | ACTIVE | Access control changes |
| IAM audit logs (Data Access) | NEEDS CONFIG | API-level data access tracking |
| Log-based alerting | PARTIAL | Some alerts configured |
| Log retention (30 days default) | ACTIVE | Investigation window |
| Log Router / sinks | AVAILABLE | Can export to BigQuery for analysis |

**What it covers:** Infrastructure events, IAM changes, service health, request logs.
**What it doesn't cover:** Application-level business logic events (covered by audit_events table).

### 3.3 Cloudflare (Network & Edge Security)

| Capability | Status | CC7.2 Coverage |
|-----------|--------|---------------|
| WAF event logging | ACTIVE | Attack detection (SQLi, XSS, etc.) |
| DDoS mitigation | ACTIVE | Availability protection |
| Bot detection | ACTIVE | Automated threat identification |
| Rate limiting analytics | ACTIVE | Abuse detection |
| Zero Trust tunnel logs | ACTIVE | Ingress monitoring |
| Security analytics dashboard | ACTIVE | Threat overview |

**What it covers:** Network-layer threats, DDoS, bot traffic, WAF events.
**What it doesn't cover:** Internal application events, database access patterns.

### 3.4 Supabase Audit Events (Application Audit Trail)

| Capability | Status | CC7.2 Coverage |
|-----------|--------|---------------|
| Append-only audit table | ACTIVE | Tamper-proof event log |
| Event categories (AUTH, ANCHOR, ADMIN, etc.) | ACTIVE | Categorized business events |
| Actor + target tracking | ACTIVE | Who did what to what |
| Immutable (trigger-protected) | ACTIVE | Cannot delete/modify events |
| PII minimization | ACTIVE | actor_id only, no emails/IPs |

**What it covers:** All business-critical operations, authentication events, admin actions.
**What it doesn't cover:** Infrastructure events (covered by Cloud Logging).

---

## 4. Gap Analysis — Current Stack vs Dedicated SIEM

| SIEM Capability | Current Stack Coverage | Gap Severity |
|----------------|----------------------|--------------|
| Log aggregation (single pane) | PARTIAL — logs split across 4 systems | LOW — manageable at current scale |
| Correlation rules | NONE — no cross-system event correlation | MEDIUM — manual correlation possible |
| Automated threat detection | PARTIAL — Cloudflare WAF + Sentry alerts | LOW — sufficient for current threat model |
| Compliance reporting | PARTIAL — manual evidence collection | LOW — compliance automation platform preferred |
| Incident investigation | AVAILABLE — each system has search/filter | LOW — adequate for startup scale |
| Log retention (1+ year) | PARTIAL — Cloud Logging 30 days, audit_events permanent | MEDIUM — extend Cloud Logging if needed |
| Real-time dashboards | PARTIAL — each system has own dashboard | LOW — manageable |

### Overall Gap Assessment: LOW-MEDIUM

The primary gap is **cross-system correlation** (e.g., linking a Cloudflare WAF event to a Cloud Logging request to a Supabase audit event). At Arkova's current scale (single-digit team, focused threat model), manual correlation is acceptable.

---

## 5. Gap Mitigations (Without SIEM)

| Gap | Mitigation | Cost | Effort |
|-----|-----------|------|--------|
| No single pane of glass | Create ops runbook with links to all 4 dashboards + common queries | $0 | 2 hours |
| No cross-system correlation | Use shared identifiers (request_id, actor_id) across systems | $0 | Already implemented |
| Limited Cloud Logging retention | Configure log sink to BigQuery for long-term storage ($5-10/mo) | $60-120/yr | 1 hour |
| No automated correlation rules | Document manual investigation playbooks per scenario type | $0 | 4 hours |
| Compliance reporting gaps | Use compliance automation platform (Vanta/Drata) for evidence collection | $5-12K/yr | Included in SOC 2 plan |

**Total mitigation cost:** ~$5-12K/yr (compliance platform, already planned for SOC 2)
**SIEM cost comparison:** $12-50K/yr for a dedicated SIEM (Datadog Security, Splunk Cloud, Elastic SIEM)

---

## 6. SIEM Options (If Needed in Future)

| Vendor | Tier | Annual Cost | Pros | Cons |
|--------|------|------------|------|------|
| **Datadog Security** | Pro | $18-36K | Excellent GCP integration, APM included | Expensive at scale |
| **Splunk Cloud** | Standard | $25-50K | Industry standard, powerful SPL | Complex, expensive |
| **Elastic SIEM** | Cloud | $12-24K | Open source core, flexible | Requires tuning expertise |
| **Google Chronicle** | Standard | $15-30K | Native GCP integration | Newer product, smaller ecosystem |
| **Cloudflare Logpush + BigQuery** | DIY | $2-5K | Already in stack, cheapest | Not a true SIEM, manual correlation |

**Recommendation if SIEM becomes required:** Cloudflare Logpush → BigQuery as Phase 1, then evaluate Datadog Security for Phase 2. This builds on existing infrastructure before adding new vendors.

---

## 7. SOC 2 Auditor Talking Points

When discussing CC7.2 with the auditor:

1. **"We monitor at 4 layers"** — application (Sentry), infrastructure (Cloud Logging), network (Cloudflare), business logic (audit_events)
2. **"All critical events are logged immutably"** — audit_events table is append-only with trigger protection
3. **"We have alerting at each layer"** — Sentry alerts, Cloud Logging alerts, Cloudflare security events
4. **"Investigation capability exists"** — each system has search/filter, shared identifiers enable cross-system correlation
5. **"We have tested our response"** — tabletop exercise completed 2026-04-12 (docs/compliance/tabletop-exercise-2026-04-12.md)

If the auditor requires consolidated logging, propose the BigQuery log sink as the immediate solution.

---

## 8. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-12 | Current stack sufficient; no dedicated SIEM | Cost/benefit: $0 + mitigations vs $12-50K/yr SIEM; adequate at current scale |
| — | Revisit at 50+ employees or HIPAA scale | SIEM becomes cost-effective when manual correlation is no longer feasible |
