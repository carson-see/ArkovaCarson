# UAT evidence — Connectors page (SPEC-CONNECTORS, T2)

**Code under test:** this branch's working tree at capture time (`feat/connectors-page`).

**Surface:** local Vite dev server (`npm run dev`) + headless Chromium via Playwright, module-level
mocking of `useAuth` / `useProfile` / `useCanIssueCredential` / `supabase.from('org_integrations')`
/ `workerFetch` — the real `ConnectorsPage`, `DriveConnectorCard`, `DocusignConnectorCard`,
`DriveFolderPicker`, `ConnectorActionChoice`, and `useConnectorRule` all run unchanged; only the
account/data boundaries are synthetic. Same technique as `e2e/helpers/secure-dialog-layout.ts`.

No Supabase project or worker process was contacted. Google Drive is entirely mocked.

## Reproduce

```
npm run dev -- --port 5183
node <a script built on e2e/fixtures/connectors-uat.{html,tsx} with module-route mocks,
     mirroring e2e/helpers/secure-dialog-layout.ts's technique>
```

Each scenario below is captured at 1280×900 and 375×812.

## Screenshots

| # | File | Scenario |
|---|---|---|
| 1 | `01-not-connected-*` | Both cards, Drive and DocuSign not connected |
| 2 | `02-empty-folders-*` | Drive connected, zero folders selected (empty state, Save disabled) |
| 3 | `03-picker-root-*` | Folder picker open, root ("My Drive") level |
| 4 | `04-picker-nested-*` | Folder picker two levels deep (`My Drive / HR`), breadcrumbs visible |
| 5 | `05-folders-selected-*` | Drive connected, 3 folders selected, "Secure it immediately" chosen — includes the inline credit-cost help text |
| 7 | `07-scope-error-*` | `insufficient_drive_scope` error inside the picker, with the Reconnect button (not Retry) |
| 8 | `08-managed-in-rules-*` | "Managed in Rules" read-only state (2+ enabled rules on the trigger type) |
| 9 | `09-docusign-connected-*` | DocuSign card connected, with its action choice |

Not captured in this pass (honest gap, not claimed as done):

- **#6** (dedicated "action help text" close-up) — the credit-cost text is visible inline in
  screenshot #5; no separate crop was made.
- **#10** (OrgProfile Settings tab after the move) — the moved-card + link-row change on
  `OrgProfilePage.tsx` was verified by its own updated test suite
  (`src/pages/OrgProfilePage.test.tsx`), not a fresh screenshot in this pass.
- **#11** mobile picker as a full-screen sheet — covered by `03-picker-root-375x812.png` and
  `04-picker-nested-375x812.png` (both taken at 375×812; the dialog renders full-width/full-height
  below the `sm` breakpoint, reading as a sheet).
- **#12** (`/organization/rules` still rendering by direct URL) — that route/page is unmodified by
  this change; not re-screenshotted.
