/**
 * UsageWidget Tests
 *
 * Tests the usage tracking widget at various usage levels.
 *
 * @see UF-06
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { UsageWidget } from './UsageWidget';

// Mock useEntitlements hook
const mockEntitlements: {
  canCreateAnchor: boolean;
  recordsUsed: number;
  recordsLimit: number | null;
  remaining: number | null;
  percentUsed: number | null;
  isNearLimit: boolean;
  planName: string | null;
  loading: boolean;
  error: string | null;
  refresh: ReturnType<typeof vi.fn>;
  canCreateCount: ReturnType<typeof vi.fn>;
} = {
  canCreateAnchor: true,
  recordsUsed: 0,
  recordsLimit: 10,
  remaining: 10,
  percentUsed: 0,
  isNearLimit: false,
  planName: 'Individual',
  loading: false,
  error: null,
  refresh: vi.fn(),
  canCreateCount: vi.fn().mockReturnValue(true),
};

vi.mock('@/hooks/useEntitlements', () => ({
  useEntitlements: () => mockEntitlements,
}));

// Mock toast
vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderWidget(compact = false) {
  return render(
    <BrowserRouter>
      <UsageWidget compact={compact} />
    </BrowserRouter>
  );
}

describe('UsageWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.recordsUsed = 0;
    mockEntitlements.recordsLimit = 10;
    mockEntitlements.remaining = 10;
    mockEntitlements.percentUsed = 0;
    mockEntitlements.isNearLimit = false;
    mockEntitlements.planName = 'Individual';
    mockEntitlements.loading = false;
    mockEntitlements.error = null;
  });

  it('renders usage at 0%', () => {
    renderWidget();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('/ 10 records')).toBeInTheDocument();
    expect(screen.getByText('Individual')).toBeInTheDocument();
  });

  it('renders usage at 50%', () => {
    mockEntitlements.recordsUsed = 5;
    mockEntitlements.remaining = 5;
    mockEntitlements.percentUsed = 50;
    renderWidget();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows warning state at 80%', () => {
    mockEntitlements.recordsUsed = 8;
    mockEntitlements.remaining = 2;
    mockEntitlements.percentUsed = 80;
    mockEntitlements.isNearLimit = true;
    renderWidget();
    expect(screen.getByText(/approaching your monthly limit/)).toBeInTheDocument();
  });

  it('shows quota reached at 100%', () => {
    mockEntitlements.recordsUsed = 10;
    mockEntitlements.remaining = 0;
    mockEntitlements.percentUsed = 100;
    mockEntitlements.isNearLimit = true;
    renderWidget();
    expect(screen.getByText(/Monthly Limit Reached/)).toBeInTheDocument();
  });

  it('shows unlimited for unlimited plans', () => {
    mockEntitlements.recordsLimit = null;
    mockEntitlements.remaining = null;
    mockEntitlements.percentUsed = null;
    renderWidget();
    expect(screen.getByText('Unlimited')).toBeInTheDocument();
  });

  it('renders compact mode', () => {
    mockEntitlements.recordsUsed = 3;
    mockEntitlements.percentUsed = 30;
    renderWidget(true);
    expect(screen.getByText('3 of 10 records used')).toBeInTheDocument();
  });

  it('returns null on error', () => {
    mockEntitlements.error = 'Some error';
    const { container } = renderWidget();
    expect(container.firstChild).toBeNull();
  });

  it('shows loading skeleton', () => {
    mockEntitlements.loading = true;
    const { container } = renderWidget();
    // Should render skeleton (not null)
    expect(container.firstChild).not.toBeNull();
  });

  it('shows upgrade CTA when near limit in compact mode', () => {
    mockEntitlements.recordsUsed = 9;
    mockEntitlements.remaining = 1;
    mockEntitlements.percentUsed = 90;
    mockEntitlements.isNearLimit = true;
    renderWidget(true);
    expect(screen.getByText('Upgrade Plan')).toBeInTheDocument();
  });

  it('fires toast warning at 80% usage', async () => {
    const { toast } = await import('sonner');
    mockEntitlements.percentUsed = 80;
    mockEntitlements.isNearLimit = true;
    renderWidget();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('80%'));
  });

  it('fires toast warning at 100% usage', async () => {
    const { toast } = await import('sonner');
    mockEntitlements.percentUsed = 100;
    mockEntitlements.isNearLimit = true;
    renderWidget();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('limit reached'));
  });
});
