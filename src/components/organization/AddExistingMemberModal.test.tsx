import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockWorkerFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/workerClient', () => ({ workerFetch: mockWorkerFetch }));

import { AddExistingMemberModal } from './AddExistingMemberModal';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
function props(overrides: Record<string, unknown> = {}) {
  return { open: true, onOpenChange: vi.fn(), orgId: ORG_ID, onMemberAdded: vi.fn(), ...overrides };
}

describe('AddExistingMemberModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([false, true])('uses the atomic exact-email endpoint (platform=%s)', async (useAdminEndpoints) => {
    mockWorkerFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        member: { id: USER_ID, email: 'found@acme.com', fullName: 'Found User' },
        idempotent: false,
      }),
    });
    const onMemberAdded = vi.fn();
    render(<AddExistingMemberModal {...props({ useAdminEndpoints, onMemberAdded })} />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), {
      target: { value: ' Found@Acme.com ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));

    await waitFor(() => expect(mockWorkerFetch).toHaveBeenCalledWith(
      `/api/organization-members/${ORG_ID}/existing`,
      { method: 'POST', body: JSON.stringify({ email: 'Found@Acme.com', role: 'INDIVIDUAL' }) },
    ));
    expect(await screen.findByText(/Found User has been added/)).toBeInTheDocument();
    expect(onMemberAdded).toHaveBeenCalledOnce();
  });

  it('shows a bounded missing-account response and permits retry', async () => {
    mockWorkerFetch
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'No existing account found for that email' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, member: { id: USER_ID, email: 'person@example.com', fullName: null }, idempotent: false }),
      });
    render(<AddExistingMemberModal {...props()} />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), {
      target: { value: 'person@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));
    expect(await screen.findByText('No existing account found for that email')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));
    expect(await screen.findByText(/person@example.com has been added/)).toBeInTheDocument();
  });

  it('shows actionable copy for an existing membership with a different role', async () => {
    const onMemberAdded = vi.fn();
    mockWorkerFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'membership_role_conflict' }),
    });
    render(<AddExistingMemberModal {...props({ onMemberAdded })} />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), {
      target: { value: 'person@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));

    expect(await screen.findByText(/already a member with a different role/i)).toBeInTheDocument();
    expect(onMemberAdded).not.toHaveBeenCalled();
  });

  it('submits with Enter and disables duplicate submission while pending', async () => {
    let resolveRequest!: (value: unknown) => void;
    mockWorkerFetch.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    render(<AddExistingMemberModal {...props()} />);
    const email = screen.getByPlaceholderText('user@example.com');
    fireEvent.change(email, { target: { value: 'person@example.com' } });
    fireEvent.keyDown(email, { key: 'Enter' });

    await waitFor(() => expect(email).toBeDisabled());
    fireEvent.keyDown(email, { key: 'Enter' });
    expect(mockWorkerFetch).toHaveBeenCalledOnce();
    resolveRequest({ ok: true, json: async () => ({ success: true, member: { id: USER_ID, email: 'person@example.com', fullName: null }, idempotent: false }) });
  });

  it('fails closed on a malformed success response', async () => {
    mockWorkerFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, member: { email: 'person@example.com' } }) });
    const onMemberAdded = vi.fn();
    render(<AddExistingMemberModal {...props({ onMemberAdded })} />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'person@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));
    expect(await screen.findByText('Failed to add member. Please try again.')).toBeInTheDocument();
    expect(onMemberAdded).not.toHaveBeenCalled();
  });

  it('ignores a stale response after controlled close and same-org reopen', async () => {
    let resolveRequest!: (value: unknown) => void;
    mockWorkerFetch.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    const onMemberAdded = vi.fn();
    const view = render(<AddExistingMemberModal {...props({ onMemberAdded })} />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'old@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));
    await waitFor(() => expect(screen.getByPlaceholderText('user@example.com')).toBeDisabled());

    view.rerender(<AddExistingMemberModal {...props({ open: false, onMemberAdded })} />);
    view.rerender(<AddExistingMemberModal {...props({ open: true, onMemberAdded })} />);
    expect(screen.getByPlaceholderText('user@example.com')).toHaveValue('');

    resolveRequest({
      ok: true,
      json: async () => ({
        success: true,
        member: { id: USER_ID, email: 'old@example.com', fullName: 'Old Request' },
        idempotent: false,
      }),
    });
    await Promise.resolve();
    expect(onMemberAdded).not.toHaveBeenCalled();
    expect(screen.queryByText(/Old Request has been added/)).not.toBeInTheDocument();
  });

  it('resets email, role and success when the controlled organization changes', async () => {
    mockWorkerFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        member: { id: USER_ID, email: 'member@example.com', fullName: null },
        idempotent: false,
      }),
    });
    const view = render(<AddExistingMemberModal {...props()} />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'member@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));
    expect(await screen.findByText(/member@example.com has been added/)).toBeInTheDocument();

    view.rerender(<AddExistingMemberModal {...props({ orgId: '33333333-3333-4333-8333-333333333333' })} />);
    expect(screen.getByPlaceholderText('user@example.com')).toHaveValue('');
    expect(screen.queryByText(/has been added/)).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveTextContent('Member');
  });
});
