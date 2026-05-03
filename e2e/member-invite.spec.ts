/**
 * Member Invite E2E Tests (QA-E2E-03)
 *
 * Tests the InviteMemberModal flow on OrgProfilePage:
 * invite button visibility, form validation, role selection, and submission.
 *
 * @created 2026-03-28
 */

import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function openPeopleTab(page: Page) {
  await page.goto('/organization');
  await page.getByRole('tab', { name: 'People' }).click();
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible({ timeout: 10000 });
}

async function openInviteDialog(page: Page) {
  await openPeopleTab(page);
  await page.getByRole('button', { name: /Invite Member/i }).click();

  const dialog = page.getByRole('dialog', { name: 'Invite Team Member' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Member Invite Flow', () => {
  test('shows Invite Member button for org admins', async ({ orgAdminPage }) => {
    await openPeopleTab(orgAdminPage);

    // Invite Member button should be visible for admins
    await expect(orgAdminPage.getByRole('button', { name: /Invite Member/i })).toBeVisible();
  });

  test('opens invite modal when clicking Invite Member', async ({ orgAdminPage }) => {
    const dialog = await openInviteDialog(orgAdminPage);

    // Email input should be present
    await expect(dialog.getByLabel('Email address')).toBeVisible();

    // Role selector should be present
    await expect(dialog.getByLabel('Role')).toBeVisible();

    // Send Invitation button should be present
    await expect(dialog.getByRole('button', { name: /Send Invitation/i })).toBeVisible();
  });

  test('disables Send Invitation button when email is empty', async ({ orgAdminPage }) => {
    const dialog = await openInviteDialog(orgAdminPage);

    // Button should be disabled when email is empty
    const sendBtn = dialog.getByRole('button', { name: /Send Invitation/i });
    await expect(sendBtn).toBeDisabled();
  });

  test('shows validation error for invalid email', async ({ orgAdminPage }) => {
    const dialog = await openInviteDialog(orgAdminPage);

    // Type invalid email
    await dialog.getByLabel('Email address').fill('invalid-email@localhost');

    // Submit
    await dialog.getByRole('button', { name: /Send Invitation/i }).click();

    // Should show validation error
    await expect(dialog.getByText(/valid email/i)).toBeVisible();
  });

  test('enables Send Invitation button when email is entered', async ({ orgAdminPage }) => {
    const dialog = await openInviteDialog(orgAdminPage);

    // Type valid email
    await dialog.getByLabel('Email address').fill('newmember@example.com');

    // Button should become enabled
    const sendBtn = dialog.getByRole('button', { name: /Send Invitation/i });
    await expect(sendBtn).toBeEnabled();
  });

  test('can select Admin role in role dropdown', async ({ orgAdminPage }) => {
    const dialog = await openInviteDialog(orgAdminPage);

    // Click role selector trigger
    await dialog.getByLabel('Role').click();

    // Admin option should be available
    const listbox = orgAdminPage.getByRole('listbox');
    await expect(listbox.getByText('Admin', { exact: true })).toBeVisible();
    await expect(listbox.getByText('Member', { exact: true })).toBeVisible();
  });

  test('closes modal when Cancel is clicked', async ({ orgAdminPage }) => {
    const dialog = await openInviteDialog(orgAdminPage);

    // Click Cancel
    await dialog.getByRole('button', { name: /Cancel/i }).click();

    // Modal should close
    await expect(dialog).not.toBeVisible();
  });

  test('modal resets form when reopened', async ({ orgAdminPage }) => {
    await openPeopleTab(orgAdminPage);

    // Open modal, type email, then cancel
    await orgAdminPage.getByRole('button', { name: /Invite Member/i }).click();
    let dialog = orgAdminPage.getByRole('dialog', { name: 'Invite Team Member' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Email address').fill('test@example.com');
    await dialog.getByRole('button', { name: /Cancel/i }).click();
    await expect(dialog).not.toBeVisible();

    // Reopen modal — email should be cleared
    await orgAdminPage.getByRole('button', { name: /Invite Member/i }).click();
    dialog = orgAdminPage.getByRole('dialog', { name: 'Invite Team Member' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Email address')).toHaveValue('');
  });
});
