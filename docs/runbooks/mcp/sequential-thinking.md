# Sequential Thinking + Google Developer Knowledge MCPs — engineering notes

> **Confluence (canonical):** [MCP-EXPAND-04 — Sequential Thinking + Google Developer Knowledge MCPs](https://arkova.atlassian.net/wiki/spaces/A/pages/26705946)
> **Jira:** SCRUM-1070

## Install

```bash
claude mcp add sequential-thinking --transport stdio -- npx -y @modelcontextprotocol/server-sequential-thinking
claude mcp add google-dev-knowledge --transport stdio -- npx -y @google/developer-knowledge-mcp
export GOOGLE_DEVELOPER_API_KEY=...   # from GCP Secret Manager: google_developer_api_key
```

## When to use (repo-specific)

- **Sequential Thinking**: designing a state machine before writing TLA+ in `machines/*.machine.ts`; debugging across worker → Supabase → Cloudflare edge.
- **Google Developer Knowledge**: any Vertex AI / Cloud Run / KMS / Secret Manager call — verify current request schema before writing the call. APIs change quarterly.

For generic use cases (sprint planning, GCP cost estimation), see the Confluence page.
