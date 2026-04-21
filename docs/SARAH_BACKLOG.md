# Sarah's Backlog

**Last updated:** 2026-04-20
**Scope rule:** Existing Jira stories and bugs only — no new epics, no Nessie (NPH/NTF/NDD/NSS/NVI/NMT), no Gemini Golden (GME/GME2-8).

## Before you start any task

1. Read `CLAUDE.md` (top-of-file note for you, plus the full Constitution — Section 1).
2. Read `docs/BACKLOG.md` to confirm the ticket is still open and nothing has changed.
3. Read `HANDOFF.md` for current state + blockers.
4. Read the Jira ticket itself and scan its comments for context.
5. Read `agents.md` in every folder you plan to touch.
6. **Commit to a branch; open a PR; stop.** Do not merge. Do not push to `main`.

## Priority 1 — Ship-ready engineering (do these first)

| # | Jira | Title | Effort | Why it's Sarah-ready |
|---|------|-------|--------|----------------------|
| 1 | [SCRUM-481 / GEO-10](https://arkova.atlassian.net/browse/SCRUM-481) | IndexNow submission for Bing | S | Pure engineering; call IndexNow API on publish. No external deps. |
| 2 | [SCRUM-680 / INFRA-07](https://arkova.atlassian.net/browse/SCRUM-680) | Sentry — provision DSN + auth token in Vercel / Cloud Run | S | Code is already complete; needs env-var provisioning + deploy. |
| 3 | [SCRUM-474 / GEO-15](https://arkova.atlassian.net/browse/SCRUM-474) | Image alt text — product screenshots | S | Add `alt=""` to remaining hero/marketing screenshots. Ranked last in GEO sprint. |
| 4 | [SCRUM-482 / PH1-PAY-02](https://arkova.atlassian.net/browse/SCRUM-482) | Self-hosted x402 facilitator | M | Flag already enabled; needs USDC receiving address configured + facilitator deployed. |

## Priority 2 — International regulatory (docs + engineering mix, no AI)

These stories need engineering deliverables (schema, API endpoints, privacy notices) but NO AI model work. Each one already has a parent Jira epic and the research done.

| # | Jira | Title | Effort | Notes |
|---|------|-------|--------|-------|
| 5 | [SCRUM-562 / REG-01](https://arkova.atlassian.net/browse/SCRUM-562) | FERPA disclosure log table + API | M | Supabase migration + `/api/v1/disclosures` endpoint + audit event wiring. |
| 6 | [SCRUM-565 / REG-04](https://arkova.atlassian.net/browse/SCRUM-565) | FERPA requester verification workflow | M | Form + state machine + email confirmation; no AI. |
| 7 | [SCRUM-566 / REG-05](https://arkova.atlassian.net/browse/SCRUM-566) | HIPAA MFA enforcement on covered accounts | S-M | Supabase Auth factor enforcement + feature flag. |
| 8 | [SCRUM-567 / REG-06](https://arkova.atlassian.net/browse/SCRUM-567) | HIPAA session timeout | S | Idle-detection hook + toast + sign-out. Frontend-only. |
| 9 | [SCRUM-570 / REG-09](https://arkova.atlassian.net/browse/SCRUM-570) | HIPAA breach notification procedure | S | Playbook doc in `docs/compliance/hipaa/`. |
| 10 | [SCRUM-572 / REG-11](https://arkova.atlassian.net/browse/SCRUM-572) | Data subject rights workflow (shared across jurisdictions) | L | Engineered `data_subject_requests` table exists; build the ops UI for request triage. |
| 11 | [SCRUM-579 / REG-18](https://arkova.atlassian.net/browse/SCRUM-579) | Australia NDB procedure doc | S | `docs/compliance/australia/ndb.md`. |
| 12 | [SCRUM-580 / REG-19](https://arkova.atlassian.net/browse/SCRUM-580) | Data correction form — Australia APP 13 | S | Component already exists (`DataCorrectionForm`); needs jurisdiction wiring + tests extension. |
| 13 | [SCRUM-586 / REG-25](https://arkova.atlassian.net/browse/SCRUM-586) | Nigeria NDPR privacy notice | S | Template doc; model it after the Kenya notice. |
| 14 | [SCRUM-588 / REG-27](https://arkova.atlassian.net/browse/SCRUM-588) | International badges on compliance dashboard | S | UI + copy only. |
| 15 | [SCRUM-589 / REG-28](https://arkova.atlassian.net/browse/SCRUM-589) | DPO designation UI on org settings | S | Org settings form field + Supabase column + audit event. |

## Priority 3 — Dependency hardening (documentation + policy)

These stories are mostly procedural / documentation and keep us SOC 2 ready. No code risk.

| # | Jira | Title | Effort | Notes |
|---|------|-------|--------|-------|
| 16 | [SCRUM-660 / DEP-01](https://arkova.atlassian.net/browse/SCRUM-660) | Supabase disaster recovery plan + cold standby runbook | M | `docs/compliance/disaster-recovery.md` + quarterly-test calendar. |
| 17 | [SCRUM-661 / DEP-02](https://arkova.atlassian.net/browse/SCRUM-661) | Cloudflare Tunnel failover procedure | S | Runbook + secondary tunnel identity. |
| 18 | [SCRUM-662 / DEP-03](https://arkova.atlassian.net/browse/SCRUM-662) | Document missing security-critical dependencies | S | Cross-reference `package.json` vs SBOM. |
| 19 | [SCRUM-663 / DEP-04](https://arkova.atlassian.net/browse/SCRUM-663) | Upgrade Express to v5 | M | Follow Express v5 migration guide; tests for async error handling. |
| 20 | [SCRUM-664 / DEP-05](https://arkova.atlassian.net/browse/SCRUM-664) | Upgrade ESLint to v9 + Flat Config | M | Code-mod + config rewrite. |
| 21 | [SCRUM-665 / DEP-06](https://arkova.atlassian.net/browse/SCRUM-665) | Pin security-critical dependency versions | S | Pin resolutions in `package.json` for crypto/auth libs. |
| 22 | [SCRUM-667 / DEP-08](https://arkova.atlassian.net/browse/SCRUM-667) | Dependency update cadence + policy doc | S | Write the policy; link from CLAUDE.md. |
| 23 | [SCRUM-668 / DEP-09](https://arkova.atlassian.net/browse/SCRUM-668) | SBOM generation in CI | S | CycloneDX or SPDX action in `.github/workflows/`. |
| 24 | [SCRUM-669 / DEP-10](https://arkova.atlassian.net/browse/SCRUM-669) | License audit — GPL compatibility review | S | Run `license-checker`; file exceptions list. |

## Priority 4 — Dependabot bumps (framework upgrades)

These are ready for Sarah once she's comfortable with the test suite. Each one is a single-PR upgrade.

| # | Jira | Bump | Notes |
|---|------|------|-------|
| 25 | [SCRUM-684](https://arkova.atlassian.net/browse/SCRUM-684) | TypeScript 6.x | Already bumped in `/services/worker`; apply to root. |
| 26 | [SCRUM-686](https://arkova.atlassian.net/browse/SCRUM-686) | Stripe 22.x | Upgrade SDK + verify webhook tests. |
| 27 | [SCRUM-687](https://arkova.atlassian.net/browse/SCRUM-687) | Zod 4.x | Migration: `.parse()` → throws vs returns. |
| 28 | [SCRUM-689](https://arkova.atlassian.net/browse/SCRUM-689) | Vitest 4.x | Breaking: test file resolution. |
| 29 | [SCRUM-691](https://arkova.atlassian.net/browse/SCRUM-691) | ESLint 10.x | Pairs with SCRUM-664 DEP-05. |
| 30 | [SCRUM-692](https://arkova.atlassian.net/browse/SCRUM-692) | Lucide 1.x | Icon import refactor. |
| 31 | [SCRUM-693](https://arkova.atlassian.net/browse/SCRUM-693) | node-cron 4.x | Worker-only; verify cron signature unchanged. |
| 32 | [SCRUM-695](https://arkova.atlassian.net/browse/SCRUM-695) | React 19 | Biggest risk — run full E2E suite after upgrade. |

## Priority 5 — Post-launch polish

| # | Jira | Title | Effort | Notes |
|---|------|-------|--------|-------|
| 33 | [SCRUM-436 / MVP-13](https://arkova.atlassian.net/browse/SCRUM-436) | Organization logo upload | M | Storage bucket + RLS + settings form. |
| 34 | [SCRUM-437 / MVP-14](https://arkova.atlassian.net/browse/SCRUM-437) | Embeddable verification widget | L | `embed.js` already exists; make it truly one-script-tag install. |

## Not on this list (and why)

- Any Nessie work (NPH-*, NTF-*, NDD-*, NSS-*, NVI-*, NMT-*) — NVI-gated training, not Sarah's track.
- Any Gemini Golden work (GME-*, GME2-*, …, GME8-*) — AI platform track, needs Vertex access + training budget.
- KAU credential training (KAU-*) — Nessie-adjacent, tracked with NPH.
- External procurement (SCRUM-517 pentest vendor, SCRUM-522 SOC 2 auditor, SCRUM-576/577 Kenya ODPC filing, SCRUM-477/478/479 GEO marketing launches) — all blocked on external action (vendor sign, regulator filing, video production). Carson + Matthew own the unblocks.

## Working rhythm

1. Pick the top unblocked ticket in Priority 1.
2. Read the ticket + scan comments + scan linked PRs.
3. Branch: `claude/YYYY-MM-DD-<short-slug>`.
4. Write tests first (TDD MANDATE per CLAUDE.md §0).
5. Open a PR; link the Jira ticket; post a memo comment on the ticket.
6. **Stop.** Do not merge.
7. Repeat.

## When to add to this backlog

Only add items that:
- Are already filed as Jira stories or bugs, AND
- Do not touch Nessie or Gemini Golden, AND
- Have engineering deliverables that can ship in a single PR (no XL tasks that span multiple Jira tickets).

Add by editing this file, never by amending an in-flight PR.
