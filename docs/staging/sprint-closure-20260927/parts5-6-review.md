# PR 3152 round-two repair — parts 5 and 6

## Verified findings and bounded disposition

- **Hosted MCP raw-key exposure:** real. Hosted `register`, `create_key`, and ComputeID admission now require a forwarded API key. JWT callers receive `API_KEY_AUTH_REQUIRED` before network I/O. List/get/update/revoke retain JWT support. Tool and operator documentation states the decision.
- **ComputeID post-commit key loss:** real latent contract hazard. SQL 0492 guarantees the core agent/key projection. The worker still validates that core and the one-time key identifiers strictly, while malformed ancillary status/binding fields are reconstructed from the already verified request and logged with only the agent id. It returns 201 and the one-time key after a committed admission. A non-record or malformed core remains a bounded 500 and never claims a usable commit response.
- **Malformed outbox claim head-of-line delay:** real. A malformed claim is logged, captured to Sentry, and skipped; the bounded loop continues. It is never sent or completed using untrusted fields, and SQL lease/DLQ policy remains authoritative.
- **V2 revoked key:** real. V2 now selects `revoked_at` and rejects it even if a stale row remains `is_active=true`.
- **Credential mutation limiting:** registration and per-agent key mint now receive the existing batch limiter without throttling lifecycle reads/status updates.
- **UUID versions:** client-side UUID guards now accept future RFC version nibbles while retaining canonical hex/hyphen/variant syntax.
- **Stale hosted documentation:** corrected dual-header fail-closed behavior, `WORKER_BASE_URL` lifecycle requirement, and 25-tool count.

Migration/RLS/retention/native SQL findings belong to the SQL repair owner and were not modified here. New webhook event types, delegation lineage, broad validator generation, and unrelated refactors were not folded into this bounded repair.

## Local evidence

- Worker: 4 focused files, 130 tests passed; typecheck and focused lint passed.
- Edge hosted MCP: 2 focused files, 136 tests passed; typecheck passed. The repository ESLint configuration ignores these edge paths and emitted warnings rather than errors.
- TypeScript SDK: 133 tests and typecheck passed.
- API CLI: 19 tests and typecheck passed.
- stdio MCP: 91 tests and typecheck passed.

No staging, commit, push, CI dispatch, migration application, deployment, or soak was performed.
