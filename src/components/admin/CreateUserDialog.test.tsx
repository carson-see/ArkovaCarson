/**
 * Tests for CreateUserDialog (SCRUM-3873).
 *
 * Focus is the pre-mortem's F6: an account created with nobody notified is the
 * most likely SILENT failure, so the opt-out path must hold the one-time
 * sign-in link on screen rather than closing over it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateUserDialog } from './CreateUserDialog';
import { workerFetch } from '@/lib/workerClient';

vi.mock('@/lib/workerClient', () => ({ workerFetch: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ORGS = [{ id: 'org-1', display_name: 'PlanBook' }];

function ok(body: unknown, status = 201) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

beforeEach(() => vi.clearAllMocks());

function renderDialog(over: Partial<Parameters<typeof CreateUserDialog>[0]> = {}) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <CreateUserDialog open organizations={ORGS} onClose={onClose} onCreated={onCreated} {...over} />,
  );
  return { onCreated, onClose };
}

describe('CreateUserDialog', () => {
  it('sends send_invite_email true by default', async () => {
    vi.mocked(workerFetch).mockResolvedValue(ok({ success: true, account: { activation_link: null } }));
    renderDialog();

    await userEvent.type(screen.getByLabelText(/email address/i), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(workerFetch).toHaveBeenCalled());
    const body = JSON.parse(vi.mocked(workerFetch).mock.calls[0][1]?.body as string);
    expect(body.send_invite_email).toBe(true);
    expect(body.role).toBe('INDIVIDUAL');
    expect(body.org_id).toBeNull();
  });

  it('F6: shows the one-time link and keeps the dialog open when no email was sent', async () => {
    vi.mocked(workerFetch).mockResolvedValue(
      ok({ success: true, account: { activation_link: 'https://app.arkova.test/set-password' } }),
    );
    const { onClose } = renderDialog();

    await userEvent.type(screen.getByLabelText(/email address/i), 'new@example.com');
    await userEvent.click(screen.getByLabelText(/email them a sign-in link/i));
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://app.arkova.test/set-password')).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('warns before submitting when the admin opts out of the email', async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/email them a sign-in link/i));
    expect(screen.getByText(/no email will be sent/i)).toBeInTheDocument();
  });

  it('blocks an invalid email without calling the API', async () => {
    renderDialog();
    await userEvent.type(screen.getByLabelText(/email address/i), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/valid email address/i)).toBeInTheDocument();
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('surfaces the role_conflict code as its own explanatory message', async () => {
    vi.mocked(workerFetch).mockResolvedValue(ok({ error: 'x', code: 'role_conflict' }, 409));
    renderDialog();

    await userEvent.type(screen.getByLabelText(/email address/i), 'ops@acme.com');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/claimed by another organization/i)).toBeInTheDocument();
  });
});

describe('CreateUserDialog — send-failure handling (code review finding)', () => {
  it('does NOT claim an email was sent when the worker reports the send failed', async () => {
    vi.mocked(workerFetch).mockResolvedValue(
      ok({
        success: true,
        account: { invite_email_sent: false, activation_link: 'https://app.arkova.test/set-password' },
      }),
    );
    const { onClose } = renderDialog();

    await userEvent.type(screen.getByLabelText(/email address/i), 'new@example.com');
    // Admin ASKED for an email (toggle left on) but the send failed.
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://app.arkova.test/set-password')).toBeInTheDocument();
    });
    expect(screen.getByText(/email could not be sent/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports plainly when the account is created but undeliverable by any route', async () => {
    vi.mocked(workerFetch).mockResolvedValue(
      ok({ success: true, account: { invite_email_sent: false, activation_link: null } }),
    );
    renderDialog();

    await userEvent.type(screen.getByLabelText(/email address/i), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/could not be sent and no sign-in link/i)).toBeInTheDocument();
  });

  it('closes on a genuine successful send', async () => {
    vi.mocked(workerFetch).mockResolvedValue(
      ok({ success: true, account: { invite_email_sent: true, activation_link: null } }),
    );
    const { onClose } = renderDialog();

    await userEvent.type(screen.getByLabelText(/email address/i), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
