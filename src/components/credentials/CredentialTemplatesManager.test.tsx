/**
 * Tests for CredentialTemplatesManager component — UAT bug fixes
 *
 * @see UAT2-09 — empty state shows starter template suggestions
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CredentialTemplatesManager } from './CredentialTemplatesManager';

// Mock TemplateSchemaBuilder
vi.mock('./TemplateSchemaBuilder', () => ({
  TemplateSchemaBuilder: ({ value, onChange }: { value: unknown[]; onChange: (v: unknown[]) => void }) => (
    <div data-testid="schema-builder">
      <button onClick={() => onChange([])}>mock-builder</button>
      <span>{Array.isArray(value) ? value.length : 0} fields</span>
    </div>
  ),
}));

const defaultProps = {
  templates: [],
  loading: false,
  error: null,
  onCreate: vi.fn().mockResolvedValue({ id: '1', name: 'Test' }),
  onUpdate: vi.fn().mockResolvedValue(true),
  onDelete: vi.fn().mockResolvedValue(true),
};

describe('CredentialTemplatesManager', () => {
  it('shows empty state when no templates', () => {
    render(<CredentialTemplatesManager {...defaultProps} />);
    expect(screen.getByText('No templates yet')).toBeDefined();
  });

  it('shows starter template buttons in empty state (UAT2-09)', () => {
    render(<CredentialTemplatesManager {...defaultProps} />);
    expect(screen.getByText('Popular templates to get started')).toBeDefined();
    expect(screen.getByRole('button', { name: /Diploma/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Professional Certificate/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Professional License/i })).toBeDefined();
  });

  it('clicking a starter template opens dialog pre-filled', () => {
    render(<CredentialTemplatesManager {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /Diploma/i }));
    // Dialog should open with pre-filled name
    expect(screen.getByDisplayValue('Diploma')).toBeDefined();
  });

  it('shows template list when templates exist', () => {
    const templates = [{
      id: '1',
      name: 'Test Template',
      description: 'A test',
      credential_type: 'CERTIFICATE' as const,
      default_metadata: null,
      is_active: true,
      org_id: 'org-1',
      created_by: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }];
    render(<CredentialTemplatesManager {...defaultProps} templates={templates} />);
    expect(screen.getByText('Test Template')).toBeDefined();
    // Should NOT show starter templates when templates exist
    expect(screen.queryByText('Popular templates to get started')).toBeNull();
  });

  it('shows loading state', () => {
    render(<CredentialTemplatesManager {...defaultProps} loading={true} />);
    // Should show loading spinner (Loader2 has animate-spin)
    expect(screen.queryByText('No templates yet')).toBeNull();
  });
});
