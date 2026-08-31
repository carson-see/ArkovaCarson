# scripts/staging/soak-harness

_Last updated: 2026-08-30 (versioned after the harness silently lost soak evidence twice)._

## Why these files are here

These scripts previously existed **only** under `~/arkova-soak/<rig>/` on one operator's
laptop. Nothing versioned them, so a fresh clone, a CI runner, or a peer session could not
see them — and a defect fixed in one rig's copy was not fixed in any other. That is not a
hypothetical: the harness lost soak evidence **twice** before these fixes landed, and each
loss was silent.

## The two silent evidence-loss defects these copies fix

**1. `PF_RC=$?` captured the PIPELINE status, not the preflight's.** The at-close preflight
runs as `npx tsx … | grep -v '^npm warn'`. When `grep -v` matches nothing it exits 1, so a
perfectly good preflight was recorded as a failure. Separately, a failing `cd "$REPO"`
short-circuited the `&&` chain and left an empty output file with no diagnosis at all.
Now uses `PIPESTATUS[0]`, checks the repo directory and its writability first, tolerates
npm noise before the JSON, and names any gap loudly instead of leaving a silent absence.
Symptom to recognise: `preflight_at_close: UNREADABLE [Errno 2] No such file or directory`
in a supervisor log — seen on the 2433 / 2446 / 2450 closes on 2026-08-29.

**2. batch-B had no at-close preflight step at all** — only a prose "Next:" note, so whether
the capture happened depended on operator memory. Added, and verified in production 40
minutes later: both 2439 and 2441 auto-captured `clean_mirror` 8/8 at their closes.

## `detach.py` — use it, `nohup` is not enough

`nohup` only ignores SIGHUP and leaves the process in the caller's process group, so a group
kill takes a supervisor down mid-window **with no error in its log**: the driver finishes its
cycle, nothing starts the next, and the log simply stops. `setsid` does not exist on macOS.
`detach.py` does a double-fork plus `os.setsid()` so the supervisor lands at `PPID 1` in its
own session and survives the launching shell.

Related trap: a supervisor launched from an agent's own shell can inherit a **filesystem
sandbox** and be unable to write under `/Volumes/…`. Each cycle then runs its probes and
crashes at `writeCycle` with `EPERM` *before* the summary log — producing no artifact and no
probe record while the process list looks healthy. Roughly 8 hours of one window were burned
this way on 2026-08-29.

## The rule these encode

**A live process is not evidence; a written cycle artifact is.** Verify a soak by an advancing
cycle counter and persisted artifacts, never by process liveness. Unartifacted load is real
load but it is not evidence, and a window that cannot produce artifacts for part of its span
must have that span excluded and disclosed — not averaged over.

The roll-up must COUNT AND NAME unparseable artifacts rather than skipping them; an
`except Exception: continue` silently produces a soak that looks thinner than it was.
