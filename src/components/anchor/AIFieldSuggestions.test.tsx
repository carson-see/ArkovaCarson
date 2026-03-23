/**
 * Tests for AIFieldSuggestions Component (P8-S5)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AIFieldSuggestions } from './AIFieldSuggestions';
import type { ExtractionField, ExtractionProgress } from '../../lib/aiExtraction';

const mockFields: ExtractionField[] = [
  { key: 'credentialType', value: 'DEGREE', confidence: 0.92, status: 'suggested' },
  { key: 'issuerName', value: 'University of Michigan', confidence: 0.88, status: 'suggested' },
  { key: 'fieldOfStudy', value: 'Computer Science', confidence: 0.75, status: 'suggested' },
  { key: 'issuedDate', value: '2024-05-15', confidence: 0.65, status: 'suggested' },
];

const defaultProps = {
  fields: mockFields,
  overallConfidence: 0.85,
  creditsRemaining: 45,
  onFieldAccept: vi.fn(),
  onFieldReject: vi.fn(),
  onFieldEdit: vi.fn(),
  onAcceptAll: vi.fn(),
};

describe('AIFieldSuggestions', () => {
  it('renders field labels and values', () => {
    render(<AIFieldSuggestions {...defaultProps} />);

    expect(screen.getByText('Credential Type')).toBeInTheDocument();
    expect(screen.getByText('DEGREE')).toBeInTheDocument();
    expect(screen.getByText('University of Michigan')).toBeInTheDocument();
    expect(screen.getByText('Computer Science')).toBeInTheDocument();
  });

  it('shows confidence badge', () => {
    render(<AIFieldSuggestions {...defaultProps} />);
    expect(screen.getByText(/Auto-detected/)).toBeInTheDocument();
    expect(screen.getByText(/85%/)).toBeInTheDocument();
  });

  it('accepts creditsRemaining prop without error', () => {
    // Beta: credits display is disabled but prop should not cause errors
    const { container } = render(<AIFieldSuggestions {...defaultProps} />);
    expect(container.querySelector('.glass-card')).toBeInTheDocument();
  });

  it('shows accept all button', () => {
    render(<AIFieldSuggestions {...defaultProps} />);
    expect(screen.getByText(/Accept all/)).toBeInTheDocument();
  });

  it('calls onAcceptAll when button clicked', () => {
    render(<AIFieldSuggestions {...defaultProps} />);
    fireEvent.click(screen.getByText(/Accept all/));
    expect(defaultProps.onAcceptAll).toHaveBeenCalledWith(mockFields);
  });

  it('calls onFieldAccept when accept button clicked', () => {
    render(<AIFieldSuggestions {...defaultProps} />);
    const acceptButtons = screen.getAllByTitle('Accept');
    fireEvent.click(acceptButtons[0]);
    expect(defaultProps.onFieldAccept).toHaveBeenCalledWith('credentialType', 'DEGREE');
  });

  it('calls onFieldReject when reject button clicked', () => {
    render(<AIFieldSuggestions {...defaultProps} />);
    const rejectButtons = screen.getAllByTitle('Reject');
    fireEvent.click(rejectButtons[0]);
    expect(defaultProps.onFieldReject).toHaveBeenCalledWith('credentialType');
  });

  it('shows edit input when edit button clicked', () => {
    render(<AIFieldSuggestions {...defaultProps} />);
    const editButtons = screen.getAllByTitle('Edit');
    fireEvent.click(editButtons[0]);

    const input = screen.getByDisplayValue('DEGREE');
    expect(input).toBeInTheDocument();
  });

  it('shows progress bar during extraction', () => {
    const progress: ExtractionProgress = {
      stage: 'ocr',
      progress: 30,
      message: 'Reading document...',
    };

    render(<AIFieldSuggestions {...defaultProps} progress={progress} />);
    expect(screen.getByText('Reading document...')).toBeInTheDocument();
  });

  it('shows error state', () => {
    const progress: ExtractionProgress = {
      stage: 'error',
      progress: 0,
      message: 'No text found in document.',
    };

    render(<AIFieldSuggestions {...defaultProps} progress={progress} />);
    const matches = screen.getAllByText('No text found in document.');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('displays accepted field status', () => {
    const fields: ExtractionField[] = [
      { key: 'credentialType', value: 'DEGREE', confidence: 0.92, status: 'accepted' },
    ];
    render(<AIFieldSuggestions {...defaultProps} fields={fields} />);
    expect(screen.getByText('Accepted')).toBeInTheDocument();
  });

  it('displays rejected field status', () => {
    const fields: ExtractionField[] = [
      { key: 'credentialType', value: 'DEGREE', confidence: 0.92, status: 'rejected' },
    ];
    render(<AIFieldSuggestions {...defaultProps} fields={fields} />);
    expect(screen.getByText('Rejected')).toBeInTheDocument();
  });

  it('returns null when no fields', () => {
    const { container } = render(
      <AIFieldSuggestions {...defaultProps} fields={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
