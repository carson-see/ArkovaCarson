# Sonatype MCP + dependency-scan CI — engineering notes

> **Confluence (canonical):** [MCP-EXPAND-02 — Sonatype MCP + CI dependency scan](https://arkova.atlassian.net/wiki/spaces/A/pages/26279938)
> **Jira:** SCRUM-1068
> **SOC 2:** CC7.1 — System Component Vulnerability Management

## Install (engineer Claude Code)

```bash
claude mcp add sonatype --transport stdio -- npx -y @sonatype/sonatype-mcp
export SONATYPE_OSS_INDEX_USER=...
export SONATYPE_OSS_INDEX_TOKEN=...   # from GCP Secret Manager: sonatype_oss_index_token
```

## CI workflow

[`.github/workflows/dependency-scan.yml`](../../../.github/workflows/dependency-scan.yml) runs on PR open/sync targeting `main` (plus weekly cron). Severity ≥ HIGH blocks merge, MEDIUM/LOW warns. SBOM artifacts retained 90 days.

**Auth path:** GitHub Actions → GCP Workload Identity Federation (existing repo secrets `GCP_SERVICE_ACCOUNT` + `GCP_WORKLOAD_IDENTITY_PROVIDER`) → `google-github-actions/get-secretmanager-secrets@v2` → pulls `sonatype_oss_index_user` + `sonatype_oss_index_token` from GCP project `arkova1`. **No Sonatype creds in GitHub repo secrets** — aligns with SCRUM-1055 SEC-HARDEN-02.

If only the token was stored in Secret Manager (not the user), the workflow falls back to `Authorization: Bearer` instead of basic auth. Either pattern works against `https://ossindex.sonatype.org/api/v3/component-report`.

## Suppression policy

Suppressions in `.sonatype/suppressions.yml` require: (1) dead-code proof, (2) no upstream fix, (3) explicit expiry + ticket. Reviewed every 90 days alongside `SCRUM-1057` rotation cadence.
