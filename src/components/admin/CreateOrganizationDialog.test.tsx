/**
 * Tests for CreateOrganizationDialog (SCRUM-3873).
 *
 * Focus is the pre-mortem's F3 (duplicate orgs from a double-submit) and F8
 * (the seed trigger silently capping every new org at 10 anchors).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateOrganizationDialog } from './CreateOrganizationDialog';
import { workerFetch } from '@/lib/workerClient';

vi.mock('@/lib/workerClient', () => ({ workerFetch: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function res(body: unknown, status = 201) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

beforeEach(() => vi.clearAllMocks());

function renderDialog() {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(<CreateOrganizationDialog open onClose={onClose} onCreated={onCreated} />);
  return { onCreated, onClose };
}

describe('CreateOrganizationDialog', () => {
  it('posts the resolved quota and credits', async () => {
    vi.mocked(workerFetch).mockResolvedValue(res({ success: true, organization: { org_id: 'o1' } }));
    renderDialog();

    await userEvent.type(screen.getByLabelText(/organization name/i), 'PlanBook');
    const credits = screen.getByLabelText(/starting credits/i);
    await userEvent.clear(credits);
    await userEvent.type(credits, '2');
    await userEvent.click(screen.getByRole('button', { name: /^create organization$/i }));

    await waitFor(() => expect(workerFetch).toHaveBeenCalled());
    const body = JSON.parse(vi.mocked(workerFetch).mock.calls[0][1]?.body as string);
    expect(body).toMatchObject({ display_name: 'PlanBook', anchor_quota: 10, credits: 2, is_test: true });
  });

  it('F8: turning the cap off sends an explicit null quota, not an omitted field', async () => {
    vi.mocked(workerFetch).mockResolvedValue(res({ success: true, organization: { org_id: 'o1' } }));
    renderDialog();

    await userEvent.type(screen.getByLabelText(/organization name/i), 'BigCo');
    await userEvent.click(screen.getByLabelText(/limit free test anchors/i));
    await userEvent.click(screen.getByRole('button', { name: /^create organization$/i }));

    await waitFor(() => expect(workerFetch).toHaveBeenCalled());
    const body = JSON.parse(vi.mocked(workerFetch).mock.calls[0][1]?.body as string);
    expect(body.anchor_quota).toBeNull();
    expect(body.is_test).toBe(false);
  });

  it('F3: a duplicate name asks for confirmation instead of silently creating a second org', async () => {
    vi.mocked(workerFetch).mockResolvedValue(
      res({ error: 'exists', code: 'org_exists', existing_org_id: 'org-existing' }, 409),
    );
    const { onCreated } = renderDialog();

    await userEvent.type(screen.getByLabelText(/organization name/i), 'PlanBook');
    await userEvent.click(screen.getByRole('button', { name: /^create organization$/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();

    // Confirming re-sends with the override.
    vi.mocked(workerFetch).mockResolvedValue(res({ success: true, organization: { org_id: 'o2' } }));
    await userEvent.click(screen.getByRole('button', { name: /create it anyway/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const body = JSON.parse(vi.mocked(workerFetch).mock.calls[1][1]?.body as string);
    expect(body.allow_duplicate_name).toBe(true);
  });

  it('blocks an empty name without calling the API', async () => {
    renderDialog();
    await userEvent.click(screen.getByRole('button', { name: /^create organization$/i }));
    expect(await screen.findByText(/enter an organization name/i)).toBeInTheDocument();
    expect(workerFetch).not.toHaveBeenCalled();
  });
});
