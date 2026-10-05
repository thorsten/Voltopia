import { expect, test, type Page } from '@playwright/test';

async function readTick(page: Page): Promise<number> {
  const text = await page.getByTestId('tick-counter').textContent();
  return Number(text?.replace(/\D/g, '') ?? '0');
}

/** Bounding box of a HUD island, or null when it is not on screen. */
async function rect(page: Page, testId: string) {
  const locator = page.getByTestId(testId);
  if ((await locator.count()) === 0) return null;
  return locator.first().boundingBox();
}

/** True when the environment has WebGL and the 3D canvas is present. */
async function has3dView(page: Page): Promise<boolean> {
  return (await page.locator('.game-view canvas').count()) > 0;
}

test.beforeEach(async ({ page }) => {
  // Keep the first-run tutorial out of unrelated tests (the tutorial
  // test opts back in via the e2eAllowTutorial marker).
  await page.addInitScript(() => {
    if (!localStorage.getItem('voltopia.e2eAllowTutorial')) {
      localStorage.setItem('voltopia.tutorialDone', '1');
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
});

test('tutorial guides brand-new games and can be skipped', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('voltopia.e2eAllowTutorial', '1');
    localStorage.removeItem('voltopia.tutorialDone');
  });
  await page.evaluate(() => indexedDB.deleteDatabase('voltopia'));
  await page.reload();
  await expect(page.getByTestId('tutorial')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('tutorial-next').click(); // welcome -> build a road
  await expect(page.getByTestId('tutorial')).toContainText('2');
  await page.getByTestId('tutorial-skip').click();
  await expect(page.getByTestId('tutorial')).toHaveCount(0);
  // Skipping is remembered.
  await page.reload();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('tutorial')).toHaveCount(0);
});

test('new-game dialog starts a fresh city with chosen difficulty', async ({ page }) => {
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('new-game-page')).toBeVisible();
  await page.getByTestId('size-48').click();
  await page.getByTestId('difficulty-hard').click();
  await page.getByTestId('seed-input').fill('gridtown');
  await page.getByTestId('start-city').click();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  // Hard difficulty: starting funds are 15,000.
  await expect(page.getByTestId('money')).toContainText('15,000');
});

test('settings page toggles persist', async ({ page }) => {
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await page.getByTestId('setting-shadows').click();
  await page.getByTestId('setting-sound').click();
  await page.reload();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('setting-shadows')).not.toBeChecked();
  await expect(page.getByTestId('setting-sound')).not.toBeChecked();
});

test('boots with a running simulation', async ({ page }) => {
  await expect(page).toHaveTitle(/Voltopia/);
  const before = await readTick(page);
  await expect.poll(async () => readTick(page), { timeout: 5_000 }).toBeGreaterThan(before);
  await expect(page.getByTestId('money')).toBeVisible();
  await expect(page.getByTestId('energy-panel')).toBeVisible();
  await expect(page.getByTestId('energy-hydro')).toBeVisible();
});

test('the HUD detail drawer toggles without moving the rest of the HUD', async ({ page }) => {
  // Open by default: the drawer holds the wide graph and the three sections.
  await expect(page.getByTestId('hud-drawer')).toBeVisible();
  await expect(page.getByTestId('energy-graph')).toBeVisible();
  await expect(page.getByTestId('detail-energy-solar')).toBeVisible();
  await expect(page.getByTestId('budget-panel')).toBeVisible();

  const before = await rect(page, 'goals-panel');
  const consoleBefore = await rect(page, 'hud-console');

  await page.getByTestId('hud-details-toggle').click();
  // Stays mounted so it can animate; hidden is the closed state.
  await expect(page.getByTestId('hud-drawer')).toBeHidden();
  // The condensed row and its sparkline stay, so the numbers and the shape
  // of the day are never fully gone.
  await expect(page.getByTestId('energy-hydro')).toBeVisible();
  await expect(page.getByTestId('energy-sparkline')).toBeVisible();

  // The drawer is an overlay: closing it must not resize or shift anything.
  expect(await rect(page, 'goals-panel')).toEqual(before);
  expect(await rect(page, 'hud-console')).toEqual(consoleBefore);

  await page.reload();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('hud-drawer')).toBeHidden();
});

test('HUD islands never overlap, down to a phone-sized window', async ({ page }) => {
  const ids = [
    'hud-vitals',
    'hud-console',
    'hud-controls',
    'goals-panel',
    'minimap',
    'overlay-toggle',
    'controls-hint',
    'toolbar',
    'select-tool',
    'open-help',
  ];
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 800, height: 600 },
    { width: 600, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(150);
    const boxes: Array<{ id: string; box: NonNullable<Awaited<ReturnType<typeof rect>>> }> = [];
    for (const id of ids) {
      const box = await rect(page, id);
      if (box) boxes.push({ id, box });
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlaps =
          a.box.x < b.box.x + b.box.width &&
          b.box.x < a.box.x + a.box.width &&
          a.box.y < b.box.y + b.box.height &&
          b.box.y < a.box.y + a.box.height;
        expect(overlaps, `${a.id} overlaps ${b.id} at ${size.width}x${size.height}`).toBe(false);
      }
    }
    // Nothing may hang off the edges either.
    for (const { id, box } of boxes) {
      expect(box.x, `${id} off the left edge at ${size.width}px`).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, `${id} off the right edge at ${size.width}px`).toBeLessThanOrEqual(
        size.width + 1,
      );
    }
  }
});

test('build menu shows every tool in one row when the window is wide', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-layout', 'row');
  await expect(page.getByTestId('build-category-energy')).toHaveCount(0);
  await expect(page.getByTestId('tool-road')).toBeVisible();
  await expect(page.getByTestId('tool-avenue')).toBeVisible();
  await expect(page.getByTestId('tool-plant-wind')).toBeVisible();
  await expect(page.getByTestId('tool-plant-park')).toBeVisible();
  await expect(page.getByTestId('tool-plant-fire')).toBeVisible();
  await expect(page.getByTestId('tool-plant-police')).toBeVisible();
  await expect(page.getByTestId('tool-plant-depot')).toBeVisible();
  await expect(page.getByTestId('tool-bus-stop')).toBeVisible();
  await expect(page.getByTestId('tool-plant-busdepot')).toBeVisible();
  await expect(page.getByTestId('tool-zone-industrial')).toBeVisible();
  await expect(page.getByTestId('demand-industrial')).toBeVisible();

  // Shrinking the window folds the row into tabs; growing unfolds it.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-layout', 'tabs');
  await expect(page.getByTestId('tool-plant-wind')).toHaveCount(0);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-layout', 'row');
});

test('build menu switches categories and explains its icons', async ({ page }) => {
  // Narrow enough that the menu folds into tabs.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-layout', 'tabs');
  // Basics is the category shown on load.
  await expect(page.getByTestId('tool-road')).toBeVisible();
  await expect(page.getByTestId('tool-plant-wind')).toHaveCount(0);

  await page.getByTestId('build-category-energy').click();
  const wind = page.getByTestId('tool-plant-wind');
  await expect(wind).toBeVisible();
  await expect(page.getByTestId('tool-road')).toHaveCount(0);

  // Icon-only buttons carry their name, cost and description in a tooltip.
  await wind.hover();
  await expect(wind.locator('.build-tooltip')).toBeVisible();
  await expect(wind.locator('.build-tooltip')).toContainText('1800');

  // A hotkey for a tool in another category brings that category forward.
  await page.keyboard.press('2'); // road
  await expect(page.getByTestId('tool-road')).toHaveClass(/active/);
});

test('pause stops the simulation, play resumes it', async ({ page }) => {
  await page.getByTestId('speed-0').click();
  // The paused state itself must reach the HUD: no tick reports it.
  await expect(page.getByTestId('speed-0')).toHaveClass(/active/);
  await expect(page.getByTestId('speed-1')).not.toHaveClass(/active/);
  await page.waitForTimeout(400);
  const paused = await readTick(page);
  await page.waitForTimeout(800);
  expect(await readTick(page)).toBe(paused);
  await page.getByTestId('speed-3').click();
  await expect.poll(async () => readTick(page), { timeout: 5_000 }).toBeGreaterThan(paused);
  await expect(page.getByTestId('speed-3')).toHaveClass(/active/);
});

test('Escape deselects the inspected tile and closes the inspector (needs WebGL)', async ({
  page,
}) => {
  test.skip(!(await has3dView(page)), 'WebGL not available in this environment');
  await page.getByTestId('hud-details-toggle').click();
  await expect(page.getByTestId('hud-drawer')).toBeHidden();

  await page.getByTestId('tool-select').click();
  const canvas = page.locator('.game-view canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('tile-inspector')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tile-inspector')).toHaveCount(0);
});

test('tax slider, smart charging and demand response are interactive', async ({ page }) => {
  const slider = page.getByTestId('tax-slider').locator('input');
  await slider.fill('25');
  await expect(page.getByTestId('tax-slider')).toContainText('25%');

  // The checkbox is controlled by worker stats, so the checked state
  // only flips with the next tick event — click and poll.
  const smartCharging = page.getByTestId('smart-charging').locator('input');
  await smartCharging.click();
  await expect(smartCharging).toBeChecked({ timeout: 5_000 });

  const demandResponse = page.getByTestId('demand-response').locator('input');
  await demandResponse.click();
  await expect(demandResponse).toBeChecked({ timeout: 5_000 });
});

test('overlay toggle switches modes', async ({ page }) => {
  await page.getByTestId('overlay-supply').click();
  await expect(page.getByTestId('overlay-supply')).toHaveClass(/active/);
  await page.getByTestId('overlay-services').click();
  await expect(page.getByTestId('overlay-services')).toHaveClass(/active/);
  await page.getByTestId('overlay-traffic').click();
  await expect(page.getByTestId('overlay-traffic')).toHaveClass(/active/);
  await page.getByTestId('overlay-deliveries').click();
  await expect(page.getByTestId('overlay-deliveries')).toHaveClass(/active/);
  await page.getByTestId('overlay-transit').click();
  await expect(page.getByTestId('overlay-transit')).toHaveClass(/active/);
  await page.getByTestId('overlay-off').click();
  await expect(page.getByTestId('overlay-off')).toHaveClass(/active/);
});

test('game state persists across a reload', async ({ page }) => {
  await page.getByTestId('speed-3').click();
  await expect.poll(async () => readTick(page), { timeout: 10_000 }).toBeGreaterThan(20);
  const beforeSave = await readTick(page);
  await page.keyboard.press('Control+s'); // quick-save
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  expect(await readTick(page)).toBeGreaterThanOrEqual(beforeSave);
});

test('autosave persists without the quick-save key', async ({ page }) => {
  await page.getByTestId('speed-3').click();
  // Wait past the autosave interval (10s) so a periodic save must fire.
  await page.waitForTimeout(11_500);
  const beforeReload = await readTick(page);
  expect(beforeReload).toBeGreaterThan(50);
  await page.reload();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  // The reloaded city continues from a recent snapshot, not from zero.
  expect(await readTick(page)).toBeGreaterThan(beforeReload / 2);
});

test('help and imprint pages work in both languages', async ({ page }) => {
  // Default (non-German browser) is English.
  await page.getByTestId('open-help').click();
  await expect(page.getByTestId('help-page')).toBeVisible();
  await expect(page.getByTestId('help-page')).toContainText('Goal');
  await page.getByTestId('help-page').getByRole('button').click(); // close
  await expect(page.getByTestId('help-page')).toHaveCount(0);

  // Switch to German: UI translates immediately.
  await page.getByTestId('language-de').click();
  await expect(page.getByTestId('tool-road')).toContainText('Straße');
  await page.getByTestId('open-help').click();
  await expect(page.getByTestId('help-page')).toContainText('Ziel');
  await page.getByTestId('help-page').getByRole('button').click();

  await page.getByTestId('open-imprint').click();
  await expect(page.getByTestId('imprint-page')).toContainText('Thorsten Rinne');
  await expect(page.getByTestId('imprint-page')).toContainText('Impressum');

  // The chosen language survives a reload.
  await page.reload();
  await expect(page.getByTestId('tool-road')).toContainText('Straße', {
    timeout: 15_000,
  });
});

test('building a road costs money (needs WebGL)', async ({ page }) => {
  test.skip(!(await has3dView(page)), 'WebGL not available in this environment');

  const moneyText = async (): Promise<number> => {
    const text = await page.getByTestId('money').textContent();
    return Number(text?.replace(/[^\d]/g, '') ?? '0');
  };
  const before = await moneyText();

  // Collapse the detail drawer: it overlays the middle of the map, and how
  // far down it reaches depends on its content.
  await page.getByTestId('hud-details-toggle').click();
  await expect(page.getByTestId('hud-drawer')).toBeHidden();

  await page.getByTestId('tool-road').click();
  const canvas = page.locator('.game-view canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  // Between the collapsed console and the build bar, clear of both rails.
  const consoleBox = await rect(page, 'hud-console');
  const buildBox = await rect(page, 'toolbar');
  if (!consoleBox || !buildBox) throw new Error('HUD not ready');
  const centerX = box.x + box.width / 2;
  const dragY = (consoleBox.y + consoleBox.height + buildBox.y) / 2;
  await page.mouse.move(centerX - 60, dragY);
  await page.mouse.down();
  await page.mouse.move(centerX + 60, dragY, { steps: 8 });
  await page.mouse.up();

  await expect.poll(moneyText, { timeout: 5_000 }).toBeLessThan(before);
});

test('drawing a power line costs money (needs WebGL)', async ({ page }) => {
  test.skip(!(await has3dView(page)), 'WebGL not available in this environment');

  const moneyText = async (): Promise<number> => {
    const text = await page.getByTestId('money').textContent();
    return Number(text?.replace(/[^\d]/g, '') ?? '0');
  };
  const before = await moneyText();

  // Same as the road test: the open drawer overlays the middle of the map.
  await page.getByTestId('hud-details-toggle').click();
  await expect(page.getByTestId('hud-drawer')).toBeHidden();

  await page.getByTestId('tool-power-line').click();
  const canvas = page.locator('.game-view canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const consoleBox = await rect(page, 'hud-console');
  const buildBox = await rect(page, 'toolbar');
  if (!consoleBox || !buildBox) throw new Error('HUD not ready');
  const centerX = box.x + box.width / 2;
  const dragY = (consoleBox.y + consoleBox.height + buildBox.y) / 2;
  await page.mouse.move(centerX - 60, dragY);
  await page.mouse.down();
  await page.mouse.move(centerX + 60, dragY, { steps: 8 });
  await page.mouse.up();

  await expect.poll(moneyText, { timeout: 5_000 }).toBeLessThan(before);
});

test('the HUD shows the season and a fresh city starts in spring', async ({ page }) => {
  const season = page.getByTestId('season');
  await expect(season).toBeVisible();
  await expect(season).toContainText(/Spring|Frühling/);
  await expect(season).toContainText('°C');
  await expect(page.getByTestId('energy-heating')).toBeVisible();
  await expect(page.getByTestId('energy-cooling')).toBeVisible();
  await expect(page.getByTestId('insulation')).toBeVisible();
  await expect(page.getByTestId('traffic')).toBeVisible();
});

test('agent tools drive the game through window.voltopia', async ({ page }) => {
  // The tools do not need WebGL: they talk to the worker directly.
  const moneyText = async (): Promise<number> => {
    const text = await page.getByTestId('money').textContent();
    return Number(text?.replace(/[^\d]/g, '') ?? '0');
  };
  type Api = {
    tools: Array<{ name: string }>;
    call: (name: string, input?: unknown) => Promise<Record<string, unknown>>;
  };
  const call = (name: string, input: unknown = {}): Promise<Record<string, unknown>> =>
    page.evaluate(
      ([name, input]) => (window as unknown as { voltopia: Api }).voltopia.call(name, input),
      [name, input] as [string, unknown],
    );

  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { voltopia?: Api }).voltopia)))
    .toBe(true);
  const names = await page.evaluate(() =>
    (window as unknown as { voltopia: Api }).voltopia.tools.map((t) => t.name),
  );
  expect(names).toContain('build_road');
  expect(names).toContain('get_map');

  const overview = await call('get_game_overview');
  expect(overview.gridSize).toBe(64);
  const before = await moneyText();

  // Find a stretch of empty land and pave it.
  const land = await call('find_tiles', { kind: 'empty_land', near: { x: 32, y: 32 }, limit: 1 });
  const [{ x, y }] = land.tiles as Array<{ x: number; y: number }>;
  const road = await call('build_road', { from: { x, y }, to: { x, y: y + 3 } });
  expect(road.ok).toBe(true);
  expect(road.spent).toBeGreaterThan(0);
  await expect.poll(moneyText, { timeout: 5_000 }).toBeLessThan(before);

  // The map mirror on the main thread reflects the new road.
  const map = await call('get_map', { origin: { x, y }, width: 1, height: 4 });
  expect(map.rows).toEqual(['+', '+', '+', '+']);

  // Rejections come back as data, not exceptions.
  const bad = await call('place_plant', { plant: 'run_of_river', x: 0, y: 0 });
  expect(bad.ok).toBe(false);
  expect(typeof bad.message).toBe('string');

  // Time can be advanced while paused; the speed is restored afterwards.
  await call('set_speed', { speed: 0 });
  const advanced = await call('advance_time', { ticks: 8 });
  expect(advanced.ticksAdvanced).toBe(8);
  const after = await call('get_game_overview');
  expect(after.speed).toBe(0);
});
