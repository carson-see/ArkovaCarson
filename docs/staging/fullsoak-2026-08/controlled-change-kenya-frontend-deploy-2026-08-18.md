# Controlled change during the soak window: Kenya transfer-basis frontend deploy

**2026-08-18T14:2xZ. Vercel production deploy of `hotfix/kenya-transfer-basis-removal`
(head `1dbf4ea67`, PR #2271) to app.arkova.ai. Frontend only.**

## What changed and why

The served bundle carried `KENYA_TRANSFER_BASIS: 'Standard Contractual Clauses (Section 48)'`
— an EU GDPR mechanism misattributed to Kenya DPA 2019 §48. Counsel (Sarah) ordered the
wording removed effective 2026-08-18 and had already told the partner contact it was being
removed that day. Removal only; replacement wording remains counsel's.

## Authorization chain

Founder saw the live-bundle verification and the class finding and directed "lets fix";
founder delegated the deploy-path decision to the CTO session ("you're the CTO"). CTO
decision: production deploy via Vercel branch promote — origin/main untouched at
`92ed61cb6`, PR #2271 remains draft and merges through the normal gates post-freeze.

## Freeze-boundary accounting (honest)

`prod-repair-poison-record-2026-08-17.md` scopes the freeze as protecting "the rig's
evidence and prod deploys" — it is NOT precedent for this deploy (an earlier internal
citation of it as such was wrong and is corrected here). This deploy is a deliberate,
documented AMENDMENT of that boundary for one change, on these grounds: (1) counsel-ordered
removal of an incorrect legal representation, already communicated to a partner as done;
(2) scope is the Vercel frontend exclusively — the soak observes the worker, and the rig
(`00013-mrw`), the prod worker revision, `DEPLOY_WORKER_PAUSED=true`, and `origin/main`
are all unchanged (verifiable via the 90-min health checks bracketing this deploy);
(3) leaving a known-false compliance representation live to preserve a test-window
narrative is the worse audit posture.

## Evidence

- Pre-deploy: bundle `copy-BsvodqV-.js` contained the string (fetched 13:45Z).
- Deploy: `arkova-26-1bqbdybsh-carsons-projects-1179ca27.vercel.app`, aliased to
  app.arkova.ai, ~14:24Z.
- Post-deploy: bundle `copy-BqF06LMI.js` — zero occurrences of the string;
  `KENYA_BREACH_TIMELINE` and the rest of the Kenya notice intact.
- Held for counsel (deliberately NOT changed): `NIGERIA_TRANSFER_BASIS` ('Standard
  Contractual Clauses', unqualified) and `SOUTH_AFRICA_TRANSFER_BASIS` ('Section 72
  binding agreement (SCCs)') — same defect shape, but `claims-register.csv` ties
  transfer-basis claims to regulator-facing filings, so those removals follow counsel's
  explicit ruling (precedent: PR #1458, counsel owns transfer-basis changes even as removals).

## Deploy 2 — Tranche 0 completion (~14:5xZ, counsel-doc execution)

Head `79abafbf1` (PR #2271), deployment `arkova-26-4hb7d6iq3`, aliased app.arkova.ai.
Executed counsel's written Tranche-0 instruction (Sarah's doc, 18 Aug addendum item 1).
Live-bundle verification (`copy-DEctzTrG.js`): Section 48 string 0 occurrences; Kenya
counsel-pending placeholder present verbatim; Sections 25-38 rights list 0; 72-hour ODPC
timeline 0; Section 3 approved wording present; "Your files never leave your browser" 0;
server-card `serverInfo.vendor` = "Bloc Doc Inc.". Rig, prod worker, main all unchanged.
Note: sentry-vite-plugin sourcemap upload failed non-fatally during build — this deploy's
frontend events are unsymbolicated until the next deploy with a working token.
