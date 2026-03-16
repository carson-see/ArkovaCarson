/**
 * ApiKeyScopeDisplay Component Tests (P4.5-TS-11)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiKeyScopeDisplay } from './ApiKeyScopeDisplay';

describe('ApiKeyScopeDisplay', () => {
  it('renders scope badges', () => {
    render(<ApiKeyScopeDisplay scopes={['verify', 'batch', 'usage']} />);
    expect(screen.getByText('Verify')).toBeInTheDocument();
    expect(screen.getByText('Batch')).toBeInTheDocument();
    expect(screen.getByText('Usage')).toBeInTheDocument();
  });

  it('renders compact mode with count', () => {
    render(<ApiKeyScopeDisplay scopes={['verify', 'batch']} compact={true} />);
    expect(screen.getByText('2 scopes')).toBeInTheDocument();
  });

  it('renders singular scope count in compact mode', () => {
    render(<ApiKeyScopeDisplay scopes={['verify']} compact={true} />);
    expect(screen.getByText('1 scope')).toBeInTheDocument();
  });

  it('renders unknown scope as raw text', () => {
    render(<ApiKeyScopeDisplay scopes={['custom_scope']} />);
    expect(screen.getByText('custom_scope')).toBeInTheDocument();
  });
});
