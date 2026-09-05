# Evidence E3 — live adversarial webhook matrix vs the running rig worker

Rig worker: `arkova-worker-docusign-bilateral-staging`, revision **00003-kt9**, image digest
`sha256:642487e3b1deaf123c7484690ef31f829e50c08d20258bd29ec79e911ee4c7f6`, source head
`2a676981cfcc337f87f42169b2d2085fdb886c87`. `/health` = healthy, database ok.
Rig DB: `aqikotdkmhxmznonwmwk`, ledger head 0424. Worker uptime start (soak clock):
**2026-08-30T16:23:20Z**. All requests real HTTP POSTs, HMAC-signed with the rig key.

## Adversarial matrix — every case behaved as designed
| # | Case | Result |
|---|---|---|
| 1 | valid outbound + signers | **202** `{ok:true}` |
| 2 | replay (identical nonce triple) | **200** `{ok:true,duplicate:true}` — deduped |
| 3 | wrong HMAC | **401** `invalid_signature` |
| 4/9 | inbound (foreign `sender.accountId`) | **202** `{ok:true,inbound:true}` |
| 5/10 | self-send: `?customrecipient=true` marker but OWN account owns the envelope | **202** `{ok:true}` — stayed **OUTBOUND** (marker cannot upgrade trust, ruling R4) |
| 6 | unknown account | **200** `{ok:true,orphaned:true}` — dropped, no durable write |

## PR #2474 — signer capture, GUIDs only (PII discipline)
Payload deliberately carried `name: "PII Name Marker"` and `email: pii-marker@example.com`
on the signer, plus a second signer whose `recipientIdGuid` was the mis-slotted value
`NOT-A-GUID-EMAIL@evil.test`.

Captured `_signers`: `[{recipient_id_guid, user_id, status, signed_at}]` — **GUIDs only**.
- planted name in job payloads: **0**
- planted email in job payloads: **0**
- planted PII in `organization_rule_events`: **0**
- planted PII in `connector_artifact`: **0**
- mis-slotted-PII signer: **rejected entirely** (the HIGH review finding — GUID-shape validation
  — working against a live system, not just a unit test)

## PR #2476 — inbound classification + declared-hash evidence class
`connector_artifact` row created for the foreign-sender envelope:
`_direction = inbound`, `_sending_account_id = ffffffff-9999-…` (the foreign account),
fingerprint = the DocuSign-**declared** sha256 (no document fetch performed),
attributed to **Soak Org A** (the receiving org), status pending.
Self-send envelope produced **no** inbound artifact — confirmed.

## PR #2476 — migration 0424 nonce tenant-scoping
7 nonce rows, **100% carrying `account_id`** — the tenant-scoped uniqueness key is live.

## Per-org isolation
Two synthetic orgs seeded (Soak Org A / Soak Org B, distinct DocuSign account_ids).
Zero artifacts cross-attributed to Org B: **isolation holds**.
