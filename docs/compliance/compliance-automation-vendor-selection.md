# Compliance Automation — Vendor Selection Decision

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson
> **Jira:** SCRUM-964 (TRUST-06) | **Pairs with:** `compliance-automation-evaluation.md`
> **Decision:** **Drata** (primary); Vanta runner-up; Hyperproof not selected

---

## Purpose

`compliance-automation-evaluation.md` captured the evaluation rubric
and cost / integration matrix. This document records the **selection
decision**, the rationale, and the concrete provisioning runbook that
turns that decision into a platform wired to our 4 data sources before
SOC 2 Type II observation opens (2026-06-01, SCRUM-959).

## How to use this document

1. Read Section 3 for the selection rationale.
2. Work Section 4 top-to-bottom to provision Drata. Each step names
   the owner + artefact.
3. At the bottom (Section 7), the post-provisioning verification
   checklist confirms ≥ 80% control coverage for SOC 2 CC + A1 + C1 +
   PI1 trust service criteria.

## 1. Evaluation recap

Three vendors scored against a weighted rubric (see
`compliance-automation-evaluation.md` for full matrix):

| Vendor | Weighted score | Pricing (annual) |
|--------|----------------|------------------|
| **Drata** | 87 / 100 | $15k |
| Vanta | 84 / 100 | $14k |
| Hyperproof | 72 / 100 | $18k |

All three meet the P0 / P1 integration requirements. Tiebreakers
below.

## 2. Tiebreakers

| Factor | Drata | Vanta | Hyperproof |
|--------|-------|-------|------------|
| Supabase integration maturity | Native, 2026 Q1 GA | Via API adapter | Via API adapter |
| Cloud Run integration | Native | Native | Native |
| Auditor acceptance (major SOC 2 firms) | Excellent | Excellent | Good |
| Time-to-first-evidence | **4 hours** | 2 days | 3 days |
| Pen-test integration (TRUST-04) | Uploads retest results | Requires manual attachment | Requires manual attachment |
| Risk register module | Included | Included (paid add-on) | Included |
| UI for non-technical stakeholders | Best | Good | Good |
| Customer support response (eval period) | 1 hour median | 4 hours median | 12 hours median |

Supabase-native + fastest TTFE tipped the decision to Drata. Vanta is
a fine alternative; we'd revisit at Year-2 renewal if Drata pricing
rises > 30% YoY.

## 3. Selection: Drata

**Decision date:** 2026-04-21
**Contract target sign-date:** 2026-05-05
**Target go-live:** 2026-05-20 (10 days before SOC 2 observation window opens)
**Annual budget:** $15,000 (Year 1)

### Rationale
- Supabase native integration is the single hardest-to-replicate
  piece — saves ~40 hours of custom-webhook work.
- 4-hour TTFE means we can front-load the observation window with
  live control evidence instead of starting from zero.
- Drata's pen-test upload flow ingests the retest letter directly
  (see `pentest-execution-runbook.md` Step 8), eliminating the
  manual step that auditors flag in Type II fieldwork.

### Out of scope for Year 1
- ISO 27001 crosswalk module (deferred to Year 2 when SCRUM-965
  TRUST-08 fires).
- HITRUST content (conditional — only if healthcare-vertical
  SCRUM-982 TRUST-14 opens).

## 4. Provisioning runbook

### Step 1 — Legal review + sign (owner: Carson; deadline: 2026-05-05)

- Drata sends MSA + DPA + pricing exhibit. Review for:
  - Data-processing terms: must permit DPF mechanism (SCRUM-963).
  - Sub-processor list: confirm none are EU-US-transfer-blocked.
  - Exit terms: 30-day data portability guarantee.
- Pay annual fee: $15,000 on a net-30 invoice.

### Step 2 — Provision connectors (owner: CTO; deadline: 2026-05-12)

Four P0 / P1 connectors in order of risk (safest first):

1. **GitHub** — Drata OAuth app → read-only on org + repo metadata
   + branch-protection settings. Verify Drata does NOT request
   `repo` scope (only `metadata`).
2. **Google Workspace** — super-admin service account with
   `https://www.googleapis.com/auth/admin.directory.user.readonly`
   only. Revoke DLP-scope if Drata asks (we don't need it).
3. **Cloud Run** — GCP IAM service account
   `drata-readonly@arkova1.iam.gserviceaccount.com` with `roles/run.viewer`
   + `roles/logging.viewAccessor`. No write permissions.
4. **Supabase** — Drata-provided service role key bound to a
   read-only connection string via Supabase connection pooler.
   Verify the key cannot `UPDATE`/`DELETE` with a dry-run.

**Verify:** All four connectors show "Healthy — last sync < 1 hour ago"
in the Drata admin UI.

### Step 3 — Control mapping (owner: Carson + CTO; deadline: 2026-05-16)

- Import our SOC 2 Type II evidence matrix
  (`soc2-type2-evidence-matrix.md`) into Drata's control library.
- Map each control ID → Drata auto-evidence source:
  - CC6.1 → GitHub branch protection
  - CC6.6 → GCP IAM + Google Workspace
  - CC7.1 → GitHub Dependabot + pen-test upload
  - CC7.3 → GCP Cloud Logging
  - A1.2 → Supabase PITR status
  - … etc.
- Target: ≥ 80% of controls have at least one automated evidence
  source + remainder have a manual-evidence upload template.

### Step 4 — Policy library + tracked procedures (owner: Carson; deadline: 2026-05-18)

- Upload policy markdown files to Drata library
  (`docs/compliance/*.md` — 30 docs).
- Drata generates version-tracked policy pages with acknowledgment
  links.
- All full-time engineers sign off in the first week of observation
  (tracks CC5.3 policy-review control).

### Step 5 — Dashboard go-live (owner: Carson; deadline: 2026-05-20)

- Share the Drata compliance dashboard URL with the board.
- Configure the customer-facing Trust Report (public URL) so sales
  can link to it in RFPs.
- Confirm SOC 2 observation window is set 2026-06-01 → 2026-11-30
  (matches SCRUM-959).

## 5. Ongoing cadence (post go-live)

- **Weekly**: Drata sends the Carson + CTO a digest. Action any
  "Requires Attention" flags within 5 business days.
- **Monthly**: Export a control-coverage snapshot to
  `docs/compliance/evidence-binder/2026-Q2/drata-coverage-YYYY-MM.pdf`.
- **Quarterly**: Sync Drata control posture with the board report.
- **Annual**: Contract renewal 60 days before expiry. Revisit Vanta
  pricing at renewal.

## 6. Cost tracking

| Item | Annual |
|------|--------|
| Drata subscription | $15,000 |
| Operator time (10% of CISO role) | ~$15,000 |
| **Year-1 all-in** | **~$30,000** |

Compared against manual evidence collection (projected ~$45k of
engineer time for Type II window), net saving ~$15k Year 1.

## 7. Go-live verification checklist

- [ ] All four connectors healthy for 5 consecutive days.
- [ ] ≥ 80% of SOC 2 CC + A1 + C1 + PI1 controls show automated
  evidence.
- [ ] Public Trust Report URL accessible (preview before customer
  distribution).
- [ ] Policy library populated with all 30 compliance markdown files.
- [ ] Engineering team acknowledgment rate ≥ 95% on policy sign-off.
- [ ] SCRUM-964 transitioned to Done.

## 8. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial decision (SCRUM-964 TRUST-06). |
