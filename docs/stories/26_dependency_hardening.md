# Dependency Hardening & Resilience — Story Documentation
_Created: 2026-04-09 | Status: IN PROGRESS (1/10 stories)_
_Epic: DEP (Dependency Hardening)_
_Jira Epic: SCRUM-550_
_Release: R-DEP-01 — Dependency Hardening v1 (Jira version 10053)_

---

## Overview

This epic addresses gaps identified during a comprehensive dependency audit of Arkova's production infrastructure. The audit cross-referenced the [Dependency Sheet](https://docs.google.com/spreadsheets/d/1Wy_HgmsiBhaEcxoqUPjUmeG0xYstJuW2ARXFYEGXUp4) against actual `package.json` files and production architecture to identify:

1. **Resilience gaps** — Single points of failure with no documented recovery path
2. **Missing documentation** — Security-critical dependencies absent from the dependency sheet
3. **Version debt** — EOL or significantly outdated packages accumulating risk
4. **Operational gaps** — No update cadence, silent failures, missing SBOM generation

These stories are not feature work — they are **infrastructure hardening** that directly impacts SOC 2 readiness, incident response capability, and long-term maintainability.

**Target personas:**
- Platform engineering team (Carson)
- SOC 2 auditors reviewing vendor risk management
- Incident responders during outage scenarios

---

## WORKSTREAM 1: RESILIENCE (P0)

### DEP-01: Supabase Disaster Recovery Plan & Cold Standby (SCRUM-552)
**Priority:** P0 | **Effort:** Large | **Depends on:** None
**Jira:** SCRUM-552

**As a** platform operator,
**I want** a documented and tested disaster recovery plan for Supabase,
**so that** a multi-hour Supabase outage does not result in total data loss or undefined RTO/RPO.

Supabase is a total single point of failure — auth, data, RLS, RPC all go down together. The dependency sheet acknowledges "NONE - total outage" with only managed backups + PITR as mitigation. For a system securing legal credentials on Bitcoin mainnet, this is the #1 existential risk.

#### What Exists
- Supabase managed backups + PITR (Supabase-hosted)
- No independent backup outside Supabase infrastructure
- No documented RTO/RPO targets
- No tested restore procedure

#### What's Needed
- RTO/RPO targets documented and agreed upon
- Nightly `pg_dump` to GCS bucket (independent of Supabase)
- Restore runbook with step-by-step procedure
- Quarterly restore drill scheduled
- Monitoring alert if backup job fails

#### Acceptance Criteria
- [ ] RTO and RPO targets documented in `docs/confluence/15_operational_runbook.md`
- [ ] GCS backup bucket created in `arkova1` project with 90-day retention
- [ ] Cloud Scheduler job runs nightly `pg_dump` via Cloud Run task
- [ ] Backup job sends Sentry alert on failure
- [ ] Restore runbook written with tested steps (connect to backup, verify row counts, swap connection strings)
- [ ] PITR restore tested at least once, results documented
- [ ] Dependency sheet updated: Supabase fallback changed from "NONE" to backup strategy reference

#### Implementation Tasks
- [ ] Create GCS bucket `arkova-db-backups` with lifecycle policy
- [ ] Write Cloud Run job for `pg_dump` using `SUPABASE_POOLER_URL`
- [ ] Create Cloud Scheduler trigger (daily 03:00 UTC)
- [ ] Write restore runbook in `docs/confluence/15_operational_runbook.md`
- [ ] Execute test restore, document results
- [ ] Update dependency sheet

#### Definition of Done
- Backup job running in production for 3+ consecutive days
- Restore tested and documented
- Dependency sheet updated
- Jira ticket closed with Confluence link

---

### DEP-02: Cloudflare Tunnel Failover Procedure (SCRUM-553)
**Priority:** P0 | **Effort:** Medium | **Depends on:** None
**Jira:** SCRUM-553

**As a** platform operator responding to a Cloudflare Tunnel outage,
**I want** a documented failover procedure to restore worker connectivity,
**so that** anchoring and billing are not blocked by a tunnel-specific failure.

The dependency sheet lists "direct Cloud Run URL bypass" as a fallback, but this bypasses the entire Zero Trust model. No procedure exists for what security controls to activate when using the bypass.

#### What Exists
- Cloudflare Tunnel as sole ingress (`cloudflared`)
- Cloud Run URL exists but is not secured for direct access
- No documented failover steps

#### What's Needed
- Failover runbook: exact steps to activate direct Cloud Run URL
- Security compensating controls for bypass mode (IP allowlisting, short-lived tokens)
- Rollback procedure when tunnel recovers
- Alert when tunnel health check fails

#### Acceptance Criteria
- [ ] Failover runbook in `docs/confluence/15_operational_runbook.md` with step-by-step procedure
- [ ] Cloud Run IAM policy prepared (commented/disabled) for emergency IP allowlisting
- [ ] Cron jobs have documented Cloud Run URL fallback configuration
- [ ] Tunnel health check documented (how to verify tunnel is up/down)
- [ ] Rollback steps documented (re-enable tunnel, revoke bypass access)
- [ ] Security trade-offs of bypass mode explicitly documented (what protections are lost)

#### Implementation Tasks
- [ ] Write failover runbook section in operational runbook
- [ ] Document Cloud Run IAM emergency policy
- [ ] Document cron job URL swap procedure
- [ ] Add tunnel health check to monitoring section
- [ ] Update dependency sheet: Cloudflare Tunnel fallback updated with runbook reference

#### Definition of Done
- Runbook reviewed and walkthrough completed
- Dependency sheet updated
- Jira ticket closed with Confluence link

---

## WORKSTREAM 2: DOCUMENTATION GAPS (P0)

### DEP-03: Document Missing Security-Critical Dependencies (SCRUM-554)
**Priority:** P0 | **Effort:** Small | **Depends on:** None
**Jira:** SCRUM-554

**As a** security auditor reviewing Arkova's dependency inventory,
**I want** all security-critical dependencies documented in the dependency sheet,
**so that** I can assess the full attack surface and verify audit coverage.

The dependency audit found 7 significant dependencies in `package.json` files that are absent from the dependency sheet. Several are security-critical (crypto, JWT, payment verification).

#### Missing Dependencies

| Package | Location | Category | Why It Matters |
|---------|----------|----------|----------------|
| `snarkjs` + `poseidon-lite` | Worker | ZK proofs | Crypto-critical, GPL license |
| `viem` + `x402` | Worker | USDC/Base payments | Payment verification chain |
| `jose` | Worker | JWT handling | Auth token verification |
| `pkijs` + `asn1js` | Worker | Certificate parsing | AdES signature validation |
| `cheerio` | Worker | HTML parsing | Web scraping for public records |
| `@huggingface/transformers` | Frontend | Client-side ML | On-device inference |
| `@tanstack/react-query` | Frontend | Data fetching | Core data layer |

#### Acceptance Criteria
- [ ] All 7 dependency groups added to dependency sheet with: name, version, used by, purpose, fallback, license
- [ ] `snarkjs` GPL license flagged with distribution compatibility note
- [ ] Security-critical deps (`jose`, `bitcoinjs-lib`, `tiny-secp256k1`, `pkijs`) marked as "pin recommended"
- [ ] Dependency sheet "Last Updated" date refreshed

#### Definition of Done
- Dependency sheet updated with all missing entries
- Jira ticket closed

---

## WORKSTREAM 3: VERSION CURRENCY (P1)

### DEP-04: Upgrade Express to v5 (SCRUM-555)
**Priority:** P1 | **Effort:** Medium | **Depends on:** None
**Jira:** SCRUM-555

**As a** platform engineer,
**I want** the worker to run Express 5,
**so that** we are not on an end-of-life framework with known `path-to-regexp` security issues.

Express 4 is in maintenance mode. Express 5 has been stable since late 2025 and provides better async error handling, removal of `path-to-regexp` vulnerabilities, and improved TypeScript support.

#### What Exists
- `express@^4.18.2` in `services/worker/package.json`
- `@types/express@^4.17.21` in devDependencies
- Standard Express 4 patterns throughout `services/worker/src/`

#### What's Needed
- Upgrade to `express@^5.0.0`
- Update type definitions
- Fix any breaking changes (removed `app.del()`, changed `req.query` handling, async error propagation)
- Verify all routes and middleware still function

#### Acceptance Criteria
- [ ] `express@^5.0.0` in `services/worker/package.json`
- [ ] `@types/express` updated to v5-compatible version
- [ ] All existing worker tests pass (`npm run test` in `services/worker/`)
- [ ] `typecheck` passes with no new errors
- [ ] Manual smoke test: worker starts, `/api/health` responds, webhook endpoint accepts test payload
- [ ] No regressions in anchoring, billing, or AI extraction flows

#### Implementation Tasks
- [ ] Update `express` and `@types/express` versions
- [ ] Audit all route handlers for Express 5 breaking changes
- [ ] Fix `req.query` type changes (no longer `string | string[]`)
- [ ] Verify async error handling works without explicit `next(err)` wrappers
- [ ] Run full worker test suite
- [ ] Deploy to staging, smoke test

#### Definition of Done
- All worker tests green
- `typecheck` + `lint` green
- Dependency sheet version updated
- Jira ticket closed

---

### DEP-05: Upgrade ESLint to v9 + Flat Config
**Priority:** P1 | **Effort:** Medium | **Depends on:** None | **Status:** COMPLETE
**Jira:** N/A (completed prior to Jira epic creation)

**As a** developer,
**I want** ESLint v9 with flat config and typescript-eslint v8,
**so that** we benefit from newer lint rules, better TS integration, and simpler configuration.

Current `eslint@^8.56.0` and `@typescript-eslint/*@^6.0.0` are 2+ years old. ESLint 9's flat config is simpler, and typescript-eslint v8 catches more type-aware bugs.

#### What Exists
- `eslint@^8.56.0` (frontend + worker)
- `@typescript-eslint/eslint-plugin@^6.0.0` + `@typescript-eslint/parser@^6.0.0`
- `.eslintrc` config files (legacy format)
- Custom `eslint-plugin-arkova` (file-based, in `eslint-rules/`)

#### What's Needed
- Upgrade to `eslint@^9.0.0` + `@typescript-eslint@^8.0.0`
- Migrate `.eslintrc` → `eslint.config.js` (flat config)
- Update custom `eslint-plugin-arkova` for flat config compatibility
- Fix any new lint errors surfaced by updated rules

#### Acceptance Criteria
- [ ] `eslint@^9.x` and `@typescript-eslint@^8.x` in both `package.json` files
- [ ] `eslint.config.js` (flat config) replaces `.eslintrc` files
- [ ] Custom `eslint-plugin-arkova` works with flat config
- [ ] `npm run lint` passes in both frontend and worker
- [ ] `npm run lint:copy` still functions
- [ ] No regressions in CI lint step

#### Implementation Tasks
- [ ] Upgrade eslint + typescript-eslint packages (frontend)
- [ ] Upgrade eslint + typescript-eslint packages (worker)
- [ ] Migrate frontend `.eslintrc` → `eslint.config.js`
- [ ] Migrate worker `.eslintrc` → `eslint.config.js`
- [ ] Update `eslint-plugin-arkova` for flat config
- [ ] Fix any new lint violations
- [ ] Verify `lint:copy` integration

#### Definition of Done
- All lint passes in both packages
- No new lint suppressions added
- Jira ticket closed

---

### DEP-06: Pin Security-Critical Dependency Versions (SCRUM-556)
**Priority:** P1 | **Effort:** Small | **Depends on:** DEP-03
**Jira:** SCRUM-556

**As a** security engineer,
**I want** exact version pins on crypto, auth, and payment dependencies,
**so that** a patch release with breaking changes in a crypto library cannot silently deploy.

Currently all deps use caret (`^`) ranges. For crypto/auth/payment libs, an unexpected minor version bump could introduce subtle behavioral changes that compromise security guarantees.

#### Dependencies to Pin (exact versions, no `^`)

| Package | Current | Location | Risk |
|---------|---------|----------|------|
| `jose` | `^6.2.1` | Worker | JWT verification — behavioral change = auth bypass risk |
| `bitcoinjs-lib` | `^6.1.7` | Worker | TX construction — any change affects anchoring |
| `tiny-secp256k1` | `^2.2.4` | Worker | Elliptic curve crypto — foundational |
| `stripe` | `^14.0.0` | Worker | Payment processing — API compatibility |
| `@supabase/supabase-js` | `^2.39.0` | Both | Data layer — breaking change = total outage |
| `snarkjs` | `^0.7.6` | Worker | ZK proof generation |
| `pkijs` | `^3.4.0` | Worker | Certificate validation |

#### Acceptance Criteria
- [ ] Listed packages pinned to exact versions (no `^`) in `package.json`
- [ ] `package-lock.json` regenerated
- [ ] All tests pass after pin
- [ ] Dependency sheet updated with "pinned" notation

#### Definition of Done
- Packages pinned, lock files committed
- Tests green
- Jira ticket closed

---

## WORKSTREAM 4: OPERATIONAL MATURITY (P2)

### DEP-07: Email Delivery Monitoring (SCRUM-557) (Replace Silent Failures)
**Priority:** P2 | **Effort:** Small | **Depends on:** None
**Jira:** SCRUM-557

**As a** platform operator,
**I want** email delivery failures to trigger alerts,
**so that** onboarding emails and security alerts don't silently disappear.

The dependency sheet documents Resend's fallback as "emails silently fail; core unaffected." For onboarding and credential expiry alerts, silent failure means lost users and missed compliance deadlines.

#### Acceptance Criteria
- [ ] Resend API errors logged via `pino` with `level: 'error'`
- [ ] Sentry alert fires on Resend 4xx/5xx responses
- [ ] Failed email delivery logged to `audit_events` table (event type: `email_delivery_failed`)
- [ ] Admin dashboard shows email delivery stats (sent/failed counts) — or deferred to future admin story
- [ ] Dependency sheet updated: Resend fallback changed from "silently fail" to "Sentry alert + audit log"

#### Implementation Tasks
- [ ] Wrap Resend `send()` calls with error handling + Sentry capture
- [ ] Add `email_delivery_failed` audit event type
- [ ] Log failed recipient + template name (no PII in Sentry — Constitution 1.4)
- [ ] Update dependency sheet

#### Definition of Done
- Error handling deployed
- Test verifies Sentry capture on Resend failure
- Jira ticket closed

---

### DEP-08: Dependency Update Cadence (SCRUM-558) & Policy
**Priority:** P2 | **Effort:** Small | **Depends on:** DEP-03
**Jira:** SCRUM-558

**As a** platform engineer,
**I want** a documented dependency update policy with audit dates,
**so that** we have a systematic approach to keeping deps current rather than reactive patching.

The dependency sheet captures _what_ but not _when_ or _how often_. No policy exists for audit frequency, security patch SLAs, or major version upgrade planning.

#### Acceptance Criteria
- [ ] Dependency sheet has new columns: "Last Audited" and "Update Policy"
- [ ] Update policy tiers documented:
  - Security patches: within 48 hours of CVE disclosure
  - Minor versions: reviewed monthly
  - Major versions: reviewed quarterly, planned with migration story
- [ ] `npm audit` added to CI pipeline (fail on HIGH+ severity)
- [ ] Monthly calendar reminder created for dep review
- [ ] Policy documented in `docs/confluence/01_architecture_overview.md` (or new page)

#### Definition of Done
- Dependency sheet columns added and populated
- CI `npm audit` gate active
- Policy documented
- Jira ticket closed

---

### DEP-09: SBOM Generation (SCRUM-559) in CI
**Priority:** P2 | **Effort:** Small | **Depends on:** None
**Jira:** SCRUM-559

**As a** compliance officer preparing for SOC 2 Type II,
**I want** an automatically generated Software Bill of Materials (SBOM),
**so that** we can answer customer security questionnaires and satisfy audit evidence requirements.

SOC 2 CC6.1 requires understanding of system components. An SBOM provides a machine-readable inventory of all dependencies, their versions, and licenses — critical for enterprise sales and regulatory compliance.

#### Acceptance Criteria
- [ ] CI pipeline generates CycloneDX SBOM on each main branch build
- [ ] SBOM artifact stored (GCS bucket or build artifact)
- [ ] SBOM includes both frontend and worker dependencies
- [ ] License summary generated (flag any GPL/AGPL/SSPL for review)
- [ ] `snarkjs` GPL license documented with compatibility assessment
- [ ] SBOM accessible to compliance team (shared bucket or download link)

#### Implementation Tasks
- [ ] Add `@cyclonedx/cyclonedx-npm` to CI
- [ ] Generate SBOM for both `package.json` files
- [ ] Upload to `arkova-compliance-artifacts` GCS bucket
- [ ] Add license summary extraction step
- [ ] Document in SOC 2 evidence collection (`docs/compliance/soc2-evidence.md`)

#### Definition of Done
- SBOM generating on every main build
- License audit completed
- SOC 2 evidence doc updated
- Jira ticket closed

---

### DEP-10: License Audit (SCRUM-560) — GPL Compatibility Review
**Priority:** P2 | **Effort:** Small | **Depends on:** DEP-03
**Jira:** SCRUM-560

**As a** legal/compliance stakeholder,
**I want** a review of all dependency licenses for compatibility with Arkova's distribution model,
**so that** we don't unknowingly violate open-source license terms.

`snarkjs@^0.7.6` is GPL-3.0. `poseidon-lite@^0.3.0` may have similar constraints. If Arkova distributes compiled code containing GPL dependencies, the entire codebase may need to be GPL-licensed — or the dependency must be isolated/replaced.

#### Acceptance Criteria
- [ ] Full license inventory generated for all production deps (frontend + worker)
- [ ] GPL/AGPL/SSPL dependencies identified and flagged
- [ ] `snarkjs` usage reviewed: is it server-side only (SaaS exemption) or bundled into client?
- [ ] Legal assessment documented: does SaaS usage trigger GPL copyleft obligations?
- [ ] If risk exists: mitigation plan (isolate into separate service, replace, or accept)
- [ ] Results documented in `docs/compliance/` and linked from dependency sheet

#### Definition of Done
- License inventory complete
- Legal assessment documented
- Dependency sheet updated with license column
- Jira ticket closed

---

## Release Plan: R-DEP-01 — Dependency Hardening v1

### Sprint 1 — Risk Reduction (P0)
_Target: 1 week_

| Story | Effort | Type |
|-------|--------|------|
| DEP-01: Supabase DR Plan | Large | Runbook + infra |
| DEP-02: Cloudflare Tunnel Failover | Medium | Runbook |
| DEP-03: Document Missing Dependencies | Small | Documentation |

**Sprint goal:** Eliminate undocumented risk. After this sprint, every critical dependency has a documented recovery path and all security-critical deps are inventoried.

### Sprint 2 — Version Currency (P1)
_Target: 1 week_

| Story | Effort | Type |
|-------|--------|------|
| DEP-04: Express v5 Upgrade | Medium | Code |
| DEP-05: ESLint v9 + Flat Config | Medium | Tooling |
| DEP-06: Pin Security-Critical Deps | Small | Config |

**Sprint goal:** Eliminate version debt on EOL packages and lock down crypto deps. After this sprint, no EOL frameworks in production and all security-sensitive packages are pinned.

### Sprint 3 — Operational Maturity (P2)
_Target: 1 week_

| Story | Effort | Type |
|-------|--------|------|
| DEP-07: Email Delivery Monitoring | Small | Code |
| DEP-08: Dep Update Cadence & Policy | Small | Process |
| DEP-09: SBOM Generation | Small | CI |
| DEP-10: License Audit (GPL) | Small | Compliance |

**Sprint goal:** Establish ongoing maintenance practices. After this sprint, deps have a review cadence, failures alert instead of silently dropping, and SOC 2 evidence is automated.

---

## Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Nightly pg_dump to GCS (not cross-region Supabase) | Supabase read replicas add cost + complexity; a cold pg_dump to GCS gives us independent recovery at minimal cost |
| Pin crypto deps, caret for UI deps | Crypto behavioral changes can silently break security; UI deps are lower risk and benefit from patch auto-updates |
| CycloneDX over SPDX for SBOM | CycloneDX has better npm tooling and is accepted by SOC 2 auditors |
| Express 5 over Fastify migration | Minimal migration effort vs full framework swap; preserves all existing middleware |

---

## Related Documentation

- [Dependency Sheet](https://docs.google.com/spreadsheets/d/1Wy_HgmsiBhaEcxoqUPjUmeG0xYstJuW2ARXFYEGXUp4)
- `docs/confluence/01_architecture_overview.md` — System architecture
- `docs/confluence/15_operational_runbook.md` — Operational procedures
- `docs/compliance/soc2-evidence.md` — SOC 2 evidence collection

---

## Change Log

| Date | Change |
|------|--------|
| 2026-04-09 | Initial creation — 10 stories across 4 workstreams, 3-sprint release plan |
