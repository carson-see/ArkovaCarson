# agents.md — credentials
_Last updated: 2026-04-28 (SCRUM-952 subtype label fallback)_

## What This Folder Contains
Credential display components. `CredentialRenderer` is the core component that renders a credential using template field schema + anchor metadata. `CredentialTemplatesManager` handles CRUD for credential templates.

## Recent Changes
- 2026-04-28 SCRUM-952: `CredentialRenderer.tsx` — when `credential_type` resolves to "Other" (unknown or genuinely OTHER) but `metadata.sub_type` carries a recognized subtype like `professional_certification`, surface the subtype as the user-visible Type label via the new `formatCredentialSubType()` helper in `src/lib/copy.ts`. Key precedence: `metadata.sub_type` (canonical schema column per migration 0213) wins over `metadata.subtype` (legacy Gemini extraction-payload alias). Prevents UAT report BUG-2026-04-21-005 second issue (Type=Other for known subtypes).
- 2026-03-16 UF-01: Created `CredentialRenderer.tsx` — 3 rendering modes (template+metadata, metadata-only, filename-only). Compact mode for table rows. Fingerprint copy-to-clipboard. 20 unit tests.
- 2026-03-16 UF-01: Updated `index.ts` — barrel exports for CredentialRenderer + CredentialRendererProps.

## Do / Don't Rules
- DO: Use `useCredentialTemplate` hook (in `src/hooks/`) to fetch template data
- DO: Follow Precision Engine design system — sharp corners (`rounded-sm`), `shadow-neon`, `animate-in-view`, `font-mono` for fingerprints. See `docs/reference/BRAND.md`.
- DO: Handle all 3 rendering modes gracefully (template+metadata, metadata-only, no-metadata)
- DON'T: Expose internal template config in public-facing renders — only rendered output
- DON'T: Format dates without `timeZone: 'UTC'` — causes off-by-one day errors

## Dependencies
- `@/hooks/useCredentialTemplate` — template data fetching
- `@/lib/copy` — `CREDENTIAL_TYPE_LABELS`, `ANCHOR_STATUS_LABELS`, `CREDENTIAL_RENDERER_LABELS`
- `@/components/ui/badge`, `@/components/ui/button`, `@/components/ui/tooltip` — shadcn/ui primitives
