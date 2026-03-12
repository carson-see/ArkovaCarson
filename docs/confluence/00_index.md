# Arkova Documentation Index
_Last updated: 2026-03-12_

## Reading Guide

This directory contains 15 architecture and design documents for the Arkova platform. They are numbered for easy reference but should be read in the order that matches your task.

### Suggested Reading Order

**New to the project? Start here:**
1. **00** (this file) — Overview, test accounts, reading order
2. **01** — System architecture and tech stack
3. **02** — Complete data model (20 tables, all enums)
4. **03** — Security and RLS policies

**Working on a specific area? Jump to:**
- Anchoring: 06 → 10 → 11 → 14 (KMS ops)
- Billing: 08 → 09
- Verification: 11 → 06
- Identity/Auth: 12 → 03
- Feature flags: 13

---

## Document Catalog

| # | File | Description |
|---|------|-------------|
| 00 | `00_index.md` | This file — reading guide, test accounts, document catalog |
| 01 | `01_architecture_overview.md` | System architecture, tech stack, deployment topology, Constitution summary |
| 02 | `02_data_model.md` | Complete database schema — 20 tables, 6 enums, all columns, constraints, triggers, ER diagram |
| 03 | `03_security_rls.md` | Row Level Security policies, FORCE RLS, privileged field protection |
| 04 | `04_audit_events.md` | Append-only audit trail design, immutability triggers, event categories |
| 05 | `05_retention_legal_hold.md` | Legal hold mechanics, retention policies, soft delete behavior |
| 06 | `06_on_chain_policy.md` | On-chain content guardrails, allowed/forbidden fields, rate limiting |
| 07 | `07_seed_clickthrough.md` | Demo seed data walkthrough and verification steps |
| 08 | `08_payments_entitlements.md` | Stripe integration, subscription tiers, billing schema (plans/subscriptions/entitlements/billing_events) |
| 09 | `09_webhooks.md` | Inbound Stripe webhooks, outbound customer webhooks, delivery engine, webhook_endpoints/webhook_delivery_logs schema |
| 10 | `10_anchoring_worker.md` | Worker service architecture, job processing, chain client interface, directory structure |
| 11 | `11_proof_packages.md` | Proof downloads (PDF + JSON both working, ~~CRIT-5~~ FIXED, ZIP planned), public verification |
| 12 | `12_identity_access.md` | Identity verification, access control, role assignment |
| 13 | `13_switchboard.md` | Feature flags (switchboard_flags), flag history, get_flag() function |
| 14 | `14_kms_operations.md` | AWS KMS key provisioning, IAM policy, key rotation, disaster recovery for mainnet treasury signing |

### Audit Documents

| File | Description |
|------|-------------|
| `docs/audit/2026-03-12_full_audit.md` | Full 7-deliverable MVP audit: backlog vs codebase, UI/UX review, gap analysis, 14 launch gap stories |
| `docs/stories/11_mvp_launch_gaps.md` | 14 MVP launch gap stories (MVP-01 through MVP-14) identified during audit |

---

## Test Accounts (Seed Data)

These accounts are created by `supabase/seed.sql` and available after `supabase db reset`.

| Email | Password | Role | Org | Use For |
|-------|----------|------|-----|---------|
| `admin_demo@arkova.local` | `demo_password_123` | ORG_ADMIN | Arkova | Org admin flows, credential issuance, member management, webhook config |
| `user_demo@arkova.local` | `demo_password_123` | INDIVIDUAL | None | Individual user flows, personal anchoring, vault dashboard |
| `beta_admin@betacorp.local` | `demo_password_123` | ORG_ADMIN | Beta Corp | Cross-org isolation testing, RLS verification |

### Quick Start

```bash
# Reset to seed data
npx supabase db reset

# Start local Supabase
npx supabase start

# Start frontend
npm run dev

# Login at http://localhost:5173 with any account above
```

---

## Companion Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Engineering directive — rules, file placement, story status, execution order |
| `MEMORY.md` | Living state — decisions, blockers, sprint context, handoff notes |
| `agents.md` (per folder) | Folder-specific context, do/don't rules, recent changes |

---

## Document Standards

- Every doc includes a `_Last updated_` line with date and story ID
- Schema docs reference specific migration numbers
- Implementation status tables distinguish Complete / Partial / Not Started
- Change logs at the bottom track audit history
- Cross-references use relative markdown links (e.g., `[02_data_model.md](./02_data_model.md)`)
