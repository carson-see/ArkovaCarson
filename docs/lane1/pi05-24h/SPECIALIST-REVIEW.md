# Specialist review pass — Lane 1 PI-0.5 24h deliverables (2026-07-20)

Five specialists reviewed the Task 1–9 deliverables in parallel, read-only under the window rules (Bitcoin, DBA, Architect, AI, Performance). Findings verified, then applied. Net: **one CRITICAL code bug fixed, two root-cause claims corrected, several counts re-scoped to honest bounds.** Nothing merged; all changes are branch-local.

## Highest-impact outcomes
1. **KPI-3 verifier had a CRITICAL correctness bug** (Bitcoin C1): it used a loose `body.includes(fingerprint)` substring match — the exact pattern the worker's own decoder (`signet.ts:extractAnchorFingerprint`, BUG-2026-06-24-004) explicitly rejects. **Rewritten** to fixed-offset canonical matching + genuine SPV (merkle-inclusion, block-header binding, confirmation-depth, optional treasury-issuer). Now 18/18 tests (was 7/7), live rehearsal passes with real merkle/header verification.
2. **Task 5 drain root-cause MECHANISM was wrong** (Architect HIGH-1): the prod drain is commit-safe (`broadcastSignedTx` infallible-after-wire; Phase 3c graceful returns; the un-caught throw is legacy-only). The real defect is the scheduler's **over-broad `try`** (wrapping its own record/emit) plus a **`SUCCEEDED/0` undercount**, not throw-after-commit `failed/0`. Severity downgraded from "guaranteed under load." **Conclusion (money-safe, reporting lies, SCRUM-2620 latent) survives.** Task 5 rewritten.
3. **Cross-deliverable contradiction** (Architect HIGH-2): Task 5 asserted "feeders paused / 0 PENDING" (stale HANDOFF) while Task 9 observed feeders ENABLED + a live SUBMITTED anchor. Reconciled — "0 PENDING" marked unverified; SECURED total labeled an estimate everywhere.

## Findings + resolutions

### Bitcoin (KPI-3 verifier, Task 1/4)
- **C1 CRITICAL — substring match** → fixed-offset canonical decode (`extractCanonicalFingerprint`). FIXED + regression test.
- **H1 HIGH — no issuer binding** ("on Bitcoin" ≠ "by Arkova") → added optional `--issuer` treasury-address check (`vin[0].prevout`). FIXED; claim scoped in runbook (§1.5).
- **H2 HIGH — explorer-trust, no merkle/depth** → added confirmation-depth gate + merkle-inclusion + header-hash binding (real SPV). FIXED.
- **M1 MED — only first OP_RETURN inspected** → iterate all. FIXED.
- **M2 MED — decode edge cases** → length validation, canonical single-push enforced. FIXED.
- **L1 LOW — fabricated block hash in fixture** → replaced with real values (hash, header, merkle root, treasury). FIXED.
- **L2/L3 LOW — NaN block arg / doc wording** → `Number.isInteger` guard; docs describe canonical-offset + SPV. FIXED.

### DBA (Tasks 2/3/6/7)
- **HIGH-1 — 2.98M is an upper bound, not the INSERT set** → Task 3 relabeled; insert authority = per-anchor `classifyAnchor`-with-cardinality, insert only on `direct_anchored`. FIXED.
- **HIGH-2 — 0340 exposure overstated + unsafe predicate** → reframed to forward direct anchors (trigger short-circuits on already-SECURED); safe predicate requires `op_return_payload IS NOT NULL`, drops `already_complete` from the OR. FIXED.
- **HIGH-3 — Task 6 query int-overflows on timestamp versions** → guarded `CASE WHEN version ~ '^[0-9]{4}$' THEN version::int`. FIXED.
- **MED-1 — batch_id rollback sentinel collides with partial index + class-only rollback unsafe** → dedicated `materialize_run_id` marker; rollback not scoped by class alone. FIXED.
- **MED-2 — Task 6 over-claims TS parity; hardcoded exemptions** → parity claim narrowed; exemptions driven from `ledger-numeric-exemptions.json`; 0350–0353 gap framing reconciled. FIXED.
- Confirmed correct: `receipt_id:=chain_tx_id`, `ON CONFLICT(anchor_id)` idempotency, census `anchor_proofs` numbers exact, W4 checkpoint finding.

### Architect (Tasks 2/3/5/9)
- **HIGH-1 / HIGH-2** (above) → Task 5 rewritten; scaffolding corrected.
- **MED-1 — Task 9 n=1 overread** ("pipeline operational right now") → softened to a single event + job-state divergence; architectural reconciliation (no prod org-queue-scheduler → SCRUM-2620 latent) confirmed correct.
- **MED-2 — three SECURED totals** → all labeled estimates; exact `anchor_proofs=6,110` used as the stable anchor.
- Confirmed correct: Task 2 W4 finding + `no_checkpoint` recommendation; Task 3 internal consistency + §1.5 honesty.

### AI (Task 8b, §1.6 boundary)
- **F1 MED — hashing-domain mismatch** (combined-PDF SHA-256 ≠ DocuSign per-document digest; hard match-or-hold gate would hold ~100%) → downgraded to corroborating-metadata-only until domains aligned. FIXED.
- **F2 LOW — "anchor today" overstates** (connectors flag-off, zero connector docs anchored) → reworded to "designed path." FIXED.
- Boundary checks PASSED: §1.6/§1.6A honored; no AI-extraction on connector bytes; embeddings isolated from `proof_bundle`.

### Performance (KPI-3 + prod scale)
- Verifier: **2.8M ops/sec, strictly O(n)** decode; per-record wall-clock is 100% explorer RTT (~0.26s × ~4 fetches ≈ ~1s/record; 15-record run < 1 min). Not a bottleneck.
- **F1 — bare `count=estimated` SECURED is unstable** (13s→22s→timeout) → materializer/monitoring must derive progress from cursor, never a bare estimated count. Applied to Task 2/3.
- **F2 — CREATE INDEX CONCURRENTLY has ALREADY failed on this prod DB** (3 invalid indexes in baseline) → Task 7 now budgets a verify-and-reindex step outside the materialize window.
- **F3 — `chain_tx_id IS NULL` seq-scans/times-out even at LIMIT 1** → never add that filter to a materializer scan. Applied to Task 3.
- **F4 — pagination + cardinality probes index-backed**; the scale wall is the ~2.98M probes (~1–3h), inherent, handled by concurrency + resumability. Noted in Task 3.

## Post-review closures (Jira + Supabase MCP came online mid-session)
- **Task 1 D1 — RESOLVED into a 🔴 launch-critical finding.** SCRUM-2912 spec (Confluence 107872257) requires HakiChain access to **15 already-provisioned anchors** by Aug 9 (first-invoice trigger); direct prod SQL shows the HakiChain account has **exactly 4** (0 sub-orgs, 0 received). **11-anchor shortfall** — escalated to founder/CTO.
- **Task 2 A1 — RESOLVED.** `secured_without_tx = 0` (exact, direct SQL); zero false-SECUREDs confirmed. Exact SECURED = **2,974,768**; no-proof-row = **2,968,658**.

## Residual (not fixed in-window, flagged)
- Exact `direct` vs shared-tx split needs the GROUP BY chain_tx_id aggregate (timed out on prod even via direct SQL) — run on an isolated mirror. Now bounded ≤2,968,658 with `secured_without_tx=0`.
- Task 6 query change is documented, not executed (0358 not yet applied).

_Lane 1 (Trust & Chain), 2026-07-20 evening. Review read-only; fixes branch-local; no merges/pushes._
