# Arkova Disaster Recovery & Business Continuity

> **Version:** 2026-03-23 | **Classification:** CONFIDENTIAL
> **Covers:** DR-1 (RTO/RPO), DR-2 (Restore Runbook), DR-4 (Backup Strategy)

---

## 1. Recovery Objectives (DR-1)

| Metric | Target | Rationale |
|--------|--------|-----------|
| **RPO (Recovery Point Objective)** | **0 for anchored data** | Cryptographic proofs are immutable on Bitcoin — no data loss possible for anchored records |
| **RPO for user data** | **24 hours** | Supabase Pro provides daily automated backups |
| **RPO for audit events** | **24 hours** | Append-only audit trail restored from daily backup |
| **RTO (Recovery Time Objective)** | **4 hours** | Full service restoration including DB, worker, and frontend |
| **RTO for read-only verification** | **1 hour** | Public verification can run against backup while write services recover |

### Data Durability Guarantees

| Data Type | Durability | Mechanism |
|-----------|-----------|-----------|
| Bitcoin anchors | **Permanent** | OP_RETURN on Bitcoin blockchain — survives total DB loss |
| Document fingerprints | **Permanent** | SHA-256 stored on-chain; can be independently verified |
| User profiles | **24-hour RPO** | Supabase automated backups |
| Audit events | **24-hour RPO** | Daily backup + append-only (no UPDATE/DELETE) |
| AI extraction data | **Reproducible** | Can be re-extracted from original documents |

---

## 2. Backup Strategy (DR-4)

### Current Infrastructure

| Component | Provider | Backup Type | Frequency | Retention |
|-----------|----------|-------------|-----------|-----------|
| Database (PostgreSQL) | Supabase Pro | Automated point-in-time | Continuous WAL | 7 days |
| Database snapshots | Supabase Pro | Daily snapshot | Daily | 7 days |
| Frontend code | GitHub | Git repository | Every push | Permanent |
| Worker code | GitHub + GCR | Git + container images | Every deploy | 90 days |
| Environment secrets | Supabase Vault + Vercel | Encrypted at rest | N/A | N/A |

### Supabase Plan Tier

**Current: Supabase Pro** (confirmed)
- Daily automated backups with 7-day retention
- Point-in-time recovery (PITR) available via WAL
- Database size limit: 8GB (current usage ~500MB)
- Connection limit: 60 direct / unlimited via PgBouncer

### Recommended Upgrades for Production

- [ ] **Enterprise PITR**: Upgrade to Supabase Enterprise for continuous PITR with configurable retention (recommended before exceeding 100K records)
- [ ] **Cross-region replica**: Add read replica in EU for GDPR data residency compliance
- [ ] **Offsite backup**: Weekly pg_dump to encrypted S3 bucket (separate AWS account)

---

## 3. Database Restore Runbook (DR-2)

### Prerequisites

- Supabase CLI installed (`npm install -g supabase`)
- Access to Supabase dashboard (admin credentials)
- GitHub access for migration files
- Cloud Run deploy permissions

### Scenario A: Restore from Supabase Backup (Primary)

```bash
# 1. Go to Supabase Dashboard > Project > Database > Backups
# 2. Select the most recent backup before the incident
# 3. Click "Restore" — this creates a new project with restored data
# 4. Note the new project URL and keys

# 5. Verify RLS policies are intact
psql $NEW_DATABASE_URL -c "
  SELECT schemaname, tablename, policyname
  FROM pg_policies
  WHERE schemaname = 'public'
  ORDER BY tablename;
"

# 6. Verify all triggers exist
psql $NEW_DATABASE_URL -c "
  SELECT trigger_name, event_object_table
  FROM information_schema.triggers
  WHERE trigger_schema = 'public';
"

# 7. Run the full test suite against restored DB
export SUPABASE_URL=<new-project-url>
export SUPABASE_SERVICE_ROLE_KEY=<new-service-role-key>
npm run test:rls

# 8. Update environment variables in Vercel and Cloud Run
# 9. Verify /health endpoint returns healthy
# 10. Verify public verification works (test with known anchor public_id)
```

### Scenario B: Rebuild from Migrations (Nuclear Option)

```bash
# Use this only if Supabase backups are unavailable

# 1. Create new Supabase project
supabase init
supabase link --project-ref <new-project-ref>

# 2. Apply all migrations
supabase db push

# 3. Handle the SUBMITTED enum value (known issue with 0068a)
docker exec -i $(docker ps --filter "name=supabase_db" -q | head -1) \
  psql -U postgres -c "ALTER TYPE anchor_status ADD VALUE IF NOT EXISTS 'SUBMITTED';"

# 4. Run seed data
psql $DATABASE_URL < supabase/seed.sql

# 5. Re-seed platform admins
psql $DATABASE_URL -c "
  UPDATE profiles SET is_platform_admin = true
  WHERE email IN ('carson@arkova.ai', 'sarah@arkova.ai');
"

# 6. Verify: run full test suite
npm run test:coverage
npm run test:rls

# NOTE: User data, anchors, and audit events will be LOST in this scenario.
# Bitcoin-anchored data can be verified independently via chain_tx_id.
```

### Scenario C: Point-in-Time Recovery

```bash
# Available on Supabase Pro with PITR enabled

# 1. Supabase Dashboard > Database > Backups > Point in Time
# 2. Select exact timestamp (before incident)
# 3. Supabase restores to a new branch or project
# 4. Verify data integrity (same as Scenario A steps 5-10)
```

### Post-Restore Checklist

- [ ] All 28+ tables have RLS enabled (`FORCE ROW LEVEL SECURITY`)
- [ ] All triggers present (credential_type immutability, audit PII null, platform admin protection)
- [ ] Feature flags in switchboard_flags match expected values
- [ ] Platform admin flags set correctly
- [ ] `/health` endpoint returns healthy
- [ ] Public verification works for known anchor
- [ ] Worker cron jobs running (check Cloud Scheduler)
- [ ] Frontend auto-deployed from main branch

### Quarterly DR Test

Schedule quarterly DR drills:
1. Restore to staging Supabase instance
2. Run full test suite against restored DB
3. Verify RLS policies, triggers, and seed data
4. Document results in `docs/compliance/dr-test-results/`
5. Update this runbook with any findings

---

## 4. Incident Response

### Severity Levels

| Level | Definition | Response Time | Escalation |
|-------|-----------|--------------|------------|
| **SEV-1** | Data breach, total service outage | 15 minutes | Founder + legal |
| **SEV-2** | Partial outage, degraded verification | 1 hour | Engineering lead |
| **SEV-3** | Performance degradation, non-critical bug | 4 hours | On-call engineer |
| **SEV-4** | Cosmetic issue, minor UX bug | Next business day | Backlog |

### Communication

- SEV-1/2: Status page update within 30 minutes
- Post-incident review within 48 hours
- Root cause analysis documented in `docs/incidents/`
