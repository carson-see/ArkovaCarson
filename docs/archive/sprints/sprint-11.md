I'm continuing work on the Arkova project. Read CLAUDE.md, HANDOFF.md, and MEMORY.md for full context.

This sprint handles the automated parts of MVP-01 (Worker production deployment). Manual infrastructure steps (GCP auth, env var setting, DNS) are deferred to Sprint 12.

Create branch `feat/mvp-01-deploy-prep` from main.

Tasks:
1. Create Dockerfile for the worker (services/worker/). Use Node.js 20 LTS, multi-stage build (build stage + production stage). Include health check endpoint.
2. Create docker-compose.yml for local development that runs the worker alongside a mock Bitcoin node.
3. Create .dockerignore to exclude node_modules, .git, tests, docs.
4. Create deployment config for GCP Cloud Run: `infra/gcp/cloud-run.yaml` with resource limits, scaling config, environment variable placeholders.
5. Create CI/CD workflow addition: `.github/workflows/deploy-worker.yml` that builds and pushes the Docker image to GCP Artifact Registry on merge to main. Use placeholder project ID.
6. Verify Dockerfile builds successfully: `docker build -t arkova-worker ./services/worker/`
7. Test the health check endpoint works in the container.

After all work, run: npx tsc --noEmit && npm run lint && npm test

Create a single commit, push, and create PR against main with title "feat(MVP-01): worker deployment prep — Dockerfile, Cloud Run config, CI/CD".

After PR is created, wait 10 minutes. Then review the PR and all its comments (use `gh pr view` and `gh api repos/carson-see/ArkovaCarson/pulls/{number}/comments`). Address any review feedback.

Update CLAUDE.md Section 8 (MVP-01 PARTIAL), HANDOFF.md, and MEMORY.md.
