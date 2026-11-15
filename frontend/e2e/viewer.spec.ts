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
  await expect(page.getByRole('heading', { name: 'See what moves.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('link', { name: /Explore for movement/ }).click();
  await expect(page.getByRole('heading', { name: 'Explore for movement' })).toBeVisible();
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
    expect(route.request().postDataJSON()).toEqual({ ra: 133.79513, dec: -7.24515, fov: 0.05, findMovers: true });
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
  await page.goto('/#explore');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
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


test('requests the next image batch on demand', async ({ page }) => {
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
  await page.goto('/#explore');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: /Select frame/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Search more observations' })).toBeVisible();
  expect(batches).toBe(0);
  await page.getByRole('button', { name: 'Search more observations' }).click();
  await expect(page.getByRole('button', { name: /Select frame/ })).toHaveCount(2);
  expect(batches).toBe(1);
  expect(cursors).toEqual(['0', '1', '1']);
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
  await page.goto('/#explore');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
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

test('launches the chosen validation example with its exposure IDs', async ({ page }) => {
  const referenceId = 'ivo://irsa.ipac/spherex_dr1?2025W19_2B_0346_1/D2';
  const comparisonId = 'ivo://irsa.ipac/spherex_dr1?2025W20_2D_0176_3/D2';
  const grid = { width: 1, height: 1, orientation: 'north-up' };
  await page.route('**/api/frames', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      ra: 210.80227, dec: 54.34895, fov: .1, exposureIds: [referenceId, comparisonId],
    });
    await route.fulfill({ status: 202, json: {
      sequenceId: 'validate-test', pollUrl: '/api/frames/validate-test', pollAfterSeconds: 1,
    } });
  });
  await page.route('**/api/frames/validate-test/gaia', (route) => route.fulfill({ json: { sources: [], limited: false } }));
  await page.route('**/api/frames/validate-test?*', (route) => route.fulfill({ json: {
    sequenceId: 'validate-test', status: 'completed', nextCursor: 2, hasMore: false, scheduledCount: 2,
    remaining: 0, batchSize: 12, progress: { total: 2, ready: 2, failed: 0 },
    frames: [frame(comparisonId, 16), frame(referenceId, 10)].map((item) => ({
      ...item, detector: 'SPHEREx-D2', alignedGrid: grid, alignedImageData: png,
      sharedDisplay: {vmin: 0, vmax: 1},
    })), error: null,
  } }));
  await page.goto('/');
  await page.getByRole('link', { name: /Validate a known object/ }).click();
  await page.getByLabel('Validation example').selectOption('m101');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const table = page.getByRole('table', { name: 'Selected frame comparison' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row').nth(1)).toContainText('2025-05-10');
  await expect(page.getByLabel('Gaia reference stars')).toBeChecked();
});

test('reviews an automatically surfaced candidate in its supporting frames', async ({ page }) => {
  const grid = { width: 30, height: 30, orientation: 'north-up' };
  const frames = [frame('a', 10), frame('b', 11), frame('c', 12)].map((item) => ({
    ...item, alignedGrid: grid, alignedImageData: png, sharedDisplay: {vmin: 0, vmax: 1},
  }));
  await page.route('**/api/frames', (route) => route.fulfill({ status: 202, json: {
    sequenceId: 'motion-test', pollUrl: '/api/frames/motion-test', pollAfterSeconds: 1,
  } }));
  await page.route('**/api/frames/motion-test?*', (route) => route.fulfill({ json: {
    sequenceId: 'motion-test', status: 'completed', nextCursor: 3, hasMore: false,
    scheduledCount: 3, remaining: 0, batchSize: 12, progress: {total: 3, ready: 3, failed: 0}, frames,
    motion: {analyzedFrames: 3, comparable: true, candidates: [{
      id: '1-1', detector: 'SPHEREx-D3', displacementArcsec: 90, elapsedHours: 48,
      residualPixels: .5, score: 3, detections: frames.map((item, i) => ({
        frameId: item.id, observedAtUtc: item.observedAtUtc, x: 5 + i * 5, y: 10,
        ra: 133 + i * .01, dec: -7.2, signalToNoise: 12,
      })),
    }]}, error: null,
  } }));
  await page.goto('/#explore');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: /Candidate 1/ }).click();
  const rows = page.getByRole('table', {name: 'Selected frame comparison'}).getByRole('row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText('133.00000°');
  const marker = page.getByRole('img', {name: 'Measured candidate position'});
  await expect(marker).toBeVisible();
  await rows.nth(2).getByRole('rowheader').getByRole('button').click();
  await expect(marker).toHaveCSS('left', /px/);
  await expect(rows.nth(2)).toContainText('133.01000°');
});
