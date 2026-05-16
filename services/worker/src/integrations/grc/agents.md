# agents.md — services/worker/src/integrations/grc/

_Last updated: 2026-05-16_

## What This Folder Contains

GRC (Governance, Risk, Compliance) platform integration. Pushes evidence to connected platforms when anchors reach SECURED status.

| File | Purpose |
|------|---------|
| `types.ts` | Shared types — `GrcPlatform` (vanta/drata/anecdotes), `GrcConnection`, `GrcSyncLog`, `GrcEvidencePayload` |
| `index.ts` | Barrel export for all GRC types, adapters, and sync service |
| `adapters.ts` | Platform-specific HTTP adapters implementing `IGrcAdapter` (Vanta, Drata, Anecdotes) |
| `syncService.ts` | Orchestrator — queries active GRC connections, builds evidence payload, pushes to each platform, logs results |
| `grc.test.ts` | Tests for adapters and sync service |

## Do / Don't Rules

- **DO** call `syncAnchorToGrc()` only after anchor status transitions to SECURED
- **DO NOT** log OAuth tokens — handled server-side only (Constitution 1.4)
