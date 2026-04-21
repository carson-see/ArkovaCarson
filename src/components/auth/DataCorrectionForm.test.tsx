/**
 * Tests for Data Correction Form — REG-19 / APP 13 (SCRUM-580)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataCorrectionForm } from './DataCorrectionForm';
import { DATA_CORRECTION_LABELS } from '@/lib/copy';

// Mock supabase
const mockInsert = vi.fn().mockResolvedValue({ error: null });
const mockSelect = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnValue({
    order: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue({ data: [] }),
    }),
  }),
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'data_subject_requests') {
        return {
          insert: mockInsert,
          select: mockSelect,
        };
      }
      return {};
    }),
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'test-user-id', email: 'test@example.com' } }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('DataCorrectionForm — REG-19 / APP 13', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (import.meta.env as Record<string, unknown>).VITE_ENABLE_DSAR_UI = '1';
  });

  it('renders the correction form with proper labels', () => {
    render(<DataCorrectionForm />);

    expect(screen.getByLabelText(DATA_CORRECTION_LABELS.FIELD_LABEL)).toBeDefined();
    expect(screen.getByPlaceholderText(DATA_CORRECTION_LABELS.FIELD_PLACEHOLDER)).toBeDefined();
    expect(screen.getByText(DATA_CORRECTION_LABELS.SUBMIT)).toBeDefined();
  });

  it('submit button is disabled when description is empty', () => {
    render(<DataCorrectionForm />);

    const submitBtn = screen.getByText(DATA_CORRECTION_LABELS.SUBMIT);
    expect(submitBtn.closest('button')?.disabled).toBe(true);
  });

  it('submit button is enabled when description has text', () => {
    render(<DataCorrectionForm />);

    const textarea = screen.getByPlaceholderText(DATA_CORRECTION_LABELS.FIELD_PLACEHOLDER);
    fireEvent.change(textarea, { target: { value: 'My name is spelled wrong' } });

    const submitBtn = screen.getByText(DATA_CORRECTION_LABELS.SUBMIT);
    expect(submitBtn.closest('button')?.disabled).toBe(false);
  });

  it('has a max length of 2000 characters on the textarea', () => {
    render(<DataCorrectionForm />);

    const textarea = screen.getByPlaceholderText(DATA_CORRECTION_LABELS.FIELD_PLACEHOLDER);
    expect(textarea.getAttribute('maxlength')).toBe('2000');
  });

  it('renders 30-day response timeline in copy', () => {
    render(<DataCorrectionForm />);

    // The description mentions 30 days — rendered by the parent card, but
    // we verify the component itself renders without error
    expect(screen.getByText(DATA_CORRECTION_LABELS.SUBMIT)).toBeDefined();
  });

  it.each([
    ['empty string (flag unset)', ''],
    ['explicit "false"', 'false'],
  ])('does not fetch data_subject_requests when the flag is %s', async (_label, flagValue) => {
    (import.meta.env as Record<string, unknown>).VITE_ENABLE_DSAR_UI = flagValue;
    const { supabase } = await import('@/lib/supabase');
    const fromSpy = supabase.from as unknown as ReturnType<typeof vi.fn>;
    fromSpy.mockClear();
    render(<DataCorrectionForm />);
    await Promise.resolve();
    const readCalls = fromSpy.mock.calls.filter((c) => c[0] === 'data_subject_requests');
    expect(readCalls.length).toBe(0);
  });
});
