# Proof-verdict fixture — rig `udpzylbccncnwvhbfjsu`

Built 2026-08-31 to unblock #2527 / #2489 / #2525, which were all stuck on the
same wall: **no rig had a materialised Merkle proof.** Every anchor on both the
shared rig and wave2 had `merkle_index=null` and an empty branch, so
`/api/v1/verify/:id/proof` returned `NO_BATCH_PROOF` / `proof_availability:
root_only` — the one branch where `verdict` is deliberately ABSENT. Any soak
would have driven only the verdict-absent path.

## The three states, and why the pair is a controlled experiment

| public_id | batch_id | merkle_index | branch | guard | verified | verdict |
|---|---|---|---|---|---|---|
| `ARK-PRFVAL-000001` | `BB-PROOF-FIX-A` | 0 | real 4-leaf branch | ARMED | true | `valid` |
| `ARK-PRFINV-000001` | `BB-PROOF-FIX-A` | 1 | **forged self-pair** | ARMED | false | `invalid` |
| `ARK-PRFUNV-000001` | `NULL` | 1 | **same forged self-pair** | unarmed | true | `unverifiable` |

`leaf_count` is not a stored column — it is `count(*)` over `anchor_proofs`
sharing `batch_id`. Batch `BB-PROOF-FIX-A` therefore holds exactly 4 rows so the
count resolves to 4 (two filler rows make up the number).

The last two rows are the point. **Same document fingerprint, same stored
branch, same committed root.** The ONLY difference is whether the guard could
arm — `batch_id NULL` leaves `leaf_count` unresolvable. So the pair isolates the
CVE-2012-2459 structural guard and nothing else.

The forged branch is a single self-pair: sibling == the leaf, with
`root = dsha256(L‖L)`. That makes it recompute to the committed root, so an
UNGUARDED verifier accepts it. `buildMerkleTree` only duplicates the rightmost
node of an odd level, so index 1 of a 4-wide level can never legitimately
self-pair — the guard must reject it.

## Proven, not assumed

Against the real `verifyMerkleInclusion` + `classifyInclusionVerdict`:

```
1 real branch, guard ARMED         armed=true  verified=true  verdict=valid
2 forged self-pair, guard ARMED    armed=true  verified=false verdict=invalid
     reason: branch[0] sibling equals running hash at a non-duplicated
             position — forged self-pair rejected (CVE-2012-2459)
3 forged self-pair, UNARMED        armed=false verified=true  verdict=unverifiable
```

And live over HTTP against the deployed worker (`git_sha` bound to the PR head):
all three states returned as above.

## The negative control — the probe CAN fail

Setting `batch_id = NULL` on `ARK-PRFINV-000001` (unarming its guard) and
re-running the driver:

```
invalid.forged_self_pair_rejected              FAILED
  status=200 verified=true verdict=unverifiable
discriminator.guard_arming_changes_the_verdict FAILED
  armed=unverifiable unarmed=unverifiable
```

The forged branch read `verified: true` the moment the guard could not arm —
the documented residual risk, reproduced live. The fixture was then restored and
the driver returned 26/26 checks clean. This is why the driver's assertions are
trustworthy: they have been made to fail, for the right reason.

## Known gap (from `/code-review`, 2026-08-31)

The two filler rows carry `proof_path '[]'` with `merkle_index` 2/3 inside the
batch, so `leafCount=4` ARMS the flag over an EMPTY branch. That is exactly
code-review finding 3 (`structuralGuardArmed` measures "options supplied", not
"guard did work"). Once the mapping is fixed the fixture should gain an explicit
probe for the single-leaf/empty-branch case.

## Reproduce

`/tmp/proof-fixture/build.mts` recomputes every hash from seed strings, so no
value here is a magic constant. Driver: `~/arkova-soak/proof-2527/driver-2527.mjs`.
