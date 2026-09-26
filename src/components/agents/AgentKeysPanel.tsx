/**
 * Agent Keys Panel (SPEC-AGENTS-UI)
 *
 * Lazily shows an agent's ACTIVE API key prefixes. `GET /api/v1/agents` (the
 * list route) does not join keys — only `GET /api/v1/agents/:agentId` does,
 * and it filters to `is_active = true` server-side. Rendered only when a row
 * is expanded (see `AgentsSettings.tsx`), never eagerly per row, so viewing
 * the agent list never fans out into N+1 detail fetches.
 */

import { KeyRound, Loader2 } from 'lucide-react';
import { AGENT_LABELS } from '@/lib/copy';
import { useAgentDetail } from '@/hooks/useAgents';

interface AgentKeysPanelProps {
  agentId: string;
}

export function AgentKeysPanel({ agentId }: AgentKeysPanelProps) {
  const { detail, loading, error } = useAgentDetail(agentId);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        {AGENT_LABELS.KEYS_LOADING}
      </div>
    );
  }

  if (error) {
    // Never render the raw thrown message (may carry server internals) —
    // one curated, scrubbed string covers every failure mode here.
    return (
      <p className="text-xs text-destructive py-2">{AGENT_LABELS.KEYS_ERROR}</p>
    );
  }

  const keys = detail?.api_keys ?? [];

  if (keys.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-2">{AGENT_LABELS.KEYS_EMPTY}</p>
    );
  }

  return (
    <ul className="space-y-1.5 py-2">
      {keys.map((key) => (
        <li key={key.id} className="flex items-center gap-2 text-xs">
          <KeyRound className="h-3 w-3 text-muted-foreground shrink-0" />
          <span className="font-mono">{key.key_prefix}••••••••</span>
          <span className="text-muted-foreground">{key.name}</span>
        </li>
      ))}
    </ul>
  );
}
