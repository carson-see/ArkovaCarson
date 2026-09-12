# Dependency Pinning (DEP-15 / SCRUM-1005)

_Last updated: 2026-04-28_

## Rule

Every entry in `dependencies` and `devDependencies` of every `package.json`
in this repo MUST be an exact version. No caret (`^`) or tilde (`~`)
ranges. Enforced by `scripts/ci/check-dep-pinning.ts` on every PR
(`Dependency Scanning` job in `.github/workflows/ci.yml`).

## Rationale

`package-lock.json` already pins resolved versions transitively, so
`npm ci` reproduces the build deterministically. But `package.json`
range specifiers still affect:

1. **`npm install --save <pkg>` on a fresh checkout** — pulls a newer
   semver-compatible version into `package-lock.json` without a code
   review of the upgrade.
2. **Renovate / Dependabot** — a `^` range lets the bot skip the
   explicit version-bump PR for patch/minor upgrades, removing the
   human checkpoint where we'd otherwise notice a CVE, deprecation, or
   behavioural change.
3. **Build reproducibility** on machines that don't share our
   `package-lock.json` (CI workers on forks, third-party scanners that
   run `npm install` instead of `npm ci`).

Pinning at `package.json` closes those gaps. Every dependency upgrade
becomes a deliberate, reviewable PR.

## Scope

Enforced on `package.json` (root), `services/worker/package.json`, and
`services/edge/package.json` (when present). Sections scanned:
`dependencies`, `devDependencies`.

NOT scanned (intentionally):
- `overrides` — these constrain the transitive tree and occasionally
  need range syntax to compose with upstream peers. Reviewed in PR.
- `peerDependencies` — advisory; consumed by downstream packages.

## Override

For a one-off PR that needs a range entry (e.g. compatibility hack
while waiting on an upstream release), apply the GitHub label
`dep-range-intentional`. The script logs the violations and exits 0.
Remove the label before the next merge so the rule re-engages.

## Active Transitive Overrides

| Package file | Override | Reason | Removal condition |
| --- | --- | --- | --- |
| `services/worker/package.json` | `svix: 1.92.2` | SCRUM-1617: keep `resend@6.12.2` while clearing the `resend -> svix -> uuid` production audit path. `svix@1.92.2` removes the vulnerable `uuid` dependency, avoiding npm's heavier Resend downgrade recommendation. | To remove, delete the `svix: 1.92.2` override from `services/worker/package.json`, refresh `services/worker/package-lock.json` with `npm install` from `services/worker`, then run `npm --prefix services/worker ls resend svix uuid --all` and `npm --prefix services/worker audit --omit=dev`. If `uuid` still appears under the Resend/Svix path or audit fails, keep the override; otherwise remove it. |
| `package.json` | `sharp@<0.35.4: 0.35.4` | SCRUM-4988 (Sekura Phase 2): libvips/libheif GHSAs on `sharp@0.34.5`, transitive via `@huggingface/transformers` (`^0.34.5`) and (dev) `wrangler -> miniflare` (exact `0.35.2`). Version-SCOPED per CTO ruling 2026-09-12, in the `minimatch@<3.1.3` form already used above: `<0.35.4` intersects both declared specs, so both still resolve to 0.35.4 and miniflare's nested copy still dedupes away (27 lockfile entries removed) — the regenerated lockfile is byte-identical to the one the unscoped key produced. The scope is what stops a future consumer declaring `^0.36` from being silently DOWNGRADED to 0.35.4; a hard key would have done exactly that. | Remove once `@huggingface/transformers` declares a range that already includes a patched `sharp`. Verify with `npm ls sharp --all` (all edges `overridden`/`deduped` to one version) and a `npm run build` + grep of `dist/` for `@img/sharp` (only `ThirdPartyNoticesPage-*.js` may match). NOTE: because the key is scoped, a consumer that moves to an unpatched version ABOVE 0.35.4 is no longer force-pinned — the loud failure is `security:license-denylist` going red on a new unallowlisted `@img/sharp-libvips-*` band, which is the intended signal. A `sharp` bump is also an allowlist + pinned-notices change — see `scripts/security/agents.md`. |
| `package.json` | `adm-zip@<0.6.1: 0.6.1` | SCRUM-4988: GHSA-vwc7-r8mq-g2x9 (extraction follows destination symlinks) affects `>=0.5.9 <=0.6.0`. The root copy is transitive via `onnxruntime-node`, whose declared `^0.5.16` the override crosses; version-scoped per CTO ruling 2026-09-12 for the same reason as the `sharp` row. The `services/worker` copy is NOT pinned — it was a direct dependency with zero importers and was deleted outright (with `@types/adm-zip`) rather than patched, which is the permanent fix. `integrations/zapier` still resolves `adm-zip@0.5.16` under `zapier-platform-cli`; that is dev-only release tooling and is deliberately left alone. | Remove when `onnxruntime-node` declares `adm-zip >=0.6.1`. Verify with `npm ls adm-zip` and `npm audit --omit=dev`. |
| `package.json` | `brace-expansion@1: 1.1.18`, `brace-expansion@5: 5.0.9` | SCRUM-4988: ReDoS advisories on the 1.1.x and 5.0.x lines, reached via eslint plugins (`minimatch@3`) and `minimatch@10`. Version-SCOPED because the tree legitimately carries three major lines at once; an unscoped key would collapse them onto one major and break `minimatch`'s declared ranges. | Remove a scoped key once every consumer of that major resolves to a patched version on its own (`npm ls brace-expansion --all`). |
| `services/worker/package.json` | `brace-expansion@2: 2.1.4`, `brace-expansion@5: 5.0.9` | SCRUM-4988: same advisories, worker tree — `snarkjs -> ejs -> jake -> filelist -> minimatch@5` (v2 line) and `eslint -> minimatch@10` (v5 line). Scoped for the same reason as the root entry. | As above, run from `services/worker`. |
| `integrations/zapier/package.json` | `form-data: 4.0.6` | SCRUM-4988: CVE-2026-12143 on `form-data@4.0.5`, transitive via `zapier-platform-core`. This directory had no Dependabot coverage at all, which is why it went unbumped; coverage added in the same PR. | Remove once `zapier-platform-core` ships a patched `form-data`. Verify with `npm ls form-data` from `integrations/zapier`. NOTE: this lockfile is scanned by neither `security:license-denylist` nor the `npm audit` CI step (root + worker only), so it needs a manual `npm audit` when touched. |

## Adding or bumping a dependency

`save-exact=true` is set in `.npmrc`, so `npm install --save <pkg>`
already pins exactly. To bump, edit `package.json` to the new exact
version and run `npm install` to refresh the lockfile. PRs must never
include range syntax in `package.json`, even temporarily.

## Implementation

- **Script:** [`scripts/ci/check-dep-pinning.ts`](../../scripts/ci/check-dep-pinning.ts)
- **Tests:** [`scripts/ci/check-dep-pinning.test.ts`](../../scripts/ci/check-dep-pinning.test.ts)
- **CI wiring:** `.github/workflows/ci.yml` → `dependency-scan` job →
  `Enforce pinned package versions` step (`npm run ci:dep-pinning`)
- **Override label:** `dep-range-intentional`
- **Test override:** `DEP_PINNING_REPO_ROOT` env var redirects the
  scanner to a fixture directory (test-only).

## Related

- DEP-06 (SCRUM-556): npm audit integration
- Epic: SCRUM-550 — DEP: Dependency Hardening v1
