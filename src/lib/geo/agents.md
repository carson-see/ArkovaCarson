# agents.md — lib/geo
_Last updated: 2026-05-16_

## What This Folder Contains

Generative Engine Optimization (GEO) helpers for structured data and schema.org markup. These generate JSON-LD that gets injected into pages for search engine and AI visibility.

## Key Files
- `videos.ts` — schema.org VideoObject builder for YouTube embeds (GEO-11 / SCRUM-478); ships an empty `VIDEOS` inventory until the first video lands
- `videos.test.ts` — validates VideoObject schema output and ensures empty inventory doesn't leak stub markup to Google

## Do / Don't Rules
- DO: Validate generated JSON-LD with Google Rich Results Test before shipping new entries
- DO: Keep the canonical helper here (main repo) even though the marketing site also consumes it
- DON'T: Add video entries without a live YouTube URL and thumbnail
