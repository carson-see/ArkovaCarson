/**
 * Tests for VerificationWalkthrough (DEMO-02)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerificationWalkthrough } from './VerificationWalkthrough';

describe('VerificationWalkthrough', () => {
  it('renders the title', () => {
    render(<VerificationWalkthrough />);
    expect(screen.getByText('How Verification Works')).toBeInTheDocument();
  });

  it('renders all three steps', () => {
    render(<VerificationWalkthrough />);
    expect(screen.getByText('Fingerprint Your Document')).toBeInTheDocument();
    expect(screen.getByText('Find It On the Network')).toBeInTheDocument();
    expect(screen.getByText('Match = Verified')).toBeInTheDocument();
  });

  it('renders step numbers', () => {
    render(<VerificationWalkthrough />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows metadata note when hasMetadata is true', () => {
    render(<VerificationWalkthrough hasMetadata />);
    expect(screen.getByText(/AI-extracted metadata/)).toBeInTheDocument();
  });

  it('hides metadata note when hasMetadata is false', () => {
    render(<VerificationWalkthrough hasMetadata={false} />);
    expect(screen.queryByText(/AI-extracted metadata/)).not.toBeInTheDocument();
  });

  it('hides metadata note when hasMetadata is not provided', () => {
    render(<VerificationWalkthrough />);
    expect(screen.queryByText(/AI-extracted metadata/)).not.toBeInTheDocument();
  });
});
