# .github/agents.md

GitHub repository configuration: PR templates, issue templates, Dependabot, and CI/CD workflows.

## Files
- **`pull_request_template.md`** — PR template with checklists for type of change, DB changes, testing, screenshots, and deployment notes.
- **`dependabot.yml`** — weekly Dependabot config for root, worker, and integration packages; groups minor/patch updates.
- **`CONTRIBUTING.md`** — contributor guidelines.
- **`ISSUE_TEMPLATE/`** — GitHub issue templates (bug report, feature request, config).
- **`workflows/`** — GitHub Actions CI/CD workflows (has its own agents.md).

## Conventions
- All CI workflows trigger on PR or push to `main`/`develop` only; feature-branch pushes are ignored.
- PR body must include staging soak evidence per CLAUDE.md 1.11/1.12.
