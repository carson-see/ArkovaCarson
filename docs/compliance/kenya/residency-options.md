# Kenya Data-Residency — Deployment Options

**Story:** [SCRUM-899 KENYA-RES-01](https://arkova.atlassian.net/browse/SCRUM-899)
**Status:** v1 draft 2026-04-18 — benchmark + DPO review pending
**Owner:** Carson Seeger (engineering) + designated DPO (legal)
**Applies to:** Hakichain pilot + any Kenya-resident customer subject to the Data Protection Act, 2019 (DPA) and the Data Protection (General) Regulations, 2021.
**GCP-only:** we do NOT run on AWS in production (see `feedback_no_aws.md`). All options below are Supabase + GCP.

---

## 1. Scope of residency question

Arkova's client-side processing boundary (Constitution 1.6) means the **document itself never leaves the user's device**. What actually lands in Postgres for a Kenya-resident user is:

- `anchors` row (fingerprint, credential_type, org_id, user_id, status, timestamps, public_id) — **no document contents**.
- `extraction_manifests` row (PII-stripped structured metadata + confidence scores + zk_proof hash) — **no raw fields**.
- `audit_events` rows (lifecycle transitions, no personal data).
- Optional `attestations` (who attested what, evidence fingerprints only).

The residency question therefore scopes to this relatively small metadata footprint plus Supabase Auth PII (email, display_name) — **not** to document bodies. That materially changes the calculus of choosing a region.

## 2. Available regions (GCP + Supabase)

### 2.1 GCP regions

GCP has **no Nairobi region**. Our 2026-04-17 Hakichain sales response was wrong on this point and must be corrected in the pilot runbook.

| Region | GCP code | Distance from Nairobi (great-circle) | Typical HTTPS RTT from Nairobi | Notes |
|---|---|---|---|---|
| Johannesburg | `africa-south1` | ~2,900 km | ~90–120 ms | **Closest GCP region to Kenya.** Opened 2024-01. Full Vertex + Cloud Run + Storage coverage. |
| Milan | `europe-west8` | ~6,000 km | ~140–180 ms | GDPR adequate; common fall-back for African deployments. |
| Frankfurt | `europe-west3` | ~6,300 km | ~150–190 ms | GDPR adequate; GCP has best regional redundancy here. |
| Mumbai | `asia-south1` | ~4,500 km | ~180–230 ms | Indian DPDP adequate, **not** DPA adequate to Kenya by default. |

### 2.2 Supabase regions (Postgres hosting)

Supabase does **not** run in any African region today. The closest available paid-tier regions, with product availability notes per [Supabase regional matrix](https://supabase.com/docs/guides/platform/regions):

| Region | Supabase code | Distance from Nairobi | Edge Functions? | PITR? | Notes |
|---|---|---|---|---|---|
| Frankfurt | `eu-central-1` | ~6,300 km | Yes | Yes (Pro) | GDPR adequate; full product parity. Current prod region. |
| London | `eu-west-2` | ~6,700 km | Yes | Yes | GDPR adequate; UK-GDPR overlay. |
| Mumbai | `ap-south-1` | ~4,500 km | Yes | Yes | **Closest Supabase region.** No DPA adequacy decision from Kenya ODPC as of writing. |
| Cape Town | `af-south-1` | ~4,100 km | Yes | Yes | **Closest African Supabase region.** POPIA-resident. DPA adequacy unclear — see §4.2. |

**Corrected sales statement:** The accurate phrasing for the Hakichain doc is "Supabase Cape Town (`af-south-1`) + GCP Johannesburg (`africa-south1`)" — *not* "GCP Nairobi" or "AWS af-south-1".

## 3. DPA / ODPC adequacy framing

Kenya's DPA 2019 §48 + the Data Protection (General) Regulations 2021 Part VII govern cross-border transfers. The relevant mechanisms:

1. **Adequacy decision** by the ODPC — none issued yet (as of 2026-04). So you can't rely on this.
2. **Standard Contractual Clauses (SCCs)** — the ODPC has not published Kenyan SCCs but accepts EU Commission SCCs (2021) + local Annex IV when the importer is in an EU adequacy-designated country. Our Confluence [Kenya SCC annex](https://arkova.atlassian.net/wiki/spaces/A/pages/TBD) drafts this for Supabase Frankfurt.
3. **Binding Corporate Rules** — not available to a small vendor like Arkova.
4. **Data subject consent** — valid but fragile; only for occasional transfers.
5. **Contract necessity** — valid when the transfer is necessary for the contract between Arkova and the Kenyan data subject (this is Hakichain's likely basis).

**Operational implication:** any region we choose needs an SCC + DPIA entry. Frankfurt has the strongest precedent (GDPR adequacy recognized under Regulation 40 of the 2021 Regulations). Cape Town requires an argument that POPIA is substantially similar to the DPA (true for the obligations, but the ODPC has not formally ruled).

## 4. Recommendation

### 4.1 Default (today, for Hakichain pilot and any Kenya-resident customer)

**Stay on Supabase Frankfurt (`eu-central-1`) + add a GCP `africa-south1` deployment for latency-sensitive compute.**

Why:
- EU adequacy recognized under Reg 40 → cleanest legal basis via EU SCCs.
- Product parity with current prod; zero migration risk.
- Latency penalty of ~150 ms is acceptable for an async anchoring flow (we're not a real-time app).
- SCC Annex already drafted (see §4.3).

The GCP `africa-south1` deployment holds the worker-side compute that needs low RTT to Nairobi (e.g. real-time AI fallback pings), not the data plane.

### 4.2 Future (when Supabase opens Cape Town or Nairobi)

Re-evaluate. Supabase has signalled African region expansion; if `af-south-1` (Cape Town) becomes generally available with PITR + Edge Functions, the calculus shifts because:
- ~4,100 km / ~80–100 ms RTT (better UX).
- POPIA is "substantially similar" to the DPA on most points (consent, access rights, cross-border transfer).
- No SCC needed for Kenya → South Africa if ODPC publishes an adequacy decision for ZA (not yet done).

**Exit criteria for migration:** Supabase Cape Town offers PITR + Edge Functions + webhooks at Pro tier AND the ODPC has published an adequacy decision OR confirmed POPIA equivalence.

### 4.3 SCC + DPIA artefacts

Pending execution by the DPO (SCRUM-888 for external counsel engagement):
- **SCC Annex** referencing our Supabase Frankfurt processor → Kenya data exporter relationship. Template is EU Commission SCCs 2021 Module 2 (controller → processor).
- **DPIA** — existing draft at `docs/compliance/kenya/dpia.md` needs a §7 update referencing Frankfurt + `africa-south1` compute.
- **Privacy notice** — existing notice at `docs/compliance/kenya/privacy-notice.md` must state the two regions by name.

## 5. Latency benchmark (to be run)

Benchmark harness committed at `services/worker/scripts/bench/kenya-latency.ts` (see §Benchmark harness below). Will produce a table like:

| Source | Target | p50 RTT | p95 RTT | Concurrency |
|---|---|---|---|---|
| GCP Nairobi test VM | Supabase Frankfurt | TBD | TBD | 10 |
| GCP Nairobi test VM | Supabase Mumbai | TBD | TBD | 10 |
| GCP Nairobi test VM | Supabase Cape Town | TBD | TBD | 10 |

Results will land in a follow-up PR + the Confluence decision log.

## 6. Open questions (for the DPO)

1. Has the ODPC made a public adequacy determination for any GCP / Supabase region? (Best current answer: **no**.)
2. Does the ODPC accept EU Commission SCCs 2021 without local Annex IV? Practice says yes; no published guidance.
3. If Hakichain signs a DPA mentioning "GCP Nairobi" (fictitious), what's the cure path? (Plain-text amendment + disclosure in the next renewal.)

## 7. Cross-links

- [SCRUM-899](https://arkova.atlassian.net/browse/SCRUM-899) — this story.
- [SCRUM-576 Kenya ODPC registration](https://arkova.atlassian.net/browse/SCRUM-576) — still Blocked on external fee payment.
- [SCRUM-577 Kenya DPIA](https://arkova.atlassian.net/browse/SCRUM-577) — draft complete, Frankfurt region referenced.
- [REG-28](https://arkova.atlassian.net/browse/TBD) — designate DPO. Unblocks this doc's §6.
- [docs/compliance/kenya/odpc-registration.md](./odpc-registration.md) — registration filing checklist.
- [docs/compliance/kenya/dpia.md](./dpia.md) — DPIA v0.1.

## Benchmark harness

See `services/worker/scripts/bench/kenya-latency.ts` (committed alongside this doc).

## How to use this document

1. **Before mentioning a Kenya residency region to a customer, read §2 + §4.** Correct any stale reference to "GCP Nairobi" or "AWS af-south-1."
2. **Before proposing a region change**, run the benchmark in §5 against the candidate and attach the output to this doc.
3. **Before signing a DPA with residency commitments**, confirm the DPO has reviewed the SCC + DPIA artefacts in §4.3.
4. **If the ODPC publishes adequacy guidance**, update §3 and re-evaluate §4.2 exit criteria.
5. **When Supabase expands African regions**, trigger the §4.2 re-evaluation; record the decision here.
