# packages/api-cli/agents.md

## 2026-09-19 — UAT-12 durable status parity

`arkova status <public-id>` reads the API-key caller-scoped
`GET /api/v1/anchor/{publicId}/submission-status` contract and prints bounded JSON unchanged. It is
a read command: no retry/rearm or credit purchase is inferred from status output.
