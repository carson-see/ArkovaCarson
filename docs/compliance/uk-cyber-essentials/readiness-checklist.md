# Cyber Essentials Plus (UK) — Readiness Checklist

> **Version:** 1.0 | **Date:** 2026-04-17 | **Classification:** INTERNAL
> **Scheme:** UK National Cyber Security Centre (NCSC) — Cyber Essentials Plus
> **Jira:** SCRUM-720 (TRUST-07) | **Owner:** Arkova Security
> **Status:** Readiness documented — awaiting external assessor engagement

---

## 1. Purpose

Cyber Essentials Plus is the UK government-backed assurance scheme that certifies an organisation against five technical controls. Plus-level requires an independent external assessor to verify the controls by hands-on vulnerability testing (credentialed scan + authenticated access tests), in contrast to the self-assessment at basic Cyber Essentials level.

Arkova targets CE+ because UK universities, NHS trusts, and UK government procurement frequently list it as a procurement precondition. Cost is modest ($2–6.5K all-in including assessor fees) and the evidence overlaps heavily with our SOC 2 controls.

---

## 2. Scope

| Item | Value |
|------|-------|
| Certification boundary | Entire production environment: worker (Cloud Run), frontend (Vercel), Supabase database, edge (Cloudflare Tunnel + Workers) |
| Device scope | Arkova-issued MacBooks (all employees); no BYOD for production access |
| User scope | All employees with access to production systems (≤ 10) |
| Cloud services in scope | Supabase, Cloudflare, Vercel, Google Cloud Run, AWS KMS, Stripe, Resend |
| Out of scope | Personal devices, contractor devices (read-only GitHub only — not in scope per NCSC cloud guidance) |

---

## 3. Five control themes — readiness

### 3.1 Firewalls (boundary + host-based)

| Requirement | Arkova status | Evidence |
|------------|---------------|----------|
| Default-deny at every internet boundary | ✅ Met | Cloudflare Tunnel — zero public ports; all ingress through Cloudflare Zero Trust |
| Change control for firewall rule changes | ✅ Met | Cloudflare access policies in Terraform (see `infra/cloudflare/`) |
| Host-based firewall on endpoints | ✅ Met | macOS Application Firewall enabled by MDM policy; verified on all devices |
| Admin interfaces restricted by IP / access policy | ✅ Met | Supabase + Cloud Run admin require Arkova SSO via Cloudflare Access |

### 3.2 Secure configuration

| Requirement | Arkova status | Evidence |
|------------|---------------|----------|
| Remove unnecessary user accounts | ✅ Met | All employees use SSO; no shared/service accounts with interactive login |
| Remove default passwords | ✅ Met | All service credentials are generated secrets stored in Google Secret Manager |
| Disable unused services | ✅ Met | Cloud Run deploys only the worker binary; no OS to harden (managed runtime) |
| Enable host-based auto-lock after idle | ✅ Met | MDM enforces 5-minute screen lock |

### 3.3 Security update management (patching)

| Requirement | Arkova status | Evidence |
|------------|---------------|----------|
| Operating system patches within 14 days of high/critical | ✅ Met | macOS auto-update enforced; Cloud Run base images are Google-managed and rebuilt weekly |
| Application patches within 14 days | ✅ Met | Dependabot PRs auto-raised, weekly triage (see `docs/compliance/dependency-update-policy.md`) |
| Unsupported OS removed from service | ✅ Met | All devices on macOS versions still receiving security updates |
| Browser auto-update enabled | ✅ Met | MDM-managed Chrome + Safari auto-update |

### 3.4 User access control

| Requirement | Arkova status | Evidence |
|------------|---------------|----------|
| Unique user accounts | ✅ Met | SSO-backed accounts per person; no shared credentials |
| MFA on internet-facing admin services | ✅ Met | Google Workspace SSO + mandatory FIDO2 security keys; Supabase admin requires SSO + hardware key |
| Separate admin vs standard accounts | ✅ Met | Elevated roles granted per-action via Supabase RBAC + GCP IAM; no always-on admin |
| User access reviewed on leaver | ✅ Met | Offboarding runbook revokes SSO, GitHub, Supabase, GCP, Cloudflare within 4 hours |

### 3.5 Malware protection

| Requirement | Arkova status | Evidence |
|------------|---------------|----------|
| Endpoint protection on all user devices | ✅ Met | Built-in XProtect + Gatekeeper (NCSC-accepted on macOS) + Jamf Protect deployed |
| Block known malicious sites | ✅ Met | Cloudflare Gateway DNS filtering on all managed devices |
| Sandboxing of untrusted code | ✅ Met | macOS app sandbox; browsers ship with per-site process isolation |

---

## 4. CE+ technical tests (what the assessor runs)

Plus certification adds four specific tests run by an accredited CE assessor against a sample of devices and cloud services:

1. **Vulnerability scan** — authenticated scan against sampled endpoints + cloud services. Remediate any high/critical within the assessor's remediation window (typically 10 business days).
2. **Malware protection test** — confirms endpoint solution detects EICAR test string and blocks execution of sample malicious files.
3. **Account separation test** — confirms standard user cannot install software or change security settings without admin credentials.
4. **Patching verification** — confirms no unpatched high/critical CVEs older than 14 days on sampled devices.

---

## 5. Pre-assessment hardening actions

- [x] Confirm Jamf Protect deployed on every Arkova-issued Mac
- [x] Dry-run EICAR detection on a sample device (log attached to this story in Jira)
- [x] Run authenticated `osquery` snapshot of installed software on all devices
- [x] Run `nuclei` + `nikto` against `api.arkova.ai` and `app.arkova.ai` internally; triage any findings ahead of assessor
- [ ] Engage accredited assessor (IASME-licensed Certification Body) — owner: security@arkova.io
- [ ] Schedule assessment within a 14-day patching window to minimise churn
- [ ] Pre-book remediation budget for any findings (typical ~$500 of engineer time)

---

## 6. Ongoing maintenance

Cyber Essentials Plus is a **12-month certification** — it must be re-assessed annually. Our maintenance cadence:

- Dependabot weekly triage (already weekly)
- Quarterly access review (see `docs/compliance/access-review-log.md`)
- Monthly malware / patching audit via Jamf reports
- Annual re-assessment scheduled 30 days before expiry
- Any change to scope (new cloud provider, new employee class) triggers a re-scope review within 14 days

---

## 7. Badge + website display

After certification the assessor issues a certificate + approved digital badge. Display locations:

- `/trust` page (footer badge)
- `/enterprise` page ("Security & Compliance" section)
- Sales collateral + RFP templates
- Email signatures for sales team

Public listing: https://registry.blockmarktech.com/ (IASME-maintained CE registry)

---

## 8. Budget

| Line item | Estimate |
|-----------|----------|
| IASME Certification Body fees | $2,000 – $4,500 (depends on org size tier) |
| Internal engineering time (pre-assessment) | $1,000 (4h) |
| Remediation buffer | $1,500 (contingency) |
| **Total** | **$4,500 – $7,000** |

---

## 9. References

- NCSC CE requirements: https://www.ncsc.gov.uk/cyberessentials/overview
- IASME assessor directory: https://iasme.co.uk/cyber-essentials/find-a-certification-body/
- Arkova SOC 2 evidence matrix: `docs/compliance/soc2-type2-evidence-matrix.md` (overlaps with CE+ controls)
- Arkova trust framework roadmap: `docs/compliance/trust-framework-roadmap.md`
