# Launch Bug Register — 2026-08-10

**Author:** CTO session · **Status:** live working register for the go-live decision
**Scope:** everything found while triaging the Sekura Phase 1 assessment, reviewing PI-0/PI-0.5
readiness, and auditing the UI ahead of a paid launch.

> **Why this file exists instead of Confluence.** CLAUDE.md §0 rule 5 makes the Confluence
> "Bug Tracker — Master Log" (page 88768514) canonical. **The Atlassian connector is not available in
> a non-interactive session** — not an auth failure, the tools are absent from the manifest entirely,
> and anonymous HTTP read redirects to login. This is a standing, recurring condition, not a one-off.
> Everything below is therefore filed in **GitHub Issues** (the only durable, writable, queryable
> tracker reachable right now) and mirrored here. **Sync to Confluence from an interactive session.**
>
> Related known gap: the canonical page is already lossy — bug rows `-006`..`-011` were recorded as
> logged but are absent from its tables, and the last authenticated session could only attach a footer
> comment because the ~98K-character body only supports full-body replacement.

---

## How to read the severity column

- **P0 BLOCKER** — launching to paying customers with this open is not defensible.
- **P0/P1** — must be closed or consciously accepted with a written residual-risk note.
- **FOUNDER** — I am structurally barred from fixing it (account credentials, IAM, third-party
  provider logins). It sits with Carson.

---

## 1. The money path — three independent, confirmed, fatal failures

Any one of these alone means zero revenue. All three are live right now. **This is the launch
decision.**

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| [#2048](https://github.com/carson-see/ArkovaCarson/issues/2048) | **P0 BLOCKER · FOUNDER** | Prod Stripe **live API key is EXPIRED** | `GET /v1/account` → `api_error / api_key_expired`. Secret `stripe-secret-key` v2, created 2026-03-14, never rotated. |
| [#2049](https://github.com/carson-see/ArkovaCarson/issues/2049) | **P0 BLOCKER** | Every UI-wired paid plan has `stripe_price_id = NULL` | Prod `plans`: `individual_verified_monthly` and `individual_verified_annual` — the only two `checkoutPlanId`s in `onboardingPlans.ts:38,54` — are both NULL. `billing.ts:63` returns HTTP 400. |
| — | **P0 BLOCKER** | Checkout UI is **not routed at all** | `PricingPage.tsx` is the only caller of `startCheckout`; it has zero importers, no entry in `App.tsx`, and no `ROUTES.PRICING`. `BillingPage.tsx:129` `handleUpgrade` calls `navigate(ROUTES.BILLING)` — the page the user is already on. Fix in flight. |
| — | **P1** | No Stripe **customer portal** access | `handleManageBilling` is the same no-op; `useBilling.ts:111 openBillingPortal` has no routed caller. `BillingOverview.tsx:179,200` "Update" and "View History" have no `onClick`. Customers cannot fix a failed card or cancel. |

**Note on why CI never caught the checkout dead end:** `e2e/billing.spec.ts:183-191` is a passing test
named *"Upgrade Plan button keeps user on billing page…"* — the suite **pins the broken revenue path
as expected behavior**.

---

## 2. Security — one incident closed today, two founder-reserved

| ID | Severity | Finding | Status |
|---|---|---|---|
| — | **P0 — RESOLVED 2026-08-10** | Prod `CRON_SECRET` was the literal hardcoded in git history since 2026-03-24, never rotated (secret had only v1). Prod `/jobs/*` — including `daily-anchor-flush`, `process-revocations`, `monthly-allocation-rollover` — were reachable by anyone with repo read for ~4.5 months. | **CLOSED.** v2 added, prod moved to revision `arkova-worker-00965-4nd` to load it, old literal now **401**, v1 disabled, literal redacted from `main` in `25e1d3202`. |
| [#2054](https://github.com/carson-see/ArkovaCarson/issues/2054) | **P0 · FOUNDER** | `arkova-cli` SA has **2 downloadable JSON keys** + `secretmanager.admin` + `cloudkms.admin` → **that key file can read `BITCOIN_TREASURY_WIF`**. Compute default SA has a downloadable key + `roles/owner`. | Open. Verified live. |
| [#2055](https://github.com/carson-see/ArkovaCarson/issues/2055) | **P1 · FOUNDER** | GetBlock RPC token, CourtListener token, OpenStates key all leaked in workflow history, reachable via `git fetch --all` from 600+ refs. | Open. Provider-side rotation required. |
| [#2052](https://github.com/carson-see/ArkovaCarson/issues/2052) | **P1** | `complianceMapping.ts:74` claims **MFA is enforced**; MFA was reverted (`6d10032b4`), no `aal2` check exists. False external-status claim on a regulated surface (§1.13 R-7). | Open. |

**Audit still owed:** a review of prod audit logs for `/jobs/*` calls not originating from Cloud
Scheduler over 2026-03-26 → 2026-08-10. Not performed.

---

## 3. Core product flows

| ID | Severity | Finding |
|---|---|---|
| [#2056](https://github.com/carson-see/ArkovaCarson/issues/2056) | **P0** | **Recipient issuance + activation broken end-to-end.** (a) `createPendingRecipient` always violated `profiles_id_fkey` — prod proves it never once succeeded (30 profiles, all ACTIVE, zero `PENDING_ACTIVATION`); (b) `ActivateAccountPage.tsx:44` calls `activate_user({p_token, p_claim_key})` but prod has one overload `(p_token, p_password)` → PGRST202; (c) `activate_user` accepts `p_password` and never uses it. Issued credentials cannot be claimed. PR #2047 + fix in flight. |
| [#2050](https://github.com/carson-see/ArkovaCarson/issues/2050) | **P0** | **Anchoring is unmetered.** `ENABLE_ORG_CREDIT_ENFORCEMENT` absent from prod worker env; `orgCredits.ts:66` short-circuits to allow. Both states unlaunchable: off = unbounded BTC spend, on-cold = 402 for every org lacking an `org_credits` row. Needs backfill + rig verification first. |
| [#2051](https://github.com/carson-see/ArkovaCarson/issues/2051) | **P1** | **Webhook retry drain has no Cloud Scheduler job in prod** — failed webhooks never retry. Also absent: `materialize-proofs`. Several drain-critical jobs exist only as hand-created GCP resources, undeclared in `cloud-scheduler.sh`. |
| — | **P1** | `FAST_TRACK_ANCHOR` **debits a credit** then enqueues `anchor.fast_track`, which has **zero consumers** — the customer pays for acceleration that never happens, while the shipped `law-firm-contract` template promises "Instantly secure…". Same class: `ai_credits.reconcile_refund` also has no consumer, so a lost refund is never surfaced. Fix in flight, with a producer/consumer parity lint. |
| — | **P2** | **Proof gap:** ~6,110 STORED proofs against ~2.97M SECURED anchors. The back-catalog materializer is manual-trigger-only by design and has no scheduler job. Any customer requesting a proof outside that set fails. |

**Corrected claims** (repo docs said these were broken; live prod says otherwise — verified
2026-08-10): the DocuSign drain **is** scheduled and ENABLED in prod (`docusign-envelope-completed`,
*/5), as are `org-queue-scheduler`, `check-confirmations`, and `populate-confirmation-proofs`. The
repo IaC drift is real; the customer-facing breakage is not.

---

## 4. UI and reachability

| Severity | Finding |
|---|---|
| **P0** | **Nessie UI is live to every customer.** `ComplianceDashboardPage.tsx:760` renders `<NessieIntelligencePanel />` **unconditionally — no flag**, on a route guarded only by `AuthGuard`. It still renders confidence scores (ordered removed, SCRUM-2914) and errors out because the backend is off. `src/components/anchor/agents.md:70` **falsely claims** these surfaces are unreachable, which is why the cleanup skipped them. Fix in flight. |
| **P1** | **Internal counsel instruction rendered on the PUBLIC `/privacy` page**: *"[Counsel review required — do not assert a specific transfer mechanism until confirmed.]"* (`copy.ts:3462` → `JurisdictionPrivacyNotices.tsx:218`). Fix in flight. |
| **P1** | **Silent empty table on fetch error — 10 instances.** Worst three cause a *wrong action*: My Credentials, Secure Queue, and Documents/Attestations all render "you have nothing" when the fetch failed, prompting re-queue/re-import and double charges. Reference fix already exists at `OrgRegistryTable.tsx:134` (SCRUM-1999). |
| **P1** | **ORG_ADMIN customers cannot reach Compliance, Review Queue, or AI Reports** — the nav entry sits inside the `isPlatformAdmin` gate (`Sidebar.tsx:107`/`:371`) while the route itself is open to any authenticated user. Also `ADMIN_ISSUER_PARTNERSHIPS` (`App.tsx:329`) is missing `<PlatformAdminRoute>` while every sibling has it — an authz gap. |
| **P1** | **Password reset cannot complete** — zero `updateUser` callers in `src/`, no set-new-password route. A locked-out paying customer has no self-serve recovery. |
| **P2** | **9 routes reachable only by typing a URL**, including the org-admin onboarding wizard (`/organization/onboarding`) — new paying org admins never see onboarding — and `/compliance/scorecard`, whose only inbound link now renders on that same page. |
| **P2** | 16 orphaned components with no path from `main.tsx`, including `SessionTimeoutBanner` (a named HIPAA §164.312(a)(2)(iii) control) and `SafeLink` (a SEC-007 `javascript:` XSS guard) — both built, never adopted. |
| [#2053](https://github.com/carson-see/ArkovaCarson/issues/2053) | **P2** | `e2e/` has **neither typecheck nor lint** coverage in CI — the direct cause of the stale assertion that turned `main` red. |

---

## 5. Sekura Phase 1 — disposition

**186 findings, ZERO confirmed by proof-of-exploit.** Sekura states this themselves: their validation
stage could not reach `app.arkova.ai`, so no lead could be promoted. Severities are indicative only
and findings are not de-duplicated (186 raw → ~138 unique; one detector accounts for 26).

| Their claim | Reality |
|---|---|
| 1 CRITICAL — pickle RCE (CWE-502) | **FALSE POSITIVE.** There is zero `pickle` anywhere in the repo; both cited lines are `json.loads`/`json.load`, and there is no Python HTTP surface at all. |
| 26 × "Generic API Key" secret | **ALL FALSE POSITIVES** — public-key fingerprints, `keyId` type literals, a truncated JOSE header in a README example. |
| HIGH — bandit B310 `urlopen` | **FALSE POSITIVE** — hardcoded `https://` literal in a CI-only script. |
| HIGH — `tarfile.extractall` | **Real but not deployed** — `scripts/` is in `.dockerignore`, the prod image has no Python interpreter, and Nessie is off by standing directive. Low, latent. |
| HIGH — JWTs in localStorage | Genuine design discussion (Supabase default), not an automatic fix. |

**The two things that actually matter are gaps, not findings:**
1. **Cross-tenant isolation was a primary objective and was NOT established.**
2. **The authenticated surface is largely direct PostgREST to Supabase, which sat OUTSIDE scope** —
   our core RLS tenant boundary was never tested by them.

Our own sweep found the real issues (§2) that their assessment missed entirely.

---

## 6. Tracking-system health

- The canonical Confluence bug log is **unreachable from any non-interactive session** — a standing
  condition, not an incident. CLAUDE.md §0 rule 5 and §3 gate 4 are therefore unsatisfiable as
  written for agent sessions. Worth an amendment naming an agent-writable fallback.
- **F-9 exists nowhere discoverable.** The only trace in the entire repo is a parenthetical in
  `docs/staging/SOAK-FINDINGS-2026-08.md` saying it "is tracked separately by a concurrent bug-log
  session." Nobody reading this repo can find out what it is.
- **`docs/staging/sprint-2026-07-28-findings.md` holds 26 items explicitly never filed**, including
  HIGH-severity ones (GitHub Actions heredoc injection — since verified fixed; 83 ruff violations
  gating the PyPI publish; the `createPendingRecipient` FK defect, now confirmed and fixed here).
- **`docs/bugs/bug_log.md` is dead but not archived** — untouched since 2026-05-26, still lists ~12
  rows as OPEN. Anyone triaging from `docs/bugs/` today works a three-month-stale list. Same for
  `UAT_S35_bugs.md`.
- **The docs are stale in both directions.** Verified today: `SOAK-FINDINGS-2026-08.md` reports PRs
  #1767/#1784 as unmerged (both merged 2026-08-02) and a logger defect as open (fixed); the stats-RPC
  and SECURITY DEFINER items it lists as open are fixed and confirmed live in prod. Do not gate a
  release on any of these documents without re-verifying against running code.

---

_Verified against live prod (`vzwyaatejekddvltxyye`), live Cloud Run, live Cloud Scheduler, live
Secret Manager, and `origin/main` @ `e6a04532e` on 2026-08-10. Claims sourced from a document rather
than a live check are labelled as such._
