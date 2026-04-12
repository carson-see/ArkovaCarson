# Dependency Update Policy (DEP-08)
_Created: 2026-04-12 | Jira: SCRUM-558_

## Update Policy Tiers

| Tier | Scope | SLA | Process |
|------|-------|-----|---------|
| **Critical** | Security patches (CVE with CVSS >= 7.0) | Within 48 hours | Patch immediately, run full test suite, deploy |
| **High** | Security patches (CVSS 4.0-6.9) | Within 1 week | Schedule patch, test, deploy in next release |
| **Minor** | Non-security minor versions | Monthly review | Batch into monthly update PR |
| **Major** | Major version upgrades | Quarterly planning | Create migration story, estimate effort, plan sprint |

## Audit Schedule

- **Weekly**: `npm audit` runs in CI on every push (added in DEP-08, fails on HIGH+ severity)
- **Monthly**: Manual dependency review — check for outdated packages, plan updates
- **Quarterly**: Major version review — identify EOL frameworks, plan migrations

## Security-Critical Dependencies (Pinned — DEP-06)

These packages use exact version pins (no `^`). Updates require explicit review:

| Package | Reason |
|---------|--------|
| `jose` | JWT verification — behavioral change = auth bypass |
| `bitcoinjs-lib` | TX construction — affects anchoring integrity |
| `tiny-secp256k1` | Elliptic curve crypto — foundational |
| `stripe` | Payment processing — API compatibility |
| `@supabase/supabase-js` | Data layer — breaking change = total outage |
| `snarkjs` | ZK proof generation — GPL licensed |
| `pkijs` | Certificate validation — AdES signatures |

## npm audit in CI

Added to the CI pipeline's dependency scanning job. Fails the build on HIGH or CRITICAL severity vulnerabilities.

```yaml
# In .github/workflows/ci.yml → dependency-scan job
- name: Audit for vulnerabilities
  run: npm audit --audit-level=high
```

## Change Log

| Date | Change |
|------|--------|
| 2026-04-12 | Initial policy — 4 tiers, pinned deps list, CI npm audit gate |
