# agents.md — components/ui
_Last updated: 2026-05-16_

## What This Folder Contains
Base UI primitives (shadcn/ui) plus Arkova-specific utility components. These are the lowest-level building blocks.

## Key Files (shadcn/ui primitives)
- `button.tsx`, `input.tsx`, `label.tsx`, `textarea.tsx` — Form controls
- `card.tsx`, `dialog.tsx`, `alert-dialog.tsx`, `alert.tsx` — Containers and feedback
- `badge.tsx`, `avatar.tsx`, `skeleton.tsx`, `progress.tsx` — Display elements
- `table.tsx`, `tabs.tsx`, `select.tsx`, `checkbox.tsx`, `switch.tsx` — Data and selection
- `dropdown-menu.tsx`, `tooltip.tsx`, `separator.tsx` — Navigation and layout

## Key Files (Arkova-specific)
- `ExplorerLink.tsx` — Deep link to network explorer (mempool.space) for anchor receipts; supports testnet4/signet/testnet/mainnet
- `SafeLink.tsx` — XSS-safe `<a>` wrapper that validates href via `isSafeUrl()` before rendering
- `OptimizedImage.tsx` — Performance-optimized `<img>` with lazy loading, eager priority mode, and CLS prevention
- `index.ts` — Barrel exports

## Do / Don't Rules
- DO: Use `SafeLink` instead of raw `<a>` when href comes from dynamic data
- DO: Use `OptimizedImage` with `priority` for above-fold hero images
- DO NOT: Modify shadcn/ui primitives without checking downstream impact across the app
