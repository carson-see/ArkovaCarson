# SCRUM-1591 Trust-the-loop Evidence - 2026-05-05

PR: [#695](https://github.com/carson-see/ArkovaCarson/pull/695)

Scope: SCRUM-1591, subtask of SCRUM-1137 / SCRUM-1135.

Evidence source branch head before this evidence-only note:
`52d77b4d7caa1945a8f2afa145ad731d31c7433f`.

Local verification command, run from
`/Volumes/Extreme/Arkova/worktrees/pr695-completion/services/worker`:

```bash
npx vitest run \
  src/api/rules-crud.test.ts \
  src/api/demo-event-injector.test.ts \
  src/jobs/rules-engine.test.ts \
  src/jobs/rule-action-dispatcher.test.ts \
  src/api/proof-packet.test.ts \
  src/api/v1/webhooks/microsoft-graph.test.ts
```

Result on 2026-05-05 09:50 ET:

```text
Test Files  6 passed (6)
Tests       103 passed (103)
Duration    388ms
```

## Acceptance Criteria Trace

AC: Create/test/enable/fire/inspect/explain demo is recorded or linked.

Evidence: this linked note ties the full demo loop to focused tests. Create and
enable are covered in `rules-crud.test.ts`; fire is covered in
`demo-event-injector.test.ts`; inspect is covered in `rules-engine.test.ts` and
`rule-action-dispatcher.test.ts`; explain is covered in the test-rule and
execution-output assertions.

AC: Trace/evidence output demonstrates why the rule fired or did not fire.

Evidence: `handleTestRule` returns `matched: true`, `reason: "matched"`, and
`evaluated_enabled: true` for a disabled draft assumed enabled during test. It
also returns `matched: false` with `reason: "filename_filter_rejected"` for a
non-matching event. `rules-engine.test.ts` persists
`input_payload.match_reason`, and dispatcher tests assert visible final status,
output, and error states.

AC: Jira or Confluence contains the final verification note before parent
closure.

Evidence: Jira should link this evidence before SCRUM-1137 or SCRUM-1135 move to
Done. Because SCRUM-1591 has a Reporter-not-Resolver Jira rule, final Done
transition must be performed by a non-Carson verifier after reviewing the
evidence.

## Demo Loop Trace

```json
{
  "create": {
    "endpoint": "POST /api/rules",
    "test": "rules-crud.test.ts:658",
    "assertion": "new rule persisted disabled despite enabled=true request"
  },
  "test": {
    "endpoint": "POST /api/rules/test",
    "test": "rules-crud.test.ts:487",
    "matched": true,
    "reason": "matched",
    "evaluated_enabled": true,
    "action_type": "AUTO_ANCHOR",
    "non_match_reason_test": "rules-crud.test.ts:525",
    "non_match_reason": "filename_filter_rejected"
  },
  "enable": {
    "endpoint": "PATCH /api/rules/:id",
    "test": "rules-crud.test.ts:779",
    "audit_event": "ORG_RULE_ENABLED"
  },
  "fire": {
    "endpoint": "POST /api/rules/demo-event",
    "test": "demo-event-injector.test.ts:166",
    "status": 202,
    "rpc": "enqueue_rule_event",
    "trigger_type": "ESIGN_COMPLETED",
    "vendor": "docusign",
    "payload": {
      "source": "demo_injector",
      "demo": true,
      "injected_by_user_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    },
    "audit_event": "DEMO_RULE_EVENT_INJECTED"
  },
  "inspect": {
    "claim_test": "rules-engine.test.ts:85",
    "claim_rpc": "claim_pending_rule_events",
    "execution_write": "organization_rule_executions upsert with status=PENDING",
    "dispatch_test": "rule-action-dispatcher.test.ts:160",
    "dispatch_status": "SUCCEEDED",
    "dispatch_output": "notification_sent"
  },
  "explain": {
    "positive_reason": "matched",
    "negative_reason": "filename_filter_rejected",
    "failure_visibility": "unknown actions fail closed with visible error"
  }
}
```

## Completion Boundary

This file closes the engineering evidence gap for the rule-loop demo trace. It
does not replace the separate T2 prod-valid soak/migration-rehearsal gate for
PR #695, and it does not bypass Jira's Reporter-not-Resolver control on the
final Done transition for SCRUM-1591.
