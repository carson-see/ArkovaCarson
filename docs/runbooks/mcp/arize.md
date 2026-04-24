# Arize AX MCP — engineering notes

> **Confluence (canonical):** [MCP-EXPAND-01 — Arize AX MCP](https://arkova.atlassian.net/wiki/spaces/A/pages/25198697)
> **Jira:** SCRUM-1067

LLM observability for Nessie + Gemini Golden. Local-only (Claude Code), not a worker runtime dep — worker keeps emitting traces via the Arize SDK already wired into `services/worker/src/ai/observability/`.

## Install

```bash
claude mcp add arize --transport stdio -- npx -y @arizeai/arize-mcp
export ARIZE_SPACE_ID=...
export ARIZE_API_KEY=...   # from GCP Secret Manager: arize_api_key
```

## When to use

- Nessie answer-quality regression after RAG re-index
- Gemini Golden fraud-signal false-positive
- Pre/post-fine-tune comparison
- Building a curated failure-mode dataset for SCRUM-1051 GEMB2-02 verification
