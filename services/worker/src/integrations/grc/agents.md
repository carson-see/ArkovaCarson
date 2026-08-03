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
- **DO** resolve control IDs through `resolveEvidenceControlIds()` (`syncService.ts`) — never push `anchors.compliance_controls` straight through. Historical rows still carry retired identifiers (`RETIRED_CONTROL_IDS` in `utils/complianceMapping.ts`), and this is the surface where an auditor is most likely to read a control ID as an assessment (SCRUM-2227/2283).
- **DO NOT** send `compliance_controls` to a platform without `compliance_controls_note`. A control list must never travel without the statement of what it does NOT assert (§1.5 / R-7 claims gate). Each adapter carries it in its platform-specific metadata/properties map; the note is set exactly when controls are non-empty.
- **DO** keep the worker mapping in sync with the frontend mirror `src/lib/complianceMapping.ts` — the drift between them is what kept a false EU-US DPF claim live on every SECURED anchor for two months.
