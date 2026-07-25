/**
 * Breadcrumbs Component Tests
 *
 * Tests breadcrumb rendering for detail and sub-pages.
 *
 * @see UF-09
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Breadcrumbs } from './Breadcrumbs';

function renderWithRoute(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <Breadcrumbs />
    </MemoryRouter>
  );
}

describe('Breadcrumbs', () => {
  it('renders nothing for top-level pages', () => {
    const { container } = renderWithRoute('/dashboard');
    expect(container.querySelector('nav')).toBeNull();
  });

  it('renders breadcrumbs for record detail page', () => {
    renderWithRoute('/records/some-id-123');
    expect(screen.getByText('My Records')).toBeInTheDocument();
    expect(screen.getByText('Record Details')).toBeInTheDocument();
  });

  it('renders breadcrumbs for credential templates page', () => {
    renderWithRoute('/settings/credential-templates');
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Document Templates')).toBeInTheDocument();
  });

  it('renders breadcrumbs for webhooks page', () => {
    renderWithRoute('/settings/webhooks');
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Webhooks')).toBeInTheDocument();
  });

  it('renders breadcrumbs for API keys page', () => {
    renderWithRoute('/settings/api-keys');
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('API Keys')).toBeInTheDocument();
  });

  it('renders breadcrumbs for billing checkout success', () => {
    renderWithRoute('/billing/success');
    expect(screen.getByText('Billing')).toBeInTheDocument();
    expect(screen.getByText('Checkout Complete')).toBeInTheDocument();
  });

  it('renders breadcrumbs for billing checkout cancel', () => {
    renderWithRoute('/billing/cancel');
    expect(screen.getByText('Billing')).toBeInTheDocument();
    expect(screen.getByText('Checkout Cancelled')).toBeInTheDocument();
  });

  it('parent breadcrumb links to parent page', () => {
    renderWithRoute('/records/some-id');
    const link = screen.getByText('My Records');
    expect(link.closest('a')).toHaveAttribute('href', '/records');
  });
});
