# infra/sentry/agents.md

Declared Sentry configuration for the `arkova-worker` project. **One file:** `alert-rules.json`.

## Read this before you change anything here

**A rule in `alert-rules.json` is a DECLARATION, not a live alarm.** The Sentry MCP cannot create
issue-alert rules, so nothing in this directory does anything until an admin opens
<https://arkova.sentry.io/alerts/rules/> and creates the rule 1:1 by hand — and it does not count as
wired until a real Slack delivery has been captured. Editing this file changes what *should* exist.
It never changes what fires. Say so plainly in any PR body that touches it.

**Do not trust a rule count written in prose.** The `comment` header has drifted from the actual
array length more than once. Count `rules`.

## 2026-08-17 — every rule is scoped to `environment: production`

Previously **no** rule carried an environment scope. That was harmless only by accident: the soak
rigs have no `SENTRY_DSN`, so they emit nothing at all. The moment any rig gets one — a Cloud Run env
change, one line, no code review, no PR — every unscoped rule would route rig events to `#ops`
identically to production. A latent trap armed by a config change nobody would think of as risky.

The scope is exact rather than best-effort because `resolveSentryEnvironment`
(`services/worker/src/utils/sentry.ts`) already does the hard half: rigs run `NODE_ENV=production`,
so the environment tag is derived from `K_SERVICE`, and **only** `arkova-worker` earns `production`.
Every other Cloud Run service tags itself with its own service name, and an explicit
`SENTRY_ENVIRONMENT=production` override is rejected for a non-prod service identity. So
`environment: production` means "the real prod service", not "something that claimed to be prod".

**When creating a rule in the UI, set the Environment dropdown at the top of the rule editor.** It is
the first-class `environment` field on the rule, not another entry in `filters`.

**The one emitter that is not the SDK.** `.github/workflows/revision-drift.yml` POSTs a hand-built
Sentry envelope from GitHub Actions instead of going through `Sentry.init`, so it inherits no
environment. Scoping the rules without also stamping that envelope would have silently stopped the
SCRUM-1247 revision-drift alert from matching — the exact failure this scope exists to prevent, just
pointed the other way. The workflow now sets `environment: "production"` in its event payload.

`scripts/ci/check-sentry-alert-environment-scope.test.ts` pins all of it: every rule scoped, the
`resolveSentryEnvironment` guards intact, and the workflow envelope stamped. If you add a rule
without an environment, that test fails.

## Related contract tests

| Test | Pins |
|---|---|
| `scripts/ci/check-sentry-alert-environment-scope.test.ts` | every rule scoped to `production`; prod-only environment derivation; workflow envelope parity |
| `scripts/ci/check-sentry-alert-contract.test.ts` | revision-drift tags ↔ workflow output |
| `scripts/ci/check-pipeline-throughput-alert-contract.test.ts` | SCRUM-3050 baseline + SUSTAINED routes, tag emission, bucketed fingerprint |
| `scripts/ci/check-ce-key-expiry-alert-contract.test.ts` | SCRUM-2902 CE key-expiry rule ↔ emitter |
