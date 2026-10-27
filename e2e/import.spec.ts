import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/** The synthetic town the import tests use (3 km around lat 49.8835, lon 8.6709). */
const FIXTURE_PATH = fileURLToPath(new URL('../src/import/fixtures/town.osm', import.meta.url));
const FIXTURE_XML = readFileSync(FIXTURE_PATH, 'utf8');
const TOWN_NAME = 'Bach & Berg';
/** How long the stubbed Overpass holds its answer, so the progress bar shows. */
const OVERPASS_STUB_DELAY_MS = 500;

async function readPopulation(page: Page): Promise<number> {
  const text = await page.getByTestId('population').locator('.hud-stat-value').textContent();
  return Number(text?.replace(/\D/g, '') ?? '0');
}

/** Opens the new-game page from the running city. */
async function openNewGame(page: Page): Promise<void> {
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('new-game-page')).toBeVisible();
  await expect(page.getByTestId('import-town')).toBeVisible();
}

/** Starts the city on the loaded town and checks the HUD shows an imported, inhabited town. */
async function startImportedTown(page: Page): Promise<void> {
  await expect(page.getByTestId('import-town-name')).toContainText(TOWN_NAME);
  await expect(page.getByTestId('import-town-report')).toContainText(/\d+ m/);
  // An imported town takes a random seed: the seed field gives way to a note.
  await expect(page.getByTestId('seed-hidden')).toBeVisible();
  await expect(page.getByTestId('seed-input')).toHaveCount(0);
  // Starting reloads the page; wait for the attribution, which only an
  // imported city shows, before reading the new page's HUD.
  await Promise.all([page.waitForEvent('load'), page.getByTestId('start-city').click()]);
  await expect(page.getByTestId('osm-attribution')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  // The settled buildings bring residents with them.
  await expect.poll(() => readPopulation(page), { timeout: 30_000 }).toBeGreaterThan(0);
}

test.beforeEach(async ({ page }) => {
  // Keep the first-run tutorial and the system intros out of these tests.
  await page.addInitScript(() => {
    localStorage.setItem('voltopia.tutorialDone', '1');
    localStorage.setItem(
      'voltopia.introsSeen',
      JSON.stringify(['smartMeters', 'demandResponse', 'islands', 'hydrogen', 'heat']),
    );
  });
  await page.goto('/');
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
});

test('imports a town from an .osm file and starts the city on it', async ({ page }) => {
  test.setTimeout(90_000);
  await openNewGame(page);
  await page.getByTestId('size-64').click();
  await page.getByTestId('import-town-file').setInputFiles(FIXTURE_PATH);
  await expect(page.getByTestId('import-town-preview')).toBeVisible();
  await startImportedTown(page);
});

test('searches a place, downloads the town and starts the city on it', async ({ page }) => {
  test.setTimeout(90_000);
  // Nominatim and Overpass are stubbed: CI never calls the real services.
  await page.route('https://nominatim.openstreetmap.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          name: TOWN_NAME,
          display_name: `${TOWN_NAME}, Landkreis Musterstadt, Hessen, Germany`,
          type: 'town',
          lat: '49.8835',
          lon: '8.6709',
        },
      ]),
    }),
  );
  // Overpass answers after a short delay so the progress bar is observable.
  await page.route('**/api/interpreter', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, OVERPASS_STUB_DELAY_MS));
    await route.fulfill({ status: 200, contentType: 'text/xml', body: FIXTURE_XML });
  });
  await openNewGame(page);
  await page.getByTestId('size-64').click();
  await page.getByTestId('import-town-query').fill('Bach');
  await page.getByTestId('import-town-query').press('Enter');
  const hit = page.getByTestId('import-town-result').first();
  await expect(hit).toContainText(TOWN_NAME);
  await hit.click();
  await expect(page.getByTestId('import-town-place')).toContainText(TOWN_NAME);
  await page.getByTestId('import-town-side').filter({ hasText: '3.5' }).click();
  await page.getByTestId('import-town-load').click();
  const progress = page.getByTestId('import-town-progress');
  await expect(progress).toBeVisible();
  await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /^\d+$/);
  await expect(page.getByTestId('import-town-progress-label')).toContainText('%');
  await expect(page.getByTestId('import-town-cancel')).toBeVisible();
  await expect(page.getByTestId('import-town-preview')).toBeVisible({ timeout: 15_000 });
  await startImportedTown(page);
});
