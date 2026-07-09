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

## Conventions

- Decision packs quote `file:line` against a named `origin/main` head — never
  assert code behaviour without a citation readable at that head.
- Distinguish *deploy-config/asserted reality* from *live prod runtime*; if a
  session did not query prod, say so explicitly rather than inferring.
- Chain-touching follow-ups specced here (provider default flip, gate
  hardening) land with their owning T3 PR, never via this folder.
