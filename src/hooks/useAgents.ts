/**
 * Agents Hook (SPEC-AGENTS-UI)
 *
 * ComputeID / agent passports shipped a full backend
 * (services/worker/src/api/v1/agents.ts, agents-computeid.ts) with zero
 * frontend: an org admin could grant `agents:manage` on an API key but had
 * no way to see which agents existed, their status, or revoke one except by
 * raw curl. PR #3083 fixed a real defect where suspending an agent did not
 * deactivate its API keys — that fix is only reachable through this hook.
 *
 * Contract (read the worker route before changing this file):
 *   GET    /api/v1/agents            -> { agents: Agent[] }
 *   GET    /api/v1/agents/:agentId   -> AgentDetail (adds api_keys, ACTIVE only)
 *   PATCH  /api/v1/agents/:agentId   -> { status?: 'active' | 'suspended', ... }
 *   DELETE /api/v1/agents/:agentId   -> { status: 'revoked', agent_id }
 *
 * `status: 'revoked'` is TERMINAL. A PATCH that carries a `status` field
 * against an already-revoked agent 409s (`agent_revocation_is_terminal` /
 * the hand-written 409 branch in the route) — there is no route back to
 * active or suspended. `revokeAgent` (DELETE) is the only way to reach
 * `revoked`, and nothing can undo it; the confirm-before-DELETE UX and the
 * terminal copy both live in `src/components/agents/AgentsSettings.tsx`.
 *
 * Scope: management of EXISTING agents only. This hook deliberately does NOT
 * cover POST /api/v1/agents (registration), POST /:agentId/key (key
 * minting), or the ComputeID admission flow — those are separate surfaces
 * with their own security considerations (out of scope per the founding
 * task).
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { workerFetch } from '@/lib/workerClient';
import { queryKeys } from '@/lib/queryClient';
import { useAuth } from './useAuth';

/** Mirrors `VALID_AGENT_TYPES` in services/worker/src/api/v1/agents.ts. */
export type AgentType = 'llm_agent' | 'ats_integration' | 'hr_platform' | 'compliance_tool' | 'custom';

/** `revoked` is terminal — see the module doc above. */
export type AgentStatus = 'active' | 'suspended' | 'revoked';

/**
 * Shape returned by `toPublicAgent()` on the worker: `org_id` and
 * `registered_by` are stripped server-side (§6 — never expose those to the
 * browser), so they are deliberately absent here rather than optional.
 */
export interface Agent {
  id: string;
  name: string;
  description: string | null;
  agent_type: AgentType;
  status: AgentStatus;
  allowed_scopes: string[];
  framework: string | null;
  version: string | null;
  callback_url: string | null;
  created_at: string;
  updated_at?: string;
  last_active_at?: string | null;
  suspended_at?: string | null;
  revoked_at?: string | null;
}

/** One agent's active API key, as returned by the detail route (is_active=true only). */
export interface AgentApiKeySummary {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface AgentDetail extends Agent {
  api_keys: AgentApiKeySummary[];
}

/**
 * Thrown by the status-changing helpers below on a non-OK worker response.
 * Carries the HTTP status so a caller can distinguish the terminal 409
 * ("agent is revoked, revocation is terminal") from an ordinary failure
 * without parsing the server's message text — the UI renders its own
 * curated copy either way (`AGENT_LABELS.REVOKED_TERMINAL_ERROR` for 409,
 * a generic `*_FAILED` string otherwise); this repo does not render raw
 * `Error.message` to users (it may carry server internals).
 *
 * `observedStatus` (review P2): a lost response can follow a committed
 * mutation, so the client cannot infer the agent's real status from "the
 * PATCH/DELETE call rejected" alone. `suspendAgent` / `resumeAgent` /
 * `revokeAgent` always read the agent back after a failure and attach the
 * result here:
 *   - `undefined` — no readback was attempted (error came from elsewhere).
 *   - a concrete `AgentStatus` — the readback succeeded; this is the truth,
 *     which may differ from what the failed request implied.
 *   - `null` — the readback itself also failed; the result could not be
 *     confirmed either way.
 */
export class AgentActionError extends Error {
  status: number;
  observedStatus?: AgentStatus | null;
  constructor(message: string, status: number, observedStatus?: AgentStatus | null) {
    super(message);
    this.name = 'AgentActionError';
    this.status = status;
    this.observedStatus = observedStatus;
  }
}

async function fetchAgentsData(): Promise<Agent[]> {
  const res = await workerFetch('/api/v1/agents');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to fetch agents (${res.status})`);
  }
  const { agents } = await res.json();
  return agents ?? [];
}

async function fetchAgentDetailData(agentId: string): Promise<AgentDetail> {
  const res = await workerFetch(`/api/v1/agents/${agentId}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to fetch agent (${res.status})`);
  }
  return await res.json() as AgentDetail;
}

/** PATCH a status change. Non-status edits (name/description/etc.) are out of scope here. */
async function patchAgentStatus(agentId: string, status: 'active' | 'suspended'): Promise<void> {
  const res = await workerFetch(`/api/v1/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AgentActionError(body.error ?? `Failed to update agent (${res.status})`, res.status);
  }
}

/**
 * Forces a fresh (non-cached) read of one agent's detail — used only to
 * establish the OBSERVED status after a mutation failure (review P2).
 * `staleTime: 0` guarantees a real network round-trip even if a cached
 * detail entry exists. Never throws: a failed readback resolves to `null`
 * so the caller can distinguish "confirmed unchanged/changed" from
 * "could not be confirmed".
 */
async function readObservedStatus(
  qc: ReturnType<typeof useQueryClient>,
  agentId: string,
): Promise<AgentStatus | null> {
  try {
    const detail = await qc.fetchQuery({
      queryKey: queryKeys.agentDetail(agentId),
      queryFn: () => fetchAgentDetailData(agentId),
      staleTime: 0,
    });
    return detail.status;
  } catch {
    return null;
  }
}

export function useAgents(options: { enabled?: boolean } = {}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const enabled = !!user && (options.enabled ?? true);

  const {
    data: agents = [],
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.agents(user?.id ?? ''),
    queryFn: fetchAgentsData,
    enabled,
    staleTime: 30_000,
  });

  /**
   * Invalidates the agents list, and — when an `agentId` is given — that
   * agent's own detail cache too (review P2). The list and detail routes are
   * separate query keys (`queryKeys.agents` vs `queryKeys.agentDetail`), so
   * invalidating only the list left a mounted `AgentKeysPanel` (via
   * `useAgentDetail`) showing pre-mutation status/keys after a
   * suspend/resume/revoke.
   */
  const invalidate = useCallback(async (agentId?: string) => {
    if (!user) return;
    const tasks: Promise<void>[] = [qc.invalidateQueries({ queryKey: queryKeys.agents(user.id) })];
    if (agentId) {
      tasks.push(qc.invalidateQueries({ queryKey: queryKeys.agentDetail(agentId) }));
    }
    await Promise.all(tasks);
  }, [user, qc]);

  const suspendAgent = useCallback(async (agentId: string) => {
    try {
      await patchAgentStatus(agentId, 'suspended');
      await invalidate(agentId);
    } catch (err) {
      // A lost response can follow a committed mutation — refetch before
      // reporting failure, never assume the pre-mutation state still holds.
      await invalidate(agentId);
      const observedStatus = await readObservedStatus(qc, agentId);
      const status = err instanceof AgentActionError ? err.status : 0;
      const message = err instanceof Error ? err.message : 'Failed to update agent';
      throw new AgentActionError(message, status, observedStatus);
    }
  }, [invalidate, qc]);

  const resumeAgent = useCallback(async (agentId: string) => {
    try {
      await patchAgentStatus(agentId, 'active');
      await invalidate(agentId);
    } catch (err) {
      await invalidate(agentId);
      const observedStatus = await readObservedStatus(qc, agentId);
      const status = err instanceof AgentActionError ? err.status : 0;
      const message = err instanceof Error ? err.message : 'Failed to update agent';
      throw new AgentActionError(message, status, observedStatus);
    }
  }, [invalidate, qc]);

  const revokeAgent = useCallback(async (agentId: string) => {
    const res = await workerFetch(`/api/v1/agents/${agentId}`, { method: 'DELETE' });
    if (!res.ok) {
      await invalidate(agentId);
      const observedStatus = await readObservedStatus(qc, agentId);
      const body = await res.json().catch(() => ({}));
      throw new AgentActionError(body.error ?? `Failed to revoke agent (${res.status})`, res.status, observedStatus);
    }
    await invalidate(agentId);
  }, [invalidate, qc]);

  return {
    agents,
    loading: enabled ? loading : false,
    error: queryError ? (queryError as Error).message : null,
    suspendAgent,
    resumeAgent,
    revokeAgent,
  };
}

/**
 * A single agent's detail, including its active API keys' prefixes.
 * Deliberately lazy (`enabled` gate) — the list route does not join keys,
 * and eagerly calling this per row would be an N+1 fetch on every page load.
 * Callers fetch it only when a row is expanded (see `AgentKeysPanel`).
 */
export function useAgentDetail(agentId: string | null, options: { enabled?: boolean } = {}) {
  const enabled = !!agentId && (options.enabled ?? true);

  const {
    data: detail,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.agentDetail(agentId ?? ''),
    queryFn: () => fetchAgentDetailData(agentId as string),
    enabled,
  });

  return {
    detail: detail ?? null,
    loading: enabled ? loading : false,
    error: queryError ? (queryError as Error).message : null,
  };
}
