# Chrome DevTools MCP — engineering notes

> **Confluence (canonical):** [MCP-EXPAND-03 — Chrome DevTools MCP for cheap UAT](https://arkova.atlassian.net/wiki/spaces/A/pages/25657447)
> **Jira:** SCRUM-1069
> **Cost lever:** `feedback_vercel_cost_control`

## Install

```bash
claude mcp add chrome-devtools --transport stdio -- npx -y @anthropic/chrome-devtools-mcp
```

Then install the Chrome companion extension from the install-output link and grant per-tab access.

## Decision matrix

| Scenario | Tool |
|---|---|
| CSS / layout / button-click UAT | Chrome DevTools MCP against `localhost:5173` |
| OAuth callback flow (needs public URL) | Vercel preview |
| Stakeholder demo | Vercel preview |
| Cross-browser smoke pre-release | Vercel preview + Playwright |
| Production smoke after deploy | `arkova-26.vercel.app` directly + Sentry |

If Chrome DevTools MCP can't do a UAT loop, file a ticket against the Confluence page rather than burning Vercel preview minutes.
