# Credential Engine — Consuming Smoke Evidence

**Run:** 2026-08-12, ~15:4x UTC
**Ticket:** SCRUM-2993 (also satisfies SCRUM-2311 / SCRUM-2870)
**Requested by:** Jeanne Kitchens, Credential Engine, on the 2026-06-02 Developer Integration Program call, and reiterated since. This is the concrete deliverable CE has been waiting on.
**Operator:** CTO session
**Credential:** GCP Secret Manager secret `Credential_Engine` (project `arkova1`). The value was never printed, logged, or written to any artifact; it was piped directly into `curl` and unset after each leg.

> **Trial-agreement scope.** The Complimentary Evaluation and API Trial Agreement permits "internal testing, evaluation, and use case development only." This run is exactly that: read-only consuming, no writes to any Credential Engine surface, no Registry data retained beyond the evidence quoted here.

> **Soak isolation.** No Arkova staging rig, Cloud Run service, or database was touched. Every request in this run went to a Credential-Engine-owned host. The `arkova-worker-fullsoak-2026-08-staging` and `arkova-worker-connector-sidecar-2026-08-staging` soaks were verified running before the run and were not contacted.

---

## 1. Result summary

| Leg | Result |
|---|---|
| Control: authenticated Search **without** the key | **HTTP 401** — the key is load-bearing |
| Authenticated Search API, 3 queries | **3/3 HTTP 200** |
| CTID → public graph resolution, 5 CTIDs | **5/5 HTTP 200, 5/5 round-trip CTID match** |
| Fabricated CTID (honesty check) | **HTTP 404**, no fabricated status |
| Course-code → CTID resolution | **Works, but only with an exact-match operator.** See §4 — this is the substantive finding. |

**The trial key is valid and authenticating as of 2026-08-12.** This had never been verified before this run.

---

## 2. Control — the key is actually load-bearing

Identical request body, only difference is the `Authorization` header.

```
POST https://apps.credentialengine.org/assistant/search/ctdl
(no Authorization header)                       -> HTTP 401
Authorization: Bearer <key>                     -> HTTP 200
```

This control matters. Arkova's existing CE integrations all read `credentialengineregistry.org/graph/<ctid>`, which is **fully public and requires no credential** (independently verified the same day by unauthenticated fetch). A smoke run only against that endpoint would prove nothing about the key. The authenticated Search API is the leg that exercises the trial credential.

---

## 3. Search leg — authenticated, 3/3 green

| # | Query | HTTP | TTFB | Bytes | Results |
|---|---|---|---|---|---|
| 1 | `@type: ceterms:Course`, `name: "welding"` | 200 | 1.34 s | 39,625 | 3 |
| 2 | `@type: ceterms:LearningOpportunityProfile`, `name: "nursing assistant"` | 200 | 2.50 s | 26,126 | 3 |
| 3 | `@type: ceterms:Certificate`, `name: "medical coding"` | 200 | 2.04 s | 13,571 | 3 |

Request shape that works (the `Sort` field is required — omitting it produced HTTP 400 after a 60 s TTFB on three separate attempts):

```json
{
  "Query": { "@type": "ceterms:Course", "ceterms:name": "welding" },
  "Skip": 0,
  "Take": 3,
  "Sort": "search:relevance"
}
```

---

## 4. Course ID → CTID — the actual use case, and the finding

This is the flow CE asked about and the one Jeff Grann described as the "wand problem": given a provider's course identifier, find the Registry CTID.

Target record, confirmed to exist and to carry an exact `ceterms:codedNotation`:

```
ceterms:ctid            ce-0db4c4a1-f5d4-4e01-8e0c-4544aba6e876
ceterms:codedNotation   WELD 207
ceterms:name            WELD 207 - Gas Metal Arc (MIG) Welding
@type                   ceterms:Course
```

Three query forms against `ceterms:codedNotation`, all HTTP 200:

| Form | Query value | Results | Rank of the correct record |
|---|---|---|---|
| A. Plain string | `"WELD 207"` | 10 | **9th** |
| B. Quoted phrase | `"\"WELD 207\""` | 10 | **9th** |
| C. Exact-match operator | `{"search:value":"WELD 207","search:matchType":"search:exactMatch"}` | **1** | **1st** |

**Finding: `codedNotation` matching is tokenized full-text with relevance ranking, not exact matching.** Form A returned `WELD 108`, `EN 207` and `CIS 207` ahead of the exact match — it is matching the tokens `WELD` and `207` independently. In an earlier `Take: 3` run the correct record did not appear at all.

**Consequence for any integration:** a naive `codedNotation` lookup will silently resolve to the *wrong course*. Course-ID → CTID resolution is only safe with `search:matchType: search:exactMatch`, which returned exactly one result and the right one.

This is the single most useful thing this smoke produced, and it is worth raising with CE directly — both to confirm the operator is the intended mechanism for identifier resolution, and because it is an easy trap for any other consumer building the same flow.

---

## 5. Resolution leg — CTID → public graph, 5/5 round-trip match

`GET https://credentialengineregistry.org/graph/<ctid>` (no credential required).

| # | CTID | HTTP | @type | Round-trip | Name |
|---|---|---|---|---|---|
| 1 | `ce-02a40ede-139a-428a-b22c-21bc2e2c6c18` | 200 | `ceterms:Course` | MATCH | Advanced Shielded Metal Arc Welding |
| 2 | `ce-0db4c4a1-f5d4-4e01-8e0c-4544aba6e876` | 200 | `ceterms:Course` | MATCH | WELD 207 - Gas Metal Arc (MIG) Welding |
| 3 | `ce-004874e6-0829-44b5-8e2b-4e57a16a5b7e` | 200 | `ceterms:LearningOpportunityProfile` | MATCH | Certified Clinical Medical Assistant Associate |
| 4 | `ce-00860b21-8f71-49a4-8653-e3f9b55e51c7` | 200 | `ceterms:LearningOpportunityProfile` | MATCH | Dental Assistant |
| 5 | `ce-00607dc7-1a2e-48bb-9a02-6eafe4aff7d5` | 200 | `ceterms:Certificate` | MATCH | Medication Aide In-Service Education |

"Round-trip MATCH" means the `ceterms:ctid` inside the returned `@graph` node equals the CTID that was requested.

---

## 6. Negative / honesty handling

```
GET /graph/ce-00000000-0000-4000-8000-000000000000  -> HTTP 404
```

A non-existent CTID returns a clean 404. No fabricated status, no empty-but-successful envelope that could be mistaken for a real record. This is the behaviour Arkova's CTID guard already assumes.

---

## 7. Operational observations

1. **`Sort` is effectively required.** Omitting it returned HTTP 400 after a **60-second** TTFB on three separate attempts. A malformed query is expensive to be told about, so client-side validation before the call is worth having.
2. **Latency is variable.** Successful Search calls returned in 0.8–2.5 s. The public graph endpoint separately exhibited a transient stall the same day: three consecutive requests held the connection open with TLS established and returned zero bytes for 90 s, then recovered on its own. Single episode, `n=1`, not characterised further. Every outbound call needs a bounded timeout regardless.
3. **No rate limiting was observed** across roughly 20 requests in ~15 minutes. Credential Engine publishes no documented limits for either API. This is not evidence that no limit exists.

---

## 8. What this evidence does and does not establish

**Establishes:**
- The trial API key is valid and authenticating on 2026-08-12.
- The authenticated Search API is reachable and returns well-formed CTDL.
- CTID → record resolution round-trips correctly against the public registry.
- Deleted/non-existent CTIDs fail honestly with a 404.
- Course-ID → CTID resolution is achievable, with the exact-match caveat in §4.

**Does not establish:**
- Anything about **publishing**. This run is read-only. Arkova has no publish path in the codebase and has never written to the Credential Registry. See SCRUM-3132.
- Anything about **sandbox** access, which remains unconfirmed (SCRUM-1938). This run used production, which the trial agreement permits for internal testing and evaluation.
- Any rate limit, quota, or throttling ceiling.

---

## 9. Follow-ups raised by this run

| Item | Owner |
|---|---|
| Ask CE to confirm `search:exactMatch` is the intended mechanism for identifier-based resolution (§4) | Carson, CE meeting |
| Ask CE whether documented rate limits exist for the Search and Assistant APIs | Carson, CE meeting |
| Encode the exact-match requirement in any course-ID → CTID implementation (SCRUM-1921) | Engineering |
| Confirm sandbox access (SCRUM-1938) before any publish work | Carson, CE meeting |

---

_All figures in this document were produced by the run described. No value from the `Credential_Engine` secret appears anywhere in this file._
