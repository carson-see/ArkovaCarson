# agents.md — components/integrations
_Last updated: 2026-09-14 (`ConnectorCardStatusRow.tsx` shared with `components/connectors/` — SonarCloud duplication fix)_

## 2026-09-14 — `ConnectorCardStatusRow.tsx` (from PR #2934) pulled into this branch

PR #2912's move of `DriveConnectorCard.tsx` / `DocusignConnectorCard.tsx` into
`src/components/connectors/` (below) left both cards with their own copy of the status-icon /
badge / Connect-Disconnect button block, on top of the two copies already in
`AdobeSignConnectorCard.tsx` and `MemberDocusignConnectorCard.tsx` here — four copies, which
SonarCloud flagged as new-code duplication over the 3% gate. PR #2934 extracted that block into
`ConnectorCardStatusRow.tsx` for the two cards in this folder; this branch copies that same
component (not a fork — same file) and points its own two cards at it instead of re-duplicating.
Button copy is now the shared generic `CONNECTIONS_LABELS.CONNECT_BUTTON` /
`DISCONNECT_BUTTON` ("Connect" / "Disconnect") rather than each card's own wording ("Connect
Drive", etc.) — matches what #2934 already shipped for the two cards here, so all four connector
cards read consistently. `e2e/integrations-drive.spec.ts` still asserts the old
`OrgProfilePage`-settings-tab copy from before the 2026-09-13 move above; it was already
orphaned by that move (the cards no longer render there at all) and is unrelated to this note —
left as-is, out of scope for the duplication fix.

## 2026-09-13 — `DriveConnectorCard.tsx` / `DocusignConnectorCard.tsx` moved to `components/connectors/`

Founder direction (2026-09-13): the Connectors page (`src/pages/ConnectorsPage.tsx`,
`/organization/connectors`) replaces `OrgProfilePage`'s "Rules" nav button with "Connectors", and
the two REAL org connector cards move there with it — they are composed by `ConnectorsPage`, not
duplicated (PM-11). `OrgProfilePage`'s Settings tab now shows a link row
("Connectors — Manage connectors") instead of rendering the cards inline.

**What stays here, and why:**

- `AdobeSignConnectorCard.tsx` — live prod state is the `adobe_sign_unconfigured` denial (no Adobe
  application registered). Putting it on the Connectors page would be exactly the greyed
  "coming soon" card the founder rejected. Moves here in one commit once Adobe is configured.
- `MemberDocusignConnectorCard.tsx` — member-scoped (writes `member_integrations`, not
  `org_integrations`), not an org connector, has no org rule. Not in scope for the Connectors page.
- `useSignatureConnection.ts` / `signatureOAuthResponse.ts` — shared by `AdobeSignConnectorCard`
  (still here) AND the moved `DocusignConnectorCard`, so they stayed put; the moved card imports them
  via `../integrations/useSignatureConnection` / `../integrations/signatureOAuthResponse` rather than
  duplicating them.

See `src/components/connectors/agents.md` for what moved and what it grew (folder picker, action
choice, `useConnectorRule`).

## 2026-08-30 — `AdobeSignConnectorCard.tsx`

Mirrors `DocusignConnectorCard.tsx` (same verified-org entitlement via `useCanIssueCredential`,
same connect/disconnect shape, tokens never touch the browser). Three things differ, each because
the Adobe backend genuinely behaves differently — not for styling:

1. **`adobe_sign_unconfigured` is a first-class denial, not an edge case.** As of 2026-08-30 no
   Adobe Acrobat Sign application is registered and prod carries no Adobe credential, so
   "not available here yet" is the LIVE path for this card. A 503 from the `ENABLE_ADOBE_SIGN_OAUTH`
   kill switch is mapped to the same copy — to an admin, "disabled" and "unconfigured" are one
   state.
2. **`webhook_registration_failed` must not say "try again".** It means the Adobe account plan does
   not grant `webhook_write`; retrying cannot fix a plan. `adobeSignErrorCopy()` maps it to
   contact-support copy, and a test asserts the string does not match `/try again/i`.
3. **It does NOT read the OAuth return-trip query string** — and that is a correction, not an
   omission. The first draft read `?adobe_sign_error=` in a card-local effect and set component
   state. That silently loses the message under React StrictMode's double mount: the first mount
   strips the params and its state is discarded, so the second mount reads an empty query string
   and renders nothing. **Unit tests did not catch it** (they mount once); the E2E spec did. The
   result is now consumed by `OrgProfilePage`'s existing `useSearchParams` effect alongside Drive
   and DocuSign, which toasts imperatively — no component state to lose. `adobeSignErrorCopy()` is
   exported from the card so the code -> copy mapping still lives in one place, and a unit test
   asserts the card does not render the copy or call `replaceState`, so the bug cannot come back
   unnoticed. If you add a fourth connector, put its result handling in the page, not the card.

**Carrying forward the GH #1836 lesson below:** the browser-side `org_integrations` select is
column-pinned to `id, account_label, account_id, connected_at, scope` and a test asserts
`encrypted_tokens` / `token_kms_key_id` / `token_secret_name` / `webhook_id` never appear in it.
That is the exact failure class `DriveConnectorCard.tsx` shipped — a browser select that bypassed
the worker's own redaction — so it is pinned here by a test rather than by care.

**Disconnect can partially succeed and the card says so.** When the worker returns
`adobe_webhook_removed: false`, the local teardown completed but Adobe kept the registration and it
needs manual removal in Adobe's admin console. The card surfaces that instead of reporting a clean
disconnect over a webhook that is still live.

## 2026-08-03 — GH #1836 (SECURITY) review follow-up: `DriveConnectorCard.tsx` stopped selecting `account_label`

Adversarial review of PR #1944 (the GH #1835/#1836/#1837 Drive fixes) found a WORSE, un-caught surface of the same #1836 vulnerability: this card selected `account_label` directly from `org_integrations` via the browser Supabase client — RLS permits any org admin to read it, with no column-level restriction — and rendered it as plaintext (`Connected as ${account_label}`). For `google_drive` rows, `account_label` is a JSON blob carrying `channel_token`, the webhook-authentication secret (see `api/v1/integrations/agents.md`'s GH #1836 entry in the worker repo tree). That shipped the secret straight to the browser and displayed it on screen — strictly worse than the `connector-health.ts` API leak found in the same review pass, because it bypassed the worker entirely.

Fix: `account_label` is no longer in the `.select()` column list at all (not fetched, then filtered — never fetched), and the card renders a plain `"Connected."` with no account-specific text. No worker-mediated sanitized-label endpoint exists yet for this card to fall back to; restoring a "Connected as {email}" display is a candidate follow-up but explicitly not required — a bare "Connected." is a safe, acceptable default. Pinned by `DriveConnectorCard.test.tsx`'s `describe` block asserting the query never requests the column and the rendered DOM never contains a `channel_token` value even if the mocked row carries one (defense against a future regression re-adding the column to the select).

## What This Folder Contains
Third-party integration connector cards for org admins and members to manage OAuth connections.

## Key Files
- `DocusignConnectorCard.tsx` — **MOVED to `src/components/connectors/` (2026-09-13, see that folder's agents.md).** Org-level DocuSign OAuth connector: connect/disconnect, tokens never touch the browser (worker returns auth URL only). Queries `org_integrations`. SCRUM-2361 (DS-01): the *connect* action is gated on the shipped verified-org signal via `useCanIssueCredential` (SCRUM-1755) — denied orgs see `CONNECTIONS_LABELS.DOCUSIGN_NOT_VERIFIED` with a disabled Connect button (`data-testid="docusign-gate-denied"`); the worker `/oauth/start` is the authoritative gate, this is UX defense-in-depth. Disconnect is never gated. Now composed by `src/pages/ConnectorsPage.tsx`. NOTE (2026-07-28): does NOT show a last-synced timestamp — the same gap DriveConnectorCard closed below; a symmetric follow-up for DocuSign is a candidate but out of scope for SCRUM-2903.
- `MemberDocusignConnectorCard.tsx` — Member-level DocuSign OAuth connector (SCRUM-2044): same pattern as org-level but queries `member_integrations` and uses `/api/v1/integrations/docusign/member/*` endpoints. `data-testid="member-docusign-card"`.
- `DriveConnectorCard.tsx` — **MOVED to `src/components/connectors/` (2026-09-13, see that folder's agents.md).** Google Drive OAuth connector: same pattern as DocuSign, tokens handled server-side only. Now composed by `src/pages/ConnectorsPage.tsx` — that is the primary reachable UI surface for Drive connector status; `OrgProfilePage`'s Settings tab links to it instead of rendering it. **SCRUM-2903 GD-PROD (2026-07-28, #1654):** now also renders "Last synced `<timestamp>`" (from `org_integrations.last_token_advanced_at` — the changes-feed runner's page-token-advance watermark; falls back to "Not yet synced"). Additive read on the existing connected-state branch — no new query fires while disconnected. **A "`N` document(s) secured via Drive" counter was proposed and CUT** (2026-08-01): it was an exact PostgREST row count on `anchors` filtered by `metadata->>connector_source`, which raises the R0-8 / SCRUM-1254 exact-count baseline (`scripts/ci/check-count-exact-baseline.ts` fails the build) and has no supporting index — a sequential scan over ~2.97M rows on every Settings render, the shape that trips the 60s PostgREST timeout. This card queries `org_integrations` ONLY; do not reintroduce an `anchors` query here without a `CREATE INDEX CONCURRENTLY` on `(org_id, (metadata->>'connector_source')) WHERE deleted_at IS NULL` plus the `count-exact-allowed` label. Pinned by a removal test in `DriveConnectorCard.test.tsx`.

## Dependencies
- `@/lib/workerClient` (workerFetch) — server-side OAuth URL generation
- `@/lib/supabase` — connection status reads

## Do / Don't Rules
- DO: Keep OAuth tokens server-side only — browser never sees or stores tokens
- DO: Use `workerFetch` for all OAuth URL generation
- DO: Gate the org connect button on `useCanIssueCredential` (the verified-org entitlement), but treat it as UX only — the worker is the real gate. Never gate disconnect.
- DO: Map the worker's connect-denial `code` to `CONNECTIONS_LABELS` via `DRIVE_DENIAL_COPY` in `DriveConnectorCard.tsx`, and keep the fallback chain `mapped ?? body.error ?? generic`. The worker deliberately pairs a specific `code` with a **generic** `error` string ("Not eligible to connect Google Drive"); rendering only the generic string is how a denied user learns nothing — the failure mode FD-D3 spent a live founder OAuth consent diagnosing. An unmapped future code must still degrade to something readable, never a blank error box.
- DON'T: add copy for a denial reason the worker cannot emit. FD-D1 removed `needs_paid_plan` and `individual_not_verified` from the Drive gate — a personal Drive can never be persisted (`org_integrations.org_id` is NOT NULL), so an upgrade prompt there was a false promise. Copy and `DriveConnectDenyReason` move together.

## 2026-09-05 — Shared signature connector status and redirect

Adobe Sign and org DocuSign now share `useSignatureConnection` for their identical public-column status query and `followSignatureOAuthStart` for the successful authorization-URL response. Error copy, entitlement gating and partial-disconnect warnings remain in each card. The hook accepts only `adobe_sign` or `docusign`; never extend its account-label projection to Google Drive, whose label stores a credential-bearing blob. Existing card tests continue to assert tenant/provider filters, credential-column exclusion, denials, redirect behavior and stranded Adobe webhook feedback.
