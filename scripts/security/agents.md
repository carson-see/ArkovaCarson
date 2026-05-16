# scripts/security/agents.md

Security scanning scripts for dependency and license compliance.

## Files
- **`license-denylist.ts`** — scans all `package-lock.json` files for AGPL/GPL/SSPL-licensed dependencies. Returns denied matches with package name, version, and license.
- **`license-denylist.test.ts`** — colocated tests for the license scanner.
- **`license-denylist.allowlist.json`** — explicit allowlist for packages with acceptable reasons despite flagged license strings.

## Conventions
- Denylist regex: `/\b(?:AGPL|GPL|SSPL)(?:[-\s]?(?:v?\d+...)?)?\b/i`.
- Allowlisted packages must include a `reason` field explaining why they are safe.
- Run as a CI gate to block PRs introducing copyleft dependencies.
