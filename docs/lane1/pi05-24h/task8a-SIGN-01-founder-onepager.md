# SIGN-01 — Founder decision one-pager: proof signatures for the pilot (D5)

**Decision owner:** Carson (founder) · **Needed by:** Jul 24 · **Prepared by:** Lane 1 (Trust & Chain)

## The one decision
Before the pilot, do we **turn on cryptographic signatures** on Arkova proof bundles, or **ship unsigned** and say so plainly?

## What's true today (verified live, 2026-07-20)
- Prod publishes **zero signing keys** — `https://docs.arkova.ai/keys.json` returns `keys: []` with the notice: *"signed proof envelopes (?format=signed) are not yet enabled in production. Unsigned proof bundles remain independently verifiable without any key."*
- **The Bitcoin proof does not need an Arkova signature.** A stranger verifies a record by hashing the document and finding that hash in the Bitcoin transaction's OP_RETURN, confirmed in a block — with zero help or keys from us. We proved this end-to-end this week on 4 live records (Task 1) and built the stranger's verifier + a "fake proof gets rejected" demo (Task 4). **The KPI-1/KPI-3 pilot promise is already met without signatures.**
- The signing machinery **exists and is ready**: an Ed25519 key already lives in our KMS (`proof-signing`, private key never leaves KMS); enabling it is a config wire-up + redeploy, not new engineering.

## What a signature would add
A detached Arkova signature says *"Arkova asserts this proof envelope came from us."* It does **not** make the record more true — the Bitcoin chain already does that. It mainly helps a verifier who wants to trust the **convenience packet** we hand them (the bundled JSON) without re-deriving everything from the chain themselves.

## Options
| | A. Enable signing now | B. Lock "no signature" language |
|---|---|---|
| **What ships** | Wire the KMS key into prod; `?format=signed` returns signed bundles; publish the public key at `keys.json` | Pilot materials + proof bundles state plainly "unsigned; verify on-chain" |
| **Effort / risk** | Low effort, but adds a **key-rotation & revocation responsibility** we own for the pilot's life; a mis-set key = 503s on signed requests | Zero effort; nothing new to operate |
| **Pilot impact** | Nicer story for partners who ask "is this signed by you?" | Fully honest; on-chain verification unaffected; **HakiChain's KPI is still met** |
| **Reversibility** | Can enable later anytime (historical unsigned bundles stay valid) | Can turn signing on later without breaking anything |

## Recommendation
**Option B for the pilot — ship unsigned, lock the honest language — with A as a fast follow if a partner explicitly requires a signature.** Rationale: the pilot's verifiable-record promise is met by Bitcoin alone (proven), signing adds an operational key-management burden during the most fragile launch window, and enabling it later is non-breaking. This also keeps our proof copy honest under §1.5 (state what is asserted vs not) — we would not claim a signature we don't apply.

**If you choose A:** Lane 1 wires `PROOF_SIGNING_KEY_ID` + publishes the public key; ~half a day, needs a staging soak before prod. **If you choose B:** we lock "unsigned — independently verifiable on Bitcoin" across pilot materials and the proof UI, and file the signing enablement as a post-pilot item.

_One line to reply with: **"SIGN-01: A (sign now)"** or **"SIGN-01: B (unsigned, lock language)."**_

_Lane 1, 2026-07-20. Founder-reserved decision; this one-pager is the ask, not the action._
