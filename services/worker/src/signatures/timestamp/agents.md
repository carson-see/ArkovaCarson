# agents.md — services/worker/src/signatures/timestamp/

_Last updated: 2026-05-16_

## What This Folder Contains

RFC 3161 timestamp protocol implementation — TSA request/response handling, QTSP provider selection with failover, and timestamp token verification.

| File | Purpose |
|------|---------|
| `rfc3161Client.ts` | RFC 3161 TSP client — builds TimeStampReq, sends to TSA, parses TimeStampResp to extract TST |
| `qtspProvider.ts` | QTSP provider selector — primary/secondary TSA endpoints with circuit breaker failover and health monitoring |
| `qtspProvider.test.ts` | Tests for QTSP failover and health checks |
| `timestampValidator.ts` | TST verification — signature validity, genTime bounds, message imprint match, TSA trust |
| `timestampValidator.test.ts` | Tests for timestamp token verification |

## Do / Don't Rules

- **DO** use `qtspProvider.ts` for all TSA requests (handles failover automatically)
- **DO** validate TST signatures against the trust store before accepting
