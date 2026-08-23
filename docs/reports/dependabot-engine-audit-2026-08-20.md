# Dependabot Engine/Breaking-Change Audit — 2026-08-20

Scope: every open dependabot PR as of 2026-08-20, audited for Node/engine-floor hazards
and API-breaking changes, per the `@google-cloud/kms` 5.7.0→6.0.0 (`feat!: upgrade
minimum Node.js version to 22`) precedent in PR #2264.

## Runtime baseline (verified from the repo, not assumed)

| Surface | Source | Value |
|---|---|---|
| Worker (Cloud Run) | `services/worker/Dockerfile` (both `builder` and prod stages) | `FROM node:20-alpine` |
| Worker `package.json` | `services/worker/package.json` | **no `engines` field** — inherits the Docker base image floor |
| Root / frontend | `package.json` `engines` | `"node": ">=20.14.0"` |
| `packages/embed` | `packages/embed/package.json` `engines` | `"node": ">=18"` (looser than root; not a constraint) |
| CI | every `.github/workflows/*.yml` `actions/setup-node` step (ci.yml ×21, deploy-worker.yml, deploy-staging.yml, merge-authority.yml, migration-drift.yml, pe-eval.yml, publish-sdk.yml, s33-wave1/2*.yml, sonatype-scan.yml, staging-evidence.yml) | `node-version: '20'` / `20` everywhere — zero references to 22 |
| Edge (Cloudflare Workers) | `wrangler.toml` / `services/edge/wrangler.toml` / `services/api-gateway/wrangler.toml` | not a Node runtime (V8 isolates via `workerd`); `compatibility_date` = `2024-12-01` / `2024-12-01` / `2025-09-01` respectively. `wrangler`/`@cloudflare/workers-types` are Node-based **dev tooling** that run under the CI/dev-machine Node (20), not under the edge runtime itself |

**Baseline: Node 20** (floor `>=20.14.0` per root `package.json`; `node:20-alpine` is the actual Cloud Run runtime). No surface in this repo runs Node 22.

## Method

For every package bumped in every open dependabot PR: read the PR body's changelog for
`BREAKING`/`feat!`/engine-version language, then confirm ground truth with
`npm view <pkg>@<version> engines` for both the **current pinned** version and the
**target** version — so a pre-existing floor violation (already true before the bump)
is distinguished from a floor the PR itself raises. Source code was grepped for actual
call sites before treating any "breaking API" note as relevant.

## Findings

| PR | Packages of concern | Engine floor vs Node 20 baseline | Verdict | What must land first |
|---|---|---|---|---|
| **#2264** `@google-cloud/kms` 5.7.0→6.0.0 | `@google-cloud/kms` | `npm view @google-cloud/kms@6.0.0 engines` → `{ node: '>=22' }`. Confirmed. | **HOLD** (already correctly held by carson-see, re-applied 2026-08-20 15:43 UTC after an earlier same-day removal; independently re-verified here) | Node 22 runtime upgrade (tracked SCRUM-3166) must land first; then re-review the KMS v6 API surface + the hand-rolled `.d.ts` shim against every call site in `gcp-kms-signing-provider.ts` (the dormant Bitcoin-treasury fallback signer, selected only when WIF is unset) |
| **#2290** worker-deps group, 12 pkgs: `@aws-sdk/client-kms` 3.1106.0→3.1111.0, `@peculiar/asn1-cms` 2.8.0→2.9.0, `@peculiar/asn1-x509` 2.8.0→2.9.0, `@sentry/node` 10.69.0→10.70.0, `@sentry/profiling-node` 10.69.0→10.70.0, `@supabase/supabase-js` 2.112.2→2.112.3, `jose` 6.2.8→6.2.9, `resend` 6.18.1→6.20.0, `viem` 2.55.11→2.55.17, `globals`/`tsx`/`typescript-eslint` (devDeps) | `@aws-sdk/client-kms` `>=20.0.0` (unchanged); `@sentry/*` `>=18`; `jose`/`viem`/`@peculiar/*` no `engines` field; `resend` `>=20` (at floor, unchanged). **`@supabase/supabase-js` requires `>=22.0.0` — but this is unchanged: `npm view @supabase/supabase-js@2.112.2 engines` (the version currently pinned in `services/worker/package.json`) is *already* `{ node: '>=22.0.0' }`.** This PR does not raise that floor; it is pre-existing latent risk (soft violation — no `engine-strict` in `.npmrc`, so `npm ci` warns, doesn't fail). | **SAFE** | None for this PR. Separately worth a tracked item: worker already runs `@supabase/supabase-js` above its declared floor on Node 20 — recommend folding into the same Node 22 upgrade work as #2264/SCRUM-3166 rather than opening a new ticket |
| **#2262** production-deps group, 19 pkgs (frontend/root): `@sentry/react` 10.69.0→10.70.0, `@supabase/supabase-js` 2.112.2→2.112.3, `lucide-react`, `mammoth`, `read-excel-file`, `sonner`, `@axe-core/playwright`, `@cloudflare/workers-types`, `@cyclonedx/cyclonedx-npm`, `@testing-library/jest-dom`, `@testing-library/user-event`, `eslint-plugin-react-refresh`, `globals`, `lockfile-lint`, `rollup-plugin-visualizer`, `supabase` CLI, `tsx`, `typescript-eslint`, `wrangler` 4.120.0→4.123.0 | Same pre-existing `@supabase/supabase-js >=22.0.0` (unchanged). `wrangler@4.123.0` → `npm view wrangler@4.123.0 engines` = `{ node: '>=22.0.0' }` — **also unchanged**: `npm view wrangler@4.120.0 engines` (currently pinned) is already `{ node: '>=22.0.0' }`. `mammoth@1.12.1` `>=12.0.0`; everything else has no `engines` field or is well under 20. Only functional changelog item found across the whole group: wrangler now defaults `nodejs_compat`/`nodejs_compat_v2` **on** for `compatibility_date >= 2026-08-04`; our `wrangler.toml` files are pinned to `2024-12-01` / `2025-09-01`, below that threshold, so the new default does not engage. | **SAFE** | None for this PR. Same pre-existing `supabase-js`/`wrangler` `>=22` latent debt as #2290 |
| **#2279** `nanoid` 3.3.14→3.3.18 (`/packages/embed`) | `nanoid` | `npm view nanoid@3.3.18 engines` = `{ node: '^10 \|\| ^12 \|\| ^13.7 \|\| ^14 \|\| >=15.0.1' }` — well under baseline. Patch-only within the 3.x line (predictable-ID security patches). `packages/embed`'s own declared floor is `>=18`, already satisfied. | **SAFE** | None |
| **#2261** `@cloudflare/workers-types` 5.20260808.1→5.20260817.1 (`/services/edge`) | `@cloudflare/workers-types` | No `engines` field on either version — ambient `.d.ts` package, compile-time only, no runtime engine exposure. | **SAFE** on engine grounds. Already carries `do-not-merge`, added by carson-see 2026-08-17T19:21Z with no PR comment recorded — timing matches the fullsoak-2026-08 change-freeze sweep (same window as #2228's explicitly-freeze-labeled hold, below). HANDOFF.md `## Now` records that freeze closing on schedule 2026-08-19. | Not this audit's call — the label is Carson's/CTO's to lift; confirm no new soak (a T3 chain-pair/rate-limit soak started the same day per HANDOFF) covers this surface before removing it |
| **#2260** `wrangler` 4.120.0→4.123.0 (`/services/edge`) | `wrangler` | Same `>=22.0.0` floor, pre-existing and unchanged (see #2262 row). Only changelog item is the same `nodejs_compat` default-on note, inapplicable per the `compatibility_date` check above. | **SAFE** | None |
| **#2228** `@hono/node-server` 1.19.14→2.1.1 | `@hono/node-server` | `npm view @hono/node-server@1.19.14 engines` = `{ node: '>=18.14.1' }` → `npm view @hono/node-server@2.1.1 engines` = `{ node: '>=20' }`. Floor rises, but lands **at** the Node 20 baseline, not above it. Diff (`gh pr diff 2228`) shows the only changed file is `package-lock.json`, with the entry marked `"dev": true` — a transitive dev dependency. Grepped every `package.json` in the repo (root + all `services/*`) and every `.ts`/`.tsx`/`.js` import: **zero direct declarations, zero imports of `hono` or `@hono/node-server` anywhere in source.** It is pulled in transitively by dev/test tooling only. | **SAFE** — major-version bump, but nothing in this repo calls its API, and the new floor doesn't exceed baseline | None. Already carries `do-not-merge`, added by carson-see 2026-08-15T19:47Z with an explicit comment: freeze-only hold ("Nothing is wrong with the PR itself... remove after the freeze lifts"). HANDOFF.md records the freeze closed 2026-08-19 — label is Carson's to lift, not this audit's |

## Action taken

- No new `do-not-merge` labels added — every PR audited fresh (#2290, #2262, #2279, #2261, #2260, #2228) cleared the engine-floor and breaking-API check.
- Posted a confirming comment on **#2264** with the independent `npm view` verification, since it is the one PR in this batch that is genuinely unsafe today (matches the pre-existing hold; not a new finding).
- No labels removed on any PR (out of scope for this audit — read-only on PR state per instructions).

## Notes for follow-up (not blocking any PR in this batch)

1. `@supabase/supabase-js` (currently pinned `2.112.2`, used by both `services/worker` and the frontend) and `wrangler` (currently pinned `4.120.0`, used by root + `services/edge`) **already** declare `engines.node >= 22.0.0` at the versions presently in the lockfiles — before any dependabot bump. This is a soft violation today (no `engine-strict` in any `.npmrc`, so `npm ci`/`npm install` only warns) but is real latent risk if either package starts using a Node-22-only API at runtime. Recommend folding into the Node 22 upgrade already tracked for #2264/SCRUM-3166 rather than treating as a separate fire.
2. `@peculiar/asn1-cms` 2.9.0 and `@peculiar/asn1-x509` 2.9.0 (in #2290) both dropped npm provenance attestation relative to their 2.8.0 predecessors, per the PR body's own "Attestation changes" note. Not an engine or breaking-API issue, but a supply-chain signal worth a second look before merging #2290.
3. `#2261` and `#2228` both carry `do-not-merge` labels dated inside the fullsoak-2026-08 freeze window (2026-08-15 and 2026-08-17 respectively) that predate today's independent audit. HANDOFF.md `## Now` confirms that freeze closed on schedule 2026-08-19, with a new T3 (chain-pair + rate-limit) soak starting the same day. Whether that new soak's scope covers `services/edge` or dev tooling is not established here — flagging for Carson/CTO to confirm before lifting either label, since this audit did not verify current soak coverage.

_Audit performed 2026-08-20. Read-only on all PR state except one confirming comment on #2264; no PR was merged, readied, or had a label removed._
