import { expect, type Page } from '@playwright/test';

const dashboardUrl = /\/dashboard(?:\?|$)/;

export async function acceptDisclaimerIfVisible(page: Page): Promise<void> {
  const acceptButton = page.getByRole('button', { name: /I Understand and Accept/i });
  if (await acceptButton.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await acceptButton.click();
    await expect(acceptButton).toBeHidden({ timeout: 5_000 });
    await waitForBlockingOverlayToClose(page);
  }
}

async function waitForBlockingOverlayToClose(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !Array.from(document.querySelectorAll('div[data-state="open"][aria-hidden="true"]'))
      .some((el) => {
        const style = window.getComputedStyle(el);
        return style.position === 'fixed' && style.pointerEvents !== 'none';
      }),
    undefined,
    { timeout: 10_000 },
  );
}

export async function openDashboard(page: Page): Promise<void> {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(dashboardUrl, { timeout: 15_000 });
  await acceptDisclaimerIfVisible(page);
  await expect(page.locator('#main-content')).toContainText(
    /Total Records|My Records|Monthly Usage|Organization/i,
    { timeout: 15_000 },
  );
}

export async function openSecureDocumentDialog(page: Page): Promise<void> {
  await openDashboard(page);

  const secureButton = getSecureDocumentButton(page);
  await expect(secureButton).toBeVisible({ timeout: 15_000 });
  await expect(secureButton).toBeEnabled();
  await secureButton.click();

  await expect(getSecureDocumentDialog(page)).toBeVisible({ timeout: 10_000 });
}

export async function expectSecureDocumentUploadStep(page: Page): Promise<void> {
  await expect(
    getSecureDocumentDialog(page).getByText(/Drag and drop/i).first()
  ).toBeVisible({ timeout: 10_000 });
}

export function getSecureDocumentButton(page: Page) {
  return page.locator('button').filter({ hasText: /Secure Document/i }).first();
}

export function getSecureDocumentDialog(page: Page) {
  return page.locator('[role="dialog"]').filter({ hasText: /Secure Document/i }).first();
}
