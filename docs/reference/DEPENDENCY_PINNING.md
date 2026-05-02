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
