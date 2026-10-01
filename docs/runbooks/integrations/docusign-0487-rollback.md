# DocuSign migration 0487 rollback — engineering companion

Canonical delivery and operator decision: [AR20-93 Confluence spec](https://arkova.atlassian.net/wiki/spaces/AR2/pages/161480731) and [AR20-93 Jira](https://arkova.atlassian.net/browse/AR20-93). This file is the source-side procedure to review there. It **supersedes the unsafe `-- ROLLBACK:` comment** in `supabase/migrations/0487_docusign_content_addressed_external_revision_backfill.sql`; do not execute that comment. The migration file is historical and must not be silently edited.

## Why the header is unsafe

Migration 0487 backfills existing DocuSign `connector_artifact.external_revision` from `fingerprint_sha256`. Both current DocuSign producers also write that equality for new rows. The header's `WHERE source='docusign' AND external_revision=fingerprint_sha256` therefore selects **both cohorts**. Migration 0343's actual unique key is `(org_id, source, external_ref, COALESCE(external_revision, ''))`; resetting distinct new versions of one envelope to NULL collapses their keys and can raise `23505`. An update that happens not to conflict still reverses rows 0487 never touched. The [migration ledger correction](../../../supabase/migrations/agents.md) explains the same defect.

## Required admission and STOP conditions

This is a rollback **preparation procedure**, not standing authorization to run against a hosted database. An operator records the exact project/environment, database migration ledger/head, source and worker revision, incident, reviewer, approved window and recovery owner before any live action. Capture the live `idx_connector_artifact_dedupe` definition and compare it with migration 0343. Confirm whether 0487 actually applied in that environment; historical notes do not prove current deployment state.

The only eligible cohort is an independently retained list of DocuSign **row IDs captured immediately before 0487** in that exact environment, with the original NULL revision, row count and a protected manifest digest. **STOP if that snapshot is absent or cannot be tied to the environment/candidate.** The post-migration equality predicate cannot reconstruct it. Do not substitute the 27-row historical count, a current query, or a backup from a different environment.

Quiesce DocuSign inbound, outbound and retry writers; confirm no mixed old/new worker revisions, queues, callbacks or schedulers can write `connector_artifact` during the transaction. If quiescence cannot be shown, STOP. Check that every captured ID still exists, is DocuSign, still has the expected org/envelope/fingerprint, and currently has `external_revision=fingerprint_sha256`. STOP on any mismatch, unknown extra ID, already-reversed row, or existing NULL-revision row for the same `(org_id, source, external_ref)` outside the cohort.

## Bounded reversal

The operator loads the approved IDs into a session-local, primary-keyed `rollback_ids(id uuid)` table. A reviewer reads back its row count and manifest digest **before** the transaction. Inside one transaction:

1. Set `lock_timeout='5s'` and `statement_timeout='30s'`. Acquire `SHARE ROW EXCLUSIVE` on `public.connector_artifact`; this blocks competing writes while the checks and update run. A timeout is a STOP, not a reason to weaken the lock.
2. Recheck the cohort fields and expected count under the lock. Preflight the 0343 unique key: no captured row may collide at the NULL/empty revision key with another row, and the snapshot may contain at most one captured row for each `(org_id, source, external_ref)`.
3. Update **only** `connector_artifact.id IN (SELECT id FROM rollback_ids)`, additionally guarded by `source='docusign'` and `external_revision=fingerprint_sha256`. Read back the exact affected count; it must equal the approved snapshot count. Read back that all noncohort post-cutover revisions and the unique-index definition are unchanged.
4. Commit only after the reviewer compares expected and actual counts and approves the rollback decision. On any error or mismatch, `ROLLBACK` the whole transaction; do not broaden the predicate or retry against a moving cohort.

Retain the command transcript and redacted counts, database/source/worker identities, snapshot digest, lock wait, SQLSTATE, reviewer and final decision. The bounded lock is a live write interruption and requires the separate release/operator admission for that environment.

## Reapplication and recovery

Keep writers paused after reversal until the incident owner decides whether the old code or the content-addressed code should run. A forward reapplication uses the **same approved ID list**, setting `external_revision=fingerprint_sha256` only where that captured row is currently NULL. Under the same bounded transaction and lock, verify the captured IDs, org/envelope/fingerprint and NULL revision still match the approved snapshot, and that no other row holds each target `(org_id, source, external_ref, fingerprint_sha256)` unique key. Stop on a mismatch or collision. Read back the exact affected count and unchanged noncohort rows. Re-enable a single compatible worker revision only after verifying its producer contract, queue state and idempotency; monitor dedupe/23505 and artifact counts. A new ID snapshot or a blanket rerun of 0487 is not a recovery shortcut.

## Isolated operator UAT

`scripts/ops/repro-docusign-0487-rollback.sh` starts a private Unix-socket-only PostgreSQL 17 fixture, reproduces migration 0343's exact unique expression, and tears down its own cluster. It rehearses the bounded transactions and locks: the header selects three rows and conflicts; cohort reversal changes one old row while preserving two new version keys; reapplication restores one. The actual snapshot guard rejects a missing cohort, a wrong row identity and two same-envelope IDs; collision guards reject a mixed old-writer NULL row before reversal and an occupied fingerprint key before reapplication. Record the exact source SHA, index/backfill migration hashes, fixture receipt, reviewer, expected/actual counts and a tabletop rollback decision. This isolated rehearsal **does not** prove a hosted migration state or authorize a live rollback.
