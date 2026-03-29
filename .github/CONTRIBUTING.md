# Contributing to Arkova

## GitHub ↔ Jira Integration

This repository is connected to [Jira (AR project)](https://blocdoc1.atlassian.net/jira/software/projects/AR/board). Follow these conventions to keep everything linked automatically.

### Branch Naming

```
AR-{issue-number}/{type}/{short-description}
```

Examples:
```
AR-45/feat/redis-rate-limiting
AR-120/fix/mempool-fallback-url
AR-200/chore/update-dependencies
```

Types: `feat`, `fix`, `chore`, `docs`, `perf`, `refactor`, `test`, `security`

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/) with Jira issue keys:

```
feat(ai): add confidence meta-model calibration AR-150

fix(worker): resolve UTXO provider testnet4 default AR-267

perf: parallelize ComplianceDashboard queries AR-180
```

**Format:** `type(scope): description AR-XXX`

The Jira issue key in the commit message automatically links the commit to the Jira issue.

### Pull Requests

1. Use the PR template (auto-loaded)
2. Include `AR-XXX` in the PR title or description
3. PRs auto-link to Jira issues when issue keys are referenced
4. All PRs must pass CI: `typecheck`, `lint`, `test`, `lint:copy`

### Labels

| Label | When to Use |
|-------|------------|
| `bug` | Bug fix |
| `security` | Security finding or fix |
| `performance` | Performance optimization |
| `ai` | AI/ML changes |
| `infrastructure` | DevOps, CI/CD, deployment |
| `api` | Verification API changes |
| `database` | Schema, migrations, RLS |
| `frontend` | React UI changes |
| `worker` | Express worker changes |
| `breaking-change` | Breaking API or schema change |
| `P0-critical` | Must fix immediately |
| `P1-high` | High priority |
| `P2-medium` | Medium priority |
| `P3-low` | Low / nice to have |

### Releases

Releases follow [Semantic Versioning](https://semver.org/):
- **Major (vX.0.0):** Breaking API changes, major architecture shifts
- **Minor (v0.X.0):** New features, new story completions
- **Patch (v0.0.X):** Bug fixes, audit findings, performance improvements

Current release: **v1.2.0**

### Smart Transitions

When GitHub is connected to Jira, these actions can auto-transition issues:
- **PR opened** → Issue moves to "In Progress"
- **PR merged** → Issue moves to "Done"
- **Branch created with AR-XXX** → Issue auto-linked

## Development Setup

See `CLAUDE.md` for the full engineering directive, including:
- Tech stack and constraints
- Testing requirements
- Security mandates
- Migration procedures

## CI Checks

Every PR runs:
```bash
npx tsc --noEmit          # TypeScript type checking
npm run lint              # ESLint
npm run test:coverage     # Vitest with coverage
npm run lint:copy         # Banned terms check
```

If schema changed: `npm run gen:types`
If user-facing flow changed: `npm run test:e2e`
