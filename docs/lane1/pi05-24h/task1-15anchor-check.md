# Task 1 — 15-anchor proof-bundle check (SCRUM-2912) — Lane 1, 24h window 2026-07-20

**Mode:** read-only, independent explorer. **No repairs attempted** (repairs scheduled Jul 22–24 per plan).
**Explorer used:** `blockstream.info` public API — independent of Arkova's `mempool.space` UTXO/broadcast path.
**Prod ref queried (read-only, service-role, no writes):** `vzwyaatejekddvltxyye` (prod).
**Evidence artifact:** [`task1-blockstream-verify.json`](./task1-blockstream-verify.json)

## Result summary

| # | public_id | confirmed | block match | fingerprint on-chain | magic | explorer block |
|---|-----------|-----------|-------------|----------------------|-------|----------------|
| 1 | ARK-2026-D2959176 | ✅ | ✅ 952022 | ✅ | ARKV | 952022 |
| 2 | ARK-2026-547B119A | ✅ | ✅ 952123 | ✅ | ARKV | 952123 |
| 3 | ARK-2026-1F070188 | ✅ | ✅ 952123 | ✅ | ARKV | 952123 |
| 4 | ARK-2026-8F862179 | ✅ | ✅ 955960 | ✅ | ARKV | 955960 |

All **4** anchors currently owned by the HakiChain prod org verify **hash → tx → block** on an independent explorer:
- The document `fingerprint` stored on the anchor row is present verbatim in the transaction's `OP_RETURN`.
- OP_RETURN structure: `6a` (OP_RETURN) · `2c` (PUSHBYTES_44) · `41524b56` (`ARKV` magic) · `<32-byte fingerprint>` · `<8-byte suffix>`.
- Each tx is `confirmed=true` at the exact block height recorded in the DB.

Example (anchor 1) OP_RETURN payload:
`41524b56` `83204bbd57f6fd588a1f3458564b9b494de6a37231982cd1d17c6b12e290f018` `e78d227d111d0c3e`
— magic + fingerprint (matches DB `fingerprint`) + suffix.

## Defects / escalations

**D1 — 🔴 LAUNCH-CRITICAL: 11-anchor shortfall against the KPI-1 requirement (escalate to founder/CTO NOW).**
_Resolved authoritatively via Jira + Confluence + direct prod SQL (all read-only) once those connectors came online._
The SCRUM-2912 spec ([Confluence 107872257](https://arkova.atlassian.net/wiki/spaces/A/pages/107872257), updated Jul 17) requires HakiChain to have **access to the 15 anchors already issued and provisioned to their account, ≥24h before launch (by Aug 9, 9am EST)** — KPI-1 acceptance triggers the **first $250 invoice**. The spec carries a **founder correction (2026-07-17): "the 15 anchors exist today — the deliverable is the demo + confirmed access, not issuing anchors."**
**Prod contradicts that correction.** Definitive read-only count (`execute_sql` on prod `vzwyaatejekddvltxyye`): the HakiChain org (`f52cd07a…`) has **exactly 4 anchors — all SECURED — 1 member, 0 sub-orgs, 0 anchors received as recipient.** There is **no** set of 15 under their account; **11 are missing.**
**Impact:** KPI-1 (Aug 9) and the first invoice cannot be met as the spec assumes — either 11 more anchors must be issued+provisioned to the HakiChain account before Aug 9, or the "15 exist today" premise is wrong and the plan must change. **This is a scheduling/scope decision for the founder/CTO, surfaced now with buffer.** The 4 that exist are fully verified (below); the demo/verification tooling (Task 4) is ready for whatever set is provisioned.

**D2 — NO MATERIALIZED PROOF BUNDLE for these 4 (proof-materialization gap).**
None of the 4 anchors has a row in `anchor_proofs` (queried by `anchor_id in (...)` → 0 rows). These are **direct single-document fingerprint anchors** (fingerprint committed directly in OP_RETURN; no merkle batch, no `merkle_root`/`proof_path`), so they ARE independently verifiable by a stranger who has the source document (hash it → find it in the named tx's OP_RETURN → confirmed in block). **However**, the downloadable canonical `proof_bundle` packet (`/proof/{publicId}?format=signed`) will be **null** for these (FE proof-gate contract "state 1b: partial proof"). For a KPI-1/KPI-3 demo that shows a downloadable proof bundle, these 4 would present the honest empty-state, not a packet. Consistent with the known gap (2.97M SECURED vs ~6,110 STORED proofs). **Recommendation:** if the demo relies on a downloadable bundle (not just OP_RETURN inspection), the curated 15 should be drawn from STORED-proof anchors, or a targeted materialization run should cover the demo set (a scheduled Jul 22–24 repair item).

## Method note (reproducible)
1. Resolve HakiChain org by `display_name/legal_name ilike '*haki*'`.
2. Resolve members via `org_members`; query anchors by indexed `user_id` (org_id filter seq-scans the 2.97M table → statement timeout).
3. For each: `GET https://blockstream.info/api/tx/<chain_tx_id>`; assert `status.confirmed`, `status.block_height == DB.chain_block_height`, and the fingerprint is committed at the **canonical byte offset** of the OP_RETURN (ARKV magic at offset 0, fingerprint at bytes [4:36]) — a fixed-offset match mirroring the worker's `signet.ts:extractAnchorFingerprint`, **not** a substring scan.

## Verifier hardening (Bitcoin specialist review, applied)
The initial verifier used a loose `body.includes(fingerprint)` substring match — the exact pattern the worker's decoder explicitly rejects (BUG-2026-06-24-004). The KPI-3 tool ([`scripts/kpi3/external-verify.mjs`](../../../scripts/kpi3/external-verify.mjs)) was rebuilt to fixed-offset canonical matching **plus** full SPV (merkle-inclusion + block-header binding + confirmation-depth + optional treasury-issuer check), so it *verifies* against Bitcoin rather than *trusting* the explorer. The 4 anchors here re-pass under the hardened verifier (18/18 tests green; live rehearsal confirmed).

_Lane 1 (Trust & Chain), 2026-07-20 evening. Read-only; zero prod writes._
