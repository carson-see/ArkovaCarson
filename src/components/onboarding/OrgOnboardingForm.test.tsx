/**
 * OrgOnboardingForm Component Tests
 */

import { beforeAll, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OrgOnboardingForm } from './OrgOnboardingForm';

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
});

describe('OrgOnboardingForm', () => {
  it('submits organization intake fields for an unverified org', () => {
    const onSubmit = vi.fn();
    render(<OrgOnboardingForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/organization name/i), {
      target: { value: 'Acme Trust' },
    });
    fireEvent.change(screen.getByLabelText(/legal name/i), {
      target: { value: 'Acme Trust LLC' },
    });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'Credential compliance team' },
    });
    fireEvent.change(screen.getByLabelText(/company domain/i), {
      target: { value: 'AcmeTrust.com' },
    });
    fireEvent.change(screen.getByLabelText(/website/i), {
      target: { value: 'https://acme.example' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create organization/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        legalName: 'Acme Trust LLC',
        displayName: 'Acme Trust',
        domain: 'acmetrust.com',
        description: 'Credential compliance team',
        websiteUrl: 'https://acme.example',
        verifyOrganization: false,
        einTaxId: null,
      }),
    );
  });

  it('requires EIN and location when organization verification is selected', () => {
    const onSubmit = vi.fn();
    render(<OrgOnboardingForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/organization name/i), {
      target: { value: 'Acme Trust' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /verify this organization/i }));
    fireEvent.click(screen.getByRole('button', { name: /create organization/i }));

    expect(screen.getByText(/EIN \/ Tax ID is required/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits verification fields when provided', () => {
    const onSubmit = vi.fn();
    render(<OrgOnboardingForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/organization name/i), {
      target: { value: 'Acme Trust' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /verify this organization/i }));
    fireEvent.change(screen.getByLabelText(/business address or headquarters/i), {
      target: { value: '123 Main St, Detroit, MI' },
    });
    fireEvent.change(screen.getByLabelText(/EIN \/ Tax ID/i), {
      target: { value: '12-3456789' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create organization/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        verifyOrganization: true,
        location: '123 Main St, Detroit, MI',
        einTaxId: '12-3456789',
      }),
    );
  });
});
