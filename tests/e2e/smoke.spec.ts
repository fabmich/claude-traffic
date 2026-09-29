import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const url = 'file://' + path.resolve('dist/index.html');

type G = { __game: any };

async function startGame(page: Page, errors: string[]): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url);
  await page.getByText('Start building').click();
  await page.waitForFunction(() => (window as unknown as G).__game?.world != null);
}

test('game loads, clock runs and pause freezes time', async ({ page }) => {
  const errors: string[] = [];
  await startGame(page, errors);
  const clock = () => page.evaluate(() => (window as unknown as G).__game.world.clock.time as number);
  const t0 = await clock();
  await page.waitForTimeout(800);
  expect(await clock()).toBeGreaterThan(t0);

  await page.keyboard.press('Space');
  const p0 = await clock();
  await page.waitForTimeout(600);
  expect(await clock()).toBe(p0);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  expect(await clock()).toBeGreaterThan(p0);
  expect(errors).toEqual([]);
});
