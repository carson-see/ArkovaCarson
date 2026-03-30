/**
 * Member Invite E2E Tests (QA-E2E-03)
 *
 * Tests the InviteMemberModal flow on OrgProfilePage:
 * invite button visibility, form validation, role selection, and submission.
 *
 * @created 2026-03-28
 */

import { test, expect } from './fixtures';

test.describe('Member Invite Flow', () => {
  test('shows Invite Member button for org admins', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization');

    // Wait for page to load
    await expect(orgAdminPage.getByText(/Members/i).first()).toBeVisible({ timeout: 10000 });

    // Invite Member button should be visible for admins
    await expect(orgAdminPage.getByRole('button', { name: /Invite Member/i })).toBeVisible();
  });

  test('opens invite modal when clicking Invite Member', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization');
    await expect(orgAdminPage.getByText(/Members/i).first()).toBeVisible({ timeout: 10000 });

    await orgAdminPage.getByRole('button', { name: /Invite Member/i }).click();

    // Modal should open with title
    await expect(orgAdminPage.getByText('Invite Team Member')).toBeVisible();

    // Email input should be present
    await expect(orgAdminPage.getByLabel('Email address')).toBeVisible();

    // Role selector should be present
    await expect(orgAdminPage.getByLabel('Role')).toBeVisible();

    // Send Invitation button should be present
    await expect(orgAdminPage.getByRole('button', { name: /Send Invitation/i })).toBeVisible();
  });

  test('disables Send Invitation button when email is empty', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization');
    await expect(orgAdminPage.getByText(/Members/i).first()).toBeVisible({ timeout: 10000 });

    await orgAdminPage.getByRole('button', { name: /Invite Member/i }).click();
    await expect(orgAdminPage.getByText('Invite Team Member')).toBeVisible();

    // Button should be disabled when email is empty
    const sendBtn = orgAdminPage.getByRole('button', { name: /Send Invitation/i });
    await expect(sendBtn).toBeDisabled();
  });

  test('shows validation error for invalid email', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization');
    await expect(orgAdminPage.getByText(/Members/i).first()).toBeVisible({ timeout: 10000 });

    await orgAdminPage.getByRole('button', { name: /Invite Member/i }).click();
    await expect(orgAdminPage.getByText('Invite Team Member')).toBeVisible();

    // Type invalid email
    await orgAdminPage.getByLabel('Email address').fill('not-an-email');

    // Submit
    await orgAdminPage.getByRole('button', { name: /Send Invitation/i }).click();

    // Should show validation error
    await expect(orgAdminPage.getByText(/valid email/i)).toBeVisible();
  });

  test('enables Send Invitation button when email is entered', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization');
    await expect(orgAdminPage.getByText(/Members/i).first()).toBeVisible({ timeout: 10000 });

    await orgAdminPage.getByRole('button', { name: /Invite Member/i }).click();
    await expect(orgAdminPage.getByText('Invite Team Member')).toBeVisible();

    // Type valid email
    await orgAdminPage.getByLabel('Email address').fill('newmember@example.com');

    // Button should become enabled
    const sendBtn = orgAdminPage.getByRole('button', { name: /Send Invitation/i });
    await expect(sendBtn).toBeEnabled();
  });

  test('can select Admin role in role dropdown', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization');
    await expect(orgAdminPage.getByText(/Members/i).first()).toBeVisible({ timeout: 10000 });

    await orgAdminPage.getByRole('button', { name: /Invite Member/i }).click();
    await expect(orgAdminPage.getByText('Invite Team Member')).toBeVisible();

    // Click role selector trigger
    await orgAdminPage.getByLabel('Role').click();

    // Admin option should be available
    await expect(orgAdminPage.getByText('Admin').first()).toBeVisible();
    await expect(orgAdminPage.getByText('Member').first()).toBeVisible();
  });

  test('closes modal when Cancel is clicked', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization');
    await expect(orgAdminPage.getByText(/Members/i).first()).toBeVisible({ timeout: 10000 });

    await orgAdminPage.getByRole('button', { name: /Invite Member/i }).click();
    await expect(orgAdminPage.getByText('Invite Team Member')).toBeVisible();

    // Click Cancel
    await orgAdminPage.getByRole('button', { name: /Cancel/i }).click();

    // Modal should close
    await expect(orgAdminPage.getByText('Invite Team Member')).not.toBeVisible();
  });

  test('modal resets form when reopened', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization');
    await expect(orgAdminPage.getByText(/Members/i).first()).toBeVisible({ timeout: 10000 });

    // Open modal, type email, then cancel
    await orgAdminPage.getByRole('button', { name: /Invite Member/i }).click();
    await expect(orgAdminPage.getByText('Invite Team Member')).toBeVisible();
    await orgAdminPage.getByLabel('Email address').fill('test@example.com');
    await orgAdminPage.getByRole('button', { name: /Cancel/i }).click();

    // Reopen modal — email should be cleared
    await orgAdminPage.getByRole('button', { name: /Invite Member/i }).click();
    await expect(orgAdminPage.getByText('Invite Team Member')).toBeVisible();
    await expect(orgAdminPage.getByLabel('Email address')).toHaveValue('');
  });
});
