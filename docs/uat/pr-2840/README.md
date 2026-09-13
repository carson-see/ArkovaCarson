# UAT evidence — PR #2840 / SCRUM-4989 (T1)

**Code under test:** `60e653dc0` (`cto-review/2840`)
The only uncommitted change at build time was `src/lib/agents.md` — a docs file that is not in the bundle.

**Surface:** local production build + headless Chromium, per the CTO ruling that the T1 smoke
surface is a local preview (CLAUDE.md §1.7) because the Vercel preview is blocked repo-wide
(`Deployment was blocked`, identical on #2836 / #2839 — not caused by this PR).

**No rig was touched.** Supabase is stubbed at the network layer inside the browser context;
`fizyjojbebyalirtjjht` was never contacted. The React components, the router,
`safeSocialHref` / `resolveSocialLinks`, `parseSocialLinksForWrite` and `toJsonLd` are all the
real shipped code — only the PostgREST/GoTrue responses are synthetic.

## Reproduce

```
npm run build
npx vite preview --port 4173 --strictPort
npx playwright test e2e/uat-pr2840.spec.ts --config=e2e/uat-pr2840.config.ts
```

Result at capture time: **10 passed** (5 scenarios × 1280×800 and 375×812).

## The stored fixture

`profiles.social_links` was unvalidated `jsonb` for its whole history, so every value below is
storable in prod **today**. This is a row that pre-dates the validator — precisely what the
render path has to defend against:

```json
{
  "linkedin": "javascript:alert(document.cookie)",
  "twitter":  "JaVaScRiPt:alert(1)",
  "github":   "//evil.example/x",
  "website":  "https://linkedin.com@evil.example/"
}
```

## Screenshots

Each is captured at both **1280×800** and **375×812**.

| File | What it shows |
|---|---|
| `settings-social-rejected-{1280x800,375x812}.png` | Settings → Social Profiles. `javascript:alert(document.cookie)` typed into LinkedIn, Save clicked. The rejection **"LinkedIn must be a link starting with https://."** renders *inside the Social Profiles card, directly above the Save button*. Before the review fix this message was set on the page-level `error` state, whose Alert lives in the profile card several hundred px above — the click looked inert. The save did not fire. |
| `dashboard-profilecard-no-link-{1280x800,375x812}.png` | Dashboard `ProfileCard` rendering the hostile row. **No social icons at all**, and the `+ Add social links` empty-state hint is present — positive proof the card took the *"no safe links"* branch rather than failing to render. |
| `public-profile-no-link-{1280x800,375x812}.png` | `/profile/profile_public_uat1` (the cross-user surface) rendering the hostile row. **Zero link pills.** |
| `control-dashboard-safe-links-render-{1280x800,375x812}.png` | **Control.** Same page, same code, legitimate values (`https://linkedin.com/in/ada`, `@ada_l`, `github.com/ada`, `https://ada.example`). The LinkedIn and X icons render with the correct resolved hrefs and the `+ Add social links` hint is gone. |
| `control-public-profile-safe-links-render-{1280x800,375x812}.png` | **Control.** Public profile with the same safe values: all four pills render (`linkedin`, `twitter`, `github`, `website`). |
| `jsonld-howitworks-{1280x800,375x812}.png` | `/how-it-works`, one of the seven JSON-LD emitters now routed through `toJsonLd`. |
| `jsonld-howitworks-parsed.json` | All **6** JSON-LD blocks on that page, parsed. Every one contains no raw `<` and round-trips through `JSON.parse`. |

The two control captures are the point of the pair: without them, "no links rendered" would be
indistinguishable from "the section failed to render". The assertions in the spec make the same
distinction machine-checkable.

## Assertions behind each capture

Beyond the visual, the spec asserts (all passing):

- No `<a href>` anywhere on either page starts with `javascript:` / `data:` / `vbscript:`, starts
  with `//`, or contains `@evil.example`.
- `a[aria-label="LinkedIn profile"]` and `a[aria-label="Twitter profile"]` have count **0** on the
  hostile row, and the exact expected `href` on the safe row.
- The rejection text is inside the same `Card` element as the Save button that produced it.
- Every `script[type="application/ld+json"]` on `/how-it-works` parses, contains no raw `<`, and a
  block with `"@type": "HowTo"` is present.

## Not covered here

- The write path against a real database. It is deliberately out of scope: the client-side
  validator is **UX, not a security boundary** — there is no CHECK constraint and no RLS predicate
  on the contents of `profiles.social_links`, so any user can `PATCH` the column directly through
  PostgREST with a `javascript:` value. The render-path resolver shown above is the actual control.
- `src/components/verification/PublicVerification.tsx`, which still carries its own hand-rolled
  `</` escape. That is a T2 surface and is filed as a separate follow-up.
