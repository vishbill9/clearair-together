import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function view(page: Page, name: string) {
  await page.evaluate((v) => {
    location.hash = `#/${v}`;
  }, name);
  await expect(page.locator(`#view-${name}`)).toBeVisible();
}

async function setLocation(page: Page, lat: string, lng: string) {
  await page.getByLabel('Latitude').fill(lat);
  const off = test.info().project.name === 'mobile' ? 1 : 0; // separate cache key per project
  await page.getByLabel('Longitude').fill(String(Number(lng) + off));
  await page.getByRole('button', { name: 'Check air quality' }).click();
}

test('shows real-data status with provenance and freshness', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'ClearAir Together, home' })).toBeVisible();
  await expect(page.getByText('Enter a location to see current air quality.')).toBeVisible();
  await setLocation(page, '21.5', '77.21');
  await expect(page.locator('#fresh-badge')).toHaveText('Live');
  await expect(page.locator('#source-badge')).toHaveText('Source: Google Air Quality API');
  await expect(page.locator('#prov')).toContainText('2026-11-26T08:00:00.000Z');
  await expect(page.locator('#indexes')).toContainText('Universal AQI: 42');
  await expect(page.locator('#pollutants')).toContainText('71.2 µg/m³');
  await setLocation(page, '21.5', '77.21');
  await expect(page.locator('#fresh-badge')).toHaveText('Recent (cached)');
});

test('shows an honest unavailable state with no numbers when the provider is down', async ({ page }) => {
  await page.goto('/');
  await setLocation(page, '0.01', '10');
  await expect(page.locator('#fresh-badge')).toHaveText('Unavailable');
  await expect(page.locator('#status-headline')).toHaveText('No reading available');
  await expect(page.locator('#status-reason')).toContainText('temporarily unavailable');
  await expect(page.locator('#indexes')).toContainText('No index values to show.');
  await expect(page.locator('#column')).toHaveClass(/none/);
});

test('validates the location form', async ({ page }) => {
  await page.goto('/');
  await setLocation(page, '123', '10');
  await expect(page.locator('#loc-error')).toContainText('latitude between -90 and 90');
});

test('household, daily plan, feedback, routine comparison with separate columns', async ({ page }) => {
  await page.goto('/');
  await setLocation(page, '23.5', '77.21');
  await expect(page.locator('#fresh-badge')).toHaveText('Live');
  await view(page, 'household');
  await page.getByLabel('A child lives here').check();
  await page.getByLabel('Usual commute').selectOption('car');
  await page.getByLabel('I can work from home').check();
  await page.getByRole('button', { name: 'Save household' }).click();
  await expect(page.locator('#house-msg')).toHaveText('Household saved.');
  await view(page, 'today');
  await page.getByRole('button', { name: 'Build today’s plan' }).click();
  await expect(page.locator('#plan-items li').first()).toBeVisible();
  await expect(page.locator('#quick-wins')).toContainText('Use the exhaust fan');
  await expect(page.locator('#plan-note')).toContainText('general guidance');
  const first = page.locator('#quick-wins li').first();
  await first.getByRole('button', { name: 'Helpful', exact: true }).click();
  await expect(first.getByRole('status')).toHaveText('Saved.');

  await view(page, 'routines');
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  const table = page.locator('#compare-tbl');
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Your exposure' })).toBeAttached();
  await expect(table.getByRole('columnheader', { name: 'Emissions' })).toBeAttached();
  await expect(table).toContainText('Walk');
});

test('assistant answers with structure, emergency wording bypasses the model', async ({ page }) => {
  await page.goto('/');
  await setLocation(page, '24.5', '77.21');
  await view(page, 'ask');
  await page.getByLabel('Your question').fill('Should I run outside tomorrow?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const bot = page.locator('.msg.bot').last();
  await expect(bot).toContainText('Consider moving a long run');
  await expect(bot).toContainText('Exposure:');
  await expect(bot).toContainText('Emissions:');
  await expect(bot).toContainText('general guidance');
  await page.getByLabel('Your question').fill("I can't breathe and have chest pain");
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.msg.emergency')).toContainText('not an emergency service');
});

test('community challenge hides counts below k=5', async ({ page }) => {
  await page.goto('/#/community');
  await page.getByRole('button', { name: 'Start a challenge' }).click();
  await expect(page.locator('#chal-count')).toContainText('Fewer than 5');
  await expect(page.locator('#chal-actions')).toContainText('once at least 5 people take part');
});

test('keeps server keys out of the browser', async ({ page }) => {
  const responses: string[] = [];
  page.on('response', async (r) => {
    try {
      responses.push(await r.text());
    } catch {
      /* binary */
    }
  });
  await page.goto('/');
  await setLocation(page, '26.5', '77.21');
  await expect(page.locator('#fresh-badge')).toHaveText('Live');
  const all = responses.join('\n') + (await page.content());
  for (const secret of ['e2e-google', 'e2e-anthropic', 'e2e-gemini', 'e2e-secret'])
    expect(all).not.toContain(secret);
  const headers = await page.request.get('/health');
  expect(headers.headers()['content-security-policy']).toContain("script-src 'self'");
});

test('accessibility smoke: no serious or critical axe violations', async ({ page }) => {
  await page.goto('/');
  await setLocation(page, '27.5', '77.21');
  await expect(page.locator('#fresh-badge')).toHaveText('Live');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});

test('keyboard: skip link and logical focus order reach the main controls', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Latitude')).toBeFocused();
});

test('no horizontal scroll at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');
  await setLocation(page, '28.5', '77.21');
  await expect(page.locator('#fresh-badge')).toHaveText('Live');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test('sign up, see the account menu, sign out and back in', async ({ page }) => {
  const email = `e2e-${test.info().project.name}-${Date.now()}@example.com`;
  await page.goto('/');
  await page.locator('#account-btn').click();
  await page.getByRole('menuitem', { name: 'Create account' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('First name (optional)').fill('Asha');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a long passphrase 1');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.locator('#account-btn').click();
  await expect(page.locator('#account-who')).toContainText(email);
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.locator('#account-btn').click();
  await page.getByRole('menuitem', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('wrong passphrase 1');
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await expect(page.locator('#auth-error')).toContainText('do not match');
  await page.getByLabel('Password').fill('a long passphrase 1');
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('menu switches views and the sky follows the verified category', async ({ page }) => {
  await page.goto('/');
  await setLocation(page, '29.5', '77.21');
  await expect(page.locator('#fresh-badge')).toHaveText('Live');
  await expect(page.locator('body')).not.toHaveAttribute('data-sky', 'none');
  await expect(page.locator('#hero-title')).not.toHaveText('Where are you breathing today?');
  await view(page, 'ask');
  await expect(page.getByRole('heading', { name: 'Ask or talk to ClearAir' })).toBeVisible();
  await page.locator('.chip[data-q]').first().click();
  await expect(page.locator('.msg.user').last()).toContainText('exercise');
});

test('Google sign-in button is hidden when the server is not configured', async ({ page }) => {
  await page.goto('/');
  await page.locator('#account-btn').click();
  await page.getByRole('menuitem', { name: 'Sign in' }).click();
  await expect(page.locator('#google-btn')).toBeHidden();
});

test('an OAuth error redirect opens the sign-in dialog with a plain message', async ({ page }) => {
  await page.goto('/?auth_error=google_denied#/today');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#auth-error')).toContainText('cancelled');
  await expect(page).toHaveURL(/\/#\/today$/);
});

test('plants: filter by light and pets, and chat is off without a Gemini model', async ({ page }) => {
  await page.goto('/#/indoor');
  const cards = page.locator('#plant-grid li');
  await expect(cards.first()).toBeVisible();
  const all = await cards.count();
  await page.locator('#plant-pets').check();
  const safe = await cards.count();
  expect(safe).toBeGreaterThan(0);
  expect(safe).toBeLessThan(all);
  await expect(page.locator('#plant-grid .tag.warn')).toHaveCount(0);
  await page.locator('#plant-light').selectOption('bright');
  await expect(page.locator('#plant-count')).toContainText('suit');
  await expect(page.locator('#plant-note')).toContainText('very little');
  await expect(page.locator('#plantchat-off')).toBeVisible();
});
