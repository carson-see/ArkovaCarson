/**
 * AgentKeysPanel Tests (SPEC-AGENTS-UI)
 *
 * Lazy per-agent API key viewer: GET /api/v1/agents/:agentId is the only
 * route that returns `api_keys` (list route does not join them), so this
 * panel fetches on demand via `useAgentDetail` rather than the list eagerly
 * N+1-fetching every row.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const useAgentDetail = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAgents', () => ({ useAgentDetail }));

import { AgentKeysPanel } from './AgentKeysPanel';

describe('AgentKeysPanel', () => {
  it('shows a loading state while the detail fetch is in flight', () => {
    useAgentDetail.mockReturnValue({ detail: null, loading: true, error: null });
    render(<AgentKeysPanel agentId="agent-1" />);
    expect(screen.getByText(/Loading API keys/)).toBeInTheDocument();
  });

  it('shows an error state on fetch failure', () => {
    useAgentDetail.mockReturnValue({ detail: null, loading: false, error: 'boom' });
    render(<AgentKeysPanel agentId="agent-1" />);
    expect(screen.getByText(/Unable to load this agent.s API keys/)).toBeInTheDocument();
    // The raw thrown message must never reach the DOM.
    expect(screen.queryByText('boom')).toBeNull();
  });

  it('shows an empty state when the agent has no active keys', () => {
    useAgentDetail.mockReturnValue({ detail: { api_keys: [] }, loading: false, error: null });
    render(<AgentKeysPanel agentId="agent-1" />);
    expect(screen.getByText(/No active API keys/)).toBeInTheDocument();
  });

  it('renders each active key’s prefix and name', async () => {
    useAgentDetail.mockReturnValue({
      detail: {
        api_keys: [
          { id: 'key-1', name: 'Recruiting Bot — auto-generated', key_prefix: 'ak_live_abc1', scopes: ['verify'], is_active: true, last_used_at: null, created_at: '2026-09-01T00:00:00Z', expires_at: null },
          { id: 'key-2', name: 'Secondary', key_prefix: 'ak_live_def2', scopes: ['verify'], is_active: true, last_used_at: null, created_at: '2026-09-02T00:00:00Z', expires_at: null },
        ],
      },
      loading: false,
      error: null,
    });
    render(<AgentKeysPanel agentId="agent-1" />);
    await waitFor(() => {
      expect(screen.getByText(/ak_live_abc1/)).toBeInTheDocument();
      expect(screen.getByText(/ak_live_def2/)).toBeInTheDocument();
    });
  });
});
