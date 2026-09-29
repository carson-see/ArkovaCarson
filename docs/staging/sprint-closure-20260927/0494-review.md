# 0494 independent review

Reviewed frozen migration `11e3db7802e3636d3225eca1746074f5809fa8eebf38c97735020cdc3a029836` and final native harness `722c3c162c6b359bfc09a470d4de1e559336aada0b02b3bef5243c3ba86b15ff`.

Verdict: PASS for source review. No hosted migration was applied by this reviewer.

- Key mint locks the tenant target agent before resolving/locking caller authority. Revoke and status paths use the same parent-first order.
- The native harness uses separate PostgreSQL backends and observed waits in both the generic mint/revoke orderings. Its API-key mint versus attached-key machine self-revoke case holds the target lock in the revoke transaction, starts the real mint wrapper concurrently, then proves revoke completes without deadlock and mint either observes terminal agent state or loses live caller authority; no new key commits.
- The physical-delete trigger rewrites active, admin-resumable, and provider-resumable keys to the permanent `system:agent.deleted` reason before the existing FK clears `agent_id`. It preserves unrelated compromised inactive reasons.
- A forced audit-insert failure during physical delete rolls back the agent delete and live-key rewrite. The existing lifecycle failure case separately proves agent/key/audit/outbox atomic rollback. Clean retry remains idempotent.
- ACL, search-path, migration-prefix, lock-timeout, shell syntax, and cleanup evidence are recorded in `0494-agent-key-delete-lock-evidence.md`; the disposable run leaves zero operational fixture rows.

Limit: this is targeted full-lineage disposable-PostgreSQL evidence, not production-ledger/application proof. Apply/rollback gates remain open.
