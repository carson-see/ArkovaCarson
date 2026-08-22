# SOC 2 control exception — MCP tool-call audit trail (dated record)

**Control:** every MCP tool invocation on `edge.arkova.ai` writes an `MCP_TOOL_CALL` row to
`audit_events` (CC7.2 / audit-trail evidence for the MCP surface).

**Exception period:** **2026-05-26 → the production deploy of PR #2232** (date to be inserted at
deploy; the fix is authored, tested, and held in draft under the fullsoak-2026-08 freeze until
2026-08-19T15:51:30Z).

**What happened.** The edge audit module emitted `event_category: 'security'` (lowercase) against an
uppercase-only CHECK constraint (`audit_events_event_category_valid`). Every insert failed HTTP 400 /
SQLSTATE 23514 and was swallowed by a fire-and-forget write. Measured in production 2026-08-13:
**409,885 audit rows, zero `MCP_TOOL_CALL`**. Bug: BUG-2026-08-13-016 (P0); fix: PR #2232.

**The gap is permanent.** The failed writes were rejected by the database, not queued: **no record of
any MCP tool call in the exception period exists anywhere**, and no backfill is possible. Requests to
`edge.arkova.ai` do appear in Cloudflare's own request logs at transport level (method/path/status),
which bounds the blind spot to *tool-call semantics* (which tool, which arguments-hash, which
principal), not to the existence of traffic.

**Why it persisted 2.5 months:** (a) the write was fire-and-forget with no failure signal; (b) the one
existing test asserted the buggy literal against an unconditional-201 mock, pinning the defect; (c) CI
has never executed the edge test suite (typecheck only). All three are addressed in PR #2232 and
BUG-2026-08-15-034/035.

**Compensating changes shipping with the fix:** casing corrected; structured `MCP_AUDIT_WRITE_FAILED`
records classifying `permanent` / `credential` / `transient` failures (SQLSTATE-only extraction,
whitelisted, because PostgREST error bodies contain the failing row); constraint-enforcing test stub;
tests moved into the gating suite. **Outstanding:** binding an alert to `failure_class == "permanent"`
(BUG-2026-08-15-037) — until then a future permanent failure is detectable but not paging.

_Recorded 2026-08-15 by the CTO session during the fullsoak-2026-08 window. This note must appear in
the Day-7 evidence pack and in any SOC 2 Type 2 report covering a period that overlaps the exception._
