# scripts/agents.md

Operational, CI, deployment, and security scripts. Run manually or from CI workflows.

## Key subdirectories
- **`ci/`** — CI gate scripts (has its own agents.md).
- **`agent/`** — local agent bootstrap helpers, including the `CLAUDE.md` acknowledgement required before staging/prod-sensitive commands.
- **`gcp-setup/`** — GCP infrastructure provisioning (service accounts, BigQuery, SLOs, Cloud Scheduler).
- **`healthcheck/`** — credential + external-service smoke tests.
- **`ops/`** — operational scripts (pg_cron management, pipeline dashboard cache).
- **`security/`** — license denylist scanner (blocks AGPL/GPL/SSPL).
- **`staging/`** — staging environment tooling (deploy, migrations).
- **`uat/`** — UAT screenshot capture scripts.
- **`admin/`** — admin provisioning scripts (sandbox orgs).

## Top-level files
- **`deploy-worker.sh`** — builds and deploys the worker to Cloud Run. Must use `--platform linux/amd64` and full 40-char SHA.
- **`deploy-edge-worker.sh`** — deploys Cloudflare edge worker via wrangler.
- **`deploy-embed-cdn.sh`** — deploys the embed widget to CDN.
- **`deploy-tunnel.sh`** — deploys Cloudflare Tunnel.
- **`publish-packages.sh`** — publishes SDK packages to npm.
- **`check-copy-terms.ts`** — `npm run lint:copy`. CI lint for banned UI terminology and public launch-blocker legal placeholder copy (Constitution §1.3). See "Copy-term linter" below for scope, detection model, and the grandfather baseline protocol.
- **`check-homepage-jsonld.test.ts`** — tests for homepage JSON-LD structured data.
- **`enforce-tdd.sh`** — enforces TDD: test must exist before production code.
- **`ci-supabase-start.sh`** — starts Supabase for CI environments.

## Copy-term linter (`check-copy-terms.ts`, SCRUM-2149 / SCRUM-2148)

**Scope (`shouldCheck` / `INCLUDE_ROOTS`):** scans `src/components/`, `src/pages/`, `src/lib/`, `src/hooks/`, and `packages/embed/src/` (the PUBLIC embeddable widget). Pre-2149 it scanned only `src/components` + `src/pages`, so banned terms in shared utilities, hooks, and the public widget shipped while the gate stayed green. Excludes (`EXCLUDE_PATTERNS`): `src/lib/copy.ts` (the vocabulary file), `**/*.test.ts(x)`, `src/components/ui/**` (primitives), `src/components/admin/treasury/**` (internal ops). `main()` walks roots via `collectCandidateFiles()`, derived from `INCLUDE_ROOTS` so coverage and `shouldCheck` cannot drift.

**Detection model — only USER-VISIBLE copy flags:**
- `FORBIDDEN_TERMS` — every §1.3 banned word with `(?<![-\w])…(?![-\w])` boundaries (incl. `testnet`/`mainnet`/`utxo`/`broadcast`, added in 2149b). Boundaries keep terms off identifiers/type-names (`BitcoinNetwork`, `Cryptographic`, `mainnetConfig`).
- `isCodeIdentifier()` (the structural filter, 2149d) drops matches in code positions that are never copy: JSX component/closing-tag names, property access (`obj.bitcoin`), TS `type`/`interface` declaration lines (union members), object-key position (`mainnet:` / `'mainnet':`), URL literals & path segments (`/block/`, `https://…/testnet`), and **bare in-code value strings** (a quoted string whose entire content is exactly the term, e.g. `'token'`, `|| 'mainnet'`). The bare-value skip does NOT apply to JSX/HTML attribute values (`placeholder="Wallet…"` — preceded by `=`), which still flag.
- `findRawEnumRenders()` + `RISKY_ENUM_FIELDS` (2149c) — flags a RAW DB-enum render: a bare `{X.status}` / `{X.credential_type}` / `{X.anchor_status}` / `{X.network}` used as a JSX expression CHILD (alone on a line or inline `>{…}<`). Ignores `${res.status}` template interpolation, `status={x.status}` attribute pass-through (the correct mapper pattern), non-risky fields, and non-`.tsx` files. Fix = route the value through a display mapper in `src/lib/copy.ts` (`ANCHOR_STATUS_LABELS`, `formatCredentialType`, …). Keep the risky-field set small.
- All hot-path regexes are pre-compiled at module scope (`FORBIDDEN_REGEXES`, `RAW_ENUM_CHILD_RE`); patterns are bounded (no nested quantifiers → ReDoS-safe).

**Grandfather baseline protocol (`scripts/ci/snapshots/copy-terms-baseline.json`):** records ONLY pre-existing violations that cannot be fixed in the current PR (a file locked by another open PR, or a fix owned by another in-flight track). The linter partitions current violations against the baseline (match key = normalised `file`+`line`; `term` is informational) and fails ONLY on NEW ones. Stale entries (baselined line no longer violating) print a non-fatal warning to prompt cleanup. `loadBaseline()` fail-closes (treats a missing/corrupt baseline as empty → everything fails). **Never baseline a violation you are introducing** — fix at source or use a mapper. Each entry must carry a `reason`. Retire entries; never extend them as a workaround.

## Conventions
- Deploy scripts must use `linux/amd64` images and full 40-char Git SHAs.
- CI scripts exit 0 = pass, exit 1 = fail with actionable message.
