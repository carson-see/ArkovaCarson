# agents.md — src/components/issuer-partnerships/

_Last updated: 2026-06-01 (SCRUM-2082 CSI-04D)_

## What This Folder Contains

UI components for the Issuer Partners admin page (SCRUM-2082). Backs the SCRUM-1596 Credential Source Import epic — these components manage **org-level** partnerships with credential issuers (Credly, Accredible, Udemy Business), **not** consumer account-linking.

| File | Purpose |
|------|---------|
| `ConnectIssuerDialog.tsx` | Single dialog that handles both Credly (client_id + client_secret) and Accredible/Udemy (api_key) connection flows. Fields shown conditionally based on the selected provider. |

## Do / Don't Rules

- **DO** use copy from `ISSUER_PARTNERSHIP_LABELS` in `src/lib/copy.ts`. UI strings live there; the lint forbids hard-coded strings.
- **DO NOT** display, log, or persist `client_secret` / `api_key` outside the dialog submission path. The dialog clears the inputs on close.
- **DO NOT** call the worker API directly from components — use the page-level data-loading hook so loading/error states stay consistent.
- **DO NOT** branch on `provider` for layout deeper than needed; conditional rendering is fine, but a separate component per provider is overkill at this scale.

## Related References

- Page: `src/pages/IssuerPartnershipsPage.tsx`
- Route: `ROUTES.ADMIN_ISSUER_PARTNERSHIPS` in `src/lib/routes.ts`
- Worker endpoint: `services/worker/src/api/v1/integrations/issuer-partnerships.ts`
- Adapters consuming these credentials: `services/worker/src/integrations/credential-sources/credly/` + `accredible/`
- Jira: [SCRUM-2082](https://arkova.atlassian.net/browse/SCRUM-2082) / parent [SCRUM-1600](https://arkova.atlassian.net/browse/SCRUM-1600) / epic [SCRUM-1596](https://arkova.atlassian.net/browse/SCRUM-1596)
