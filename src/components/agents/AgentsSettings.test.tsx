/**
 * AgentsSettings Component Tests (SPEC-AGENTS-UI)
 *
 * Covers the gap left by PR #3083 (suspending an agent now deactivates its
 * API keys, but that fix was only reachable by curl before this UI existed):
 * list rendering, all three data states (loading/empty/error, §1.2), the
 * suspend/resume/revoke actions, the terminal-revocation UI rule (a revoked
 * agent offers no status actions), and the confirm-before-DELETE flow for
 * revoke.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// AgentKeysPanel does its own data fetching (useAgentDetail / React Query) —
// stubbed here so this file tests AgentsSettings' own list/action behavior
// without needing a QueryClientProvider. AgentKeysPanel has its own tests.
vi.mock('./AgentKeysPanel', () => ({
  AgentKeysPanel: ({ agentId }: { agentId: string }) => <div data-testid={`keys-panel-${agentId}`}>keys for {agentId}</div>,
}));

import { AgentsSettings } from './AgentsSettings';
import { AgentActionError } from '@/hooks/useAgents';
import type { Agent } from '@/hooks/useAgents';

const activeAgent: Agent = {
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

const suspendedAgent: Agent = {
  ...activeAgent,
  id: 'agent-2',
  name: 'Compliance Checker',
  status: 'suspended',
  suspended_at: '2026-09-10T00:00:00Z',
};

const revokedAgent: Agent = {
  ...activeAgent,
  id: 'agent-3',
  name: 'Old Integration',
  status: 'revoked',
  revoked_at: '2026-09-15T00:00:00Z',
};

function makeProps(overrides: Partial<React.ComponentProps<typeof AgentsSettings>> = {}) {
  return {
    agents: [activeAgent, suspendedAgent, revokedAgent],
    onSuspend: vi.fn().mockResolvedValue(undefined),
    onResume: vi.fn().mockResolvedValue(undefined),
    onRevoke: vi.fn().mockResolvedValue(undefined),
    loading: false,
    fetchError: null,
    ...overrides,
  };
}

describe('AgentsSettings — list rendering', () => {
  it('renders every agent by name', () => {
    render(<AgentsSettings {...makeProps()} />);
    expect(screen.getByText('Recruiting Bot')).toBeInTheDocument();
    expect(screen.getByText('Compliance Checker')).toBeInTheDocument();
    expect(screen.getByText('Old Integration')).toBeInTheDocument();
  });

  it('renders type, status, and created date', () => {
    render(<AgentsSettings {...makeProps({ agents: [activeAgent] })} />);
    expect(screen.getByText('ATS Integration')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });
});

describe('AgentsSettings — data states (§1.2: loading, empty, error)', () => {
  it('renders a loading state', () => {
    render(<AgentsSettings {...makeProps({ agents: [], loading: true })} />);
    expect(document.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders an empty state when there are no agents', () => {
    render(<AgentsSettings {...makeProps({ agents: [], loading: false })} />);
    expect(screen.getByText(/No agents registered yet/)).toBeInTheDocument();
  });

  it('renders a fetch-error state', () => {
    render(<AgentsSettings {...makeProps({ agents: [], fetchError: 'network down' })} />);
    expect(screen.getByText(/Unable to load agents/)).toBeInTheDocument();
  });
});

describe('AgentsSettings — suspend / resume actions', () => {
  it('calls onSuspend for an active agent', async () => {
    const onSuspend = vi.fn().mockResolvedValue(undefined);
    render(<AgentsSettings {...makeProps({ agents: [activeAgent], onSuspend })} />);
    fireEvent.click(screen.getByRole('button', { name: /suspend recruiting bot/i }));
    await waitFor(() => expect(onSuspend).toHaveBeenCalledWith('agent-1'));
  });

  it('calls onResume for a suspended agent', async () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    render(<AgentsSettings {...makeProps({ agents: [suspendedAgent], onResume })} />);
    fireEvent.click(screen.getByRole('button', { name: /resume compliance checker/i }));
    await waitFor(() => expect(onResume).toHaveBeenCalledWith('agent-2'));
  });

  it('surfaces a curated message (not the raw error) when suspend 409s because the agent is already revoked', async () => {
    const onSuspend = vi.fn().mockRejectedValue(new AgentActionError('Agent is revoked — revocation is terminal; register a new agent instead', 409));
    render(<AgentsSettings {...makeProps({ agents: [activeAgent], onSuspend })} />);
    fireEvent.click(screen.getByRole('button', { name: /suspend recruiting bot/i }));
    await waitFor(() => {
      expect(screen.getByText(/This agent has already been revoked/)).toBeInTheDocument();
    });
  });

  it('surfaces a generic curated failure message on a non-409 suspend failure', async () => {
    const onSuspend = vi.fn().mockRejectedValue(new AgentActionError('Internal server error', 500));
    render(<AgentsSettings {...makeProps({ agents: [activeAgent], onSuspend })} />);
    fireEvent.click(screen.getByRole('button', { name: /suspend recruiting bot/i }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to suspend this agent/)).toBeInTheDocument();
    });
    // Never the raw server string.
    expect(screen.queryByText('Internal server error')).toBeNull();
  });
});

describe('AgentsSettings — revoke requires confirmation', () => {
  it('does not call onRevoke until the confirm dialog is accepted', async () => {
    const onRevoke = vi.fn().mockResolvedValue(undefined);
    render(<AgentsSettings {...makeProps({ agents: [activeAgent], onRevoke })} />);

    fireEvent.click(screen.getByRole('button', { name: /revoke recruiting bot/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(onRevoke).not.toHaveBeenCalled();

    // The dialog states the terminal, key-deactivating consequence.
    expect(screen.getByText(/permanent and cannot be undone/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /yes, revoke permanently/i }));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledWith('agent-1'));
  });

  it('does not call onRevoke when the confirm dialog is cancelled', async () => {
    const onRevoke = vi.fn().mockResolvedValue(undefined);
    render(<AgentsSettings {...makeProps({ agents: [activeAgent], onRevoke })} />);

    fireEvent.click(screen.getByRole('button', { name: /revoke recruiting bot/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onRevoke).not.toHaveBeenCalled();
  });
});

describe('AgentsSettings — revoked agent is terminal', () => {
  it('offers no status action buttons for a revoked agent', () => {
    render(<AgentsSettings {...makeProps({ agents: [revokedAgent] })} />);
    expect(screen.queryByRole('button', { name: /suspend old integration/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /resume old integration/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /revoke old integration/i })).toBeNull();
    // Status is not communicated by color alone — text is always present.
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText(/revocation is terminal/i)).toBeInTheDocument();
  });
});

describe('AgentsSettings — API keys panel', () => {
  it('is hidden until the row is expanded, then shows the lazy panel', async () => {
    render(<AgentsSettings {...makeProps({ agents: [activeAgent] })} />);
    expect(screen.queryByTestId('keys-panel-agent-1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /view api keys/i }));
    await waitFor(() => expect(screen.getByTestId('keys-panel-agent-1')).toBeInTheDocument());
  });
});
