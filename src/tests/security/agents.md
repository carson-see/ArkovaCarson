# agents.md — tests/security
_Last updated: 2026-05-16_

## What This Folder Contains

CISO audit and security tier tests that statically analyze migrations, source files, and schemas for security invariants. Most tests read the baseline pg_dump (`00000000000000_baseline_at_main_HEAD.sql`) after SCRUM-1668 Path C collapsed individual migrations.

## Key Files
- `security-tier1.test.ts` — PII-01 (audit_events has no PII columns), PII-02 (anonymize RPC), INJ-01 (parameterized search), RLS-02 (api_keys access), PII-03 (retention policy)
- `rls-policy-audit.test.ts` — SEC-005: checks all tables with RLS also have `FORCE ROW LEVEL SECURITY` and validates USING/WITH CHECK clause coverage
- `service-role-audit.test.ts` — SEC-003: scans source tree for hardcoded keys, service-role imports in client code, and `supabase.auth.admin` usage
- `url-validator.test.ts` — SEC-007: validates rejection of `javascript:`, `data:`, `vbscript:` URLs
- `view-invoker-ssrf.test.ts` — SEC-009/010: retired after Path C; invariants now enforced by CI scripts
- `audit-06-payment-ledger-invoker.test.ts` — verifies payment ledger view security
- `audit-07-empty-policy-tables.test.ts` — detects tables with RLS enabled but no policies
- `audit-08-search-path-coverage.test.ts` — validates `SET search_path` on SECURITY DEFINER functions
- `dependency-versions.test.ts` / `postgres-version.test.ts` — version pinning checks

## Do / Don't Rules
- DO: Read the baseline SQL for schema assertions — individual pre-0290 migration files no longer exist
- DON'T: Skip or weaken these tests — they map directly to CISO audit findings
