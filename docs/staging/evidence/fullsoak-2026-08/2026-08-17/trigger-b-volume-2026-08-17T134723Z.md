# Trigger B volume injection — 2026-08-17T134723Z

One-shot. Makes Trigger B reachable so the window can evidence more than the
daily flush. See `batch-trigger-coverage.md` for why A and B are otherwise
structurally unreachable at ~36 anchors/day.

| field | value |
|---|---|
| submitted | 10500 |
| accepted (2xx) | 10498 |
| rejected | 2 |
| start | 2026-08-17T13:47:24.901562+00:00 |
| end | 2026-08-17T14:24:58.971605+00:00 |
| pace | ~10/s against a 1,000/min API-key limit |

Response-code histogram:
```
10498 201
   2 503
```

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
Trigger evaluation and broadcast are the rig's own bound cron.
