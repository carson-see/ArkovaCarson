/**
 * MetadataDisplay Tests
 *
 * Tests the enhanced metadata display component for verification views.
 *
 * @see MVP-18
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetadataDisplay } from './MetadataDisplay';
import type { TemplateFieldDefinition } from '@/components/credentials/TemplateSchemaBuilder';

describe('MetadataDisplay', () => {
  it('renders key-value pairs', () => {
    render(
      <MetadataDisplay
        metadata={{
          institution: 'MIT',
          degree: 'Computer Science',
        }}
      />
    );
    expect(screen.getByText('Institution')).toBeInTheDocument();
    expect(screen.getByText('MIT')).toBeInTheDocument();
    expect(screen.getByText('Degree')).toBeInTheDocument();
    expect(screen.getByText('Computer Science')).toBeInTheDocument();
  });

  it('formats dates nicely', () => {
    render(
      <MetadataDisplay
        metadata={{
          graduation_date: '2025-06-15',
        }}
      />
    );
    expect(screen.getByText('Graduation Date')).toBeInTheDocument();
    // Date formatting depends on local timezone; just verify it's a readable date format
    const dateEl = screen.getByText(/June \d{1,2}, 2025/);
    expect(dateEl).toBeInTheDocument();
    expect(dateEl.className).toContain('font-mono');
  });

  it('renders URLs as links', () => {
    render(
      <MetadataDisplay
        metadata={{
          website: 'https://example.com/profile',
        }}
      />
    );
    const link = screen.getByText('https://example.com/profile');
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://example.com/profile');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders emails as mailto links', () => {
    render(
      <MetadataDisplay
        metadata={{
          contact_email: 'test@example.com',
        }}
      />
    );
    const link = screen.getByText('test@example.com');
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'mailto:test@example.com');
  });

  it('shows "No metadata" for empty object', () => {
    render(<MetadataDisplay metadata={{}} />);
    expect(screen.getByText('No metadata')).toBeInTheDocument();
  });

  it('handles null values gracefully', () => {
    render(
      <MetadataDisplay
        metadata={{
          field_one: null,
          field_two: 'has value',
        }}
      />
    );
    expect(screen.getByText('Not provided')).toBeInTheDocument();
    expect(screen.getByText('has value')).toBeInTheDocument();
  });

  it('applies schema labels when provided', () => {
    const schema: TemplateFieldDefinition[] = [
      {
        id: 'f1',
        name: 'Full Name',
        type: 'text',
        required: true,
      },
      {
        id: 'f2',
        name: 'Graduation Date',
        type: 'date',
        required: false,
      },
    ];
    render(
      <MetadataDisplay
        metadata={{
          full_name: 'John Doe',
        }}
        schema={schema}
      />
    );
    // Should use schema label "Full Name" instead of converting key
    expect(screen.getByText('Full Name')).toBeInTheDocument();
    expect(screen.getByText('John Doe')).toBeInTheDocument();
  });

  it('uses mono font for values', () => {
    render(
      <MetadataDisplay
        metadata={{
          degree: 'Computer Science',
        }}
      />
    );
    const valueEl = screen.getByText('Computer Science');
    expect(valueEl.className).toContain('font-mono');
  });

  it('formats boolean values as Yes/No', () => {
    render(
      <MetadataDisplay
        metadata={{
          is_active: true,
          is_expired: false,
        }}
      />
    );
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('renders number values', () => {
    render(
      <MetadataDisplay
        metadata={{
          credits: 120,
        }}
      />
    );
    expect(screen.getByText('120')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <MetadataDisplay metadata={{ key: 'value' }} className="custom-class" />
    );
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('uses schema type hint for URL formatting', () => {
    const schema: TemplateFieldDefinition[] = [
      {
        id: 'f1',
        name: 'Portfolio',
        type: 'url',
        required: false,
      },
    ];
    render(
      <MetadataDisplay
        metadata={{
          Portfolio: 'https://portfolio.example.com',
        }}
        schema={schema}
      />
    );
    const link = screen.getByText('https://portfolio.example.com');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://portfolio.example.com');
  });

  it('renders object values as JSON, not [object Object]', () => {
    render(
      <MetadataDisplay
        metadata={{
          nested: { key: 'value' } as unknown as string,
        }}
      />
    );
    expect(screen.getByText('{"key":"value"}')).toBeInTheDocument();
    expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
  });

  it('uses schema type hint for email formatting', () => {
    const schema: TemplateFieldDefinition[] = [
      {
        id: 'f1',
        name: 'Contact',
        type: 'email',
        required: false,
      },
    ];
    render(
      <MetadataDisplay
        metadata={{
          Contact: 'admin@school.edu',
        }}
        schema={schema}
      />
    );
    const link = screen.getByText('admin@school.edu');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'mailto:admin@school.edu');
  });

  // SCRUM-2910 (BUG-2026-07-17-009 / -010, P0): fraud-derived metadata must
  // never reach the DOM on any render surface. MetadataDisplay is a generic
  // key-value renderer exported from the verification barrel; it must apply
  // the same `isFraudMetadataKey` filter every other metadata surface uses.
  describe('SCRUM-2910 — fraud metadata never renders', () => {
    it('drops every fraud_* / fraudSignals key but keeps legitimate fields', () => {
      const { container } = render(
        <MetadataDisplay
          metadata={{
            institution: 'MIT',
            fraud_score: 0.87 as unknown as string,
            fraud_risk_level: 'high',
            fraud_analysis_method: 'client_side_worker_v2',
            fraudSignals: '["Font inconsistency detected"]',
            'Fraud-Risk-Level': 'critical',
          }}
        />
      );
      // Legitimate field still renders (guard is not vacuously green).
      expect(screen.getByText('Institution')).toBeInTheDocument();
      expect(screen.getByText('MIT')).toBeInTheDocument();

      const haystack = (container.textContent ?? '').toLowerCase();
      expect(haystack).not.toContain('fraud');
      expect(haystack).not.toContain('0.87');
      expect(haystack).not.toContain('87%');
      expect(haystack).not.toContain('client_side_worker_v2');
      expect(haystack).not.toContain('font inconsistency');
      expect(haystack).not.toContain('critical');
    });

    it('drops `_`-prefixed internal keys', () => {
      render(
        <MetadataDisplay
          metadata={{ _internal: 'secret', visible: 'shown' }}
        />
      );
      expect(screen.getByText('Visible')).toBeInTheDocument();
      expect(screen.queryByText('secret')).not.toBeInTheDocument();
    });

    it('renders the empty state when every key is fraud-derived', () => {
      render(
        <MetadataDisplay
          metadata={{ fraud_score: 0.9 as unknown as string, fraud_risk_level: 'high' }}
        />
      );
      expect(screen.getByText('No metadata')).toBeInTheDocument();
    });
  });
});
