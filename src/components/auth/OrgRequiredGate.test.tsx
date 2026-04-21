/**
 * Tests for the OrgRequiredGate component.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const profileState = { profile: null as { org_id: string | null } | null, loading: false };

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => profileState,
}));

import { OrgRequiredGate } from './OrgRequiredGate';

describe('OrgRequiredGate', () => {
  it('renders children when the profile has an org', () => {
    profileState.profile = { org_id: 'org-1' };
    profileState.loading = false;
    render(
      <MemoryRouter>
        <OrgRequiredGate>
          <div data-testid="inner">protected</div>
        </OrgRequiredGate>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('inner')).toBeInTheDocument();
  });

  it('renders the upgrade card when profile.org_id is null', () => {
    profileState.profile = { org_id: null };
    profileState.loading = false;
    render(
      <MemoryRouter>
        <OrgRequiredGate>
          <div data-testid="inner">protected</div>
        </OrgRequiredGate>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('inner')).not.toBeInTheDocument();
    expect(screen.getByText(/Organization required/i)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Create an organization/i }),
    ).toHaveAttribute('href', '/onboarding/org');
    expect(
      screen.getByRole('link', { name: /invite code/i }),
    ).toHaveAttribute('href', '/onboarding/org?mode=invite');
  });

  it('accepts custom title + explanation', () => {
    profileState.profile = { org_id: null };
    render(
      <MemoryRouter>
        <OrgRequiredGate
          title="API keys live with your organization"
          explanation="Create an organization to start issuing keys."
        >
          <div />
        </OrgRequiredGate>
      </MemoryRouter>,
    );
    expect(screen.getByText('API keys live with your organization')).toBeInTheDocument();
    expect(
      screen.getByText(/Create an organization to start issuing keys/i),
    ).toBeInTheDocument();
  });

  it('does not render children while profile is loading', () => {
    profileState.profile = null;
    profileState.loading = true;
    render(
      <MemoryRouter>
        <OrgRequiredGate>
          <div data-testid="inner" />
        </OrgRequiredGate>
      </MemoryRouter>,
    );
    // While loading, neither the upgrade card nor the protected content
    // render — the gate is waiting for profile resolution.
    expect(screen.queryByTestId('inner')).not.toBeInTheDocument();
    expect(screen.queryByText(/Organization required/i)).not.toBeInTheDocument();
  });
});
