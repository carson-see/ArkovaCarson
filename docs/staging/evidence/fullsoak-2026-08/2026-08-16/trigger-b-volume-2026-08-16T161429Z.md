# Trigger B volume injection — 2026-08-16T161429Z

One-shot. Makes Trigger B reachable so the window can evidence more than the
daily flush. See `batch-trigger-coverage.md` for why A and B are otherwise
structurally unreachable at ~36 anchors/day.

| field | value |
|---|---|
| submitted | 16 |
| accepted (2xx) | 16 |
| rejected | 0 |
| start | 2026-08-16T16:14:30.593233+00:00 |
| end | 2026-08-16T16:14:34.922315+00:00 |
| pace | ~8/s against a 1,000/min API-key limit |

Response-code histogram:
```
  16 201
```

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
Trigger evaluation and broadcast are the rig's own bound cron.
