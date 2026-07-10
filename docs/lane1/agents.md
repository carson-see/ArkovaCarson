# docs/lane1/agents.md

Lane 1 (Trust & Chain) internal engineering notes and cross-lane contracts.
Per CLAUDE.md §0.4 these markdown files are internal engineering records, NOT
product documentation — the canonical specs live on Confluence.

## Files

- **`fe-proof-gate-contract-s2.md`** — FROZEN PI-0 Sprint 2 contract between
  Lane 1 (PROOF-04, SCRUM-2337) and Lane 2 (SCRUM-2501): the `ProofPacket`
  shape, download envelope, and `isProofDownloadable` gate. Changes after
  freeze are a handoff, not a reach-in.
- **`DISC-03-chain-posture-decision-pack.md`** — S3-C1 chain-posture decision
  record: code-verified reality (ARKV OP_RETURN marker, GetBlock
  header/inclusion-proof source, broadcast/UTXO/fee path table, WIF signing)
  + the four launch decisions (a)–(d) awaiting Carson's formal countersign +
  the R-5 parity-gate flip spec for the S3-P0 producer wave. HARD CONSTRAINT:
  no S3-P0 mainnet broadcast until (a)–(c) confirmed AND a real-DB/real-key
  soak proves the bytea header round-trip + no-double-broadcast-on-resume.

### Sprint 3.3 (PR #TBD — lane1/s33-txid-journal-design)

- **`s33-prod-drain-topology.md`** — L1-0 read-only prod audit (2026-07-10,
  gcloud-verified): the batch drain's REAL Scheduler triggers (`batch-anchors`
  30-min unforced UTC; `daily-anchor-flush` 03:00 **America/New_York**
  `?force=true`; `check-confirmations`; `recover-broadcasts` — ALL created
  out-of-band, none in `cloud-scheduler.sh`), NO `org-queue-scheduler` job in
  any location, the canonical per-trigger invariant PAIR (CTO R3 verbatim),
  and the binding rig-topology requirement (arm BOTH paths explicitly;
  in-process node-cron disabled or logged+attributed). Co-signed L1-0/L2-S6 —
  pending L2 ack.
- **`s33-txid-journal-design.md`** — L1-5 design: the B3 ambiguous crash
  window (network-accept → persist) that today's `recover_stuck_broadcasts`
  turns into a double-broadcast; pre-broadcast txid journal fix; 0355+ table
  design (NOT filed); post-07-12 wiring plan (`batch-anchor.ts` collides with
  soaking #1417); P2WPKH-non-malleability + RBF notes for protocol-specialist
  review. The pure decision core it specs IS shipped in the same PR:
  `services/worker/src/jobs/txid-journal.ts` (+34 red-first tests).
- **`s33-treasury-runway-paper-model.md`** — L1-6 paper model, **asserted
  from the fee model, NOT measured on-chain**: N-org drain cost multiplier
  (157 vB/tx via in-tree `estimateTxVsize`), runway sensitivity
  N ∈ {5,25,50,100} × r ∈ {2,10,50} sat/vB, UTXO pre-split cost line,
  assumptions enumerated A1–A8.
- **`s33-multiorg-harness-design.md`** — multi-org extension design vs merged
  #1463 `batch-drain-harness-lib.ts`: `zipfOrgPlan` distribution spec (≥30
  orgs, whale/long-tail knobs), poison-pill org set (credit-starved,
  bad-fingerprint), per-trigger assertion matrix (R3 pair), and the L1-2
  signet provision-script parameters that FOLLOW L2-S2a-FIX (net-new signet
  secret names, pre-clock signet probe, mempool.space-signet fallback wording
  for RTE pre-approval).

## Conventions

- Decision packs quote `file:line` against a named `origin/main` head — never
  assert code behaviour without a citation readable at that head.
- Distinguish *deploy-config/asserted reality* from *live prod runtime*; if a
  session did not query prod, say so explicitly rather than inferring.
- Chain-touching follow-ups specced here (provider default flip, gate
  hardening) land with their owning T3 PR, never via this folder.
