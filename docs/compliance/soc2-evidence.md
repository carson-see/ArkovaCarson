# SOC 2 Evidence Collection — Arkova

> **Created:** 2026-03-23 (Session 10)
> **Purpose:** Document evidence artifacts for SOC 2 Type II readiness.
> **Scope:** Trust Service Criteria — Security, Availability, Processing Integrity, Confidentiality, Privacy.

---

## 1. CI/CD Pipeline (Change Management — CC8.1)

### Automated Testing
- **Frontend tests:** 978 unit/integration tests via Vitest (`npm test`)
- **Worker tests:** 1,120 tests via Vitest (`services/worker/npm test`)
- **RLS tests:** Dedicated Row-Level Security test suite (`npm run test:rls`)
- **E2E tests:** Playwright browser tests (`npm run test:e2e`)
- **Coverage thresholds:** 80% on critical paths via `@vitest/coverage-v8`

### CI Pipeline (`.github/workflows/ci.yml`)
| Job | Purpose | Evidence |
|-----|---------|----------|
| `secret-scan` | TruffleHog + Gitleaks — blocks commits with secrets | CI logs |
| `dependency-scan` | npm audit on root + worker (critical/high thresholds) | CI logs |
| `typecheck-lint` | TypeScript strict mode + ESLint + copy term lint | CI logs |
| `types-check` | Generated DB types match committed version | CI logs |
| `test` | Full test suite + RLS + worker coverage | CI logs + coverage reports |
| `tla-verify` | TLA+ formal verification of anchor lifecycle (TLA-02) | CI logs |
| `e2e` | Playwright E2E tests | CI logs + Playwright report artifacts |

### Deployment
- **Frontend:** Auto-deploys from `main` via Vercel (immutable deployments)
- **Worker:** Manual deploy via `gcloud run deploy` (Cloud Run, rev-tagged)
- **Edge:** Cloudflare Workers via `wrangler deploy`

---

## 2. Row-Level Security (Access Control — CC6.1, CC6.3)

### Coverage
- **All tables** have RLS enabled (`FORCE ROW LEVEL SECURITY`)
- RLS policies enforce tenant isolation at the database level
- Test suite verifies: user A cannot read user B's records

### Key Policies
| Table | Policy | Enforces |
|-------|--------|----------|
| `anchors` | `SELECT` filtered by `user_id` or `org_id` | Tenant isolation |
| `profiles` | `SELECT/UPDATE` own row only | User data isolation |
| `organizations` | Members-only access via `org_members` join | Org boundary |
| `attestations` | Creator-only access | Attestation ownership |
| `api_keys` | Owner-only via `user_id` | API key isolation |

### Evidence Artifacts
- `src/tests/rls/` — RLS test helpers (`withUser()`, `withAuth()`)
- `npm run test:rls` — executes against live Supabase instance
- CI job `test` includes RLS test step with real database

---

## 3. Audit Event Logging (Monitoring — CC7.1, CC7.2)

### Immutable Audit Trail
- `audit_events` table with RLS preventing user modification
- Events logged for: anchor creation, status changes, revocation, verification lookups
- Timestamps: Postgres `timestamptz` (UTC, server-generated)
- GDPR erasure anonymizes audit events (replaces PII with `[DELETED]`) but preserves event records

### Key Audit Events
| Event Type | Trigger | Data Captured |
|------------|---------|---------------|
| `ANCHOR_CREATED` | Document secured | fingerprint, credential_type, user_id |
| `ANCHOR_SECURED` | Chain confirmation | chain_tx_id, block_height |
| `ANCHOR_REVOKED` | Admin revocation | reason, revoker_id |
| `VERIFICATION_LOOKUP` | Public verify page | public_id, viewer context |
| `API_KEY_CREATED` | API key generated | key_prefix, user_id |
| `ATTESTATION_CREATED` | Attestation submitted | attestation_type, public_id |

---

## 4. Data Protection (Confidentiality — C1.1, Privacy — P1.1)

### Client-Side Processing Boundary (Constitution 1.6)
- Documents **never leave the user's device**
- `generateFingerprint()` runs in browser only
- Client-side OCR via PDF.js + Tesseract.js
- PII stripped before any server communication
- Gated by `ENABLE_AI_EXTRACTION` flag

### Encryption
- Data at rest: Supabase managed encryption (AES-256)
- Data in transit: TLS 1.3 (Supabase, Cloud Run, Cloudflare)
- API keys: HMAC-SHA256 hashed, raw key never persisted after creation
- Treasury keys: Server-side only, never logged (Constitution 1.4)

### PII Handling
- Sentry: `maskAllText`, `blockAllMedia`, custom `beforeSend` scrubbing
- No user emails, fingerprints, or API keys in error events
- GDPR erasure RPCs: `erase_user_pii()`, `anonymize_audit_events()`

---

## 5. Availability & Change Control

### Infrastructure
- **Frontend:** Vercel (global CDN, automatic failover)
- **Database:** Supabase (managed Postgres, daily backups)
- **Worker:** Cloud Run (auto-scaling 0-3, 1GB memory)
- **Edge:** Cloudflare Workers (global edge network)
- **Ingress:** Cloudflare Tunnel (zero trust, no public ports)

### Change Control
- All changes via pull request → review → squash merge to `main`
- CI gates: typecheck, lint, tests, secret scan, dependency scan must pass
- No direct pushes to `main` (branch protection recommended)
- Migration procedure documented in `CLAUDE.md` Section 4

### Monitoring
- Sentry error tracking (frontend + worker)
- Cloud Run logs via Google Cloud Logging
- Cloud Scheduler job monitoring (12 active jobs)

---

## 6. Formal Verification (Processing Integrity — PI1.1)

### TLA+ Model Checking
- Bitcoin anchor lifecycle formally verified via TLA PreCheck
- Model: `machines/bitcoinAnchor.machine.ts`
- States: PENDING → SUBMITTED → SECURED (with REVOKED branch)
- Invariants verified: no invalid transitions, no stuck states
- CI enforcement: `tla-verify` job runs on anchor code changes

### Credential Immutability
- `credential_type` immutable after SECURED (DB trigger, migration 0089)
- Attestation claims immutable after submission (DB trigger)
- Anchor `status = 'SECURED'` only settable by worker via `service_role`

---

## 7. Evidence Collection Checklist

| Control | Evidence Location | Status |
|---------|------------------|--------|
| CI pipeline runs | GitHub Actions logs | Automated |
| Test results | CI artifacts, coverage reports | Automated |
| RLS coverage | `npm run test:rls` output | Automated |
| Audit event logging | `audit_events` table queries | Database |
| Secret scanning | TruffleHog + Gitleaks CI logs | Automated |
| Dependency scanning | npm audit CI logs | Automated |
| Source map upload | Sentry dashboard | Needs SENTRY_AUTH_TOKEN |
| Branch protection | GitHub repo settings | Manual config |
| GDPR erasure | RPC test results | Automated |
| TLA+ verification | CI `tla-verify` logs | Automated |

---

_Document version: 2026-03-23 | 89 migrations | 978 frontend tests | 1,120 worker tests_
