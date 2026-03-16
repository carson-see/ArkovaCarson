/**
 * TemplateSchemaBuilder Tests
 *
 * Tests the schema builder for credential template field definitions.
 *
 * @see MVP-17
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  TemplateSchemaBuilder,
  type TemplateFieldDefinition,
} from './TemplateSchemaBuilder';

const SAMPLE_FIELDS: TemplateFieldDefinition[] = [
  {
    id: 'field_1',
    name: 'Institution',
    type: 'text',
    required: true,
  },
  {
    id: 'field_2',
    name: 'Graduation Date',
    type: 'date',
    required: false,
  },
];

describe('TemplateSchemaBuilder', () => {
  it('renders existing fields', () => {
    render(
      <TemplateSchemaBuilder value={SAMPLE_FIELDS} onChange={vi.fn()} />
    );
    expect(screen.getByDisplayValue('Institution')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Graduation Date')).toBeInTheDocument();
  });

  it('shows empty state with Add Field prompt when no fields', () => {
    render(
      <TemplateSchemaBuilder value={[]} onChange={vi.fn()} />
    );
    expect(
      screen.getByText('No fields defined yet. Add a field to get started.')
    ).toBeInTheDocument();
    expect(screen.getByText('Add Field')).toBeInTheDocument();
  });

  it('calls onChange with new field when Add Field is clicked', () => {
    const onChange = vi.fn();
    render(
      <TemplateSchemaBuilder value={[]} onChange={onChange} />
    );
    fireEvent.click(screen.getByText('Add Field'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const newFields = onChange.mock.calls[0][0] as TemplateFieldDefinition[];
    expect(newFields).toHaveLength(1);
    expect(newFields[0].name).toBe('');
    expect(newFields[0].type).toBe('text');
    expect(newFields[0].required).toBe(false);
    expect(newFields[0].id).toMatch(/^field_/);
  });

  it('calls onChange when a field is removed', () => {
    const onChange = vi.fn();
    render(
      <TemplateSchemaBuilder value={SAMPLE_FIELDS} onChange={onChange} />
    );
    const removeButtons = screen.getAllByLabelText('Remove field');
    fireEvent.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedFields = onChange.mock.calls[0][0] as TemplateFieldDefinition[];
    expect(updatedFields).toHaveLength(1);
    expect(updatedFields[0].id).toBe('field_2');
  });

  it('calls onChange when field name is edited', () => {
    const onChange = vi.fn();
    render(
      <TemplateSchemaBuilder value={SAMPLE_FIELDS} onChange={onChange} />
    );
    const nameInput = screen.getByDisplayValue('Institution');
    fireEvent.change(nameInput, { target: { value: 'University' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedFields = onChange.mock.calls[0][0] as TemplateFieldDefinition[];
    expect(updatedFields[0].name).toBe('University');
    // Other field unchanged
    expect(updatedFields[1].name).toBe('Graduation Date');
  });

  it('calls onChange when field type is changed', () => {
    const onChange = vi.fn();
    const singleField: TemplateFieldDefinition[] = [
      { id: 'field_1', name: 'Test', type: 'text', required: false },
    ];
    render(
      <TemplateSchemaBuilder value={singleField} onChange={onChange} />
    );
    // Open the select by clicking the trigger
    const typeSelect = screen.getByLabelText('Field type');
    fireEvent.click(typeSelect);
    // Select "Email" option
    const emailOption = screen.getByText('Email');
    fireEvent.click(emailOption);
    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedFields = onChange.mock.calls[0][0] as TemplateFieldDefinition[];
    expect(updatedFields[0].type).toBe('email');
  });

  it('calls onChange when required toggle is changed', () => {
    const onChange = vi.fn();
    render(
      <TemplateSchemaBuilder value={SAMPLE_FIELDS} onChange={onChange} />
    );
    // Second field (Graduation Date) has required=false, toggle it
    const switches = screen.getAllByLabelText('Required');
    fireEvent.click(switches[1]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedFields = onChange.mock.calls[0][0] as TemplateFieldDefinition[];
    expect(updatedFields[1].required).toBe(true);
  });

  it('adds another field when list is non-empty', () => {
    const onChange = vi.fn();
    render(
      <TemplateSchemaBuilder value={SAMPLE_FIELDS} onChange={onChange} />
    );
    fireEvent.click(screen.getByText('Add Field'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedFields = onChange.mock.calls[0][0] as TemplateFieldDefinition[];
    expect(updatedFields).toHaveLength(3);
  });

  it('shows options input when field type is select', () => {
    const selectField: TemplateFieldDefinition[] = [
      {
        id: 'field_1',
        name: 'Honors',
        type: 'select',
        required: false,
        options: ['None', 'Cum Laude'],
      },
    ];
    render(
      <TemplateSchemaBuilder value={selectField} onChange={vi.fn()} />
    );
    expect(screen.getByLabelText('Select options')).toBeInTheDocument();
    expect(screen.getByDisplayValue('None, Cum Laude')).toBeInTheDocument();
  });
});
