# Arkova Partner Integration Guide
## ComputeID / CortexOS — AgentPassport identity + document anchoring

_Internal engineering copy (2026-09-07). Canonical partner-facing versions: Confluence (epic SCRUM-4492 AUDIT page tree) and Drive "Arkova Partner Documentation". Per CLAUDE.md §4 this file is context, not the record._

**Audience:** ComputeID engineering (Praveen Gajjala) integrating CortexOS / Agent OS with Arkova.
**Agreement:** 12-month term from 2026-10-01. Arkova → ComputeID 500 anchors/month included; ComputeID → Arkova 100 AgentPassports/month; reciprocal $113/month; fingerprint-only boundary.

## Table of contents

1. What Arkova does
2. The boundary: fingerprints only
3. Getting started
4. Two integration directions
5. Direction A — CortexOS anchors documents with Arkova
6. Direction B — ComputeID AgentPassports act on Arkova
7. Revocation webhook contract (ComputeID → Arkova)
8. Rate limits, quotas and the credit model
9. Errors
10. Independent offline verification
11. What is measured, what is asserted, what is NOT asserted
12. Support and recommended sequence

---

## 1. What Arkova does

Arkova secures a document's fingerprint on the Production Network and issues a Network Receipt that anyone can verify later, with or without Arkova. A record answers two questions: was this exact document secured at this time, and under whose authority. With ComputeID the second question gains a machine-verifiable answer: the acting agent's AgentPassport and the organization key that admitted it.

## 2. The boundary: fingerprints only

Arkova never receives document bytes over the API. Your side computes the SHA-256 fingerprint; only the fingerprint plus bounded, personal-data-stripped metadata reaches Arkova. This is a hard architectural boundary on both sides of the partnership and it is why Agent OS can secure a document without the document leaving your customer's environment.

## 3. Getting started

1. Your ComputeID organization is provisioned by Arkova with the contract quota (SCRUM-4496). Log in at [app.arkova.ai](https://app.arkova.ai).
2. **Settings → API Keys → Create API Key.** The key is shown once (`ak_live_…`). Store it in your secrets manager. Use one key per environment.
3. For AgentPassport admission (Direction B) the organization key must carry the `agents:manage` scope.
4. SDKs: npm `arkova` (TypeScript/Node), PyPI `arkova` (Python), plus `arkova-mcp-server` for MCP-native agents. REST works everywhere; the base URL is `https://api.arkova.ai`.

## 4. Two integration directions

| Direction | Who calls whom | What it gives you |
|---|---|---|
| **A. Anchoring** | CortexOS → Arkova API | Every agent action or signed contract gets a verifiable Network Receipt. 500/month included; batch by default. |
| **B. Agent identity** | Agent (holding a ComputeID passport) → Arkova admission endpoint; ComputeID → Arkova revocation webhook | The passport is verified offline against ComputeID's CA, bound to an Arkova agent record, and issued a restricted key. Revocation on ComputeID's side stops future actions on Arkova. |

Direction B is shipped flag-gated and turns on after activation (SCRUM-4495). Everything in Direction A is live today.

## 5. Direction A — CortexOS anchors documents with Arkova

### 5a. Secure one document (batch by default)

```bash
FINGERPRINT=$(sha256sum decision-record.pdf | awk '{print $1}')

curl -X POST https://api.arkova.ai/api/v1/anchor \
  -H "X-API-Key: $ARKOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"fingerprint\": \"$FINGERPRINT\",
    \"documentType\": \"agent_action\",
    \"credentialType\": \"AGENT_DECISION\",
    \"description\": \"Agent OS action record\"
  }"
```

The response carries a `publicId` (`ARK-…`) and `status: PENDING`. Records queue and are secured either when the queue reaches 10,000 or once every 24 hours, whichever comes first — that is how the per-record economics stay where they are. Submitting the same fingerprint twice returns the same public ID; re-anchoring is a safe no-op.

### 5b. Instant securing (uses a credit)

When a record needs its own timestamp at that moment — a signed contract, a high-stakes agent decision — request instant securing. It consumes one instant credit (15/month included, more can be added). Default agent actions should stay on the batch path; expose instant as an explicit option only where warranted, as agreed on 2026-08-13.

### 5c. Bulk securing

Up to 1,000 fingerprints per call; counted as one request against rate limits; one credit per record. Use `dryRun: true` to validate rows without deducting credits.

### 5d. Verify a record (no API key needed)

```bash
curl https://api.arkova.ai/api/v1/verify/ARK-2026-00418
```

Returns `verified`, `status` (ACTIVE / REVOKED / EXPIRED / SUPERSEDED / UNKNOWN), `issuerName`, `anchorTimestamp`, `networkReceiptId`, `recordUri`. Batch verification accepts up to 20 public IDs per call.

### 5e. Outbound notifications (Arkova → CortexOS)

Register a webhook for `anchor.secured`, `anchor.revoked`, `anchor.expired`, `anchor.superseded`. Every delivery carries `X-Arkova-Signature`, `X-Arkova-Timestamp`, `X-Arkova-Event`; verify `HMAC-SHA256(secret, "${timestamp}.${rawBody}")` (hex) and reject timestamps older than five minutes. Endpoints can be listed, tested, disabled and deleted programmatically.

## 6. Direction B — ComputeID AgentPassports act on Arkova

### 6a. Flow

1. ComputeID issues the AgentPassport, scoped to the agent's capabilities.
2. The agent obtains its verification receipt from ComputeID: `GET https://api.aicomputeid.com/v1/agents/{passport_id}/verify` → `verification_receipt`.
3. The agent (or the org's integration on its behalf) presents the passport id and the receipt to Arkova.
4. Arkova verifies the receipt **offline** against its pinned copy of ComputeID's CA (RSA-SHA256 over the exact `receipt_payload` bytes; key id `ebb276c2f18ed34f`). No call to ComputeID is made on this path, so ComputeID uptime never gates admission.
5. Arkova binds the passport to a new agent record and issues an agent-scoped key. The key is bound to the agent record, which names the passport and the organization key that admitted it. **Per-record attribution (the acting agent named on each secured record) is planned for the next release (SCRUM-4497) and is NOT asserted today.**

### 6b. Admission request

```bash
curl -X POST https://api.arkova.ai/api/v1/agents/computeid/admit \
  -H "X-API-Key: $ARKOVA_ORG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "passport_id": "0d8f7c1e-2a1b-4c3d-9e8f-1a2b3c4d5e6f",
    "verification_receipt": { ...the verification_receipt object exactly as ComputeID returned it... },
    "name": "cortex-agent-7",
    "allowed_scopes": ["verify", "anchor:write"]
  }'
```

- Caller: an organization API key with `agents:manage`. The key's creator is recorded as the authorizing principal.
- `allowed_scopes` is clamped to `verify`, `verify:batch`, `anchor:write`, `write:anchors`, `anchor:read`, `read:records`, `read:search`; management scopes are never granted to a passport agent. Default is `["verify"]`. The legacy `verify` scope also satisfies `anchor:read`, `oracle:read` and `attestations:read`; these read capabilities are part of its effective grant.
- Arkova admission policy limits a receipt to 24 hours of validity and requires expiry after issuance; partner compatibility must be confirmed before activation. A recorded provider revocation is terminal across organizations, even if a newer receipt is presented.
- Pass the receipt object through **unchanged**. Arkova verifies the signature over the `receipt_payload` string byte-for-byte; re-serializing it will fail verification.

### 6c. Admission response (201)

```json
{
  "agent": { "id": "…", "name": "cortex-agent-7", "status": "active", "agent_type": "llm_agent", "allowed_scopes": ["verify", "anchor:write"], "created_at": "…" },
  "binding": { "issuer": "computeid", "passport_id": "0d8f7c1e-…", "bound_at": "…", "receipt_expires_at": "…" },
  "key": "ak_live_…",
  "key_id": "…",
  "key_prefix": "ak_live_abcd",
  "scopes": ["verify", "anchor:write"],
  "warning": "This is the only time the raw API key will be shown. Store it securely."
}
```

The agent then uses `key` for Direction A calls.

### 6d. Admission errors

| HTTP | `error.code` | Meaning |
|---|---|---|
| 503 | `vendor_gated` | Integration not yet activated in this environment |
| 401 | `api_key_required` / `authentication_required` | No organization key presented |
| 403 | `insufficient_scope` | Key lacks `agents:manage` |
| 400 | `invalid_request` | Body shape invalid (Zod issues returned) |
| 401 | `receipt_invalid` + `reason` | `invalid_signature`, `key_id_mismatch`, `expired`, `not_yet_valid`, `status_not_active`, `passport_id_mismatch`, `payload_field_mismatch`, `malformed_payload`, `malformed_signature`, `unsupported_algorithm` |
| 400 | `no_permitted_scopes` | Every requested scope is outside the allowlist (`permitted` lists it) |
| 409 | `passport_already_bound` | A live agent in this organization already holds the passport |
| 409 | `passport_revoked` | ComputeID terminally revoked this passport; a fresh receipt cannot reissue it |

The shared authentication guard on `/api/v1/agents/computeid/*` returns the flat legacy shape for 401/403: `{ "error": "authentication_required" | "insufficient_scope", "message": "…", "required": "agents:manage", "granted": [...] }` — key on `error` there, not `error.code`.

## 7. Revocation webhook contract (ComputeID → Arkova)

Arkova registers one endpoint with ComputeID: `POST https://api.arkova.ai/webhooks/computeid`, events `passport.revoked`, `passport.suspended`, `passport.reinstated`, signed `X-ComputeID-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`.

What Arkova does with each event, for every agent bound to that passport:

| Event | Effect on Arkova |
|---|---|
| `passport.revoked` | Agent status → `revoked`; every key issued to that agent is deactivated. **Terminal.** Records already secured are untouched — revocation stops future actions, it never rewrites history. |
| `passport.suspended` | Agent status → `suspended`; **every key issued to that agent is deactivated** (the API-key check is where access is enforced). |
| `passport.reinstated` | A suspension **Arkova applied from your event** is lifted and its keys restored. A suspension applied by the organization itself is never lifted by a partner event. Ignored for a revoked agent. |

Ordering: authenticated `passport.revoked` is terminal across organizations and overrides local receipt/event floors. Revocation is recorded even when no agent is bound yet. Suspension and reinstatement follow the signed timestamp, with reinstatement requiring a strictly newer timestamp; a same-time event cannot relax a suspension. Timestamps over five minutes ahead are rejected and recorded for investigation; accepted timestamps are canonicalized and the stored clock is capped at receipt time. Arkova answers `409 conflict_retry` when a bound agent changed concurrently and `5xx` if a transaction fails; please redeliver both. Repeated revocations still enforce every affected agent after partial delivery failures.

What Arkova needs from ComputeID for this to be production-grade (tracked as SCRUM-4498): an API key for Arkova; the retry policy for non-2xx; authentication and a delete/rotate path on `/v1/webhooks/register`; one real `passport.revoked` delivery against Arkova's staging endpoint during the soak window.

## 8. Rate limits, quotas and the credit model

| Surface | Limit |
|---|---|
| Public verify (no key) | 100 req/min per IP |
| API-key endpoints | 1,000 req/min per key |
| Batch verify | 10 req/min per key, up to 20 IDs each |
| Bulk secure | 1 request per call, up to 1,000 records |
| Admission | shares the batch limiter |

`429` responses carry `Retry-After`. Contract quota: 500 records/month and 15 instant credits/month included; prepaid tiers $0.10/record (1,000–99,999) and $0.05/record (100,000+), locked for the initial term. One credit per record is deducted at queue time; at zero balance, securing calls return `402 insufficient_credits` while records already queued continue to completion.

## 9. Errors

Endpoints added for this integration return `{ "error": { "code": "…", "message": "…" } }`. The shared authentication guard (401/403 on `/api/v1/agents/computeid/*`) and legacy endpoints return the flat `{ "error": "…", "message": "…" }` shape. Codes are stable; messages are not. Never key logic on the message text.

## 10. Independent offline verification

Arkova publishes an open verifier (CLI and Python) that checks a Network Receipt against the public network without contacting Arkova. Ship it with your audit tooling so a record remains verifiable if Arkova is unreachable. See the HakiChain guide §10 for the current commands; the same tools apply.

## 11. What is measured, what is asserted, what is NOT asserted

- **Measured:** that a fingerprint was included in a record secured on the Production Network at the Network Observed Time; that a receipt from ComputeID's CA validated at admission; the timestamps of each passport event Arkova applied.
- **Asserted (by the submitter):** document type, description, the agent's name and requested scopes, the passport's capabilities as issued by ComputeID.
- **NOT asserted:** the content or legal effect of any document; that the agent's action was authorized beyond the scopes on its key; ML-DSA-65 verification — ComputeID's CA publishes an RSA key only, so Arkova verifies the RSA receipt; per-record acting-agent attribution on secured records (planned, SCRUM-4497); that a revocation reaches Arkova if ComputeID's delivery fails (a scheduled re-check is planned, SCRUM-4497).

## 12. Support and recommended sequence

1. Provisioned org + key (Arkova) · 2. Secure one record on batch, verify it · 3. Register an outbound webhook · 4. After activation: admit one passport, secure with the agent key, revoke it on ComputeID and watch the agent stop · 5. Bulk path.

Engineering contact: carson@arkova.ai.
