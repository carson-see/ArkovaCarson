# E1 — Direct probes, PR #2524 T3 soak (rig `uqobkjhlnqmcpjidngxr`, head `a3f1d6b36b513d2fd9d65e2d1e6f6f5f2b6cf20c`)

Captured 2026-09-02 by the operating session, independently of the soak driver. Every line below is a
measurement taken against the live rig; nothing is inferred from code or from the driver's own output.

## 1. Sweep advances and rotates (H1 — the cursor fix)
Supabase MCP `execute_sql` on `anchor_proofs`, three reads across scheduler ticks (`*/5`):

| read (UTC) | populated | candidates | half_pairs | index_out_of_range |
|---|---|---|---|---|
| after tick 1 | 880 | 2,120 | 0 | 0 |
| after tick 2 | 1,880 | 1,120 | 0 | 0 |
| ~6h in | 2,880 | 120 | 0 | 0 |

The 120 remaining are exactly the designed wedge cohort: `count(DISTINCT chain_tx_id)=1`,
`count(DISTINCT block_hash)=120`, and they lead the `anchor_id` keyspace. A build with the pre-fix
cursor (`.gt('anchor_id','')` on a uuid column → `22P02`) reports 0/0 on every tick; this rig advanced by
1,000 per page and stopped precisely at the never-completable cohort.

## 2. Read/write coherence and bundle publication (H3/H4, B3) — direct probe
Record `ARK-DOC-FMY2TU` (seeded, real mainnet txid).

Stored (`psql`, session pooler):
`branch_len=12 index=1961 schema_v=1`

Published (`GET /api/v1/verify/ARK-DOC-FMY2TU/proof`, IAM via `X-Serverless-Authorization`):
`verified=true`, `proof_bundle.tx_inclusion_branch` length 12, `tx_block_index` 1961, `proof_schema_version` 1.
Bundle keys: block_hash, block_header, block_height, block_timestamp, fingerprint, leaf_count, merkle_index,
merkle_proof, merkle_root, op_return_payload, proof_schema_version, signature, tx_block_index, tx_id,
tx_inclusion_branch.

The pair the writer persisted is the pair the reader publishes. The same endpoint answered `200` with the
identical bundle under three header variants (IAM token alone; plus `Authorization: Bearer <cron-secret>`;
plus `X-Cron-Secret`), so the app-level route does not reject any header the driver sends.

## 3. Driver runs to date
- `r1-live-01`: invalid — worker boot config not in the driver's env (`Invalid configuration`). Discarded.
- `r1-live-02`: A1, A4, A9 pass; A2/A3 confounded by pre-rotated cursor; A5/A6 blocked by a native
  Sentry profiler resolution failure in the operator's worktree; A7/A8 `HTTP 403`.
- `r1-live-04`: **A1–A6 all pass** (cursor advance + wrap observed; fold guard verified against real
  `gettxoutproof`; multi-match rejected; chunk boundary crossed). A7/A8 `HTTP 403` from the driver's
  `/proof` call only — the same request from `curl` returns `200` (section 2). Under investigation with
  response-body logging (`r1-live-05`).

## 4. Not asserted here
No reorg was induced; the broadcast→confirmation path is not exercised (anchors seeded SECURED); the rig's
`maxScale` is 2, so per-instance cursor arithmetic is not guaranteed exact (A2/A3 nonetheless passed in
`r1-live-04`).
