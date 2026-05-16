# agents.md — services/worker/src/signatures/compliance/

_Last updated: 2026-05-16_

## What This Folder Contains

Compliance event emitters and audit proof export for the signatures subsystem.

| File | Purpose |
|------|---------|
| `complianceEvents.ts` | Compliance webhook event types and emitters (cert expiry, anchor delay, etc.) |
| `complianceEvents.test.ts` | Tests for compliance event emission |
| `auditProofExporter.ts` | Per-credential audit proof package generation (anchor proof, AdES details, timestamp, cert chain, eIDAS/ESIGN assessment) |

## Do / Don't Rules

- **DO** emit compliance events through the existing webhook infrastructure (WEBHOOK-1 through WEBHOOK-4)
- **DO NOT** include raw document content in audit proof packages
