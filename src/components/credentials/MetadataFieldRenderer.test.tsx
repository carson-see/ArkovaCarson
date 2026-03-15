/**
 * MetadataFieldRenderer Tests
 *
 * Tests dynamic form field rendering from template schemas.
 *
 * @see UF-05
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MetadataFieldRenderer } from './MetadataFieldRenderer';
import type { TemplateField } from '@/hooks/useCredentialTemplate';

const TEXT_FIELDS: TemplateField[] = [
  { key: 'institution', label: 'Institution', type: 'text', required: true },
  { key: 'degree', label: 'Degree', type: 'text' },
];

const DATE_FIELD: TemplateField[] = [
  { key: 'graduation_date', label: 'Graduation Date', type: 'date' },
];

const NUMBER_FIELD: TemplateField[] = [
  { key: 'gpa', label: 'GPA', type: 'number' },
];

const SELECT_FIELD: TemplateField[] = [
  {
    key: 'honors',
    label: 'Honors',
    type: 'select',
    options: ['None', 'Cum Laude', 'Magna Cum Laude'],
  },
];

describe('MetadataFieldRenderer', () => {
  it('renders nothing when fields array is empty', () => {
    const { container } = render(
      <MetadataFieldRenderer fields={[]} values={{}} onChange={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders text input fields with labels', () => {
    render(
      <MetadataFieldRenderer fields={TEXT_FIELDS} values={{}} onChange={vi.fn()} />
    );
    expect(screen.getByLabelText(/Institution/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Degree/)).toBeInTheDocument();
  });

  it('shows required marker for required fields', () => {
    render(
      <MetadataFieldRenderer fields={TEXT_FIELDS} values={{}} onChange={vi.fn()} />
    );
    // Institution is required — should have asterisk
    const label = screen.getByText('Institution');
    expect(label.parentElement?.textContent).toContain('*');
  });

  it('does not show required marker for optional fields', () => {
    render(
      <MetadataFieldRenderer fields={TEXT_FIELDS} values={{}} onChange={vi.fn()} />
    );
    const degreeLabel = screen.getByText('Degree');
    expect(degreeLabel.parentElement?.textContent).not.toContain('*');
  });

  it('renders date input for date type', () => {
    render(
      <MetadataFieldRenderer fields={DATE_FIELD} values={{}} onChange={vi.fn()} />
    );
    const input = screen.getByLabelText('Graduation Date');
    expect(input).toHaveAttribute('type', 'date');
  });

  it('renders number input for number type', () => {
    render(
      <MetadataFieldRenderer fields={NUMBER_FIELD} values={{}} onChange={vi.fn()} />
    );
    const input = screen.getByLabelText('GPA');
    expect(input).toHaveAttribute('type', 'number');
  });

  it('displays current values from props', () => {
    render(
      <MetadataFieldRenderer
        fields={TEXT_FIELDS}
        values={{ institution: 'MIT', degree: 'PhD' }}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByDisplayValue('MIT')).toBeInTheDocument();
    expect(screen.getByDisplayValue('PhD')).toBeInTheDocument();
  });

  it('calls onChange when text input changes', () => {
    const onChange = vi.fn();
    render(
      <MetadataFieldRenderer fields={TEXT_FIELDS} values={{}} onChange={onChange} />
    );
    fireEvent.change(screen.getByLabelText(/Institution/), {
      target: { value: 'Stanford' },
    });
    expect(onChange).toHaveBeenCalledWith('institution', 'Stanford');
  });

  it('disables fields when disabled prop is true', () => {
    render(
      <MetadataFieldRenderer
        fields={TEXT_FIELDS}
        values={{}}
        onChange={vi.fn()}
        disabled
      />
    );
    expect(screen.getByLabelText(/Institution/)).toBeDisabled();
    expect(screen.getByLabelText(/Degree/)).toBeDisabled();
  });

  it('displays error messages for specific fields', () => {
    render(
      <MetadataFieldRenderer
        fields={TEXT_FIELDS}
        values={{}}
        onChange={vi.fn()}
        errors={{ institution: 'Institution is required' }}
      />
    );
    expect(screen.getByText('Institution is required')).toBeInTheDocument();
  });

  it('renders select field with options', () => {
    render(
      <MetadataFieldRenderer fields={SELECT_FIELD} values={{}} onChange={vi.fn()} />
    );
    expect(screen.getByText('Honors')).toBeInTheDocument();
  });

  it('renders section title', () => {
    render(
      <MetadataFieldRenderer fields={TEXT_FIELDS} values={{}} onChange={vi.fn()} />
    );
    expect(screen.getByText('Credential Details')).toBeInTheDocument();
  });
});
