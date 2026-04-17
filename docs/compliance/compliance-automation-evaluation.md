# Compliance Automation Platform Evaluation (TRUST-05)

**Date:** 2026-04-17  
**Status:** EVALUATION  
**Budget:** $12-20K/year  

## Overview

Evaluate compliance automation platforms to reduce manual evidence collection for SOC 2 Type II and ISO 27001 audits. Arkova's unique client-side processing architecture means some standard integrations (e.g., DLP monitoring) are not applicable.

## Evaluation Criteria

### Integration Requirements

| Integration | Priority | Notes |
|-------------|----------|-------|
| GitHub | P0 | Branch protection, PR reviews, code scanning |
| Supabase | P1 | Database access logs, RLS verification |
| Vercel | P1 | Deployment logs, environment variables |
| GCP Cloud Run | P1 | Worker container logs, IAM |
| Cloudflare | P2 | Tunnel config, WAF rules |
| Sentry | P2 | Error monitoring, release tracking |
| Stripe | P2 | Payment processing compliance |
| Jira/Confluence | P2 | Task tracking, documentation |

### Feature Comparison

| Feature | Vanta | Drata | Secureframe |
|---------|-------|-------|-------------|
| **SOC 2 support** | Yes | Yes | Yes |
| **ISO 27001 support** | Yes | Yes | Yes |
| **GDPR support** | Yes | Yes | Yes |
| **HIPAA support** | Yes | Yes | Yes |
| **GitHub integration** | Native | Native | Native |
| **Supabase integration** | Via PostgreSQL | Via API | Via PostgreSQL |
| **Vercel integration** | Native | Plugin | Native |
| **GCP integration** | Native | Native | Native |
| **Cloudflare integration** | Native | Plugin | Plugin |
| **Custom integrations** | API + Webhooks | API | API |
| **Policy management** | Templates + custom | Templates + custom | Templates + custom |
| **Risk assessment** | Built-in | Built-in | Built-in |
| **Vendor management** | Yes | Yes | Yes |
| **Employee onboarding** | Yes | Yes | Yes |
| **Continuous monitoring** | Yes | Yes | Yes |
| **Evidence auto-collection** | 80%+ automated | 75%+ automated | 70%+ automated |
| **Auditor collaboration** | Built-in portal | Built-in portal | Built-in portal |
| **SBOM generation** | Via integration | Via integration | Via integration |

### Pricing Comparison

| Platform | Startup Tier | Growth Tier | Enterprise Tier |
|----------|-------------|-------------|-----------------|
| **Vanta** | $12K/yr | $18K/yr | Custom |
| **Drata** | $10K/yr | $16K/yr | Custom |
| **Secureframe** | $14K/yr | $20K/yr | Custom |

### Arkova-Specific Considerations

1. **Client-side processing boundary** reduces scope of data handling monitors
2. **Supabase RLS** is a unique control that may need custom evidence collection
3. **Bitcoin anchoring** is not a standard compliance control — needs custom documentation
4. **Multi-jurisdiction** (LGPD, PDPA, LFPDPPP) requires broad international framework support
5. **Startup team size** (<10 employees) favors lower-cost solutions with templates

## Recommendation

**Vanta** is recommended for Arkova's needs based on:
- Broadest native integration coverage (GitHub, Vercel, GCP, Cloudflare all native)
- Largest auditor network for SOC 2 Type II readiness
- Strong international framework support (GDPR, ISO 27001, SOC 2)
- Competitive startup pricing ($12K/yr)
- Most mature Supabase/PostgreSQL integration

**Risks:**
- Supabase-specific RLS evidence may need custom collection scripts
- Bitcoin anchoring controls will be documented manually regardless of platform
- Cost increases as team grows beyond startup tier

## Next Steps

1. Request Vanta demo and trial access
2. Verify Supabase PostgreSQL integration depth
3. Test GitHub + Vercel + GCP connector setup
4. Map existing evidence inventory (`soc2-evidence.md`) to Vanta framework
5. Estimate time savings vs. current manual process
