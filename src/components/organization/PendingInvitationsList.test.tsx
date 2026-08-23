/**
 * PendingInvitationsList Tests
 *
 * The founder-visible half of the invite-accept investigation: an org admin
 * who sends an invite currently has no way to see whether it is still
 * pending, has expired unseen, or was ever received — MembersTable only
 * shows people who already joined. This component is that missing status
 * surface, plus a Resend action for invites that never landed.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingInvitationsList } from './PendingInvitationsList';
import type { OrgInvitation } from '@/hooks/useOrgInvitations';

const PENDING: OrgInvitation = {
  id: 'inv-1',
  email: 'newperson@example.com',
  role: 'INDIVIDUAL',
  createdAt: '2026-08-17T12:00:00.000Z',
  expiresAt: '2026-08-24T12:00:00.000Z',
  displayStatus: 'pending',
};

const EXPIRED: OrgInvitation = {
  id: 'inv-2',
  email: 'alex@arkova.ai',
  role: 'INDIVIDUAL',
  createdAt: '2026-08-03T15:31:18.375Z',
  expiresAt: '2026-08-10T15:31:18.375Z',
  displayStatus: 'expired',
};

describe('PendingInvitationsList', () => {
  it('renders nothing when there are no non-accepted invitations and loading has finished', () => {
    const { container } = render(<PendingInvitationsList invitations={[]} loading={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists pending and expired invitations with their email and status', () => {
    render(<PendingInvitationsList invitations={[PENDING, EXPIRED]} loading={false} />);

    expect(screen.getByText('newperson@example.com')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('alex@arkova.ai')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });

  it('offers a Resend action for an expired invitation and calls onResend with it', async () => {
    const onResend = vi.fn().mockResolvedValue(undefined);
    render(<PendingInvitationsList invitations={[EXPIRED]} loading={false} onResend={onResend} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /resend/i }));

    expect(onResend).toHaveBeenCalledWith(EXPIRED);
  });

  it('offers a Resend action for a still-pending invitation too — the admin cannot tell from here whether it was ever delivered', () => {
    const onResend = vi.fn();
    render(<PendingInvitationsList invitations={[PENDING]} loading={false} onResend={onResend} />);

    expect(screen.getByRole('button', { name: /resend/i })).toBeEnabled();
  });

  it('does not render a Resend action for a revoked invitation', () => {
    const revoked: OrgInvitation = { ...PENDING, id: 'inv-3', displayStatus: 'revoked' };
    render(<PendingInvitationsList invitations={[revoked]} loading={false} onResend={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /resend/i })).not.toBeInTheDocument();
  });
});
