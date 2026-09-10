# UAT — PR #2529, Adobe Sign connector card

CLAUDE.md §0 rule 6 (UAT every UI change: 1280px and 375px, screenshots in the PR).

Captured from `e2e/integrations-adobe-sign.spec.ts` against the local stack
(Supabase local, `npm run dev`), chromium, 19/19 passing. Reviewed by eye, not
just asserted.

| File | Viewport | State |
|---|---|---|
| `adobe-sign-settings-desktop-1280.png` | 1280 | Disconnected — Connect enabled |
| `adobe-sign-connected-desktop-1280.png` | 1280 | Connected — account label + Disconnect |
| `adobe-sign-unconfigured-desktop-1280.png` | 1280 | **The live production path**: no Adobe application registered → "not available on this environment yet" |
| `adobe-sign-stranded-webhook-desktop-1280.png` | 1280 | Disconnected locally but Adobe kept the registration → manual-cleanup message |
| `adobe-sign-webhook-refused-desktop-1280-in-page.png` | 1280 | `webhook_registration_failed` toast in page context, showing the card's position between DocuSign and Personal DocuSign |
| `adobe-sign-settings-mobile-375-in-page.png` | 375 | Disconnected, in page context |
| `adobe-sign-connected-mobile-375-in-page.png` | 375 | Connected — card stacks, button goes full width |
| `adobe-sign-webhook-refused-mobile-375-in-page.png` | 375 | Longest message in the UI, wrapped inside the viewport |

## Two notes on the capture itself

**These are card-scoped screenshots, not `fullPage`.** This app scrolls inside a
container rather than the document, so `page.screenshot({ fullPage: true })`
captures only the region above the fold — the org banner — and never reaches the
connector cards. The first run of this spec produced byte-identical "connected"
and "disconnected" images for exactly that reason. The helper now scrolls the
card into view and screenshots the element, plus a viewport shot for layout
context. If you add UAT to another connector spec, do the same.

**No live Adobe account is involved.** Production carries no Adobe credential
(verified 2026-08-30), so the OAuth hops are mocked at the network layer. These
screenshots are evidence of the UI's behaviour across its states, not evidence
that a real Adobe connection works — that needs a registered Adobe application
and is called out as the blocker on the PR.
