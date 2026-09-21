# packages/api-cli/agents.md

## 2026-09-19 — UAT-12 durable status parity

`arkova status <public-id>` reads the API-key caller-scoped
`GET /api/v1/anchor/{publicId}/submission-status` contract and prints bounded JSON unchanged. It is
a read command: no retry/rearm or credit purchase is inferred from status output.

## 2026-09-19 — UAT-23 row import

`arkova import <rows-json-file>` accepts only strict fingerprint rows, caps input at 100, sends no file bytes or `org_id`, and never automatically retries the write.
## 2026-09-19 — UAT-24 folder parity

The CLI exposes list/create/update/reparent/delete/connector-bind-or-clear/bulk-move through the canonical folder routes. `--root` is the explicit null-parent operation; connector clear cannot be combined with binding fields.
