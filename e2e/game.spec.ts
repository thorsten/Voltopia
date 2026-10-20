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

/** Tick and sandbox flag of the autosave in IndexedDB, or null when there is none. */
async function readAutosave(page: Page): Promise<{ tick: number; sandbox: boolean } | null> {
  return page.evaluate(
    () =>
      new Promise<{ tick: number; sandbox: boolean } | null>((resolve) => {
        const open = indexedDB.open('voltopia');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('saves')) {
            db.close();
            resolve(null);
            return;
          }
          const get = db.transaction('saves').objectStore('saves').get('autosave');
          get.onerror = () => {
            db.close();
            resolve(null);
          };
          get.onsuccess = () => {
            db.close();
            const save = get.result as { tick?: number; sandbox?: boolean } | undefined;
            resolve(save ? { tick: save.tick ?? 0, sandbox: save.sandbox === true } : null);
          };
        };
      }),
  );
}

/** Plant type of one tile in the autosave, or -1 when there is no autosave. */
async function readAutosavePlant(page: Page, index: number): Promise<number> {
  return page.evaluate(
    (index) =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('voltopia');
        open.onerror = () => resolve(-1);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('saves')) {
            db.close();
            resolve(-1);
            return;
          }
          const get = db.transaction('saves').objectStore('saves').get('autosave');
          get.onerror = () => {
            db.close();
            resolve(-1);
          };
          get.onsuccess = () => {
            db.close();
            const save = get.result as { layers?: { plantType?: ArrayBuffer } } | undefined;
            const layer = save?.layers?.plantType;
            resolve(layer ? (new Uint8Array(layer)[index] ?? -1) : -1);
          };
        };
      }),
    index,
  );
}

/** True when the environment has WebGL and the 3D canvas is present. */
async function has3dView(page: Page): Promise<boolean> {
  return (await page.locator('.game-view canvas').count()) > 0;
}

test.beforeEach(async ({ page }) => {
  // Keep the first-run tutorial and the system intros out of unrelated
  // tests (the tutorial test opts back in via the e2eAllowTutorial marker).
  await page.addInitScript(() => {
    if (!localStorage.getItem('voltopia.e2eAllowTutorial')) {
      localStorage.setItem('voltopia.tutorialDone', '1');
    }
    localStorage.setItem(
      'voltopia.introsSeen',
      JSON.stringify(['smartMeters', 'demandResponse', 'islands', 'hydrogen', 'heat']),
    );
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

test('help page starts a system intro that can be stepped and closed', async ({ page }) => {
  await page.getByTestId('open-help').click();
  await page.getByTestId('help-intro-start-smartMeters').click();
  await expect(page.getByTestId('help-page')).toHaveCount(0);
  const intro = page.getByTestId('intro');
  await expect(intro).toHaveAttribute('data-intro', 'smartMeters');
  await expect(intro).toContainText('1/2');
  await page.getByTestId('intro-next').click();
  await expect(intro).toContainText('2/2');
  await page.getByTestId('intro-close').click();
  await expect(intro).toHaveCount(0);
});

test('new-game dialog starts a fresh city with chosen difficulty', async ({ page }) => {
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('new-game-page')).toBeVisible();
  await page.getByTestId('size-48').click();
  await page.getByTestId('difficulty-hard').click();
  await page.getByTestId('seed-input').fill('gridtown');
  // Starting reloads the page; the old page's money would satisfy the
  // waits below, so wait for the new page first.
  await Promise.all([page.waitForEvent('load'), page.getByTestId('start-city').click()]);
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  // Hard difficulty: starting funds are 15,000.
  await expect(page.getByTestId('money')).toContainText('15,000', { timeout: 15_000 });
});

test('a sandbox city builds beyond any starting money and runs at 6x', async ({ page }) => {
  test.setTimeout(90_000);
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('new-game-page')).toBeVisible();
  await page.getByTestId('disasters-harsh').click();
  await page.getByTestId('sandbox-toggle').check();
  await expect(page.getByTestId('disasters-off')).toHaveClass(/active/);
  // Leaving sandbox restores the disaster level chosen before.
  await page.getByTestId('sandbox-toggle').uncheck();
  await expect(page.getByTestId('disasters-harsh')).toHaveClass(/active/);
  await page.getByTestId('sandbox-toggle').check();
  await expect(page.getByTestId('disasters-off')).toHaveClass(/active/);
  await expect(page.getByTestId('difficulty-easy')).toBeDisabled();
  await page.getByTestId('size-48').click();
  await page.getByTestId('start-city').click();
  // Starting reloads the page: wait for the badge, which only the new
  // sandbox city shows, before talking to the page.
  await expect(page.getByTestId('sandbox-badge')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('money')).toContainText('∞');

  type Api = { call: (name: string, input?: unknown) => Promise<Record<string, unknown>> };
  const call = (name: string, input: unknown = {}): Promise<Record<string, unknown>> =>
    page.evaluate(
      ([name, input]) => (window as unknown as { voltopia: Api }).voltopia.call(name, input),
      [name, input] as [string, unknown],
    );
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { voltopia?: Api }).voltopia)))
    .toBe(true);

  // Ten wind turbines cost more than the easy difficulty's starting money.
  const land = await call('find_tiles', {
    kind: 'empty_land',
    near: { x: 24, y: 24 },
    limit: 30,
  });
  const results: Array<Record<string, unknown>> = [];
  for (const { x, y } of land.tiles as Array<{ x: number; y: number }>) {
    if (results.length === 10) break;
    const placed = await call('place_plant', { plant: 'wind', x, y });
    if (placed.ok) results.push(placed);
  }
  expect(results).toHaveLength(10);
  for (const placed of results) expect(placed.sandbox).toBe(true);
  await expect(page.getByTestId('money')).toContainText('∞');

  const credit = await call('take_credit', { kind: 'loan', amount: 5000 });
  expect(credit.ok).toBe(false);

  // The sim must report 6x, and run clearly faster than at 3x. A slow
  // runner drops ticks at both speeds, so compare paces rather than
  // trusting an absolute tick count.
  const ticksIn = async (ms: number): Promise<number> => {
    const before = await readTick(page);
    await page.waitForTimeout(ms);
    return (await readTick(page)) - before;
  };
  await page.getByTestId('speed-3').click();
  await expect(page.getByTestId('speed-3')).toHaveClass(/active/);
  const at3x = await ticksIn(2_000);
  await page.getByTestId('speed-6').click();
  await expect(page.getByTestId('speed-6')).toHaveClass(/active/);
  expect((await call('get_game_overview')).speed).toBe(6);
  const at6x = await ticksIn(2_000);
  // Nominally 48 vs 24 ticks; 1.4x leaves room for timer jitter.
  expect(at6x).toBeGreaterThan(at3x * 1.4);

  // The sandbox flag survives the autosave: quick-save, then wait until
  // the autosave slot holds this sandbox city before reloading.
  const savedFrom = await readTick(page);
  await page.keyboard.press('Control+s');
  await expect
    .poll(
      async () => {
        const save = await readAutosave(page);
        return save !== null && save.sandbox && save.tick >= savedFrom;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await page.reload();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('money')).toContainText('∞');
});

test('a scenario starts from the scenarios page and survives a reload', async ({ page }) => {
  // Starting a scenario reloads the page and stamps a 48x48 town; under
  // SwiftShader that takes 25-30 s before the HUD shows the panel.
  test.setTimeout(150_000);
  await page.getByTestId('open-scenarios').click();
  await expect(page.getByTestId('scenarios-page')).toBeVisible();
  await page.getByTestId('start-scenario-dunkelflaute').click();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('scenario-panel')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('scenario-day')).toContainText('90');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByTestId('scenario-panel')).toBeVisible({ timeout: 60_000 });
});

test('statistics page opens from the footer', async ({ page }) => {
  await page.getByTestId('open-stats').click();
  await expect(page.getByTestId('stats-page')).toBeVisible();
  await expect(page.getByTestId('stats-compare')).toBeVisible();
  await expect(page.getByTestId('stats-csv-days')).toBeVisible();
  await expect(page.getByTestId('stats-csv-years')).toBeVisible();
});

test('settings page toggles persist', async ({ page }) => {
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await page.getByTestId('setting-shadows').click();
  await page.getByTestId('setting-ambient-occlusion').click();
  await page.getByTestId('setting-sound').click();
  await page.reload();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('setting-shadows')).not.toBeChecked();
  await expect(page.getByTestId('setting-ambient-occlusion')).not.toBeChecked();
  await expect(page.getByTestId('setting-sound')).not.toBeChecked();
});

test('boots with a running simulation', async ({ page }) => {
  await expect(page).toHaveTitle(/Voltopia/);
  const before = await readTick(page);
  await expect.poll(async () => readTick(page), { timeout: 5_000 }).toBeGreaterThan(before);
  await expect(page.getByTestId('money')).toBeVisible();
  await expect(page.getByTestId('energy-panel')).toBeVisible();
  await expect(page.getByTestId('energy-hydro')).toBeVisible();
  // Desktop-sized viewport: no small-screen notice.
  await expect(page.getByTestId('small-screen-notice')).toHaveCount(0);
});

test('a phone-sized viewport gets the bigger-screen notice', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('small-screen-notice')).toBeVisible();
  await page.getByTestId('small-screen-continue').click();
  await expect(page.getByTestId('small-screen-notice')).toHaveCount(0);
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
    'open-stats',
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
  await expect(page.getByTestId('tool-plant-substation')).toBeVisible();
  await expect(page.getByTestId('tool-plant-park')).toBeVisible();
  await expect(page.getByTestId('tool-plant-fire')).toBeVisible();
  await expect(page.getByTestId('tool-plant-police')).toBeVisible();
  await expect(page.getByTestId('tool-plant-depot')).toBeVisible();
  await expect(page.getByTestId('tool-bus-stop')).toBeVisible();
  await expect(page.getByTestId('tool-rail')).toBeVisible();
  await expect(page.getByTestId('tool-plant-station')).toBeVisible();
  await expect(page.getByTestId('tool-plant-terminal')).toBeVisible();
  await expect(page.getByTestId('tool-plant-railyard')).toBeVisible();
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
  await page.getByTestId('speed-6').click();
  await expect(page.getByTestId('speed-6')).toHaveClass(/active/);
  await expect(page.getByTestId('speed-3')).not.toHaveClass(/active/);
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

test('an ordinance switches on, bills the budget and survives a reload', async ({ page }) => {
  // Checkbox follows worker stats (next tick event): click and poll.
  const toggle = page.getByTestId('policy-speedLimit').locator('input');
  await toggle.click();
  await expect(toggle).toBeChecked({ timeout: 10_000 });
  await page.getByTestId('speed-3').click();
  await expect.poll(async () => readTick(page), { timeout: 15_000 }).toBeGreaterThan(20);
  // The drawer is open by default: the budget lists the ordinance line
  // at its daily admin cost (the speed limit has no subsidies).
  const budgetLine = page.getByTestId('budget-slice-policies');
  await expect(budgetLine).toBeVisible({ timeout: 10_000 });
  const perDay = Number(
    (await budgetLine.locator('.budget-legend-value').textContent())?.replace(/,/g, ''),
  );
  expect(perDay).toBeCloseTo(50, 0);
  await expect(page.getByTestId('policy-speedLimit-happiness')).toContainText('−2 %');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('policy-speedLimit').locator('input')).toBeChecked({
    timeout: 10_000,
  });
});

test('a loan and a grid fee show in the budget and the credit survives a reload', async ({
  page,
}) => {
  // Growing the first house runs a few hundred ticks; slow runners need room.
  test.setTimeout(150_000);
  // The drawer is open by default; a new city may borrow right away.
  await expect(page.getByTestId('finance-panel')).toBeVisible();
  await expect(page.getByTestId('credit-1')).toHaveCount(0);
  await page.getByTestId('credit-loan-5000').click();
  // The credit list follows worker stats: wait for the next tick event.
  await expect(page.getByTestId('credit-1')).toBeVisible({ timeout: 10_000 });
  // Loans repay a little every tick, so the outstanding amount starts
  // just under the principal by the time the row shows.
  await expect(page.getByTestId('credit-1')).toContainText(/(5,000|4,9\d\d) ⌁/);
  await expect(page.getByTestId('finance-debt')).toContainText(/(5,000|4,9\d\d) \//);
  await expect(page.getByTestId('credit-rating')).toContainText(/[A-D]/);

  // A fresh map has no buildings, so nothing would pay a grid fee: grow a
  // small powered street through the agent tools (no WebGL needed).
  type Api = { call: (name: string, input?: unknown) => Promise<Record<string, unknown>> };
  const call = (name: string, input: unknown = {}): Promise<Record<string, unknown>> =>
    page.evaluate(
      ([name, input]) => (window as unknown as { voltopia: Api }).voltopia.call(name, input),
      [name, input] as [string, unknown],
    );
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { voltopia?: Api }).voltopia)))
    .toBe(true);
  // A biogas plant feeding a power line along a street of houses. Hilly
  // seeds have steep tiles a plant refuses: take the first flat one.
  const land = await call('find_tiles', { kind: 'empty_land', near: { x: 32, y: 32 }, limit: 50 });
  let site: { x: number; y: number } | undefined;
  for (const tile of land.tiles as Array<{ x: number; y: number }>) {
    if ((await call('place_plant', { plant: 'biogas', ...tile })).ok) {
      site = tile;
      break;
    }
  }
  if (!site) throw new Error('no flat tile for the plant');
  const { x, y } = site;
  const street = { from: { x, y: y + 1 }, to: { x, y: y + 12 } };
  expect((await call('build_road', street)).ok).toBe(true);
  expect((await call('build_power_line', street)).ok).toBe(true);
  // Growth tries three random map tiles a tick: zone plenty so a house
  // appears within a few hundred ticks on any seed.
  for (const [from, to] of [
    [x - 2, x - 1],
    [x + 1, x + 2],
  ]) {
    await call('paint_zone', {
      zone: 'residential',
      from: { x: from, y: y + 1 },
      to: { x: to, y: y + 12 },
    });
  }
  // Paused, advance_time runs the worker at full speed instead of 1x.
  await call('set_speed', { speed: 0 });
  // Only billed consumption pays the fee: wait until a house draws energy.
  type Overview = { energyPerTick: { consumption: { buildings: number } } };
  await expect
    .poll(
      async () => {
        await call('advance_time', { ticks: 200 });
        const overview = (await call('get_game_overview')) as unknown as Overview;
        return overview.energyPerTick.consumption.buildings;
      },
      { timeout: 90_000 },
    )
    .toBeGreaterThan(0);
  await page.getByTestId('speed-3').click();

  // A non-zero grid fee bills the buildings' consumption.
  const slider = page.getByTestId('grid-fee-slider').locator('input');
  await slider.fill('5');
  await expect(page.getByTestId('grid-fee-slider')).toContainText('0.005 ⌁/EU', {
    timeout: 10_000,
  });
  await expect(page.getByTestId('grid-fee-happiness')).toContainText('−');
  await expect(page.getByTestId('budget-slice-gridFees')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('budget-slice-interest')).toBeVisible({ timeout: 15_000 });

  await page.keyboard.press('Control+s');
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('credit-1')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('budget-slice-gridFees')).toBeVisible({ timeout: 15_000 });
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

test('energy drawer lists grid districts and the Grid overlay toggles', async ({ page }) => {
  // The tools do not need WebGL: they talk to the worker directly. A lone
  // plant is already a grid island of its own (plants are supply sources
  // even without a line reaching them), so this is the cheapest way to
  // get a district row to assert on.
  type Api = { call: (name: string, input?: unknown) => Promise<Record<string, unknown>> };
  const call = (name: string, input: unknown = {}): Promise<Record<string, unknown>> =>
    page.evaluate(
      ([name, input]) => (window as unknown as { voltopia: Api }).voltopia.call(name, input),
      [name, input] as [string, unknown],
    );
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { voltopia?: Api }).voltopia)))
    .toBe(true);

  const land = await call('find_tiles', { kind: 'empty_land', near: { x: 32, y: 32 }, limit: 1 });
  const [{ x, y }] = land.tiles as Array<{ x: number; y: number }>;
  const placed = await call('place_plant', { plant: 'solar', x, y });
  expect(placed.ok).toBe(true);
  await call('advance_time', { ticks: 4 });

  // The drawer starts open by default (see 'the HUD detail drawer
  // toggles...' above) — cycle it closed then open so this exercises the
  // actual open transition instead of relying on that default.
  await page.getByTestId('hud-details-toggle').click();
  await expect(page.getByTestId('hud-drawer')).toBeHidden();
  await page.getByTestId('hud-details-toggle').click();
  await expect(page.getByTestId('district-list')).toBeVisible();
  await expect(page.getByTestId('district-row')).toHaveCount(1);

  await page.getByTestId('overlay-grid').click();
  await expect(page.getByTestId('overlay-grid')).toHaveClass(/active/);

  // Switch away, then prove selecting a district switches the overlay
  // back to Grid on its own.
  await page.getByTestId('overlay-off').click();
  await expect(page.getByTestId('overlay-off')).toHaveClass(/active/);
  await page.getByTestId('district-row').first().click();
  await expect(page.getByTestId('overlay-grid')).toHaveClass(/active/);
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
  await page.getByTestId('help-page').locator('.modal-close').click();
  await expect(page.getByTestId('help-page')).toHaveCount(0);

  // Switch to German: UI translates immediately.
  await page.getByTestId('language-de').click();
  await expect(page.getByTestId('tool-road')).toContainText('Straße');
  await page.getByTestId('open-help').click();
  await expect(page.getByTestId('help-page')).toContainText('Ziel');
  await page.getByTestId('help-page').locator('.modal-close').click();

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

test('saves page keeps named saves', async ({ page }) => {
  // Pause so the save holds a known tick.
  await page.getByTestId('speed-0').click();
  await expect(page.getByTestId('speed-0')).toHaveClass(/active/);
  await page.waitForTimeout(400);
  const savedTick = await readTick(page);

  await page.getByTestId('open-saves').click();
  await expect(page.getByTestId('saves-page')).toBeVisible();
  await expect(page.getByTestId('saves-empty')).toBeVisible();
  await page.getByTestId('save-name-input').fill('Testville');
  await page.getByTestId('save-new').click();
  const row = page.locator('[data-testid^="save-row-"]');
  await expect(row).toHaveCount(1);
  const id = (await row.getAttribute('data-testid'))!.replace('save-row-', '');
  await expect(page.getByTestId(`save-name-${id}`)).toHaveText('Testville');

  // Rename in place; Enter commits.
  await page.getByTestId(`save-rename-${id}`).click();
  await page.getByTestId(`save-rename-input-${id}`).fill('Testville 2');
  await page.getByTestId(`save-rename-input-${id}`).press('Enter');
  await expect(page.getByTestId(`save-name-${id}`)).toHaveText('Testville 2');

  // The entry survives a reload.
  await page.reload();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('speed-3').click();
  await expect
    .poll(async () => readTick(page), { timeout: 15_000 })
    .toBeGreaterThan(savedTick + 60);
  await page.getByTestId('open-saves').click();
  await expect(page.getByTestId(`save-name-${id}`)).toHaveText('Testville 2');

  // Loading reloads the page with the saved city, not the later one.
  await page.getByTestId(`save-load-${id}`).click();
  await expect(page.getByTestId('saves-page')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  expect(await readTick(page)).toBeLessThan(savedTick + 60);

  // Delete needs a second click to confirm.
  await page.getByTestId('open-saves').click();
  await page.getByTestId(`save-delete-${id}`).click();
  await expect(page.getByTestId(`save-row-${id}`)).toHaveCount(1);
  await page.getByTestId(`save-delete-${id}`).click();
  await expect(page.getByTestId(`save-row-${id}`)).toHaveCount(0);
  await expect(page.getByTestId('saves-empty')).toBeVisible();
});

test('a shared city opens from its link and the old city is kept', async ({ page }) => {
  test.setTimeout(120_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  type Api = { call: (name: string, input?: unknown) => Promise<Record<string, unknown>> };
  const call = (name: string, input: unknown = {}): Promise<Record<string, unknown>> =>
    page.evaluate(
      ([name, input]) => (window as unknown as { voltopia: Api }).voltopia.call(name, input),
      [name, input] as [string, unknown],
    );
  const toolsReady = () =>
    expect
      .poll(
        () => page.evaluate(() => Boolean((window as unknown as { voltopia?: Api }).voltopia)),
        {
          timeout: 15_000,
        },
      )
      .toBe(true);
  await toolsReady();
  await call('set_speed', { speed: 0 });
  const overview = await call('get_game_overview');
  const size = overview.gridSize as number;
  // Hilly seeds have steep tiles a plant refuses: take the first flat one.
  const land = await call('find_tiles', { kind: 'empty_land', near: { x: 32, y: 32 }, limit: 50 });
  let site: { x: number; y: number } | undefined;
  for (const tile of land.tiles as Array<{ x: number; y: number }>) {
    if ((await call('place_plant', { plant: 'biogas', ...tile })).ok) {
      site = tile;
      break;
    }
  }
  if (!site) throw new Error('no flat tile for the plant');

  await page.getByTestId('open-saves').click();
  await page.getByTestId('share-city').click();
  const message = page.getByTestId('saves-message');
  await expect(message).toContainText(
    /Link copied|Link kopiert|Copying failed|Kopieren fehlgeschlagen/,
    { timeout: 15_000 },
  );
  const output = page.getByTestId('share-link-output');
  const url =
    (await output.count()) > 0
      ? await output.inputValue()
      : await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toMatch(/#city=[A-Za-z0-9_-]+$/);

  // Change the running city so it differs from the shared one.
  await page.getByTestId('saves-page').locator('.modal-close').click();
  expect((await call('bulldoze', { from: site, to: site })).ok).toBe(true);
  await page.keyboard.press('Control+s');
  // Wait until the autosave no longer holds the plant before navigating.
  const plantIndex = site.y * size + site.x;
  await expect.poll(() => readAutosavePlant(page, plantIndex), { timeout: 10_000 }).toBe(0);

  // Opening the link in this running tab only changes the hash (same
  // document): the app reloads itself to read it.
  await page.evaluate((link) => {
    window.location.hash = new URL(link).hash;
  }, url);
  await expect(page.getByTestId('shared-city-dialog')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('shared-city-details')).toContainText(`${size}×${size}`);
  await expect(page.getByTestId('shared-city-details')).toContainText(/day|Tag/);
  expect(page.url()).not.toContain('#city=');

  // Loading reloads the page; the HUD only exists on the new page.
  await page.getByTestId('shared-city-load').click();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  await toolsReady();
  await expect
    .poll(async () => (await call('inspect_tile', site)).plant, { timeout: 10_000 })
    .toBe('biogas');

  // The city that was running before is kept as a named save.
  await page.getByTestId('open-saves').click();
  await expect(
    page
      .locator('[data-testid^="save-name-"]')
      .filter({ hasText: /Before shared city|Vor geteilter Stadt/ }),
  ).toHaveCount(1);
});

test('an invalid city link shows a notice and the game starts normally', async ({ page }) => {
  await page.goto('about:blank');
  await page.goto('/#city=notavalidcode');
  await expect(page.getByTestId('share-invalid')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  expect(page.url()).not.toContain('#');
});

test('a pasted invalid city link is rejected on the saves page', async ({ page }) => {
  await page.getByTestId('open-saves').click();
  await page.getByTestId('share-open-input').fill('no city in here!');
  await page.getByTestId('share-open').click();
  await expect(page.getByTestId('saves-message')).toContainText(
    /does not contain a valid city|enthält keine gültige Stadt/,
  );
  await expect(page.getByTestId('shared-city-dialog')).toHaveCount(0);
});
