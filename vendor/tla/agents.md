# vendor/tla/ — vendored TLA+ model checker

## What is here

`tla2tools.jar` — the TLC model checker used by `npm run verify:machines` and by
the `TLA+ Verification` CI job. It is **committed on purpose**. Do not delete it,
and do not "clean it up" as a stray binary.

| Field | Value |
|---|---|
| Upstream | `https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar` |
| SHA256 | `ab323b79802aedc3203b3f9af37c6aca3ed43f4e0225b36f2aa77b26de46c05f` |
| SHA1 | `5288dcb2c48ece915768f61eaa1f117fd71044c6` |
| Size | 4486193 bytes |
| TLC version | `2026.08.11.125311` |
| Upstream asset `updated_at` | `2026-08-11T12:59:18Z` |
| Vendored on | 2026-08-11 |
| License | MIT (TLA+ Tools, Microsoft Research / Lamport) |

## Why it is vendored rather than downloaded

Upstream `tlaplus/tlaplus` **v1.8.0 is a mutable pre-release tag**. Upstream
re-cut it four times in about five weeks — 2026-07-09, 2026-07-18/21,
2026-07-31, 2026-08-11 — and each re-cut changes the jar bytes *and* the TLC
build. CI used to download the jar at job time and check it against a pinned
SHA256, so every re-cut broke the pin, turned `TLA+ Verification` red on every
PR touching `machines/`, and **skipped the actual model check** — the job read
like an infra hiccup while formal verification quietly stopped running. See
`git log -- .github/workflows/ci.yml` for the four re-pin commits.

Vendoring removes the failure class outright: no network at verify time, no
mutable upstream tag in the critical path, byte-identical checking on every
run and on every developer machine.

Alternatives considered and rejected:

- **Pin to stable v1.7.4** (genuinely immutable, published 2024-08-05) —
  rejected: downgrades TLC by two years and changes verification semantics.
- **Mirror to a GCS bucket** — rejected: the TLA job has no GCP auth today, and
  adding Workload Identity Federation introduces a secretless-PR skip path
  (compare `migration-drift.yml`'s "Skip prod drift check for Dependabot
  secretless PRs" step). That reintroduces the exact silent-skip behaviour
  vendoring is meant to remove.
- **Keep downloading, only make the failure louder** — rejected as insufficient:
  the job was already red; the real cost is the recurring ~10-day breakage.

## Beware the silent cache fallback

`tla-precheck`'s `resolveTlcJarPath()` (`dist/core/tooling.js`) uses
`TLA2TOOLS_JAR` when it is set **and the file exists**, and otherwise silently
falls back to its own `~/.tla-precheck/tla2tools.jar` download cache. A typo in
the path therefore does not fail — it quietly model-checks against whatever
build that machine happened to download months ago. Three different TLC builds
were observed coexisting on one developer machine while writing this.

Because of that, CI deliberately does **not** run `tla-precheck setup`: there is
no cache for a misconfiguration to fall back onto, so a broken path errors
loudly instead of verifying against the wrong jar.

## Updating the jar

Only update deliberately — for a real TLA+ upgrade, not to chase a re-cut.

1. Download and record all three independent anchors (this is the same
   supply-chain protocol the old pin used):
   - the release body's SHA1 checksum table vs `shasum -a 1` of the download,
   - the release API asset digest: `gh api repos/tlaplus/tlaplus/releases/tags/<tag>`,
   - a direct `curl --proto '=https' --proto-redir '=https' -fsSL <url> | shasum -a 256`.

   All three must agree. A mismatch is a supply-chain signal, not an update.
2. Replace `tla2tools.jar`, update the table above **and** `TLA2TOOLS_SHA256` in
   `.github/workflows/ci.yml` (they are cross-checked in CI).
3. Re-run every machine locally before pushing:

   ```bash
   TLA2TOOLS_JAR="$PWD/vendor/tla/tla2tools.jar" npm run verify:machines
   ```

   All machines must pass. `.github/workflows/ci.yml` and `vendor/tla/**` are in
   the `TLA+ Verification` trigger set, so a jar change re-runs the real model
   check in CI too.
