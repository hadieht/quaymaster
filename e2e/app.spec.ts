import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'E2e-Passw0rd-123!';
const dataDir = process.env['E2E_DATA_DIR'] ?? '';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Containers' }).first()).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('first-run setup, logout, wrong password, login', async ({ page }) => {
  await page.goto('/');
  const token = readFileSync(path.join(dataDir, 'setup-token'), 'utf8').trim();
  await page.getByLabel('Setup token').fill(token);
  await page.getByLabel('Administrator username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat password').fill(PASSWORD);
  await page.getByRole('button', { name: /create|set up|finish/i }).click();
  await expect(page.getByRole('link', { name: 'Containers' }).first()).toBeVisible();

  await page
    .getByRole('button', { name: /sign out|log out|logout/i })
    .first()
    .click();
  await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();

  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('wrong-password-xyz');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText(/invalid|incorrect|wrong/i).first()).toBeVisible();

  await login(page);
});

test('dashboard shows fixture data only', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.locator('main')).toContainText(/qmtest|container/i);
});

test('containers list, detail and logs', async ({ page }) => {
  await login(page);
  await page.goto('/containers');
  await expect(page.getByText('qmtest-single-solo-1').first()).toBeVisible();
  await page.getByText('qmtest-multi-app-1').first().click();
  await expect(page).toHaveURL(/\/containers\//);
  await expect(page.getByText('qmtest-multi-app-1').first()).toBeVisible();
  await page.getByRole('tab', { name: /logs/i }).click();
  await expect(page.getByRole('tabpanel')).toBeVisible();
});

test('compose projects and project detail', async ({ page }) => {
  await login(page);
  await page.goto('/compose');
  await expect(page.getByText('qmtest-multi').first()).toBeVisible();
  await page.goto('/compose/qmtest-multi');
  await expect(page.getByText(/db|app|worker/).first()).toBeVisible();
});

test('images', async ({ page }) => {
  await login(page);
  await page.goto('/images');
  await expect(page.getByRole('heading', { name: /images/i }).first()).toBeVisible();
  await expect(page.locator('main')).toContainText(/alpine|qmtest/);
});

test('volumes and networks', async ({ page }) => {
  await login(page);
  await page.goto('/storage');
  await expect(page.locator('main')).toContainText(/qmtest/);
});

test('logs and events', async ({ page }) => {
  await login(page);
  await page.goto('/logs');
  await expect(page.getByRole('heading', { name: /logs|events/i }).first()).toBeVisible();
});

test('settings', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});

test('full update flow: dry run, prepare, approve, run succeeds', async ({ page }) => {
  await login(page);
  await page.goto('/maintenance/plan');
  await page.getByLabel('Project').selectOption('qmtest-upd');
  await page.getByRole('button', { name: 'Create dry-run plan' }).click();
  await expect(page.getByRole('button', { name: /Prepare run for approval/ })).toBeEnabled();
  await page.getByRole('button', { name: /Prepare run for approval/ }).click();
  const dlg = page.getByRole('dialog');
  const typed = dlg.getByRole('textbox');
  if (await typed.count()) await typed.fill('qmtest-upd');
  await dlg.getByRole('button', { name: 'Prepare run' }).click();

  await page.goto('/maintenance/approvals');
  await page.getByRole('cell', { name: 'qmtest-upd', exact: true }).first().click();
  await page.getByRole('button', { name: /^Approve/ }).click();
  const dlg2 = page.getByRole('dialog');
  const typed2 = dlg2.getByRole('textbox');
  if (await typed2.count()) await typed2.fill('qmtest-upd');
  await dlg2.getByRole('button', { name: 'Approve and run' }).click();

  await expect(page.getByText(/completed|succeeded|updated/i).first()).toBeVisible({ timeout: 150_000 });
  await page.goto('/maintenance/runs');
  await expect(page.getByText('qmtest-upd').first()).toBeVisible();
});
