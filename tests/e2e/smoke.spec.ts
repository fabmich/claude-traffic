import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const url = 'file://' + path.resolve('dist/index.html');

type G = { __game: any };

async function startGame(page: Page, errors: string[], opts: { seed?: number; sandbox?: boolean } = {}): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url);
  if (opts.seed !== undefined) await page.fill('input.seed', String(opts.seed));
  if (opts.sandbox) await page.click('text=Sandbox');
  await page.getByText('Start building').click();
  await page.waitForFunction(() => (window as unknown as G).__game?.world != null);
}

/** Finds a square block of land and centres the camera on it. Returns its top-left tile. */
async function prepareFlatArea(page: Page, size: number): Promise<[number, number]> {
  const pos = await page.evaluate((size) => {
    const m = (window as unknown as G).__game.world.map;
    const ok = (x: number, y: number) => m.terrain[y * m.w + x] !== 3 && m.terrain[y * m.w + x] !== 4;
    let best: [number, number] | null = null;
    let bd = 1e9;
    for (let y = 2; y + size < m.h - 2; y++)
      for (let x = 2; x + size < m.w - 2; x++) {
        const d = Math.hypot(x - m.w / 2, y - m.h / 2);
        if (d >= bd) continue;
        let good = true;
        for (let yy = y; yy < y + size && good; yy++) for (let xx = x; xx < x + size; xx++) if (!ok(xx, yy)) good = false;
        if (good) {
          bd = d;
          best = [x, y];
        }
      }
    return best;
  }, size);
  expect(pos).not.toBeNull();
  await page.evaluate(
    ([x, y, size]) => {
      const c = (window as unknown as G).__game.renderer.camera;
      c.x = (x + size / 2) * 24;
      c.y = (y + size / 2) * 24;
      c.setZoom(Math.min(c.viewW, c.viewH - 250) / ((size + 2) * 24));
    },
    [pos![0], pos![1], size],
  );
  await page.waitForTimeout(300);
  return pos!;
}

async function screenOf(page: Page, tx: number, ty: number): Promise<[number, number]> {
  return page.evaluate(([tx, ty]) => {
    const c = (window as unknown as G).__game.renderer.camera;
    return [c.worldToScreenX((tx + 0.5) * 24), c.worldToScreenY((ty + 0.5) * 24)] as [number, number];
  }, [tx, ty]);
}

async function dragTiles(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const [x0, y0] = await screenOf(page, ...from);
  const [x1, y1] = await screenOf(page, ...to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 12 });
  await page.mouse.up();
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

test('building a crossroads with the mouse creates a junction and costs money', async ({ page }) => {
  const errors: string[] = [];
  await startGame(page, errors, { seed: 4242 });
  const [x, y] = await prepareFlatArea(page, 14);
  const money0 = await page.evaluate(() => (window as unknown as G).__game.world.money as number);
  await page.keyboard.press('r');
  await dragTiles(page, [x + 1, y + 7], [x + 13, y + 7]);
  await dragTiles(page, [x + 7, y + 1], [x + 7, y + 13]);
  const info = await page.evaluate(([cx, cy]) => {
    const w = (window as unknown as G).__game.world;
    const node = w.network.nodeByTile.get(cy * w.map.w + cx);
    return { arms: node ? node.arms.length : 0, connectors: node ? node.connectors.length : 0, money: w.money as number };
  }, [x + 7, y + 7]);
  expect(info.arms).toBe(4);
  expect(info.connectors).toBe(12);
  expect(info.money).toBeLessThan(money0);
  await page.keyboard.press('b');
  await dragTiles(page, [x + 12, y + 7], [x + 13, y + 7]);
  const after = await page.evaluate(() => (window as unknown as G).__game.world.money as number);
  expect(after).toBeGreaterThan(info.money);
  expect(errors).toEqual([]);
});

test('junction editor: traffic lights and lane manager work from the UI', async ({ page }) => {
  const errors: string[] = [];
  await startGame(page, errors, { seed: 4242, sandbox: true });
  const [x, y] = await prepareFlatArea(page, 14);
  await page.keyboard.press('r');
  await page.locator('.subtoolbar .tool-btn', { hasText: 'Avenue' }).click();
  await dragTiles(page, [x + 1, y + 7], [x + 13, y + 7]);
  await dragTiles(page, [x + 7, y + 1], [x + 7, y + 13]);
  await page.keyboard.press('Escape');
  const [jx, jy] = await screenOf(page, x + 7, y + 7);
  await page.mouse.click(jx, jy);
  await expect(page.locator('.side-panel h3')).toContainText('Junction');
  await page.locator('.side-panel .seg', { hasText: 'Lights' }).click();
  const kind = await page.evaluate(([cx, cy]) => {
    const w = (window as unknown as G).__game.world;
    const node = w.network.nodeByTile.get(cy * w.map.w + cx);
    return w.traffic.control(node).kind as string;
  }, [x + 7, y + 7]);
  expect(kind).toBe('signals');
  await expect(page.locator('.phase')).toHaveCount(2);
  // Turn off the first arrow of the first lane in the lane manager.
  const outsBefore = await page.evaluate(() => (window as unknown as G).__game.world.network.connectors.length as number);
  await page.locator('.lane-manager .chip.on').first().click();
  const outsAfter = await page.evaluate(() => (window as unknown as G).__game.world.network.connectors.length as number);
  expect(outsAfter).toBeLessThan(outsBefore);
  expect(errors).toEqual([]);
});

test('zoning near a road from the highway grows a town', async ({ page }) => {
  const errors: string[] = [];
  // Seed 8 has open land next to its first highway exit.
  await startGame(page, errors, { seed: 8 });
  const exit = await page.evaluate(() => {
    const m = (window as unknown as G).__game.world.map;
    const DX = [1, 1, 0, -1, -1, -1, 0, 1];
    const DY = [0, 1, 1, 1, 0, -1, -1, -1];
    const oc = m.outside[0];
    return { x: oc.x + DX[oc.dir] * oc.length, y: oc.y + DY[oc.dir] * oc.length, dx: DX[oc.dir], dy: DY[oc.dir] };
  });
  const at = (k: number, side: number): [number, number] => [exit.x + exit.dx * k - exit.dy * side, exit.y + exit.dy * k + exit.dx * side];
  await page.evaluate(
    ([x, y]) => {
      const c = (window as unknown as G).__game.renderer.camera;
      c.x = (x + 0.5) * 24;
      c.y = (y + 0.5) * 24;
      c.setZoom(Math.min(c.viewW, c.viewH - 250) / (18 * 24));
    },
    at(6, 0),
  );
  await page.waitForTimeout(300);
  await page.keyboard.press('r');
  await dragTiles(page, at(0, 0), at(12, 0));
  await page.keyboard.press('z');
  await expect(page.locator('.subtoolbar .tool-btn.active')).toContainText('Residential');
  await dragTiles(page, at(1, 1), at(11, 3));
  await page.locator('.subtoolbar .tool-btn', { hasText: 'Industrial' }).click();
  await dragTiles(page, at(1, -1), at(11, -3));
  const zoned = await page.evaluate(() => {
    const z = (window as unknown as G).__game.world.city.zones as Uint8Array;
    return { r: z.filter((v) => v === 1).length, i: z.filter((v) => v === 3).length };
  });
  expect(zoned.r).toBeGreaterThan(15);
  expect(zoned.i).toBeGreaterThan(15);
  await page.keyboard.press('Escape');
  const stats = await page.evaluate(() => {
    const w = (window as unknown as G).__game.world;
    let vehicles = 0;
    for (let i = 0; i < 1.5 * 10800; i++) {
      w.step(0.1);
      if (i % 100 === 0) vehicles = Math.max(vehicles, w.traffic.count);
    }
    const buildings = w.city.buildings.filter((b: { state: number } | null) => b && b.state === 1);
    return { pop: w.city.population as number, buildings: buildings.length as number, vehicles, first: buildings[0] ? [buildings[0].x0, buildings[0].y0] : null };
  });
  expect(stats.pop).toBeGreaterThan(20);
  expect(stats.buildings).toBeGreaterThan(5);
  expect(stats.vehicles).toBeGreaterThan(0);
  // Inspect a building and open the city panel.
  await page.evaluate(
    ([x, y]) => {
      const c = (window as unknown as G).__game.renderer.camera;
      c.x = (x + 0.5) * 24;
      c.y = (y + 0.5) * 24;
    },
    stats.first!,
  );
  await page.waitForTimeout(200);
  const [cx, cy] = await screenOf(page, stats.first![0], stats.first![1]);
  await page.mouse.click(cx, cy);
  await expect(page.locator('.side-panel .zone-tag')).toBeVisible();
  await page.keyboard.press('c');
  await expect(page.locator('.side-panel .tabs')).toBeVisible();
  await expect(page.locator('.demand-bar')).toHaveCount(4);
  expect(errors).toEqual([]);
});
