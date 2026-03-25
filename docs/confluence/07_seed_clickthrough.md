# Seed Data & Click-Through Guide
_Last updated: 2026-03-24 | Story: Demo Quality_

## Overview

Arkova includes seed data for local development and testing. This guide explains the demo data and how to use it for click-through testing.

## Quick Start

```bash
# Start Supabase locally
supabase start

# Reset database (applies migrations + seed)
supabase db reset

# Verify seed data (inline — see Verification Queries below)
```

## Demo Users

| Email | Password | Role | Organization |
|-------|----------|------|--------------|
| `admin@umich-demo.arkova.io` | `Demo1234!` | ORG_ADMIN | UMich Registrar |
| `registrar@umich-demo.arkova.io` | `Demo1234!` | ORG_MEMBER | UMich Registrar |
| `admin@midwest-medical.arkova.io` | `Demo1234!` | ORG_ADMIN | Midwest Medical Board |
| `individual@demo.arkova.io` | `Demo1234!` | INDIVIDUAL | None |

## Demo Organizations

| ID Prefix | Display Name | Domain | Status |
|-----------|-------------|--------|--------|
| `aaaaaaaa-...` | UMich Registrar | umich.edu | VERIFIED |
| `bbbbbbbb-...` | Midwest Medical Board | midwest-medical.org | VERIFIED |

## Demo Anchors

### UMich Registrar (ORG_A) — 5 anchors

| # | Label | Filename | Status | Legal Hold | Credential Type |
|---|-------|----------|--------|------------|-----------------|
| 1 | BS Computer Science — Maya Chen | `UMich_Diploma_Chen_Maya_BSc_CS_2024.pdf` | SECURED | No | DEGREE |
| 2 | MBA — James Okafor | `UMich_Ross_MBA_Okafor_James_Dec2023.pdf` | SECURED | **Yes** | DEGREE |
| 3 | RN License — Priya Sharma | `RN_License_Sharma_Priya_MI_2022.pdf` | REVOKED | No | LICENSE |
| 4 | PMP — Daniel Torres | `PMP_Cert_Torres_Daniel_PMI_2023.pdf` | EXPIRED | No | PROFESSIONAL |
| 5 | MS Data Science — Sarah Kim | `UMich_MSc_DataScience_Kim_Sarah_Aug2024.pdf` | PENDING | No | DEGREE |

### Midwest Medical Board (ORG_B) — 1 anchor

| # | Label | Filename | Status | Credential Type |
|---|-------|----------|--------|-----------------|
| 6 | MD License — Dr. Marcus Webb | `MD_License_Webb_Marcus_MI_Board_2025.pdf` | SECURED | LICENSE |

### Individual User (Casey Morgan) — 2 anchors

| # | Label | Filename | Status | Credential Type |
|---|-------|----------|--------|-----------------|
| 7 | Personal Certification | `CaseyMorgan_PersonalCert_2025.pdf` | PENDING | CERTIFICATE |
| 8 | Professional Development Certificate | `CaseyMorgan_ProfDev_2025.pdf` | PENDING | CERTIFICATE |

### Expected Status Distribution

| Status | Count |
|--------|-------|
| SECURED | 3 |
| PENDING | 3 |
| REVOKED | 1 |
| EXPIRED | 1 |

## Click-Through Scenarios

### Scenario 1: Organization Admin Flow

1. Sign in as `admin@umich-demo.arkova.io` / `Demo1234!`
2. View dashboard at `/dashboard` — should see 5 UMich anchors (via `anchors_select_org` RLS policy)
3. View organization details at `/settings` — should see UMich Registrar info
4. View members at `/settings/members` — should see Alex Rivera + Jordan Lee
5. Navigate to a SECURED anchor detail — should show chain receipt and QR code
6. Attempt to view Midwest Medical anchors — should be blocked (RLS)

### Scenario 2: Individual User Flow

1. Sign in as `individual@demo.arkova.io` / `Demo1234!`
2. View vault at `/vault` — should see only 2 anchors (Casey Morgan's PENDING records)
3. Both anchors should show PENDING status (amber badge)
4. Cannot see any UMich or Midwest Medical anchors (RLS isolation)

### Scenario 3: Cross-Tenant Isolation

1. Sign in as `admin@umich-demo.arkova.io`
2. Query organizations — should only see UMich Registrar
3. Sign out, sign in as `admin@midwest-medical.arkova.io`
4. Query organizations — should only see Midwest Medical Board
5. Verify anchor 6 (Dr. Marcus Webb) is visible to Midwest Medical admin only

### Scenario 4: Legal Hold

1. Anchor 2 (James Okafor MBA) has `legal_hold = true`
2. Using service_role, attempt soft delete — should fail (`anchors_legal_hold_no_delete` constraint)
3. Remove legal hold (service_role): `UPDATE anchors SET legal_hold = false WHERE id = 'a2a2a2a2-...'`
4. Attempt soft delete — should succeed

### Scenario 5: Role Immutability

1. Sign in as `individual@demo.arkova.io`
2. Attempt to change role to ORG_ADMIN — should fail (`check_role_immutability` trigger)
3. Using service_role, attempt to change role — should also fail (trigger fires regardless)

### Scenario 6: Credential Lifecycle States

1. Sign in as `admin@umich-demo.arkova.io`
2. View anchor 1 (Maya Chen) — SECURED with green badge, chain receipt present
3. View anchor 3 (Priya Sharma) — REVOKED with gray badge, revocation reason displayed
4. View anchor 4 (Daniel Torres) — EXPIRED with gray badge, expiry date past
5. View anchor 5 (Sarah Kim) — PENDING with amber badge, no chain data

### Scenario 7: Public Verification

1. Navigate to `/verify/ARK-2024-00091` — should show Maya Chen's SECURED credential
2. Navigate to `/verify/ARK-2022-00183` — should show Priya Sharma's REVOKED status
3. Navigate to `/verify/nonexistent` — should show "not found" result

## Verification Queries

Run these queries to verify seed data after `supabase db reset`:

```sql
-- Anchor status distribution
SELECT status, COUNT(*) FROM anchors GROUP BY status ORDER BY status;
-- Expected: EXPIRED=1, PENDING=3, REVOKED=1, SECURED=3

-- Organization anchor counts
SELECT o.display_name, COUNT(a.id)
FROM organizations o
LEFT JOIN anchors a ON a.org_id = o.id
GROUP BY o.display_name;
-- Expected: UMich Registrar=5, Midwest Medical Board=1

-- Individual user anchors
SELECT COUNT(*) FROM anchors WHERE user_id = '33333333-0000-0000-0000-000000000001';
-- Expected: 2

-- Legal hold
SELECT legal_hold FROM anchors WHERE id = 'a2a2a2a2-0000-0000-0000-000000000002';
-- Expected: true

-- Audit events
SELECT COUNT(*) FROM audit_events;
-- Expected: 13

-- Memberships
SELECT p.full_name, m.role, o.display_name
FROM memberships m
JOIN profiles p ON m.user_id = p.id
JOIN organizations o ON m.org_id = o.id;
-- Expected: Alex Rivera (ORG_ADMIN, UMich), Jordan Lee (ORG_MEMBER, UMich),
--           Dr. Renata Kowalski (ORG_ADMIN, Midwest Medical)

-- Switchboard flags (re-seeded after TRUNCATE CASCADE)
SELECT id, value FROM switchboard_flags ORDER BY id;
-- Expected: 10+ flags (includes ENABLE_X402_PAYMENTS and other feature gates)
```

## Reset Procedure

```bash
# Full reset (drops and recreates)
supabase db reset

# This will:
# 1. Drop all tables
# 2. Run all 109 migrations in order (0001-0109, 0033+0078 skipped)
# 3. Run seed.sql (truncates + re-inserts demo data)
# 4. Re-seeds switchboard flags (cleared by TRUNCATE CASCADE)
# 5. Post-reset: manually apply ALTER TYPE for SUBMITTED status (see CLAUDE.md §4)
```

## Extending Seed Data

To add more seed data:

1. Edit `supabase/seed.sql`
2. Follow existing patterns (fixed UUIDs, ARK-YYYY-NNNNN public IDs)
3. Use consistent UUIDs (for reproducibility)
4. Remember: `auto_create_anchoring_job` trigger fires on insert — clean up stale jobs for non-PENDING anchors
5. Run `supabase db reset` to apply

## Troubleshooting

### Auth Issues

If demo users can't authenticate:

```bash
# Check auth.users table
supabase db execute -c "SELECT id, email FROM auth.users;"

# Verify 4 users exist with correct emails
```

### Missing Seed Data

```bash
# Check if seed ran
supabase db execute -c "SELECT COUNT(*) FROM organizations;"

# If 0, seed may have failed - check logs
supabase db reset --debug
```

### RLS Blocking Queries

```bash
# Use service_role to bypass RLS for debugging
export PGPASSWORD=postgres
psql -h localhost -p 54322 -U postgres -d postgres -c "SELECT * FROM anchors;"
```

## Current Seed Summary

| Entity | Count | Notes |
|--------|-------|-------|
| Plans | 4 | free, individual, professional, organization |
| Switchboard flags | 10+ | Includes `ENABLE_X402_PAYMENTS`, `ENABLE_AI_EXTRACTION`, `ENABLE_VERIFICATION_API`, etc. |
| Platform admins | 2 | `admin@umich-demo.arkova.io`, `admin@midwest-medical.arkova.io` |
| Demo anchors | 11 | 8 original + 3 attestation demo anchors (migration 0105) |
| Demo organizations | 2 | UMich Registrar, Midwest Medical Board |

## Related Documentation

- [02_data_model.md](./02_data_model.md) — Table definitions
- [03_security_rls.md](./03_security_rls.md) — RLS policies tested by click-through scenarios

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-10 | Audit session 3 | Full rewrite: fixed "Ralph" branding, updated demo users/orgs/anchors to match current seed.sql (4 users, 2 orgs, 8 anchors with credential_type and metadata). Removed reference to nonexistent `scripts/verify-seed.sql`. Added credential lifecycle and public verification scenarios. |
| 2026-03-24 | Doc refresh | Updated migration count (48 → 109). Updated switchboard flags count (5 → 10+, includes ENABLE_X402_PAYMENTS). Noted 4 plans, 2 platform admins, 11 demo anchors in current seed. Added post-reset step note. |
