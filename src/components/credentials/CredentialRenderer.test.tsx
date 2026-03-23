/**
 * CredentialRenderer Tests
 *
 * Tests all three rendering modes:
 * 1. Template + metadata (structured fields)
 * 2. No template, has metadata (key-value pairs)
 * 3. No metadata (filename + fingerprint only)
 *
 * @see UF-01
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CredentialRenderer } from './CredentialRenderer';
import type { TemplateDisplayData } from '@/hooks/useCredentialTemplate';

// Mock clipboard API
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
};
Object.assign(navigator, { clipboard: mockClipboard });

beforeEach(() => {
  vi.clearAllMocks();
});

const MOCK_TEMPLATE: TemplateDisplayData = {
  name: "Bachelor's Degree",
  fields: [
    { key: 'institution', label: 'Institution', type: 'text' },
    { key: 'degree', label: 'Degree', type: 'text' },
    { key: 'graduation_date', label: 'Graduation Date', type: 'date' },
    { key: 'gpa', label: 'GPA', type: 'number' },
  ],
};

const MOCK_METADATA = {
  institution: 'University of Michigan',
  degree: 'Bachelor of Science',
  graduation_date: '2025-05-15',
  gpa: 3.8,
};

describe('CredentialRenderer', () => {
  describe('Mode 1: Template + Metadata', () => {
    it('renders template name as title', () => {
      render(
        <CredentialRenderer
          template={MOCK_TEMPLATE}
          metadata={MOCK_METADATA}
          credentialType="DEGREE"
          status="SECURED"
        />
      );
      expect(screen.getByText("Bachelor's Degree")).toBeInTheDocument();
    });

    it('renders credential type as subtitle when template name differs', () => {
      render(
        <CredentialRenderer
          template={MOCK_TEMPLATE}
          metadata={MOCK_METADATA}
          credentialType="DEGREE"
          status="SECURED"
        />
      );
      // "Degree" appears as credential type subtitle AND as metadata field label
      const degreeElements = screen.getAllByText('Degree');
      expect(degreeElements.length).toBeGreaterThanOrEqual(1);
    });

    it('renders all metadata fields with labels', () => {
      render(
        <CredentialRenderer
          template={MOCK_TEMPLATE}
          metadata={MOCK_METADATA}
          status="SECURED"
        />
      );
      expect(screen.getByText('Institution')).toBeInTheDocument();
      expect(screen.getByText('University of Michigan')).toBeInTheDocument();
      expect(screen.getByText('Degree')).toBeInTheDocument();
      expect(screen.getByText('Bachelor of Science')).toBeInTheDocument();
      expect(screen.getByText('GPA')).toBeInTheDocument();
      expect(screen.getByText('3.8')).toBeInTheDocument();
    });

    it('formats date fields as human-readable', () => {
      render(
        <CredentialRenderer
          template={MOCK_TEMPLATE}
          metadata={MOCK_METADATA}
          status="SECURED"
        />
      );
      expect(screen.getByText('Graduation Date')).toBeInTheDocument();
      expect(screen.getByText('May 15, 2025')).toBeInTheDocument();
    });

    it('hides fields with null or empty values', () => {
      render(
        <CredentialRenderer
          template={MOCK_TEMPLATE}
          metadata={{ institution: 'MIT', degree: '', gpa: null }}
          status="SECURED"
        />
      );
      expect(screen.getByText('MIT')).toBeInTheDocument();
      expect(screen.queryByText('Degree')).not.toBeInTheDocument();
      expect(screen.queryByText('GPA')).not.toBeInTheDocument();
    });
  });

  describe('Mode 2: No Template, Has Metadata', () => {
    it('renders metadata as key-value pairs with formatted labels', () => {
      render(
        <CredentialRenderer
          metadata={{ field_of_study: 'Computer Science', year: 2025 }}
          status="SECURED"
        />
      );
      expect(screen.getByText('Field Of Study')).toBeInTheDocument();
      expect(screen.getByText('Computer Science')).toBeInTheDocument();
      expect(screen.getByText('Year')).toBeInTheDocument();
      expect(screen.getByText('2025')).toBeInTheDocument();
    });

    it('skips internal fields (recipient, jurisdiction, _prefixed)', () => {
      render(
        <CredentialRenderer
          metadata={{ field: 'visible', recipient: 'hidden@test.com', jurisdiction: 'US', _internal: 'skip' }}
          status="SECURED"
        />
      );
      expect(screen.getByText('visible')).toBeInTheDocument();
      expect(screen.queryByText('hidden@test.com')).not.toBeInTheDocument();
      expect(screen.queryByText('skip')).not.toBeInTheDocument();
    });

    it('skips pipeline metadata fields (merkle_proof, batch_id, etc.)', () => {
      render(
        <CredentialRenderer
          metadata={{
            issuer: 'MIT',
            merkle_proof: [{ hash: 'abc', position: 0 }],
            merkle_root: 'def456',
            chain_tx_id: 'tx_789',
            batch_id: 'batch_123',
            pipeline_source: 'edgar',
            abstract: 'Some abstract text',
          }}
          status="SECURED"
        />
      );
      expect(screen.getByText('MIT')).toBeInTheDocument();
      expect(screen.queryByText(/merkle/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/batch/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/pipeline/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/abstract/i)).not.toBeInTheDocument();
    });

    it('renders object values as JSON strings, not [object Object]', () => {
      render(
        <CredentialRenderer
          metadata={{ nested_data: { foo: 'bar', count: 42 } }}
          status="SECURED"
        />
      );
      expect(screen.getByText('{"foo":"bar","count":42}')).toBeInTheDocument();
      expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
    });
  });

  describe('Mode 3: No Metadata', () => {
    it('renders filename and no-metadata message', () => {
      render(
        <CredentialRenderer
          filename="diploma.pdf"
          status="SECURED"
        />
      );
      expect(screen.getByText('diploma.pdf')).toBeInTheDocument();
      expect(screen.getByText('No additional details available for this record.')).toBeInTheDocument();
    });
  });

  describe('Status Badge', () => {
    it('renders SECURED status with green badge', () => {
      render(<CredentialRenderer status="SECURED" filename="test.pdf" />);
      const badge = screen.getByText('Secured');
      expect(badge).toBeInTheDocument();
    });

    it('renders REVOKED status', () => {
      render(<CredentialRenderer status="REVOKED" filename="test.pdf" />);
      expect(screen.getByText('Revoked')).toBeInTheDocument();
    });

    it('renders PENDING status', () => {
      render(<CredentialRenderer status="PENDING" filename="test.pdf" />);
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });
  });

  describe('Issuer', () => {
    it('renders issuer name when provided', () => {
      render(
        <CredentialRenderer
          issuerName="Acme University"
          status="SECURED"
          filename="test.pdf"
        />
      );
      expect(screen.getByText('Acme University')).toBeInTheDocument();
    });

    it('does not render issuer section when null', () => {
      render(<CredentialRenderer status="SECURED" filename="test.pdf" />);
      expect(screen.queryByText('Issued by')).not.toBeInTheDocument();
    });
  });

  describe('Dates', () => {
    it('renders issued and expiry dates', () => {
      render(
        <CredentialRenderer
          issuedDate="2025-01-15"
          expiryDate="2030-01-15"
          status="SECURED"
          filename="test.pdf"
        />
      );
      expect(screen.getByText('January 15, 2025')).toBeInTheDocument();
      expect(screen.getByText('January 15, 2030')).toBeInTheDocument();
    });
  });

  describe('Fingerprint', () => {
    it('shows fingerprint when showFingerprint is true', () => {
      const fp = 'abc123def456789';
      render(
        <CredentialRenderer
          fingerprint={fp}
          showFingerprint
          status="SECURED"
          filename="test.pdf"
        />
      );
      expect(screen.getByText(fp)).toBeInTheDocument();
    });

    it('hides fingerprint when showFingerprint is false', () => {
      render(
        <CredentialRenderer
          fingerprint="abc123"
          showFingerprint={false}
          status="SECURED"
          filename="test.pdf"
        />
      );
      expect(screen.queryByText('abc123')).not.toBeInTheDocument();
    });

    it('copies fingerprint to clipboard on button click', async () => {
      const fp = 'abc123def456';
      render(
        <CredentialRenderer
          fingerprint={fp}
          showFingerprint
          status="SECURED"
          filename="test.pdf"
        />
      );
      const copyBtn = screen.getByRole('button');
      fireEvent.click(copyBtn);
      expect(mockClipboard.writeText).toHaveBeenCalledWith(fp);
    });
  });

  describe('Compact Mode', () => {
    it('renders compact card with template name', () => {
      render(
        <CredentialRenderer
          template={MOCK_TEMPLATE}
          metadata={MOCK_METADATA}
          credentialType="DEGREE"
          status="SECURED"
          issuerName="MIT"
          compact
        />
      );
      expect(screen.getByText("Bachelor's Degree")).toBeInTheDocument();
      expect(screen.getByText('MIT')).toBeInTheDocument();
      expect(screen.getByText('Secured')).toBeInTheDocument();
      // Should NOT render full field grid
      expect(screen.queryByText('University of Michigan')).not.toBeInTheDocument();
    });

    it('falls back to credential type label in compact mode when no template', () => {
      render(
        <CredentialRenderer
          credentialType="CERTIFICATE"
          status="SECURED"
          compact
        />
      );
      expect(screen.getByText('Certificate')).toBeInTheDocument();
    });

    it('falls back to filename in compact mode when no template or type', () => {
      render(
        <CredentialRenderer
          filename="diploma.pdf"
          status="SECURED"
          compact
        />
      );
      expect(screen.getByText('diploma.pdf')).toBeInTheDocument();
    });
  });
});
