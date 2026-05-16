# agents.md — components/admin/treasury
_Last updated: 2026-05-16_

## What This Folder Contains
Admin-only treasury dashboard widgets for monitoring BTC balance, anchor stats, network status, and recent receipts.

## Key Files
- `BalanceCard.tsx` — Live BTC balance display (confirmed + unconfirmed) in BTC and USD, links to mempool.space
- `AnchorStats.tsx` — Anchor statistics panel showing records by lifecycle stage (PENDING/SUBMITTED/SECURED/REVOKED)
- `NetworkInfo.tsx` — Network status, live fee rates from mempool.space, estimated cost for next batch
- `ReceiptTable.tsx` — Lists last 20 network receipts with tx_id deep links, fee paid, and confirmation status
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useTreasuryBalance` — balance, fee rates, receipts, anchor stats data
- `@/lib/copy` (TREASURY_LABELS) — all UI strings
- `@/lib/platform` — mempool.space URL helpers

## Do / Don't Rules
- DO: Use approved terminology from `TREASURY_LABELS` — never say "wallet" or "transaction" in UI
- DO NOT: Expose this section to non-admin users; admin sidebar toggle gates access
