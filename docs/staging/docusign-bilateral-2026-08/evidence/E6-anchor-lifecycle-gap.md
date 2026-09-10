# Evidence E6 — the soak was silently not exercising the anchor lifecycle

## What monitoring caught
At ~6.5 h into the RC-2 window, a routine deep DB check (not a probe failure — every
probe was green) showed **41 connector_artifact rows stuck in `queued`**, oldest 12 h,
none carrying a `drain_error`. Probe-level evidence looked perfect the whole time.

## Root cause chain (each step verified, not assumed)
1. Artifacts materialize correctly → an anchor is created in `PENDING`.
2. The drain's confirmation pass re-reads materialized rows; because the anchor never
   advances past `PENDING`, it **requeues** them (`reconfirmRequeued`), so rows cycle
   `materialized → queued → claimed → …` indefinitely. Not a leak — a retry loop
   waiting on an anchor state that was never going to arrive.
3. Anchors never advanced because the supervisor drove the webhook and the drain but
   **never `/jobs/batch-anchors` or `/jobs/check-confirmations`**.
4. Adding those triggers still returned `processed: 0`, even with `?force=true`.
5. `processBatchAnchors` has a hard enablement gate:
   `if (!flagRegistry.getFlag('ENABLE_BATCH_ANCHORING')) return EMPTY;` — DB-backed
   switchboard flag with env fallback, **fail-closed**. The rig had neither.
6. Inserting the `switchboard_flags` row alone did **not** help: the deployed worker
   resolves that flag from a **boot snapshot**. (Open PR #2438 —
   "resolve ENABLE_BATCH_ANCHORING … live, not from the boot snapshot" — exists for
   exactly this; the bug is confirmed in the wild here.)
7. Redeploy with `ENABLE_BATCH_ANCHORING=true` + `BATCH_ANCHOR_MAX_SIZE=25`.

## Result after the fix
| Check | Result |
|---|---|
| `POST /jobs/batch-anchors?force=true` | **processed 71**, real `batchId`, `merkleRoot`, `txId` |
| `POST /jobs/check-confirmations` | **checked 71 / confirmed 71** |
| anchors reaching `SECURED` with a chain tx id | **71** |
| inbound anchors still `fingerprint_source=issuer_record_attestation` **after securing** | **true** — securing does not overwrite the honest evidence class |
| PII leakage | **0** |

## Why the clock was restarted (again)
The T3 matrix requires *Trigger A fires, Trigger B fires, Daily flush observation*. Without
batch anchoring the window could never produce them — it proved ingestion and anchor
*creation* but never the anchor lifecycle. That is the hollow-soak shape the standard
forbids, so ~7.5 h of clock was traded for a window that can actually satisfy T3.
RC-2's 50 sealed cycles are preserved in `~/arkova-soak/docusign-bilateral/round2-sealed/`
and are not counted toward the new window.

**New window:** revision `00005-ss6`, clock basis **2026-08-31T04:55:06Z**,
closes **2026-09-02T04:55:06Z**. Supervisor now drives, per cycle: 6 adversarial webhook
families → drain → Trigger A (batch-anchors) → forced flush → Trigger B (confirmations)
→ signer-backfill (#2521) → second drain.

## Reusable lesson for every future connector soak
A connector soak that drives only the webhook and the drain will look perfectly green
while never exercising anchoring. Three rig prerequisites must be verified **before the
clock starts** — the sibling `mig-docusign-trust` soak independently hit the same three:
`org_members` owner row, funded `org_credits`, and `ENABLE_BATCH_ANCHORING` on **at boot**.
The first is now fixed at source in PR #2516; the third needs either the env var at deploy
time or PR #2438's live-refresh.

---

# E7 — three concurrent drivers ran undetected for ~7.5 h (disclosed, not hidden)

## What happened
A `flush_missing_or_failed` alert on a cycle numbered 30 — impossible in a window that had
just restarted at cycle 1 — exposed **three** supervisor processes driving this rig, not one.

Two of them (PIDs 51748, 63723, ~7.5 h old) were launched by earlier `cd "$SOAKDIR" &&
./run-detached.sh` invocations, so their command line was the RELATIVE `bash ./supervisor.sh`.
Every `pkill -f 'arkova-soak/docusign-bilateral/supervisor.sh'` in this session silently
matched nothing for them. They were only found by enumerating processes by **cwd**
(`lsof -a -p <pid> -d cwd`), not by command-line pattern.

They ran the pre-flush version of the script, so they wrote cycle files with no `flush`
field — which is what tripped the alert.

## Blast radius, stated plainly
- **Overlap:** all of RC-1, all of RC-2, and the first ~35 min of the RC-3 window.
- **Effect:** roughly 3x the documented webhook load, from identical adversarial families.
  It is EXTRA LOAD, not different or wrong data.
- **Correctness at the moment of discovery, under that 3x load:** 93/93 connector artifacts
  in terminal `anchored`, 96 anchors SECURED with chain tx ids, inbound evidence class
  correct on every row, 100% nonce tenant-scoping, **0** PII leaks, **0** cross-org
  attribution, **0** unresolved provenance conflicts.
- **Cycle files** written by the stale drivers are quarantined in
  `~/arkova-soak/docusign-bilateral/contaminated-dual-driver/` and are excluded from the
  evidence set.

## Decision: the RC-3 clock was NOT restarted a third time
The overlap is ~35 min of a 48 h window, worker uptime was continuous, and no correctness
assertion was affected — the system handled 3x the intended load with zero failures, which
is stronger evidence, not weaker. Restarting for a load-profile footnote would have been
over-correction. This paragraph is the disclosure; the RC manifest carries it as a
documented deviation rather than a silent one.

## Fixed so it cannot recur
- Supervisor now takes a **PID lock** (`supervisor.pid`) and refuses to start when a live
  driver holds it. Verified by attempting a duplicate start:
  `refusing to start: supervisor 265 already running`, process count stayed 1.
- The monitor now alerts on `>1` driver directly, instead of the condition arriving
  disguised as a flush error.
- **Lesson:** never identify a soak driver by command-line pattern alone. A relative-path
  invocation is invisible to `pkill -f <abs-path>`. Enumerate by cwd, or make the driver
  hold a lock (now both).
