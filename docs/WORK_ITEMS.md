# Arkova — Centralized Open Work Items
_Consolidated: 2026-03-27 | Source: BACKLOG.md, HANDOFF.md, CLAUDE.md, bug_log.md, sprint docs_

> **Single view of all remaining open items.** For detailed history, see `BACKLOG.md`.

---

## OPERATIONAL BLOCKERS (6 items)

| ID | Item | Status | Next Action |
|----|------|--------|-------------|
| OPS-03 | Sentry DSN env vars | PENDING | Set `VITE_SENTRY_DSN` + `SENTRY_DSN` in Vercel + Cloud Run |
| OPS-04 | Sentry source map upload | PENDING | Configure `SENTRY_AUTH_TOKEN` in CI |
| OPS-05 | GCP KMS key provisioning | DONE (2026-03; mainnet live) | `gcloud kms` key provisioned. AWS path intentionally not deployed — SCRUM-902. |
| OPS-06 | Mainnet treasury funding | PENDING | Fund `bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc` (currently ~34k sats) |
| OPS-07 | Key rotation (Stripe + service role) | PENDING | Rotate Stripe keys + Supabase service role key |
| DEPLOY | Migrations 0108-0117 + 0120 | PENDING | Apply to production Supabase |

---

## OPEN PRODUCTION BUGS (4 items)

| ID | Severity | Bug | Fix Required |
|----|----------|-----|-------------|
| BUG-PROD-002 | CRITICAL | Google OAuth disabled | Enable Google provider in Supabase Dashboard + add OAuth Client ID/Secret |
| BUG-PROD-003 | CRITICAL | Email confirmation | Verify "Enable email confirmations" ON in Supabase Auth settings |
| BUG-PROD-004 | CRITICAL | Password reset rate limited | Configure custom SMTP (SendGrid/Resend/Mailgun) in Supabase |
| TODO-01 | LOW | `Sidebar.tsx:58` — hardcoded admin check | Migrate to `profiles.is_platform_admin` flag |

---

## INCOMPLETE STORIES (12 of 192)

### Launch-Adjacent (3)
| ID | Story | Status | Blocker |
|----|-------|--------|---------|
| PH1-PAY-02 | Self-hosted x402 facilitator | PARTIAL | Needs USDC address + facilitator deploy |
| INFRA-07 | Sentry integration | PARTIAL | Code complete — needs env vars (see OPS-03/04) |
| GEO-02 | LinkedIn entity + sameAs | PARTIAL | Needs Wikidata entry (external) |

### Post-Launch Features (4)
| ID | Story | Priority |
|----|-------|----------|
| MVP-13 | Organization logo upload | LOW |
| MVP-14 | Embeddable verification widget | LOW |
| P7-TS-04 | P7 Go-Live (no scope) | TBD |
| P7-TS-06 | P7 Go-Live (no scope) | TBD |

### GEO & SEO (5 not started)
| ID | Story | Priority |
|----|-------|----------|
| GEO-08 | Content expansion — 5 core pages | HIGH |
| GEO-09 | Community & brand presence launch | MEDIUM |
| GEO-10 | IndexNow for Bing/Copilot | MEDIUM |
| GEO-11 | YouTube explainers + VideoObject schema | MEDIUM |
| GEO-04 | About page with team bios | MEDIUM |

---

## QA AUDIT — OPEN ITEMS (14 of 25)

### Infrastructure (3)
| ID | Description | Priority |
|----|-------------|----------|
| QA-PERF-1 | Redis-backed rate limiting (Upstash) | HIGH |
| QA-PERF-3 | PgBouncer connection pooling (port 6543) | MEDIUM |
| QA-PERF-6 | DB query perf monitoring (pg_stat_statements) | MEDIUM |

### Frontend (1)
| ID | Description | Priority |
|----|-------------|----------|
| QA-PERF-5 | Virtual scrolling for 500+ record lists | LOW |

### E2E Coverage Gaps (9)
| ID | Description | Priority |
|----|-------------|----------|
| QA-E2E-01 | Billing E2E suite (Stripe test mode) | HIGH |
| QA-E2E-02 | API key + verify + webhook E2E | HIGH |
| QA-E2E-03 | Member invite E2E | MEDIUM |
| QA-E2E-04 | Public search E2E | MEDIUM |
| QA-E2E-05 | Proof download E2E (PDF + JSON) | MEDIUM |
| QA-E2E-06 | Issue credential full submit E2E | MEDIUM |
| QA-E2E-07 | Seed SECURED anchors fixture | LOW |
| QA-E2E-08 | Cross-browser E2E (Firefox + Safari) | LOW |
| QA-E2E-09 | Mobile viewport E2E (375px) | LOW |

### Chaos/Resilience Testing (4)
| ID | Description | Priority |
|----|-------------|----------|
| QA-CHAOS-01 | Supabase outage simulation | MEDIUM |
| QA-CHAOS-02 | Mempool.space unavailability | MEDIUM |
| QA-CHAOS-03 | Stripe webhook duplicate delivery | LOW |
| QA-CHAOS-04 | Embedding memory pressure | LOW |

---

## GITHUB CODEQL ALERTS (20 — mostly false positives)

See GitHub Security tab for details. 9/29 fixed, 20 remaining flagged as false positives.

---

## SUMMARY

| Category | Open | Blocking Launch? |
|----------|------|:----------------:|
| Operational blockers | 6 | **YES** |
| Production bugs (Supabase config) | 3 | **YES** |
| Code TODOs | 1 | No |
| Incomplete stories (launch-adjacent) | 3 | No |
| Incomplete stories (post-launch) | 9 | No |
| QA audit items | 14 | No |
| CodeQL alerts | 20 | No (false positives) |
| **Total** | **56** | |

---

_Consolidated from: `docs/BACKLOG.md` (canonical), `HANDOFF.md`, `CLAUDE.md` §5/§8, `docs/bugs/bug_log.md`, `docs/SPRINT_2026-03-25.md`_
