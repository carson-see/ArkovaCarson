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
- `FORBIDDEN_TERMS` — every §1.3 banned word, with **two deliberate boundary styles**:
  - **Hyphen-guarded** `(?<![-\w])X(?![-\w])` — a hyphen adjacent to the term blocks the match. Used **only** for `block` and `gas`, which collide with Tailwind/CSS utilities (`inline-block`, `text-block-fg`). The hyphen carve-out is needed there and **nowhere else**.
  - **Word-boundary** `(?<!\w)X(?!\w)` — a hyphen adjacent to the term **still flags**. Used for the chain/marketing terms (`bitcoin`, `blockchain`, `crypto`, `cryptocurrency`, `testnet`, `mainnet`, `utxo`, `broadcast`) so hyphenated hero copy like `Bitcoin-anchored` / `Crypto-secured` / `UTXO-based` / `Re-broadcast` flags (SCRUM-2149 review B1). className values are stripped upstream and identifier/type positions are dropped by `isCodeIdentifier()`, so the hyphen guard is unnecessary for these. (`wallet`/`hash`/`transaction`/`mining`/`token` keep the hyphen guard — strictly safer, no known hyphenated-copy case.)
- `isCodeIdentifier()` (the structural filter, 2149d; decomposed into named predicates per review N3 — `isJsxComponentName`, `isPropertyAccess`, `isObjectKey`, `isUrlSegment`, `isBareValueString`, `isJsxVisibleText`) drops matches in code positions that are never copy: JSX component/closing-tag names, property access (`obj.bitcoin`), TS `type`/`interface` declaration lines (union members), object-key position (`mainnet:` / `'mainnet':`), URL literals & path segments (`/block/`, `https://…/testnet`), and **bare in-code value strings** (a quoted string whose entire content is exactly the term, e.g. `'token'`, `|| 'mainnet'`). Two of these — URL-segment and bare-value — are **gated on `!isJsxVisibleText`** (review N2): they will NOT suppress a banned word that sits in visible JSX element text (between `>` and `<`), so `<p>Testnet/Mainnet</p>` flags both terms and `<p>"Bitcoin"</p>` / `<button>'Broadcast'</button>` flag. The bare-value skip also does NOT apply to JSX/HTML attribute values (`placeholder="Wallet…"` — preceded by `=`), which still flag.
- `findRawEnumRenders()` + `RISKY_ENUM_FIELDS` (2149c) — flags a RAW DB-enum render: a bare `{X.status}` / `{X.credential_type}` / `{X.anchor_status}` / `{X.network}` used as a JSX expression CHILD. A child is the whole (trimmed) line, an inline `>{…}<`, **or an expression preceded by leading text** when a tag has closed (`>`) earlier on the line and a tag (`<`) follows (review N1: `<div>Label: {row.status}</div>` now flags). Ignores `${res.status}` template interpolation, `status={x.status}` / `key={x.status}` attribute positions (excluded by the leading boundary class `[^$=\w.]`), non-risky fields, and non-`.tsx` files. Fix = route the value through a display mapper in `src/lib/copy.ts` (`ANCHOR_STATUS_LABELS`, `formatCredentialType`, …). Keep the risky-field set small.
- **Deliberate heuristic blind spots (do NOT over-trust the gate):** the raw-enum detector targets the bare `{ident.field}` shape only. It does **not** flag a defaulted child `{x.status || ''}`, a call-result child `{getX().status}`, a template-literal child `` {`${x.status}`} ``, a multi-line JSX child split across lines, or any risky field accessed via bracket notation `{x['status']}`. These are accepted false-negatives to keep false-positives near zero; a banned literal rendered through any of them must be caught in review or via a `src/lib/copy.ts` mapper. The term scan is also line-by-line, so a banned word split across two lines is not caught.
- All hot-path regexes are pre-compiled at module scope (`FORBIDDEN_REGEXES`, `RAW_ENUM_CHILD_RE`, `LEADING_BRACE_EXPR_RE`, `ENUM_FIELD_RE`); patterns are bounded — character classes exclude their delimiter (`[^}]*`) and there are no nested/lazy quantifiers or `\s+$`-style anchored runs, so they are **ReDoS-safe** (SonarCloud S5852/S6594 clean; review B3 replaced the `replace(/\s+$/,'')` and lazy `.match(/…[^}]*?…/)` with `.trimEnd()` + non-lazy `RegExp.exec`).

**Grandfather baseline protocol (`scripts/ci/snapshots/copy-terms-baseline.json`):** records ONLY pre-existing violations that cannot be fixed in the current PR (a file locked by another open PR, or a fix owned by another in-flight track). The linter partitions current violations against the baseline (match key = normalised `file`+`line`; `term` is informational) and fails ONLY on NEW ones. Stale entries (baselined line no longer violating) print a non-fatal warning to prompt cleanup. `loadBaseline()` fail-closes (treats a missing/corrupt baseline as empty → everything fails). **Never baseline a violation you are introducing** — fix at source or use a mapper. Each entry must carry a `reason`. Retire entries; never extend them as a workaround.

## Conventions
- Deploy scripts must use `linux/amd64` images and full 40-char Git SHAs.
- CI scripts exit 0 = pass, exit 1 = fail with actionable message.
