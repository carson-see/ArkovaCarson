# agents.md — components/rules
_Last updated: 2026-05-16_

## What This Folder Contains
Automation rule testing UI for org admins to simulate rules before saving.

## Key Files
- `RuleSimulatorPanel.tsx` — Wraps `POST /api/rules/test` endpoint; lets admins run sample events through a rule without persisting. Supports trigger types: ESIGN_COMPLETED, WORKSPACE_FILE_MODIFIED, CONNECTOR_DOCUMENT_RECEIVED. Shows matched/not-matched, reason, and action preview.

## Dependencies
- `@/lib/workerClient` (workerFetch) — rule test API
- `@/lib/copy` (RULE_SIMULATOR_COPY, RULE_ACTION_COPY, RULE_TRIGGER_COPY) — UI strings

## Do / Don't Rules
- DO: Keep "Test rule" action clearly separate from Save/Enable
- DO: Provide source-specific sample payload templates per trigger_type
