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

[`.github/workflows/dependency-scan.yml`](../../../.github/workflows/dependency-scan.yml) runs on PR open/sync targeting `main`. Severity ≥ HIGH blocks merge, MEDIUM/LOW warns. SARIF uploaded to GitHub Security tab.

## Suppression policy

Suppressions in `.sonatype/suppressions.yml` require: (1) dead-code proof, (2) no upstream fix, (3) explicit expiry + ticket. Reviewed every 90 days alongside `SCRUM-1057` rotation cadence.
