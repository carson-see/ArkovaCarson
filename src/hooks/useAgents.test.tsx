/**
 * useAgents — request-shape tests (SPEC-AGENTS-UI).
 *
 * ComputeID / agent passports shipped a full backend
 * (services/worker/src/api/v1/agents.ts) with no frontend at all: an org
 * admin could not see, suspend, or revoke an agent except by raw curl. PR
 * #3083 fixed a real defect where suspending an agent did not deactivate its
 * API keys — that fix is only reachable through this hook's `suspendAgent`.
 *
 * Mirrors `useApiKeys.extend.test.tsx`'s pattern: assert the exact request
 * body/method per mutation, not just that the callback resolved, because a
 * wrong body silently 400s/409s server-side in a way a callback-only test
 * would never catch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('./useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, signOut: vi.fn() }),
}));

const workerFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/workerClient', () => ({ workerFetch }));

import { useAgents, useAgentDetail, AgentActionError, type Agent } from './useAgents';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function okResponse(body: unknown = {}) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

const mockAgent: Agent = {
  id: 'agent-1',
  name: 'Recruiting Bot',
  description: null,
  agent_type: 'ats_integration',
  status: 'active',
  allowed_scopes: ['verify'],
  framework: null,
  version: null,
  callback_url: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  last_active_at: null,
  suspended_at: null,
  revoked_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  workerFetch.mockResolvedValue(okResponse({ agents: [mockAgent] }));
});

describe('useAgents — list', () => {
  it('fetches GET /api/v1/agents and returns the agents array', async () => {
    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agents).toEqual([mockAgent]);
    expect(workerFetch).toHaveBeenCalledWith('/api/v1/agents');
  });

  it('surfaces a fetch error without throwing', async () => {
    workerFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Failed to list agents' }),
    });

    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Failed to list agents');
    expect(result.current.agents).toEqual([]);
  });
});

describe('useAgents — suspendAgent', () => {
  it('PATCHes {status: "suspended"} to /api/v1/agents/:id', async () => {
    const { result } = renderHook(() => useAgents(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.suspendAgent('agent-1');
    });

    const call = workerFetch.mock.calls.find(([path]) => String(path) === '/api/v1/agents/agent-1');
    expect(call).toBeDefined();
    expect(call![1].method).toBe('PATCH');
    expect(JSON.parse(call![1].body)).toEqual({ status: 'suspended' });
  });
});

describe('useAgents — resumeAgent', () => {
  it('PATCHes {status: "active"} to /api/v1/agents/:id', async () => {
    const { result } = renderHook(() => useAgents(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.resumeAgent('agent-1');
    });

    const call = workerFetch.mock.calls.find(([path]) => String(path) === '/api/v1/agents/agent-1');
    expect(call).toBeDefined();
    expect(call![1].method).toBe('PATCH');
    expect(JSON.parse(call![1].body)).toEqual({ status: 'active' });
  });
});

describe('useAgents — revokeAgent', () => {
  it('DELETEs /api/v1/agents/:id', async () => {
    const { result } = renderHook(() => useAgents(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.revokeAgent('agent-1');
    });

    const call = workerFetch.mock.calls.find(([path]) => String(path) === '/api/v1/agents/agent-1');
    expect(call).toBeDefined();
    expect(call![1].method).toBe('DELETE');
  });

  it('requires no confirmation itself — that is the caller’s job — but throws on failure so the caller never assumes success', async () => {
    workerFetch
      .mockResolvedValueOnce(okResponse({ agents: [mockAgent] }))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Failed to revoke agent' }),
      });

    const { result } = renderHook(() => useAgents(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(async () => { await result.current.revokeAgent('agent-1'); }),
    ).rejects.toThrow();
  });
});

describe('useAgents — 409 terminal-revocation surfacing', () => {
  it('suspendAgent throws an AgentActionError carrying status 409, not a raw message the UI must parse', async () => {
    workerFetch
      .mockResolvedValueOnce(okResponse({ agents: [mockAgent] }))
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'Agent is revoked — revocation is terminal; register a new agent instead' }),
      });

    const { result } = renderHook(() => useAgents(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.suspendAgent('agent-1');
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(AgentActionError);
    expect((caught as AgentActionError).status).toBe(409);
  });

  it('resumeAgent throws an AgentActionError carrying status 409', async () => {
    workerFetch
      .mockResolvedValueOnce(okResponse({ agents: [mockAgent] }))
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'Agent is revoked — revocation is terminal; register a new agent instead' }),
      });

    const { result } = renderHook(() => useAgents(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.resumeAgent('agent-1');
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(AgentActionError);
    expect((caught as AgentActionError).status).toBe(409);
  });
});

describe('useAgentDetail', () => {
  it('fetches GET /api/v1/agents/:id and returns api_keys', async () => {
    workerFetch.mockResolvedValue(okResponse({
      ...mockAgent,
      api_keys: [
        { id: 'key-1', name: 'Recruiting Bot — auto-generated', key_prefix: 'ak_live_abc1', scopes: ['verify'], is_active: true, last_used_at: null, created_at: '2026-09-01T00:00:00Z', expires_at: null },
      ],
    }));

    const { result } = renderHook(() => useAgentDetail('agent-1'), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(workerFetch).toHaveBeenCalledWith('/api/v1/agents/agent-1');
    expect(result.current.detail?.api_keys).toHaveLength(1);
    expect(result.current.detail?.api_keys[0].key_prefix).toBe('ak_live_abc1');
  });

  it('does not fetch when disabled (agentId null)', () => {
    const { result } = renderHook(() => useAgentDetail(null), { wrapper });
    expect(result.current.loading).toBe(false);
    expect(workerFetch).not.toHaveBeenCalled();
  });
});
