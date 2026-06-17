# S0-E3 — CLAUDE.md v-next rationale (DRAFT — Carson reviews & merges)

> Sprint-0 epic S0-E3 (CTO+RTE author; **Carson-only merge** — constitution/rule change). This documents every edit so the diff review is fast and no load-bearing rule is silently lost.

## Size

| | origin/main | v-next | Δ |
|---|---|---|---|
| Lines | 291 | **299** | +8 (≤300 rule held) |
| ~Tokens (chars/4) | ~7,175 | ~7,628 | **+453** |
| git diff | — | +17 / −9 | surgical |

**Honesty note on the AC's "measured token reduction":** this v-next is a *net token increase* (+~453), because it ADDS four load-bearing encodings the AC required (manifest pointer, operating model, tiered-merge, drift + claims gates). I did **not** force a net reduction — safely cutting constitution prose needs your eyes (the AC also says "no load-bearing rule lost"). A reduction pass is proposed below as candidates for your call, not executed.

## Edits (all rule-preserving)

1. **§0.1 read-list** — bootstrap now includes the lane manifest + the session operating model + the `ack-claude-bootstrap.sh` step + "ACTIVE SOAKS (never disrupt)". (Encodes the manifest pointer + operating model.)
2. **§0 Sarah note bullet 2** — collapsed the duplicated read-list (now canonical in §0.1) to a pointer. *Duplicate removed; intent preserved.* **← please confirm this collapse.**
3. **§0 rule 10** — updated the stale trailing clause ("drop 0322/0323 exempt_regex once reconciled") to current truth: ledger reconciled numeric 2026-06-15; the full-ledger audit lands via SCRUM-2500 / S0-E4, which retires the exemptions.
4. **§1.6** — trimmed the historical "earlier revisions were drift" meta-commentary; the rule (default true in prod; off-prod false; no raw-mode bypass) is unchanged.
5. **§1.13 (NEW)** — encodes: one-lane-per-session (+ Sprint-0 train-led exception) → manifest; **tiered-merge** (council T0/T1 via Mergify; Carson sole T2/T3; path detector fails closed); **config-drift/parity gate (R-5)** → `scripts/ci/check-config-drift.ts`; **claims-review gate (R-7)**.
6. **§5** — re-pointed the roadmap from the SUPERSEDED PO Roadmap 27591934 to the canonical **12-Month Roadmap v3 (82444290)** + PI-1 Master (83296257).
7. **Footer** — version line records the DRAFT v-next amendment.

## Preserved-rules attestation

The 10-rule methodology (§0), the full constitution (§1.1–§1.12 incl. RLS/`FORCE ROW LEVEL SECURITY`, SECURITY DEFINER `search_path`, `generateFingerprint` browser-only, Stripe `constructEvent`, HMAC-SHA256 keys, §1.6/§1.6A boundaries, staging §1.11/§1.11A, soak matrix §1.12), the 7 gates (§3), the doc matrix (§4), §5.1 Jira conventions, §6 common mistakes, §7 env, §8 history pointer — **all retained**. Spot-grep confirms the key invariants still present (10 anchor hits). The diff is +17/−9 lines, none of which remove a rule.

## Proposed (NOT done) — token-reduction candidates for your call

- Collapse the **§0 Sarah note** fully into §0.1 + §1.13 (the "never-merge" point is already in rule 8 + §1.13; the "get caught up" point is now §0.1). Saves ~4 lines.
- Tighten **§1.11 / §1.11A** prose (very long; load-bearing — trim wording only, no substance).
- Fold **§0 rule 10** into §1.11A once SCRUM-2500's full-ledger audit ships (the manual reconciliation becomes the audit's job).

Each needs your sign-off because it touches the constitution. Happy to apply whichever you approve.
