# Incident Response Plan
_Last updated: 2026-03-17 | Story: AUDIT-16_

## Overview

This document defines Arkova's incident response procedures aligned with SOC 2 Trust Service Criteria (CC7.2–CC7.5). It covers detection, classification, escalation, response, and post-incident review for security and availability incidents.

## Scope

All Arkova production systems:
- Frontend: `arkova-carson.vercel.app` (Vercel)
- Worker: `arkova-worker-kvojbeutfa-uc.a.run.app` (GCP Cloud Run)
- Database: Supabase project `vzwyaatejekddvltxyye`
- Edge: Cloudflare Workers (reports, batch queue, AI fallback, MCP server)
- DNS/CDN: Cloudflare

## Incident Classification

| Severity | Definition | Response Time | Examples |
|----------|-----------|---------------|----------|
| **SEV-1 Critical** | Service down, data breach, or PII exposure | 15 min acknowledgment, 1 hr mitigation | Database compromised, auth bypass, PII leak |
| **SEV-2 High** | Significant degradation, security vulnerability exploited | 1 hr acknowledgment, 4 hr mitigation | Anchor processing halted, API key compromise, DDoS |
| **SEV-3 Medium** | Partial degradation, non-critical vulnerability | 4 hr acknowledgment, 24 hr mitigation | Search unavailable, AI extraction errors, elevated error rate |
| **SEV-4 Low** | Minor issue, informational | Next business day | UI rendering bug, non-critical log noise |

## Detection Sources

| Source | What It Detects | Alert Channel |
|--------|----------------|---------------|
| Sentry | Frontend/worker errors, performance regressions | Email + dashboard |
| Supabase Dashboard | Database health, connection pool, RLS violations | Dashboard |
| GCP Cloud Monitoring | Cloud Run health, request latency, container crashes | Email alerts |
| Cloudflare Analytics | DDoS, edge worker errors, WAF blocks | Dashboard + email |
| Stripe Webhooks | Payment processing failures | Webhook logs |
| `audit_events` table | Unusual access patterns, failed auth spikes | Manual review / cron alert |
| GitHub Dependabot | Vulnerable dependencies | PR + email |

## Response Procedures

### Phase 1: Detection & Triage (0–15 min)

1. **Identify** the incident from monitoring alerts or user reports
2. **Classify** severity per the table above
3. **Assign** an incident commander (IC)
4. **Create** incident channel (Slack/Discord `#incident-YYYY-MM-DD`)
5. **Notify** stakeholders per escalation matrix

### Phase 2: Containment (15 min – 1 hr)

| Scenario | Containment Action |
|----------|--------------------|
| Data breach / PII exposure | Rotate all secrets, revoke affected API keys, enable maintenance mode |
| Auth bypass | Disable affected auth flow, force re-authentication |
| API key compromise | Revoke key via `PATCH /api/v1/keys/:id`, log to `audit_events` |
| DDoS / abuse | Enable Cloudflare Under Attack Mode, tighten rate limits |
| Worker crash loop | Scale to 0, investigate logs, redeploy with fix |
| Database corruption | Enable read-only mode via Supabase, restore from point-in-time backup |

### Phase 3: Eradication & Recovery (1–24 hr)

1. **Root cause** identified and documented
2. **Fix** deployed (hotfix branch → PR → merge → deploy)
3. **Verify** fix in production (health checks, smoke tests)
4. **Restore** full service
5. **Monitor** for recurrence (24 hr watch period)

### Phase 4: Post-Incident Review (within 72 hr)

1. **Timeline** of events (detection → containment → resolution)
2. **Root cause analysis** (5 Whys)
3. **Impact assessment** (users affected, data exposure, duration)
4. **Action items** with owners and deadlines
5. **Process improvements** to prevent recurrence
6. **Document** in `docs/incidents/YYYY-MM-DD-description.md`

## Escalation Matrix

| Severity | Primary | Escalate To | Executive Notify |
|----------|---------|-------------|------------------|
| SEV-1 | On-call engineer | CTO + CEO | Within 1 hr |
| SEV-2 | On-call engineer | CTO | Within 4 hr |
| SEV-3 | Assigned engineer | Team lead | Daily standup |
| SEV-4 | Assigned engineer | — | Weekly review |

## Communication Templates

### Internal (SEV-1/2)
```
INCIDENT: [Brief description]
SEVERITY: SEV-[N]
STATUS: [Investigating | Mitigating | Resolved]
IMPACT: [What users/systems are affected]
IC: [Name]
NEXT UPDATE: [Time]
```

### External (if user-facing)
```
We are aware of an issue affecting [service]. Our team is actively
working on a resolution. We will provide updates as they become available.
Current status: [status page URL]
```

## Secret Rotation Procedures

| Secret | Location | Rotation Steps |
|--------|----------|----------------|
| `SUPABASE_SERVICE_ROLE_KEY` | GCP Secret Manager | Rotate in Supabase dashboard → update GCP secret → redeploy worker |
| `STRIPE_SECRET_KEY` | GCP Secret Manager | Rotate in Stripe dashboard → update GCP secret → redeploy worker |
| `STRIPE_WEBHOOK_SECRET` | GCP Secret Manager | Rotate in Stripe webhook settings → update GCP secret → redeploy worker |
| `API_KEY_HMAC_SECRET` | GCP Secret Manager | Rotate secret → all existing API keys become invalid (notify users first) |
| `BITCOIN_TREASURY_WIF` | GCP Secret Manager | Generate new keypair → fund new address → update secret → redeploy |
| `CRON_SECRET` | GCP Secret Manager + Cloud Scheduler | Update both locations simultaneously |

## SOC 2 Mapping

| TSC | Criteria | How Arkova Addresses |
|-----|----------|---------------------|
| CC7.2 | Monitor system components for anomalies | Sentry, GCP Monitoring, Cloudflare Analytics, audit_events table |
| CC7.3 | Evaluate detected events as incidents | Severity classification matrix above |
| CC7.4 | Respond to identified incidents | Four-phase response procedure with containment actions |
| CC7.5 | Communicate incidents | Escalation matrix + communication templates |

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-17 | AUDIT-16 | Initial creation |
