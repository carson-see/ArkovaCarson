# Evidence E1/E2 — migration 0423 write-authority guard (PR #2472)

Rig: isolated Supabase project `aqikotdkmhxmznonwmwk` (arkova-soak-docusign-bilateral, us-east-2).
Rig state at capture: ledger head **0424**, 120 migrations, 116 public tables / 116 RLS-enabled,
`trg_strip_unattested_docusign_metadata_keys` + `enforce_docusign_metadata_key_authority()` present,
`docusign_webhook_nonces.account_id` present, `anchors.fingerprint_source` present.
Captured 2026-08-30 via Supabase MCP `execute_sql` against the live rig (not a mock, not a unit test).

## E1 — a non-service_role (browser/PostgREST) caller CANNOT forge DocuSign provenance
Insert as `request.jwt.claim.role='authenticated'` with forged DocuSign metadata:

| Assertion | Result |
|---|---|
| `connector_source` stripped | **true** |
| `account_id` stripped | **true** |
| `envelope_id` stripped | **true** |
| `_signers` stripped | **true** |
| `_docusign_env` stripped | **true** |
| legitimate `customer_field` preserved | **true** |
| anchor still written (strip, not reject) | **true** |

Final persisted metadata: `{"customer_field": "legit-non-docusign-value"}` — every forged DocuSign key gone.

## E2 — legitimate writes survive; the conditional guard protects real customer data
| Assertion | Result |
|---|---|
| service_role (worker) DocuSign keys survived | **true** |
| NON-DocuSign row: browser-written `account_id` preserved | **true** |
| NON-DocuSign row: browser-written `envelope_id` preserved | **true** |
| browser UPDATE tamper on a worker row reverted to the worker value | **true** |

The two middle rows are the CTO-review fix in action: an AI-extracted `account_id` on a
non-DocuSign document (e.g. a bank statement) is NOT silently stripped, because the guard is
conditional on the row claiming DocuSign provenance. A forger cannot exploit that, since claiming
provenance requires `connector_source`, which is itself always guarded (E1).
