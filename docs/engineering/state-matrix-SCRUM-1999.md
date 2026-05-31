# State Matrix — Empty / Loading / Error / Permission (SCRUM-1999)

> **Status of this file:** internal engineering note (CLAUDE.md §0.4). The canonical
> documentation for SCRUM-1999 lives in Confluence ([space A](https://arkova.atlassian.net/wiki/spaces/A)).
> This note is the working artifact: it enumerates the core list/table/detail
> surfaces against the four states, marks current handling, and records which gaps
> were fixed in this PR vs. deferred (locked under concurrent PRs).
>
> Epic: GA-S2 / E3 (SCRUM-2012). Story: [SCRUM-1999](https://arkova.atlassian.net/browse/SCRUM-1999).

## The four states

Every core surface that renders server data should explicitly handle all four,
rather than rendering blank, stuck, or a misleading empty state:

| State | Definition | Anti-pattern it prevents |
|---|---|---|
| **Loading** | Fetch in flight | Blank flash / layout shift |
| **Empty** | Fetch succeeded, zero rows | "Is it broken or just empty?" ambiguity |
| **Error** | Fetch failed (network / 5xx / unexpected) | Silent fall-through to the empty state, hiding outages |
| **Permission** | Caller is not authorized (RLS / role / entitlement) | A blank page that looks like an error, or a misleading empty state |

The cardinal sin this story targets: a fetch failure handled only by `console.error`,
leaving the surface showing its **empty** state. To an operator the table looks
empty-but-fine while the backend is actually down or the row is RLS-denied.

## Detection conventions (reused, not invented)

- **Permission (Supabase/PostgREST):** `code === '42501' || code === 'insufficient_privilege' || message.includes('insufficient_privilege') || message.includes('permission')`. This mirrors `src/hooks/useRevokeAnchor.ts` so behaviour is consistent app-wide.
- **Not-found (single row):** `code === 'PGRST116'` (see `src/hooks/useAnchor.ts`).
- **Recoverable data-fetch error banner (admin):** `src/components/DataErrorBanner.tsx` (amber, retry button) — the canonical shape for recoverable admin-dashboard fetch failures.
- **Empty state (friendly):** `src/components/dashboard/EmptyState.tsx`.

## Matrix

Legend: ✓ handled · ✗ gap · — n/a · **(fixed)** addressed in this PR · *(locked)* owned by a surface frozen under a concurrent PR — documented, not touched here.

| Surface | File | Loading | Empty | Error | Permission |
|---|---|---|---|---|---|
| **Org registry table** | `src/components/organization/OrgRegistryTable.tsx` | ✓ skeleton (mobile + desktop) | ✓ "No records found" | ✗→✓ **(fixed)** explicit "Couldn't load records" + Retry | ✗→✓ **(fixed)** "You don't have access to these records" (no retry) |
| **Reports list** | `src/components/reports/ReportsList.tsx` | ✓ spinner | ✓ "No reports generated yet" | ✗→✓ **(fixed)** explicit "Couldn't load reports" + Retry | ✓ `hasReportsEntitlement` notice (plan gate) |
| **Members table** | `src/components/organization/MembersTable.tsx` | ✓ skeleton | ✓ "No members yet" | — (presentational; parent owns fetch) | — (parent owns) |
| **API usage dashboard** | `src/components/api/ApiUsageDashboard.tsx` | ✓ | ✓ | ✓ classified error, raw text scrubbed (BUG-UAT5-04) | ✓ (error copy covers 401/403) |
| **Webhook settings** | `src/components/webhooks/WebhookSettings.tsx` | ✓ | ✓ "No endpoints" | ✓ inline `setError` + Alert | ✓ (server error surfaced) |
| **Pipeline admin** | `src/pages/PipelineAdminPage.tsx` | ✓ | ✓ | ✓ `DataErrorBanner` (stats + records) | ✓ admin-gated route |
| **Treasury admin** | `src/pages/TreasuryAdminPage.tsx` | ✓ | ✓ | ✓ `DataErrorBanner` | ✓ admin-gated route |

### Documented gaps — deferred (surface locked under a concurrent PR)

These were audited and have a real or partial gap, but the owning surface is in
the SCRUM-1999 collision-guard set (frozen under another open PR), so they are
recorded here and **not** edited in this PR. Each is a candidate follow-up.

| Surface | File | Gap | Notes |
|---|---|---|---|
| Dashboard records list | `src/pages/DashboardPage.tsx` *(locked)* | Records-fetch **error** has no dedicated banner (stats error *is* handled via `statsError`). | `useAnchors()` swallows the list error; the list renders empty on failure. Stats path already explicit. |
| Vault dashboard records | `src/components/vault/VaultDashboard.tsx` | Records-fetch **error** relies on `useAnchors()`; no dedicated banner. | Empty/loading/revoke-error handled; list-fetch error falls to empty. Out of this PR's bounded scope. |
| Manage sub-orgs | `src/components/org/ManageSubOrgs.tsx` | Load **error** is silently swallowed (`if (!response.ok) return;` + empty `catch`). | Action errors use toast (✓); the initial load error masks as empty. Good next follow-up — left out to keep this PR bounded. |
| Search page | `src/pages/SearchPage.tsx` *(locked)* | Already handled (post BUG-UAT5-01 the silent catch was removed). | Listed for completeness; no gap. |

### Presentational components (state owned by the parent)

`RecordsList.tsx` returns `null` on `records.length === 0` **by design** — its
parent (`DashboardPage` / `VaultDashboard`) owns the empty / error / permission
states and renders the surrounding `EmptyState`. This is correct separation, not
a gap; the parent is where any missing list-error banner belongs.

## What this PR changed

1. **`OrgRegistryTable.tsx`** — added a `FetchErrorKind` (`'none' | 'load' | 'permission'`) state. On a fetch error the table now sets the appropriate kind, clears the rows, and renders an explicit `role="alert"` banner (Retry for `'load'`; no retry for `'permission'`) in both the mobile and desktop layouts, instead of `console.error` + the misleading empty state.
2. **`ReportsList.tsx`** — added a `loadError` state and an explicit `role="alert"` error banner with Retry, replacing the silent `console.error` fall-through to "No reports generated yet". Permission was already covered by the `hasReportsEntitlement` plan notice.
3. **Tests** — `OrgRegistryTable.test.tsx` (empty / error / permission, distinguishing the error state from empty) and a new `ReportsList.test.tsx` (empty / error / permission). Both use a controllable thenable Supabase mock.
4. **E2E** — `e2e/error-states.spec.ts` extended with a registry data-fetch failure case (PostgREST `anchors` GET forced to 500 via route interception) asserting the explicit error state + Retry appear and the empty state does **not**.

Copy lives in local constants in each component (`REGISTRY_STATE_COPY`,
`REPORTS_STATE_COPY`) because `src/lib/copy.ts` is locked under a concurrent PR;
the strings are banned-term-free (`npm run lint:copy` clean) and should be
promoted into `copy.ts` when that file is next touched.
