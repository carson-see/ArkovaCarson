# agents.md — components/agents

## What This Folder Contains

The ComputeID / agent passport management surface (SPEC-AGENTS-UI). See the
`agents/` row in the parent `src/components/agents.md` Subfolder Map and its
2026-09-25 dated entry for the full writeup — this file is the folder-local
quick reference.

- `AgentsSettings.tsx` — lists an org's registered agents (name, type,
  status, created date) with suspend / resume / revoke actions. Pure
  presentational component: all data + mutations come from
  `@/hooks/useAgents` via props (`agents`, `onSuspend`, `onResume`,
  `onRevoke`, `loading`, `fetchError`), matching the `ApiKeySettings.tsx`
  pattern in `components/api/`.
- `AgentsSettings.test.tsx` — list rendering, all three data states
  (loading/empty/error per §1.2), suspend/resume calls, the revoke
  confirm-before-DELETE flow, the terminal-revocation UI rule (a `revoked`
  agent renders no status action buttons), and 409-vs-generic curated error
  copy.
- `AgentKeysPanel.tsx` — lazily fetches and renders one agent's ACTIVE API
  key prefixes via `useAgentDetail`, only when its row is expanded. `GET
  /api/v1/agents` (the list route) does not join keys; only the per-agent
  detail route does. Do not eagerly render this for every row on mount —
  that would be an N+1 fetch the worker was not built to serve.
- `AgentKeysPanel.test.tsx` — loading / error / empty / populated states,
  with `useAgentDetail` mocked (own React Query lifecycle, tested here in
  isolation from `AgentsSettings`).

## Do / Don't Rules
- DO: Keep this component a pure prop-driven view — `AgentsSettingsPage.tsx`
  owns the `useAgents()` call, matching every sibling settings page.
- DO: Map a mutation failure to curated copy via `AGENT_LABELS` — never
  render the raw thrown `Error.message` (may carry server internals). A 409
  (`AgentActionError.status === 409`) always renders
  `AGENT_LABELS.REVOKED_TERMINAL_ERROR`; anything else renders the
  action-specific `*_FAILED` string.
- DO: Keep the revoke path behind the confirm `Dialog` — DELETE is
  irreversible (revocation is terminal) and deactivates every active API key
  on the agent, which the dialog body must keep saying.
- DO NOT: Render a Suspend/Resume/Revoke button for a `revoked` agent. The
  worker 409s a status-changing PATCH against one and DELETE has nothing
  left to revoke; the correct UI is no button, not a disabled one.
- DO NOT: Add agent registration, API key minting, or ComputeID admission UI
  here — those are separate, deliberately out-of-scope surfaces (own
  security review).

## Dependencies
- `@/hooks/useAgents` — `useAgents()` (list + suspend/resume/revoke),
  `useAgentDetail()` (lazy per-agent key fetch), `AgentActionError`
- `@/lib/copy` (`AGENT_LABELS`, `AGENT_TYPE_LABELS`) — every user-visible
  string; no bare literals (§1.3, `npm run lint:copy`)
- `@/components/ui/dialog` — the revoke confirmation dialog (Radix: focus
  trap + Escape, keyboard-reachable without extra wiring)
