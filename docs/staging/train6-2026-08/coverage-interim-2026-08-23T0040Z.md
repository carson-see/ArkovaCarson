# TRAIN-6 — interim coverage, 28.4 h into a 48 h T3 window

**Written:** 2026-08-23T00:40Z, **mid-window**. This is NOT a close-out — the clock runs to
2026-08-23T20:33:58Z. It exists so the close-out is written from verified numbers rather than
assembled under time pressure, and because two claims I had been carrying about this soak were
**wrong** and needed correcting while there was still time to act on them.

**PR under soak:** #2249 (anchor lifecycle).

## Clock integrity — TWO windows exist; only the second is evidence

| | revision | clockStart | cycles |
|---|---|---|---|
| window 1 — **VOID** | `arkova-worker-wave2-2026-08-staging-00005-nax` | 2026-08-21T18:54:36Z | 4 |
| **window 2 — authoritative** | `arkova-worker-wave2-2026-08-staging-00006-gik` | **2026-08-21T20:33:58Z** | **67** |

Per [[FD-CLOCK-1]] the clock is the *serving revision's* creation, so the 4 window-1 cycles
(`2026-08-21T18:57:41Z` → `20:13:04Z`) are from a superseded revision and are **excluded from
every number below**. Any aggregate over `load-*.json` without that filter is wrong by 4 cycles
— including the first one I computed. Filter on
`.servingRevision == "arkova-worker-wave2-2026-08-staging-00006-gik"`.

## Window-2 totals

| metric | value |
|---|---|
| cycles | **67** (`2026-08-21T20:59:52Z` → `2026-08-23T00:37:53Z`) |
| `ok` | **12,107** |
| `fail` | **1** |
| `status_200` | 11,437 |
| `status_429` | **0** |
| `status_other` | 336 (declared-expected non-200s, see probes) |
| cycles with deviations | **1** |

**Failure rate 1 in 12,107 — 0.008 %.**

## The rate budget is the reason this window is not hollow

Every cycle records:

```json
"rateBudget": { "offeredRpm": 8, "budgetRpm": 45, "ceilingRpm": 60 }
```

The driver offers **8 rpm** against the real **60 rpm** `apiIpShadowGuard` ceiling.
**`status_429` is 0 across all 67 cycles.** Contrast the migration-T3 window, which offered
~160 rpm into the same ceiling and recorded 144,763 × 429 with a **1.02 %** success rate — a
48-hour soak that measured its own rate limiter. [[FD-LOAD-1]] is fixed here, and this window is
the positive control proving it.

## Lifecycle IS observed — correcting a claim I repeated for many ticks

I stated repeatedly that "anchor-state counters are null; cycles prove throughput, NOT
lifecycle." **That is wrong.** It was true of the 4 **window-1** cycles, which predate the
`fixture` block, and I generalised it to the whole window without re-reading a current file.

Every window-2 cycle carries:

```json
"fixture": { "submitted": 5, "submittedFloor": 5, "secured": 40, "expired": 60 }
```

and it **moves monotonically**:

| | secured | expired |
|---|---|---|
| 2026-08-21T20:59:52Z | **95** | 5 |
| 2026-08-23T00:37:53Z | **40** | 60 |

**55 anchors observed transitioning SECURED → EXPIRED**, with `secured + expired = 100`
conserved at every sample — one cohort aging through the lifecycle, not churn. `submitted` holds
at its floor of 5. For an anchor-lifecycle PR this is the evidence that matters, and it is
present.

## Member probes — 7 surfaces, every cycle, no drift

All seven fire in **all 67** cycles with identical status:

| probe | status | reading |
|---|---|---|
| `2249-anchor-expiry-sweep` | 200 | |
| `2249-ai-credit-reconcile` | 200 | |
| `2249-org-queue-scheduler` | 200 | |
| `2249-rule-action-dispatcher` | 200 | |
| `2249-docusign-notarization` | 200 | |
| `2249-connector-artifact-drain` | 200 | |
| `2249-prof-education` | **503** | constant in all 67 cycles and **never** raised as a deviation → 503 is this probe's **declared-expected** status, not a fault |

The `deviations` field is empty in 66 of 67 cycles, which is what makes the 503 above readable
as intentional rather than tolerated.

## The single deviation, in full

`2026-08-22T01:11:08Z` — `deviations = "health=503(want 200)"`, `requests = {ok:178, fail:1,
status_200:168, status_429:0, status_other:6}`. One health probe returned 503 where 200 was
declared. **Non-recurring across the following 40+ cycles.** 1 in 12,107 requests. Recorded, not
explained — a single transient 503 with no recurrence has no diagnosable signal, and inventing
one would be worse than leaving it named.

## What this window does NOT cover — to be carried into the close-out

- **48 h not yet elapsed.** 28.4 h of 48 h at the time of writing. Nothing here is a T3 pass.
- **The rig cannot exercise signing / treasury / broadcast.** Same standing limit as the other
  wave rigs; any #2249 behaviour touching those paths is out of scope and must not be claimed.
- **No rollback rehearsal recorded yet** — §1.12 requires one at T2+.
- **No preflight artifact for this window** is present in the evidence directory.
- **`status_other` = 336 is not itemised** beyond the constant `prof-education` 503. The driver
  records a status class, not a per-path breakdown, so "336 non-200s were all expected" is an
  inference from the empty `deviations` field, not a direct measurement.

## Reproducing these numbers

```bash
D=docs/staging/train6-2026-08/evidence
jq -sr '[.[]|select(.servingRevision=="arkova-worker-wave2-2026-08-staging-00006-gik")]
  | {cycles:length, ok:([.[].requests.ok]|add), fail:([.[].requests.fail]|add),
     s429:([.[].requests.status_429]|add)}' $D/load-*.json
```

The evidence files are **untracked** — a `docs/staging/*.json` glob will not find them.
train-6 uses `.requests.*`; the migration soak uses `.byMode.<mode>.ok`. They are different
schemas and mixing them silently yields zeros.
