# Trigger B volume injection — 2026-08-17T141439Z

One-shot. Makes Trigger B reachable so the window can evidence more than the
daily flush. See `batch-trigger-coverage.md` for why A and B are otherwise
structurally unreachable at ~36 anchors/day.

| field | value |
|---|---|
| submitted | 7200 |
| accepted (2xx) | 7198 |
| rejected | 2 |
| start | 2026-08-17T14:14:45.569108+00:00 |
| end | 2026-08-17T14:39:12.777532+00:00 |
| pace | ~12/s against a 1,000/min API-key limit |

Response-code histogram:
```
7198 201
   2 503
```

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
Trigger evaluation and broadcast are the rig's own bound cron.
