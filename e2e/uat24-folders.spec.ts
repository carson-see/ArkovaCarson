import { expect, test } from '@playwright/test';
import path from 'node:path';

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
  test(`${viewport.width}px folder controls remain actionable`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/e2e/fixtures/uat24-folders.html');
    await page.getByRole('button', { name: 'Legal', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Selected: legal')).toBeVisible();
    await page.getByRole('button', { name: 'My org-context folder' }).click();
    await expect(page.getByText('You and authorized organization or platform administrators can access this folder.')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: path.join('docs/staging/uat24-completion-20260919/screenshots', `folder-privacy-${viewport.width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Move 2 records' }).click();
    await expect(page.getByRole('dialog', { name: 'Move to Folder' })).toBeVisible();
    await page.getByRole('button', { name: /Signed agreements/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    const body = await page.locator('body').evaluate((el) => ({ scroll: el.scrollWidth, width: el.clientWidth, offenders: [...el.querySelectorAll('*')].filter((node) => node.getBoundingClientRect().right > innerWidth + 1).slice(0, 5).map((node) => `${node.tagName}.${node.className}`) }));
    expect(body.offenders, JSON.stringify(body)).toEqual([]);
    expect(body.scroll).toBeLessThanOrEqual(body.width);
    await page.screenshot({ path: path.join('docs/staging/uat24-completion-20260919/screenshots', `folders-${viewport.width}.png`), fullPage: true });
  });
}
