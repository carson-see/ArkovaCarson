I'm continuing work on the Arkova project. Read CLAUDE.md, HANDOFF.md, and MEMORY.md for full context.

Execute GCP infrastructure stories (automated code parts only).

Create branch `feat/gcp-infrastructure` from main.

Implement:
1. MVP-27: GCP Secret Manager integration — Create a secret manager client in services/worker/src/utils/secrets.ts that loads secrets from GCP Secret Manager. Fall back to env vars when not in GCP. Add to worker config.ts.
2. MVP-28: GCP Cloud Scheduler — Create scheduler job definitions in infra/gcp/scheduler/ for worker cron jobs (anchor processing, webhook retry, report generation). Use Cloud Scheduler HTTP targets pointing to worker endpoints.
3. MVP-29: GCP Cloud KMS integration — Update KmsSigningProvider in services/worker/src/chain/signing-provider.ts to use GCP Cloud KMS instead of AWS KMS. Follow the existing interface. Add config for GCP KMS key ring + key name.
4. MVP-30: GCP CI/CD pipeline — Create .github/workflows/deploy-worker.yml with: build Docker image, push to Artifact Registry, deploy to Cloud Run. Use workload identity federation for auth (no service account keys).

TDD for all code changes.

After all work, run: npx tsc --noEmit && npm run lint && npm test

Create a single commit, push, and create PR against main with title "feat: GCP infrastructure — Secret Manager, Scheduler, KMS, CI/CD".

After PR is created, wait 10 minutes. Then review the PR and all its comments (use `gh pr view` and `gh api repos/carson-see/ArkovaCarson/pulls/{number}/comments`). Address any review feedback.

Update CLAUDE.md Section 8, HANDOFF.md, and MEMORY.md.
