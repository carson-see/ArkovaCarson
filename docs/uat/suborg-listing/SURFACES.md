# SCRUM-3864 — Public affiliation-listing surfaces

Inventory of every read path that could reveal a parent↔child organization
affiliation, checked against `origin/main` (head `a3d0bddb5`) in this session,
2026-09-13. "Leaking" means: an unauthenticated (`anon`) caller, or an
authenticated caller with no relationship to either organization, can learn
that org A is affiliated with org B without both `sub_org_listing_parent_optin`
AND `sub_org_listing_child_optin` being true.

## Correction to this ticket's premise

SCRUM-3864's brief states migration 0429 added the two consent columns "but
NOTHING reads them." That was true when the ticket was written, but is no
longer true: migration 0429 (`supabase/migrations/0429_suborg_tenancy_foundations.sql`,
merged via PR #2572, commit `f100fb995`/`fde7b5fbb`/`d8fadbdf7`, in the
ancestry of `origin/main`) **already replaced both public-facing RPCs** to
enforce both consent flags, added the `protect_org_tenancy_fields()` column-
authority trigger, and a TLA+ model (`machines/subOrgListingConsent.machine.ts`)
proving the consent-reset invariant. A private behaviour-proof script
(`docs/staging/hakichain-suborgs-2026-09/verify-0429.sql`) exercises 19
assertions against a real Postgres cluster and is referenced from the
migration's own `agents.md` entry.

**What was genuinely still missing** (verified by grep across `src/`,
`services/worker/src/`, `services/edge/src/` on `origin/main` before this
session's changes — zero hits for `sub_org_listing_parent_optin` /
`sub_org_listing_child_optin` outside the migration, the machine, the
verification SQL, and a soak driver script): the dashboard toggles that let
each org's admin actually set its own half of the consent, a CI-tracked
automated RLS test for the trigger, and the two flags were not surfaced on
the parent's own private sub-org list endpoint. This session adds those. No
new migration was needed — the enforcement layer this ticket asked for was
already shipped; see `PR-BODY-3864.md` for the full accounting.

## Public read surfaces (data layer)

| # | Surface | File:line | Leaking BEFORE 0429 | Leaking on `origin/main` (before this session) | After this session |
|---|---|---|---|---|---|
| 1 | `get_public_org_profile(p_org_id)` RPC — `sub_organizations` field, `anon`-granted | `supabase/migrations/0429_suborg_tenancy_foundations.sql:315-393` (children filtered `AND child.sub_org_listing_parent_optin AND child.sub_org_listing_child_optin`) | YES (see migration header, "red baseline" proof) | NO — fixed by 0429 | NO — unchanged |
| 2 | `get_org_subtree(p_root_id, p_max_depth)` RPC — full descendant tree, `anon`-granted, depth 3 | `supabase/migrations/0429_suborg_tenancy_foundations.sql:406-480` (recursive term pruned on both consents; root's own `parent_org_id` also gated, see inline `-- 0429:` comments) | YES | NO — fixed by 0429 | NO — unchanged |
| 3 | `get_public_org_profiles(p_org_id, p_limit, p_offset)` RPC — org directory listing, `anon`-granted | `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql:3767` | N/A | NO — return shape has no `parent_org_id` / sub-org field at all (id, display_name, domain, description, website_url, logo_url, founded_date, org_type, linkedin_url, twitter_url, location, industry_tag, verification_status, created_at). Confirms an org's own listing, never an affiliation edge. | NO — unchanged, out of scope |
| 4 | `search_public_issuers` / `get_public_issuer_registry` RPCs, `anon`-granted | `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql:3533,6237` | N/A | NO — return shapes (`id, legal_name, display_name, public_id, verified, credential_count` / issuer + anchor list) carry no parent/child field | NO — unchanged, out of scope |
| 5 | `GET /api/v1/org/sub-orgs` (worker) — private parent-scoped list | `services/worker/src/api/v1/orgSubOrgs.ts:663-731` | N/A (didn't return the columns) | Not public — `requireAuth` + `.eq('parent_org_id', orgId)` scopes strictly to the calling parent's own children. Not a leak, but the flags were absent from the response, so a parent admin could not see its own consent state without an extra query. | Flags added to the `select()`/response (this session) — still scoped to the caller's own org, still not public |
| 6 | `services/edge/src/mcp-tools.ts` / `mcp-tool-schemas.ts` (MCP tools) | n/a | N/A | NO — grepped for `get_org_subtree`, `get_public_org_profile`, `sub_organizations`, `parent_org` — zero hits. No MCP tool touches org affiliation at all. | NO — unchanged |
| 7 | `services/worker/src/api/v1/*` other than `orgSubOrgs.ts` (verify routes, `/api/v1/orgs*`, v2) | n/a | N/A | NO — grepped `parent_org_id` across `services/worker/src/api/v1` and `services/worker/src/api/v2`; only hits are inside `orgSubOrgs.ts` itself, `docusign-inheritance.ts` (an org's OWN parent lookup for connector inheritance, not exposed publicly), and `response-schemas.ts`'s `BANNED_RESPONSE_KEYS` (which explicitly documents `parent_org_id` as "only safe inside RPC results, not response bodies"). No `/v2/orgs` route exists yet (SUBORG-PARITY-PLAN's future work). | NO — unchanged |
| 8 | Frontend consumers of the above RPCs (`src/hooks/usePublicSearch.ts` `useOrgSubtree`/`useOrgProfile`, `src/pages/IssuerRegistryPage.tsx`) | n/a | N/A (whatever the RPC returned, rendered as-is) | NO — these render whatever the (already-filtered) RPC gives them; no independent query bypasses the RPC | NO — unchanged |
| 9 | Direct anon/authenticated `SELECT` on `organizations.parent_org_id` | RLS-gated | N/A | Not checked as a distinct row — `organizations` SELECT RLS restricts to org members / platform admins (no anon SELECT policy on the base table exists; only the two SECURITY DEFINER RPCs above are `anon`-granted). Out of scope for this ticket's "public surface" definition, unchanged either way. | NO — unchanged |

## Verdict

**Two RPCs were the only public-surface leak, and both were already closed by
migration 0429 before this session started.** Count leaking before this
session's changes: **0 of 9** surfaces inventoried (2 fixed by 0429, 7 never
leaked). Count leaking after this session: **0 of 9** (unchanged — this
session's work is additive: dashboard toggles, the private list-endpoint
field, and a CI-tracked automated test for the trigger these RPCs depend on;
no data-layer change was required or made).

## Enforcement predicate

No JS/TS `isAffiliationPubliclyListed(parent, child)` predicate was added.
There is no worker or edge code path that reads these two flags to decide
what to show a public caller — the only two surfaces that ever exposed an
affiliation (#1, #2 above) do the filtering entirely inside the SQL RPC
body (`AND child.sub_org_listing_parent_optin AND child.sub_org_listing_child_optin`,
migration 0429). Introducing a parallel JS predicate with no call site would
be dead code violating a single-rationale-per-file discipline, and would
create exactly the kind of drift risk (two places encoding "is this
affiliation public") that the original F1 finding in 0429's commit message
exists to prevent. If a future public surface needs to make this decision in
application code rather than SQL, the predicate is:
`parent.sub_org_listing_parent_optin === true && child.sub_org_listing_child_optin === true`
(both flags live on the CHILD's row; see the correction below).

## Correction to this ticket's stated toggle design

The task brief describes the toggle model as "parent sets parent_optin on
itself; child sets child_optin on itself." That is not how migration 0429
actually shapes the columns: **both `sub_org_listing_parent_optin` and
`sub_org_listing_child_optin` live on the CHILD org's row**, not one on each
party's own row. The parent's consent is a column on a row it does not own,
writable only because the affiliate-creation flow
(`buildAffiliateMembershipRows`) already makes the creating parent admin an
`org_members` `owner` of the child, and the `protect_org_tenancy_fields()`
trigger is the actual column-level authority (an admin of `parent_org_id` may
change `sub_org_listing_parent_optin`; an admin of the child who is NOT also
an admin of the parent may change `sub_org_listing_child_optin`). This
session implements the toggles against the real schema:
`useAffiliateListingConsent.setParentListingOptin(childOrgId, next)` for the
parent (updates the child's row) and the existing
`useOrganization().updateOrganization({ sub_org_listing_child_optin })` for
the child (updates its own row, both columns being on the same row it
already owns). See `src/hooks/useAffiliateListingConsent.ts` for the full
rationale.
