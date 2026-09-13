/**
 * SubOrgListingConsentToggle Tests (SCRUM-3864)
 *
 * Pure presentational + interaction tests. `onToggle` / `onChanged` are
 * injected, so this file does not care whether the caller is the parent-side
 * hook (`useAffiliateListingConsent`) or the child-side
 * `useOrganization().updateOrganization` — that wiring is covered separately
 * in `useAffiliateListingConsent.test.ts` and `ManageSubOrgs.test.tsx`.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubOrgListingConsentToggle } from './SubOrgListingConsentToggle';

describe('SubOrgListingConsentToggle', () => {
  it('shows "not shown" status and an unchecked switch when own consent is false', () => {
    render(
      <SubOrgListingConsentToggle
        id="t1"
        ownValue={false}
        otherPartyValue={false}
        waitingLabel="Waiting on the other org"
        onToggle={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(screen.getByTestId('t1-status')).toHaveTextContent('Not shown on public pages');
  });

  it('shows the waiting label when own consent is true but the other party has not consented', () => {
    render(
      <SubOrgListingConsentToggle
        id="t2"
        ownValue={true}
        otherPartyValue={false}
        waitingLabel="Waiting on the affiliated organization to also allow this."
        onToggle={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByTestId('t2-status')).toHaveTextContent(
      'Waiting on the affiliated organization to also allow this.',
    );
  });

  it('shows "listed" status when both sides have consented', () => {
    render(
      <SubOrgListingConsentToggle
        id="t3"
        ownValue={true}
        otherPartyValue={true}
        waitingLabel="Waiting"
        onToggle={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByTestId('t3-status')).toHaveTextContent('Listed on public pages');
  });

  it('calls onToggle with the next value and onChanged with the confirmed landed value', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn().mockResolvedValue(true);
    const onChanged = vi.fn();

    render(
      <SubOrgListingConsentToggle
        id="t4"
        ownValue={false}
        otherPartyValue={false}
        waitingLabel="Waiting"
        onToggle={onToggle}
        onChanged={onChanged}
      />,
    );

    await user.click(screen.getByRole('switch'));

    expect(onToggle).toHaveBeenCalledWith(true);
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(true));
  });

  it('does NOT call onChanged when onToggle resolves null (validation/RLS/network failure)', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn().mockResolvedValue(null);
    const onChanged = vi.fn();

    render(
      <SubOrgListingConsentToggle
        id="t5"
        ownValue={false}
        otherPartyValue={false}
        waitingLabel="Waiting"
        onToggle={onToggle}
        onChanged={onChanged}
      />,
    );

    await user.click(screen.getByRole('switch'));

    expect(onToggle).toHaveBeenCalledWith(true);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('disables the switch while busy and while explicitly disabled', () => {
    const { rerender } = render(
      <SubOrgListingConsentToggle
        id="t6"
        ownValue={false}
        otherPartyValue={false}
        waitingLabel="Waiting"
        busy
        onToggle={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole('switch')).toBeDisabled();

    rerender(
      <SubOrgListingConsentToggle
        id="t6"
        ownValue={false}
        otherPartyValue={false}
        waitingLabel="Waiting"
        disabled
        onToggle={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
