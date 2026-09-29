# Google Drive selected-folder recovery — source review

## Frozen source

- Owned diff SHA-256: `e5ebd9f7728590f227e739063b79df7011f864848a631ebeb92426d06910558c`
- Scope: selected-folder parsing and eager mirror parity, scheduled persisted-rule reconciliation, connector health visibility, and recovery-state evidence.
- Independent source review: PASS against the frozen diff.

## Verified behavior

The canonical parser keeps the configured folder array authoritative, deduplicates the legacy `folder_id` only when the rule is explicitly `type: drive_folder`, and enforces the configured folder cap. Scheduled reconciliation scans enabled Google Drive connector rules, rereads each rule before mirroring, uses the current connection, and keeps disconnected, missing-creator, and invalid-rule outcomes visible without making those tenant-specific repair states fatal to the shared hourly job. Transport, mirror, deadline, and durable health-state failures remain retryable job failures.

Mirror failure and recovery markers are scoped to the organization rule. State changes only are recorded, using fixed reason tokens; folder names, Drive folder identifiers, and raw errors are not written into their public health payload. Connector health reads the exact latest marker for every currently enabled rule with concurrency capped at ten and one shared three-second abort deadline. Query failure, deadline expiry, or malformed state data returns unknown health (`503`) rather than reporting a false healthy result.

## Local verification

- Worker focused suite: 9 files, 293 tests passed.
- App connector-health suite: 2 files, 27 tests passed.
- Focused worker ESLint: passed.
- Worker TypeScript typecheck: passed.
- Root TypeScript typecheck: passed.
- UI copy lint: passed.
- Git diff whitespace check: passed.

## Limits

This is source, unit, and type/lint evidence only. It does not establish deployment, hosted Scheduler execution, live Google Drive OAuth or folder access, browser acceptance, staging acceptance, customer acceptance, or soak results. No cloud configuration or remote system was changed by this review.
