/**
 * IntegrityScoreBadge Tests (P8-S8)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IntegrityScoreBadge } from './IntegrityScoreBadge';

describe('IntegrityScoreBadge', () => {
  it('renders HIGH level badge', () => {
    render(<IntegrityScoreBadge score={90} level="HIGH" />);
    expect(screen.getByText('High Integrity')).toBeTruthy();
    expect(screen.getByText('90/100')).toBeTruthy();
  });

  it('renders MEDIUM level badge', () => {
    render(<IntegrityScoreBadge score={65} level="MEDIUM" />);
    expect(screen.getByText('Medium Integrity')).toBeTruthy();
  });

  it('renders LOW level badge', () => {
    render(<IntegrityScoreBadge score={45} level="LOW" />);
    expect(screen.getByText('Low Integrity')).toBeTruthy();
  });

  it('renders FLAGGED level badge', () => {
    render(<IntegrityScoreBadge score={20} level="FLAGGED" />);
    expect(screen.getByText('Flagged')).toBeTruthy();
  });

  it('renders compact mode', () => {
    render(<IntegrityScoreBadge score={85} level="HIGH" compact />);
    expect(screen.getByText('85')).toBeTruthy();
    expect(screen.queryByText('High Integrity')).toBeNull();
  });

  it('hides score when showScore is false', () => {
    render(<IntegrityScoreBadge score={85} level="HIGH" showScore={false} />);
    expect(screen.queryByText('85/100')).toBeNull();
    expect(screen.getByText('High Integrity')).toBeTruthy();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<IntegrityScoreBadge score={85} level="HIGH" onClick={onClick} />);
    screen.getByText('High Integrity').closest('button')?.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders compact badge with title attribute', () => {
    render(<IntegrityScoreBadge score={75} level="MEDIUM" compact />);
    const button = screen.getByTitle('Medium Integrity: 75/100');
    expect(button).toBeTruthy();
  });
});
