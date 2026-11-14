import { expect, test } from '@playwright/test';

// Synthetic display fixture; archive services are never called by these tests.
test.afterEach(async ({ page }, testInfo) => {
  await page.screenshot({ path: testInfo.outputPath('full-page.png'), fullPage: true });
});

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1sAAAAASUVORK5CYII=';
function frame(id: string, day: number) {
  return { id, visit: 0, observedAtUtc: `2025-05-${day}T00:00:00Z`, release: 'spherex_dr1',
    detector: 'SPHEREx-D3', status: 'ready', imageData: png, grid: { width: 1, height: 1, orientation: 'native' }, error: null };
}

test('shows inputs and an empty viewer without layout overflow', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Explore the infrared sky.' })).toBeVisible();
  await expect(page.getByLabel('Right ascension')).toHaveValue('133.79513');
  await expect(page.getByLabel('Declination')).toHaveValue('-7.24515');
  await expect(page.getByLabel('Field of view')).toHaveValue('0.05');
  await expect(page.getByRole('button', { name: 'Next frame' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('submits once, polls all pages, and navigates received images', async ({ page }) => {
  const cursors: string[] = [];
  let submissions = 0;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/frames', async (route) => {
    submissions++;
    expect(route.request().postDataJSON()).toEqual({ ra: 133.79513, dec: -7.24515, fov: 0.05 });
    await route.fulfill({ status: 202, json: { sequenceId: 'browser-test', status: 'queued',
      pollUrl: '/api/frames/browser-test', pollAfterSeconds: 1 } });
  });
  await page.route('**/api/frames/browser-test?*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('after')!;
    cursors.push(cursor);
    const batch = cursor === '0' ? [frame('first', 10)] : cursor === '1' ? [frame('second', 11)] : [frame('third', 12)];
    const next = Number(cursor) + 1;
    await route.fulfill({ json: {
      sequenceId: 'browser-test', status: next === 1 ? 'running' : 'completed',
      nextCursor: next, hasMore: next === 2, pollAfterSeconds: 1,
      progress: { total: 3, ready: next, failed: 0 }, frames: batch, error: null,
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Find observations' }).click();
  await expect(page.getByRole('button', { name: /Select frame/ })).toHaveCount(3);
  expect(submissions).toBe(1);
  expect(cursors).toEqual(['0', '1', '2']);
  await expect(page.locator('.image-stage img')).toHaveAttribute('alt', /2025-05-10/);
  await page.getByRole('button', { name: 'Next frame' }).click();
  await expect(page.locator('.image-stage img')).toHaveAttribute('alt', /2025-05-11/);
  await page.getByRole('slider').fill('2');
  await expect(page.locator('.image-stage img')).toHaveAttribute('alt', /2025-05-12/);
  await page.locator('.image-stage').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.image-stage img')).toHaveAttribute('alt', /2025-05-11/);
  expect(await page.locator('.image-stage img').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1);
  expect(errors).toEqual([]);
});


test('automatically requests the next image batch', async ({ page }) => {
  let batches = 0;
  const cursors: string[] = [];
  await page.route('**/api/frames', (route) => route.fulfill({ status: 202,
    json: { sequenceId: 'batch-test', pollUrl: '/api/frames/batch-test', pollAfterSeconds: 1 } }));
  await page.route('**/api/frames/batch-test/batches', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ after: 1 });
    batches++;
    await route.fulfill({ status: 202, json: { sequenceId: 'batch-test', pollUrl: '/api/frames/batch-test', pollAfterSeconds: 1 } });
  });
  await page.route('**/api/frames/batch-test?*', (route) => {
    cursors.push(new URL(route.request().url()).searchParams.get('after')!);
    return route.fulfill({ json: { sequenceId: 'batch-test',
      status: batches ? 'completed' : 'awaiting_more', nextCursor: batches ? 2 : 1,
      scheduledCount: batches ? 2 : 1, remaining: batches ? 0 : 1, batchSize: 1,
      hasMore: false, pollAfterSeconds: 1,
      progress: { total: 2, ready: batches ? 2 : 1, failed: 0 },
      frames: [frame(batches ? 'second' : 'first', batches ? 11 : 10)], error: null } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Find observations' }).click();
  await expect(page.getByRole('button', { name: /Select frame/ })).toHaveCount(2);
  expect(batches).toBe(1);
  expect(cursors).toEqual(['0', '1']);
});


test('stops and resumes the same sequence without losing images or its cursor', async ({ page }) => {
  let submissions = 0;
  let batches = 0;
  const cursors: string[] = [];
  await page.route('**/api/frames', async (route) => {
    submissions++;
    await route.fulfill({ status: 202, json: { sequenceId: 'resume-test', pollUrl: '/api/frames/resume-test', pollAfterSeconds: 1 } });
  });
  await page.route('**/api/frames/resume-test/batches', async (route) => {
    batches++;
    await route.fulfill({ status: 202, json: { sequenceId: 'resume-test', pollUrl: '/api/frames/resume-test', pollAfterSeconds: 1 } });
  });
  await page.route('**/api/frames/resume-test?*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('after')!;
    cursors.push(cursor);
    await route.fulfill({ json: { sequenceId: 'resume-test',
      status: batches ? 'completed' : cursor === '0' ? 'running' : 'awaiting_more',
      nextCursor: batches ? 2 : 1, scheduledCount: batches ? 2 : 1,
      remaining: batches ? 0 : 1, batchSize: 1, hasMore: false, pollAfterSeconds: 30,
      progress: { total: 2, ready: batches ? 2 : 1, failed: 0 },
      frames: batches ? [frame('second', 11)] : cursor === '0' ? [frame('first', 10)] : [], error: null } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Find observations' }).click();
  await expect(page.getByRole('button', { name: /Select frame/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Stop loading' }).click();
  await expect(page.getByRole('button', { name: 'Resume loading' })).toBeVisible();
  expect(cursors).toEqual(['0']);
  expect(batches).toBe(0);
  await expect(page.getByRole('button', { name: /Select frame/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Resume loading' }).click();
  await expect(page.getByRole('button', { name: /Select frame/ })).toHaveCount(2);
  expect(submissions).toBe(1);
  expect(batches).toBe(1);
  expect(cursors).toEqual(['0', '1', '1']);
  await expect(page.getByRole('button', { name: 'Resume loading' })).toHaveCount(0);
});
