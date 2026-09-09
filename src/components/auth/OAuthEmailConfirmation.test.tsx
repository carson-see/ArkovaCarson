import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthEmailConfirmation } from './OAuthEmailConfirmation';
const { status, send, complete, refresh, setSession, signOut, navigate } = vi.hoisted(() => ({
  status: vi.fn(), send: vi.fn(), complete: vi.fn(), refresh: vi.fn(), setSession: vi.fn(), signOut: vi.fn(), navigate: vi.fn(),
}));
vi.mock('@/lib/emailConfirmationApi', () => ({ ConfirmationError: class extends Error {}, getConfirmationStatus: status, sendConfirmationEmail: send, completeEmailConfirmation: complete }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { refreshSession: refresh, setSession, signOut } } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'current@example.test' }, signOut: vi.fn() }) }));

describe('OAuth confirmation signup experience', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    status.mockResolvedValue({ required: true, email: 'current@example.test', sent: false, retryAfterSeconds: 0 });
    send.mockResolvedValue({ required: true, sent: true, retryAfterSeconds: 90 });
  });
  it('sends once then shows check-email state and disables immediate resend', async () => {
    render(<OAuthEmailConfirmation mailboxProof={null} />);
    await screen.findByText(/We sent a confirmation link/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Resend in/ })).toBeDisabled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it('reports failed delivery without claiming that an email was sent', async () => {
    send.mockRejectedValue(new Error('Delivery unavailable'));
    render(<OAuthEmailConfirmation mailboxProof={null} />);
    await screen.findByRole('alert');
    expect(screen.queryByText(/We sent a confirmation link/)).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
  it('requires an explicit action before redeeming a link or switching browser accounts', async () => {
    complete.mockResolvedValue({ complete: true, session: { access_token: 'new', refresh_token: 'new' } });
    setSession.mockResolvedValue({ data: { session: { access_token: 'new' } }, error: null });
    render(<OAuthEmailConfirmation mailboxProof="mailbox-proof" />);
    expect(complete).not.toHaveBeenCalled();
    expect(screen.getByText(/signs you in to the account/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email and continue' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true }));
    expect(complete).toHaveBeenCalledWith('mailbox-proof');
  });
  it('switches accounts only after sign-out succeeds, and preserves recovery on failure', async () => {
    const location = { href: '' };
    vi.stubGlobal('window', new Proxy(window, { get: (target, key) => key === 'location' ? location : Reflect.get(target, key) }));
    signOut.mockResolvedValueOnce({ error: new Error('private signout error') }).mockResolvedValueOnce({ error: null });
    render(<OAuthEmailConfirmation mailboxProof="mailbox-proof" />);
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    await screen.findByRole('alert');
    expect(navigate).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('arkova_signed_out')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    await waitFor(() => expect(location.href).toBe('/login'));
    expect(sessionStorage.getItem('arkova_signed_out')).toBe('1');
  });
  it('does not continue until refreshed session is no longer pending', async () => {
    status.mockResolvedValue({ required: false });
    refresh.mockResolvedValue({ data: { session: { access_token: `h.${btoa(JSON.stringify({ role: 'arkova_email_pending' }))}.s` } }, error: null });
    render(<OAuthEmailConfirmation mailboxProof={null} />);
    await screen.findByRole('alert');
    expect(navigate).not.toHaveBeenCalled();
  });
});
