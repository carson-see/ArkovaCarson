import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SetPasswordPage } from './SetPasswordPage';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), updateUser: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: {
  getUser: mocks.getUser, updateUser: mocks.updateUser,
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe: mocks.unsubscribe } } }),
} } }));
vi.mock('@/components/layout', () => ({ AuthLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
function page() { render(<MemoryRouter><SetPasswordPage /></MemoryRouter>); }
function fill(password: string, confirmation = password) {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirmation } });
  fireEvent.click(screen.getByRole('button', { name: 'Save password' }));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'fixture-user' } }, error: null });
  mocks.updateUser.mockResolvedValue({ data: { user: { id: 'fixture-user' } }, error: null });
});
describe('SetPasswordPage', () => {
  it('lets a recovered authenticated recipient choose a durable password', async () => {
    page(); await screen.findByLabelText('New password'); fill('Chosen-password-3873!');
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith({ password: 'Chosen-password-3873!' }));
    expect(await screen.findByText('Your password is ready. Use it the next time you sign in.')).toBeInTheDocument();
  });
  it('does not offer a password write without a valid server-verified user', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'expired token' } });
    page(); expect(await screen.findByText(/request a new link/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it('rejects mismatched passwords without calling Auth', async () => {
    page(); await screen.findByLabelText('New password'); fill('Chosen-password-3873!', 'different-password');
    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it('rejects a short password before calling Auth', async () => {
    page(); await screen.findByLabelText('New password'); fill('short');
    expect(await screen.findByText('Choose a password between 8 and 128 characters.')).toBeInTheDocument();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it('keeps the form open on Auth failure without exposing provider details', async () => {
    mocks.updateUser.mockResolvedValue({ error: { message: 'sensitive provider detail' } });
    page(); await screen.findByLabelText('New password'); fill('Chosen-password-3873!');
    expect(await screen.findByText('Unable to save your password. Try again or request a new link.')).toBeInTheDocument();
    expect(screen.queryByText('sensitive provider detail')).not.toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
  });
});
