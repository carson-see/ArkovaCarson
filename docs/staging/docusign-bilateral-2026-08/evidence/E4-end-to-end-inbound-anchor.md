# Evidence E4 — inbound envelope anchored END-TO-END (the headline result)

Two envelopes owned by a FOREIGN DocuSign account (`ffffffff-9999-…`), delivered to the connected
org's webhook, traversed the entire pipeline on the live rig:

`POST /webhooks/docusign?customrecipient=true` (HMAC-signed)
 → classified **inbound** (server-side, from stored connected-account state)
 → `connector_artifact` (`_direction=inbound`, `_sending_account_id=<foreign>`, DocuSign-declared sha256)
 → `/jobs/drain-connector-artifacts` → **status `materialized`**
 → real anchors **ARK-DOC-JFQ9QR** and **ARK-DOC-DGHFW2**

| Property | Value |
|---|---|
| `fingerprint_source` on both inbound anchors | **`issuer_record_attestation`** (the honest "declared, NOT measured by Arkova" class) |
| `connector_source` | `docusign` |
| `_direction` | `inbound` |
| owning org | Soak Org A (the RECEIVING org) — correct attribution |
| `connector_artifact_id` linkage | present |
| document fetched from DocuSign | **never** (declared-hash path, by design) |
| PII (planted name/email) anywhere in anchors or artifacts | **0** |

This is problem #1 from the founder brief — "incoming contracts that we sign that originate from
another organization are not accounted for" — demonstrably working, with the correct weaker
evidence class rather than a false verification claim.

## Findings surfaced by running it for real (all environment/seed, none a code defect)
1. `docusign_integration_missing_refresh_token_secret` — the OUTBOUND path cannot fetch documents
   for synthetic orgs with no real DocuSign OAuth grant. Correct fail-closed behavior; it does NOT
   affect inbound, which never fetches. (Outbound document-fetch coverage requires a real
   DocuSign-connected account and is out of scope for a synthetic rig.)
2. Drain refused to anchor at **zero credit balance** — fail-closed billing working as designed.
3. Drain requires an `org_members` row with role `owner`/`admin` (NOT `profiles.role`) — a rig-seed
   requirement worth adding to `seed-baseline-fixture.sql` so future soaks don't rediscover it.
4. macOS bash 3.2 has no `declare -A`; the first supervisor died instantly. Verified rather than
   assumed — worth noting for every future soak driver on this host.
