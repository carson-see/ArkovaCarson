# Partner referral panel — UAT harness (SCRUM-5024)

Renders `ReferralPanel` in a real browser against a **stubbed** `@/lib/supabase`
module (`.from('referral_codes')...maybeSingle()` and
`.rpc('get_org_referrals' | 'ensure_org_referral_code', ...)`), with a fixed
active code and three referred organizations (one VERIFIED, one UNVERIFIED,
one pre-public-id-backfill row with `organization_public_id: null` to exercise
the "omit the field, don't render null" path).

Why not the normal dev server / full `/settings/referrals` route: rendering
the full page needs `useAuth`, `useProfile` (React Query + its Provider) and
`useActiveOrg` (react-router's `useParams`, so a Router), none of which the
referral change touches — stubbing all of them to reach one component is more
surface than the panel itself. Modeled on the SCRUM-3865 harness
(`uat-harness/` is a shared scratch location; this replaces that PR's files,
per-PR, same as it replaced whatever preceded it).

Run it:

```bash
npx vite --config uat-harness/vite.config.ts --port 5599 --strictPort
```

Then open <http://localhost:5599>.

Screenshots captured from this harness for the PR:
`docs/uat/scrum-5024/referral-panel-1280x800.png` and
`docs/uat/scrum-5024/referral-panel-375x812.png`.

Not part of the app build — nothing in `src/` imports it.

## Known limitation: same React-dedupe workaround as SCRUM-3865

The harness resolves React through the worktree's symlinked `node_modules`, so
without the `dedupe`/alias pins in `vite.config.ts`, Radix's primitives (the
`Card`/`Button` components this panel wraps) would see a second React copy.
The pins in this file are copied from the SCRUM-3865 harness and are load-
bearing, not decorative.
