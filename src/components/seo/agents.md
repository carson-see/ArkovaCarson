# agents.md — components/seo
_Last updated: 2026-05-16_

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
