import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Regenerates docs/screenshots/*.png against the fixture environment (see e2e/run.sh).
// The server runs with QM_VISIBLE_SCOPE=qmtest-*, so only fixture resources can appear.
const PASSWORD = 'Demo-Passw0rd-123!';
const dataDir = process.env['E2E_DATA_DIR'] ?? '';
const out = (name: string): string => path.resolve(import.meta.dirname, '../docs/screenshots', name);

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200); // charts / live badges
}

test.describe.configure({ mode: 'serial' });

test('capture', async ({ page }) => {
  await page.goto('/');
  const token = readFileSync(path.join(dataDir, 'setup-token'), 'utf8').trim();
  await page.getByLabel('Setup token').fill(token);
  await page.getByLabel('Administrator username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat password').fill(PASSWORD);
  await page.getByRole('button', { name: /create|set up|finish/i }).click();
  await expect(page.getByRole('link', { name: 'Containers' }).first()).toBeVisible();

  // plan (dry run) first: the update it describes is then rolled out so history has content
  await page.goto('/maintenance/plan');
  await page.getByLabel('Project').selectOption('qmtest-upd');
  await page.getByRole('button', { name: 'Create dry-run plan' }).click();
  await expect(page.getByRole('button', { name: /Prepare run for approval/ })).toBeEnabled();
  await settle(page);
  await page.screenshot({ path: out('maintenance-plan.png'), fullPage: true });

  await page.getByRole('button', { name: /Prepare run for approval/ }).click();
  const dlg = page.getByRole('dialog');
  if (await dlg.getByRole('textbox').count()) await dlg.getByRole('textbox').fill('qmtest-upd');
  await dlg.getByRole('button', { name: 'Prepare run' }).click();
  await page.goto('/maintenance/approvals');
  await page.getByRole('cell', { name: 'qmtest-upd', exact: true }).first().click();
  await settle(page);
  await page.screenshot({ path: out('maintenance-approval.png'), fullPage: true });
  await page.getByRole('button', { name: /^Approve/ }).click();
  const dlg2 = page.getByRole('dialog');
  if (await dlg2.getByRole('textbox').count()) await dlg2.getByRole('textbox').fill('qmtest-upd');
  await dlg2.getByRole('button', { name: 'Approve and run' }).click();
  await expect(page.getByText(/Updated \d+ service|completed/i).first()).toBeVisible({ timeout: 150_000 });

  await page.goto('/');
  await page.waitForTimeout(75_000); // the charts use 1-minute roll-ups: wait for the first ones
  await settle(page);
  await page.screenshot({ path: out('dashboard.png') });

  await page.goto('/containers');
  await settle(page);
  await page.screenshot({ path: out('containers.png') });

  await page.getByText('qmtest-multi-app-1').first().click();
  await settle(page);
  await page.screenshot({ path: out('container-detail.png'), fullPage: true });
  await page.goto('/containers');
  await page.getByText('qmtest-standalone').first().click();
  await page.getByRole('tab', { name: /logs/i }).click();
  await settle(page);
  await page.screenshot({ path: out('container-logs.png') });

  await page.goto('/compose/qmtest-multi');
  await settle(page);
  await page.screenshot({ path: out('compose-project.png'), fullPage: true });

  await page.goto('/images');
  await settle(page);
  await page.screenshot({ path: out('images.png') });

  await page.goto('/maintenance/runs');
  await settle(page);
  await page.screenshot({ path: out('run-history.png') });

  await page.goto('/settings');
  await settle(page);
  await page.screenshot({ path: out('settings.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/containers');
  await settle(page);
  await page.screenshot({ path: out('mobile-containers.png') });
});
