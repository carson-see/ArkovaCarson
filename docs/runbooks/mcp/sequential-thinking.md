# Sequential Thinking + Google Developer Knowledge MCPs — engineering notes

> **Confluence (canonical):** [MCP-EXPAND-04 — Sequential Thinking + Google Developer Knowledge MCPs](https://arkova.atlassian.net/wiki/spaces/A/pages/26705946)
> **Jira:** SCRUM-1070

## Install

```bash
claude mcp add sequential-thinking --transport stdio -- npx -y @modelcontextprotocol/server-sequential-thinking
claude mcp add google-dev-knowledge --transport stdio -- npx -y @google/developer-knowledge-mcp
export GOOGLE_DEVELOPER_API_KEY=...   # from GCP Secret Manager: google_developer_api_key
```

## When to use Sequential Thinking

- Designing a state machine before writing TLA+ in `machines/*.machine.ts`
- Multi-component failure debugging (worker → Supabase → Cloudflare edge)
- Sprint planning decomposition
- PR review > 500 LoC

## When to use Google Developer Knowledge

- Any GCP API call — verify current request schema (Vertex APIs change quarterly)
- Cloud Run cost estimation
- IAM role audit (`roles/X` semantics shift between releases)
- Vertex AI quota planning
