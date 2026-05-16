# agents.md — components/embed
_Last updated: 2026-05-16_

## What This Folder Contains
Embeddable widget for third-party sites to display document verification status via iframe.

## Key Files
- `VerificationWidget.tsx` — Self-contained verification widget at `/embed/verify/:publicId`; shows verification status for a given publicId
- `index.ts` — Barrel exports

## Usage
Embedded via iframe: `<iframe src="https://app.arkova.ai/embed/verify/ABC123" width="400" height="500" />`

## Do / Don't Rules
- DO: Keep this component self-contained with no dependency on auth state
- DO NOT: Expose internal IDs — only `public_id` is used
