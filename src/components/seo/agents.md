# agents.md — components/seo
_Last updated: 2026-09-12_

## 2026-09-12 SCRUM-4989 — both JSON-LD blocks use `toJsonLd`

`OrganizationSchema.tsx` and `VideoObjectSchema.tsx` each hand-rolled an escape (VideoObject had none at all). Both now call `toJsonLd` from `src/lib/jsonLd.ts`, which escapes every `<` plus U+2028/2029. **Any new component here that emits a JSON-LD block must use it — never bare `JSON.stringify`.** The tests assert the property (no raw `<` reaches the tokenizer, exactly one `<script>` element, the payload still `JSON.parse`s back to the original) rather than one particular escape form, so a future change to the escape does not have to touch them.

## What This Folder Contains
SEO and structured data components for public-facing pages: Open Graph meta tags, JSON-LD schema, and video embeds.

## Key Files
- `OrgPageMeta.tsx` — Open Graph + Twitter Card meta tags for public org pages (React 19 document metadata hoisting)
- `OrganizationSchema.tsx` — JSON-LD schema.org Organization block for AI search engines and crawlers
- `VideoObjectSchema.tsx` — JSON-LD VideoObject schema for embedded video content
- `YouTubeExplainerEmbed.tsx` — YouTube explainer video embed component

## Do / Don't Rules
- DO: Keep the JSON-LD builder pure/testable — split from rendering so SSR can reuse it
- DO: Include verified social profiles and logo in Organization schema
## 2026-09-21 — Org logo must stay publicly addressable (PR #3033 review)

`OrgPageMeta` (og:image / twitter:image) and `OrganizationSchema` (schema.org
`logo`) read `logo_url`, and their consumers are out-of-band crawlers: a
short-lived signed URL is useless to them. The upload path therefore keeps
`logo_url` populated with a stable public URL. Both test files pin this
end-to-end from `orgBrandUpdates`; do not switch these components to a storage
path.
