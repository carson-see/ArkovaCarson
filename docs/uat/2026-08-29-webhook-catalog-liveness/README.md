# UAT — webhook catalog credential.* liveness truth-fix (2026-08-29)

Captured against a throwaway vite harness mounting the two real changed
components (`WebhookEventCatalog`, `WebhookSettings` with `endpoints=[]`) —
static rendering only, no auth stack needed. Playwright (system Chrome,
headless) at 1280×900 and 375×812.

| File | Shows |
|---|---|
| `catalog-credential-rows-1280.png` / `-375.png` | `credential.issued` **Active**, `credential.verified` **Not yet active** (+ subscribe note), `credential.status_changed` **Active** |
| `settings-event-labels-1280.png` / `-375.png` | Add Endpoint dialog: "Credential Issued", "Record Verified (coming soon)", "Record Status Changed" |

Programmatic checks in the same run: each of the three labels matched exactly
once per viewport (`getByText(..., { exact: true })`); DOM badge text read back
as `issued=Active`, `status_changed=Active`, `verified=Not yet active`. No
console errors; no layout regression at 375px (rows wrap, no horizontal
overflow).
