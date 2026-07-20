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

**D1 — CANONICAL SET UNDEFINED IN-SESSION (escalate to RTE/CTO).**
The task names "15 HakiChain pre-issued anchors," but prod holds exactly **4** anchors under the HakiChain org (`f52cd07a-6d8a-4387-9346-23babec84e5c`; sole member = owner `23f09d51…`; the `[SANDBOX] hakichain` org `ca1c9a22…` has zero members). The authoritative list of 15 is defined in **SCRUM-2912 / the KPI-1 demo doc**, which was not reachable this session (Atlassian/Drive connectors unauthorized in headless run). **Need:** the canonical 15 `public_id` list from SCRUM-2912 (or confirmation the KPI-1 set is a curated cross-org showcase, not HakiChain-org-owned). The remaining 11 could not be identified from repo, prod-by-org, or prod-by-owner — they are **not verifiable until the list is supplied.** This does not block: the 4 identified HakiChain anchors are green.

**D2 — NO MATERIALIZED PROOF BUNDLE for these 4 (proof-materialization gap).**
None of the 4 anchors has a row in `anchor_proofs` (queried by `anchor_id in (...)` → 0 rows). These are **direct single-document fingerprint anchors** (fingerprint committed directly in OP_RETURN; no merkle batch, no `merkle_root`/`proof_path`), so they ARE independently verifiable by a stranger who has the source document (hash it → find it in the named tx's OP_RETURN → confirmed in block). **However**, the downloadable canonical `proof_bundle` packet (`/proof/{publicId}?format=signed`) will be **null** for these (FE proof-gate contract "state 1b: partial proof"). For a KPI-1/KPI-3 demo that shows a downloadable proof bundle, these 4 would present the honest empty-state, not a packet. Consistent with the known gap (2.97M SECURED vs ~6,110 STORED proofs). **Recommendation:** if the demo relies on a downloadable bundle (not just OP_RETURN inspection), the curated 15 should be drawn from STORED-proof anchors, or a targeted materialization run should cover the demo set (a scheduled Jul 22–24 repair item).

## Method note (reproducible)
1. Resolve HakiChain org by `display_name/legal_name ilike '*haki*'`.
2. Resolve members via `org_members`; query anchors by indexed `user_id` (org_id filter seq-scans the 2.97M table → statement timeout).
3. For each: `GET https://blockstream.info/api/tx/<chain_tx_id>`; assert `status.confirmed`, `status.block_height == DB.chain_block_height`, and `DB.fingerprint` substring of the OP_RETURN vout `scriptpubkey`.

_Lane 1 (Trust & Chain), 2026-07-20 evening. Read-only; zero prod writes._
