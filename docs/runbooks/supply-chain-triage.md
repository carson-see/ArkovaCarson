# Supply Chain Triage Runbook

> **SCRUM-1001 (DEP-11)** | Internal engineering note — canonical docs in Confluence.

## Detection Sources

1. **Socket.dev PR check** — flags typosquatting, install-script malware, maintainer takeover
2. **OpenSSF Dependency Review** — blocks CRITICAL severity findings + GPL/AGPL/SSPL licenses
3. **npm audit** — standard vulnerability database (run in CI on every build)
4. **GitHub Dependabot/Renovate alerts** — automated CVE notifications

## Triage Decision Tree

```
New dependency alert
  |
  ├─ CRITICAL finding (malware, install script, typosquat)?
  │   ├─ YES → Block PR immediately. Do NOT merge.
  │   │         Remove the dependency. Notify #security.
  │   └─ NO  → Continue
  |
  ├─ Known vulnerability with upstream fix?
  │   ├─ YES → Update dependency in same PR.
  │   └─ NO  → Assess exploitability (see below).
  |
  ├─ Exploitable in our context?
  │   ├─ YES → Block PR. Apply CVE triage SLA.
  │   └─ NO  → Document in allowlist. Add to risk register.
  |
  └─ License violation (GPL/AGPL/SSPL)?
      ├─ YES → Block PR. Find alternative package.
      └─ NO  → Approve.
```

## Allowlist Management

To allowlist a known false positive:

1. Document in this runbook (table below)
2. Add to the relevant tool's config (Socket dashboard, `.gitleaks.toml`, `npm audit` overrides)
3. Set a calendar reminder to re-evaluate in 90 days

| Package | Finding | Reason for Allowlist | Added By | Date | Review Date |
|---------|---------|----------------------|----------|------|-------------|
| — | — | — | — | — | — |

## Incident Response (Compromised Dependency)

1. **Identify scope**: Which services import the package? Is it production or dev-only?
2. **Pin to last known-good**: `npm install package@known-good-version --save-exact`
3. **Audit transitive**: `npm ls package` to check all paths
4. **Rotate secrets**: If the package had access to env vars, rotate all secrets it could read
5. **Deploy**: Fast-track deployment with pinned version
6. **Notify**: Post to #security, update bug tracker, file Jira ticket
7. **Postmortem**: Document in incident log within 48 hours
