# Trigger B volume injection — 2026-08-16T161447Z

One-shot. Makes Trigger B reachable so the window can evidence more than the
daily flush. See `batch-trigger-coverage.md` for why A and B are otherwise
structurally unreachable at ~36 anchors/day.

| field | value |
|---|---|
| submitted | 3100 |
| accepted (2xx) | 70 |
| rejected | 3030 |
| start | 2026-08-16T16:14:48.541122+00:00 |
| end | 2026-08-16T16:25:45.032407+00:00 |
| pace | ~8/s against a 1,000/min API-key limit |

Response-code histogram:
```
3030 429
  70 201
```

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
Trigger evaluation and broadcast are the rig's own bound cron.
