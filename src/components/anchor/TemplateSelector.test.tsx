/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * BETA-08: Template Selector Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TemplateSelector } from './TemplateSelector';

const mockFrom = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

const systemTemplates = [
  { id: 't1', name: 'Diploma', description: 'Academic diploma', credential_type: 'DEGREE', is_system: true, org_id: null },
  { id: 't2', name: 'Certificate', description: 'Professional certificate', credential_type: 'CERTIFICATE', is_system: true, org_id: null },
  { id: 't3', name: 'License', description: 'Professional license', credential_type: 'LICENSE', is_system: true, org_id: null },
];

const orgTemplates = [
  { id: 'o1', name: 'Custom Diploma', description: 'Org-specific', credential_type: 'DEGREE', is_system: false, org_id: 'org-1' },
];

function mockSupabaseQuery(data: unknown[]) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data, error: null }),
  };
  mockFrom.mockReturnValue(chain);
  return chain;
}

describe('TemplateSelector', () => {
  const onSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders system templates for individual users', async () => {
    mockSupabaseQuery(systemTemplates);

    render(<TemplateSelector orgId={null} onSelect={onSelect} />);

    await waitFor(() => {
      expect(screen.getByText('Diploma')).toBeInTheDocument();
    });

    // "Certificate" and "License" appear as both template names and type badges
    expect(screen.getAllByText('Certificate').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('License').length).toBeGreaterThanOrEqual(1);
  });

  it('renders org + system templates for org users', async () => {
    mockSupabaseQuery([...orgTemplates, ...systemTemplates]);

    render(<TemplateSelector orgId="org-1" onSelect={onSelect} />);

    await waitFor(() => {
      expect(screen.getByText('Custom Diploma')).toBeInTheDocument();
    });

    expect(screen.getByText('Diploma')).toBeInTheDocument();
  });

  it('calls onSelect when a template is clicked', async () => {
    mockSupabaseQuery(systemTemplates);

    render(<TemplateSelector orgId={null} onSelect={onSelect} />);

    await waitFor(() => {
      expect(screen.getByText('Diploma')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Diploma'));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', credential_type: 'DEGREE' })
    );
  });

  it('highlights selected template', async () => {
    mockSupabaseQuery(systemTemplates);

    render(<TemplateSelector orgId={null} onSelect={onSelect} selectedId="t2" />);

    await waitFor(() => {
      expect(screen.getByText('Professional certificate')).toBeInTheDocument();
    });

    // The selected card should have a visual indicator — find by description which is unique
    const selectedCard = screen.getByText('Professional certificate').closest('[data-selected]');
    expect(selectedCard).toHaveAttribute('data-selected', 'true');
  });

  it('shows loading state', () => {
    // Never resolves query
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnValue(new Promise(() => {})),
    };
    mockFrom.mockReturnValue(chain);

    render(<TemplateSelector orgId={null} onSelect={onSelect} />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows error state on fetch failure', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: null, error: { message: 'Fetch failed' } }),
    };
    mockFrom.mockReturnValue(chain);

    render(<TemplateSelector orgId={null} onSelect={onSelect} />);

    await waitFor(() => {
      expect(screen.getByText(/Fetch failed/i)).toBeInTheDocument();
    });
  });
});
