# UAT — shared connector card status row

Visual UAT for the `ConnectorCardStatusRow` extraction (PR against `main`,
unblocks SonarCloud's duplication gate on #2912). The cards in shot:
`MemberDocusignConnectorCard` and `AdobeSignConnectorCard`, the two that adopt
the shared row.

| File | Viewport | State |
|---|---|---|
| `connected-1280x900.png` | 1280×900 | connected, account label rendered |
| `disconnected-1280x900.png` | 1280×900 | not connected, Connect enabled |
| `connected-375x812.png` | 375×812 | connected (row stacks below `sm:`) |
| `disconnected-375x812.png` | 375×812 | not connected |

**This refactor changes no markup.** That is asserted, not assumed: a throwaway
parity harness rendered the pre-refactor (`origin/main`) and post-refactor cards
side by side in jsdom and compared the SHA-256 of their normalized `innerHTML`.
Every pair matched, with a negative control proving the harness can tell two
different cards apart:

| State | SHA-256 (first 16, old == new) | bytes |
|---|---|---|
| Member — disconnected | `dc24b1680c2087fb` | 2418 |
| Member — connected | `594a265157b0baca` | 3284 |
| Adobe — disconnected | `952369fb31a272e3` | 2403 |
| Adobe — connected | `1adc08bfc9d37bc7` | 3269 |
| Adobe — entitlement gate blocked | `fa831019a3607931` | 3284 |
| Adobe — entitlement gate loading | `60e5004edba60083` | 2503 |

The screenshots were taken from a throwaway Vite harness modelled on
`uat-harness/` (same `dedupe: ['react','react-dom']` + absolute React alias
workaround for the symlinked worktree `node_modules`), with `@/lib/supabase`,
`@/lib/workerClient` and `@/hooks/useCanIssueCredential` aliased to stubs so the
UAT needs no local Supabase stack — the stack is shared across worktrees and a
concurrent `supabase stop` from another session would wipe the run. Neither the
harness nor the parity test is committed: both hold a copy of the pre-refactor
card, which would rot the moment the card changes again. The durable guard is
`src/components/integrations/ConnectorCardStatusRow.test.tsx` (rendered contract)
plus `MemberDocusignConnectorCard.test.tsx` (behaviour, written pre-refactor).
