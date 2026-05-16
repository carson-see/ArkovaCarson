# agents.md — components/dashboard
_Last updated: 2026-05-16_

## What This Folder Contains
Main dashboard widgets: stats, profile card, credit usage, empty states, and batch AI processing status.

## Key Files
- `StatCard.tsx` — Reusable metric card with label, value, icon, and optional trend indicator
- `ProfileCard.tsx` — User profile section: avatar, name, public ID, verified badge, privacy toggle, org link, social links
- `CreditUsageWidget.tsx` — Credit balance and usage cycle info via `useCredits()` hook
- `CleCreditWidget.tsx` — CLE-specific credit display widget
- `EmptyState.tsx` — Friendly empty state with optional action button
- `BatchAIDashboard.tsx` — Batch AI processing job status, progress, and results (gated behind ENABLE_AI_EXTRACTION)
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useCredits` — credit balance data
- `@/lib/supabase` — for BatchAIDashboard direct queries

## Do / Don't Rules
- DO: Use `useCredits()` hook for credit data, not direct Supabase queries
- DO: Gate AI features behind `ENABLE_AI_EXTRACTION` flag
