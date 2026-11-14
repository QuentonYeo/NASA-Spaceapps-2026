import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Explicit synthetic API fixtures, never displayed in production or fetched from an archive.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1sAAAAASUVORK5CYII=';
const frame = (id: string, group: number) => ({ id, visit: group, observationGroupId: group, observedAtUtc: `2025-05-${group ? '25' : '10'}T00:00:00Z`, release: 'test', detector: 'test', status: 'ready', imageData: png, sharedImageData: png, sharedDisplay: { vmin: 0, vmax: 1 }, alignedImageData: png, alignedGrid: { width: 48, height: 36, orientation: 'north-up' }, wavelengthUm: 2 + group, grid: { width: 30, height: 20, orientation: 'native' }, error: null });
const sample = (id: string, group: number) => ({ frameId: id, observationGroupId: group, observedAtUtc: frame(id, group).observedAtUtc, status: 'partial', value: -2 - group, uncertainty: .2, unit: 'MJy/sr', wavelengthUm: 2 + group, bandwidthUm: .1, wavelengthRangeUm: [1.95 + group, 2.05 + group], coverage: .8, backgroundCoverage: .9, sourcePixels: 4, backgroundPixels: 8, mjd: 60000, reasons: ['Synthetic quality fixture'], qualityPolicy: 'Test fixture', sourceFitsUrl: '' });
const result = (body: Record<string, unknown>, samples = [sample('a', 0), sample('archive/b', 1)]) => ({ ...body, region: { ra: 10, dec: 20, radiusArcsec: 5, innerArcsec: 10, outerArcsec: 15 }, samples, pendingFrames: 0, uncertaintyNote: 'Synthetic uncertainty fixture', processingVersion: 'test-v1', discoveryScope: 'query-centre-only', regionMapping: 'Test mapping' });
async function setup(page: Page, progressiveGate?: Promise<void>, includeFailure = false, thirdAligned = false) {
  await page.route('**/api/frames', route => route.fulfill({ status: 202, json: { sequenceId: 'spectra-test', pollUrl: '/api/frames/spectra-test', pollAfterSeconds: 1 } }));
  await page.route('**/api/frames/spectra-test?*', async route => {
    const first = !!progressiveGate && new URL(route.request().url()).searchParams.get('after') === '0';
    if (progressiveGate && !first) await progressiveGate;
    const frames = first ? [frame('a', 0)] : [frame('a', 0), frame('archive/b', 1)];
    if (thirdAligned) frames.push(frame('c', 2));
    const failed = { ...frame('failed', 0), status: 'failed', imageData: null, error: { message: 'Synthetic failed download' } };
    await route.fulfill({ json: { sequenceId: 'spectra-test', status: first ? 'running' : 'completed', nextCursor: first ? 1 : 2, hasMore: false, pollAfterSeconds: 1, progress: { total: includeFailure ? 3 : 2, ready: first ? 1 : 2, failed: includeFailure ? 1 : 0 }, frames: includeFailure ? [...frames, failed] : frames, error: null } });
  });
  await page.route('**/frames/*/frames/*/projection', route => route.fulfill({ json: { rings: [[[1, 1], [2, 1], [2, 2]]] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Find observations' }).click();
  await expect(page.getByRole('button', { name: /Select frame/ })).toHaveCount(progressiveGate ? 1 : thirdAligned ? 3 : 2);
}

test('native extraction, comparisons and frame selection are independent on desktop and mobile', async ({ page, isMobile }) => {
  const requests: Record<string, unknown>[] = [];
  await page.route('**/spectra-test/spectra', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    await route.fulfill({ json: result(body) });
  });
  await setup(page);
  // Pointer geometry must be relative to the actual displayed image, including non-square frames.
  const image = page.getByRole('img', { name: 'Draw circular region on native image' });
  const bounds = (await image.boundingBox())!;
  await image.dispatchEvent('pointerdown', { button: 0, pointerId: 1, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 });
  await image.dispatchEvent('pointerup', { button: 0, pointerId: 1, clientX: bounds.x + bounds.width * .6, clientY: bounds.y + bounds.height / 2 });
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ sequenceId: 'spectra-test', referenceFrameId: 'a', observationGroupIds: [0, 1] });
  const circle = requests[0].circle as { x: number; y: number; radiusPixels: number };
  expect(circle.x).toBeCloseTo(14.5); expect(circle.y).toBeCloseTo(9.5); expect(circle.radiusPixels).toBeCloseTo(3);
  if (isMobile) await page.getByRole('tab', { name: 'Spectrum', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Region spectrum' });
  if (!isMobile) {
    const viewer = (await page.getByRole('region', { name: 'Frame viewer' }).boundingBox())!;
    const spectrum = (await panel.boundingBox())!;
    expect(spectrum.x).toBeGreaterThan(viewer.x + viewer.width - 1);
    expect(spectrum.y).toBeCloseTo(viewer.y, 0);
  }
  await expect(panel.getByRole('button', { name: /Select measurement a,/ })).toBeVisible();
  await panel.getByLabel('Observation group', { exact: true }).selectOption('1');
  const point = panel.getByRole('button', { name: /Select measurement archive\/b,/ });
  await expect(point).toBeVisible();
  await point.focus(); await page.keyboard.press('Enter');
  if (isMobile) await page.getByRole('tab', { name: 'Image', exact: true }).click();
  await expect(page.locator('.image-stage img')).toHaveAttribute('alt', /2025-05-25/);
  await expect(page.locator('.image-stage polygon')).toHaveCount(1);
  await page.getByRole('button', { name: 'Previous frame' }).click();
  if (isMobile) await page.getByRole('tab', { name: 'Measurements', exact: true }).click();
  await page.locator('.measurements summary').click();
  await expect(page.getByRole('cell', { name: '-3.000 MJy/sr', exact: true })).toBeVisible();
  await page.locator('.measurements').getByRole('button', { name: 'archive/b', exact: true }).click();
  await expect(page.locator('.image-stage img')).toHaveAttribute('alt', /2025-05-25/);
  expect(requests).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('newly completed exposures update the committed region and preserve selection', async ({ page, isMobile }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve });
  const requests: Record<string, unknown>[] = [];
  await page.route('**/spectra-test/spectra', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    const samples = requests.length === 1 ? [sample('a', 0)] : [sample('a', 0), sample('archive/b', 1)];
    await route.fulfill({ json: { ...result(body, samples), pendingFrames: requests.length === 1 ? 1 : 0 } });
  });
  await setup(page, gate);
  await page.getByRole('button', { name: 'Use circle at image centre' }).click();
  if (isMobile) await page.getByRole('tab', { name: 'Spectrum', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Region spectrum' })).toContainText('1 exposures pending');
  release();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].circle).toEqual(requests[0].circle);
  expect(requests[1].referenceFrameId).toBe('a');
  expect(requests[1].observationGroupIds).toEqual([0, 1]);
  await page.getByRole('region', { name: 'Region spectrum' }).getByLabel('Observation group', { exact: true }).selectOption('1');
  await expect(page.getByRole('button', { name: /Select measurement archive\/b,/ })).toBeVisible();
  expect(requests).toHaveLength(2);
});

test('a superseded region response cannot replace the newest spectrum', async ({ page, isMobile }) => {
  let count = 0;
  let releaseOld: (() => void) | undefined;
  await page.route('**/spectra-test/spectra', async route => {
    const n = ++count;
    if (n === 1) await new Promise<void>(resolve => { releaseOld = resolve });
    const data = result(route.request().postDataJSON(), [{ ...sample('a', 0), value: n === 1 ? 999 : -7 }]);
    await route.fulfill({ json: data }).catch(() => {});
  });
  await setup(page);
  await page.getByRole('button', { name: 'Use circle at image centre' }).click();
  await expect.poll(() => count).toBe(1);
  await page.getByLabel('Radius (native pixels)', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Apply region' }).click();
  if (isMobile) await page.getByRole('tab', { name: 'Spectrum', exact: true }).click();
  await expect(page.getByRole('button', { name: /Select measurement a, group 1, -7/ })).toBeVisible();
  releaseOld?.();
  await expect(page.getByRole('button', { name: /Select measurement a, group 1, -7/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Select measurement.*999/ })).toHaveCount(0);
});

test('missing science remains unavailable and selects its failed frame explicitly', async ({ page, isMobile }) => {
  let count = 0;
  await page.route('**/spectra-test/spectra', async route => {
    count++;
    await route.fulfill({ json: result(route.request().postDataJSON(), [sample('a', 0), {
      ...sample('failed', 0), status: 'unavailable', value: null, uncertainty: null,
      wavelengthUm: null, bandwidthUm: null, wavelengthRangeUm: null, reasons: ['Synthetic failed science'],
    }]) });
  });
  await setup(page, undefined, true);
  await page.getByRole('button', { name: 'Use circle at image centre' }).click();
  if (isMobile) await page.getByRole('tab', { name: 'Measurements', exact: true }).click();
  await page.locator('.measurements summary').click();
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'failed', exact: true }) });
  await expect(row).toContainText('unavailable: Synthetic failed science');
  await expect(row).toContainText('Unavailable MJy/sr');
  await row.getByRole('button', { name: 'failed', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Selected frame unavailable' })).toBeVisible();
  await expect(page.locator('.image-stage img')).toHaveCount(0);
  expect(count).toBe(1);
});

test('aligned clicks never extract and measurement selection exits blink for the native source', async ({ page, isMobile }) => {
  const requests: Record<string, unknown>[] = [];
  await page.route('**/spectra-test/spectra', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    await route.fulfill({ json: result(body) });
  });
  await setup(page);
  await page.getByRole('button', { name: 'Use circle at image centre' }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByLabel('View', { exact: true }).selectOption('blink');
  await expect(page.getByRole('button', { name: 'Return to native image for region selection' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Draw circular region on native image' })).toHaveCount(0);
  await expect(page.locator('.host-markers')).toHaveCount(0);
  await expect(page.locator('.image-stage')).toContainText('48 × 36 PX');
  const image = page.locator('.image-stage > img');
  await image.dispatchEvent('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  await image.dispatchEvent('pointerup', { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
  await page.getByRole('button', { name: 'Play blink' }).click();
  await expect(page.locator('.stage-label').first()).toHaveText('FRAME 2 / 2');
  if (isMobile) await page.getByRole('tab', { name: 'Spectrum', exact: true }).click();
  await page.getByRole('region', { name: 'Region spectrum' }).getByLabel('Observation group', { exact: true }).selectOption('1');
  const point = page.getByRole('button', { name: /Select measurement archive\/b,/ });
  await point.focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('View', { exact: true })).toHaveValue('browse');
  await expect(page.locator('.image-stage img')).toHaveAttribute('alt', /2025-05-25/);
  await expect(page.locator('.image-stage')).toContainText('30 × 20 PX');
  await expect(page.getByRole('img', { name: 'Draw circular region on native image' })).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('aligned comparison defaults, append, remove and reference controls remain available', async ({ page }) => {
  await setup(page, undefined, false, true);
  await page.getByLabel('View', { exact: true }).selectOption('blink');
  const comparison = page.getByRole('region', { name: 'Selected frame comparison' });
  await expect(comparison.getByRole('row')).toHaveCount(3);
  await expect(comparison).toContainText('2025-05-25');
  await expect(page.getByLabel('Frame to add', { exact: true })).toHaveValue('c');
  await page.getByRole('button', { name: 'Add frame', exact: true }).click();
  await expect(comparison.getByRole('row')).toHaveCount(4);
  await page.getByRole('button', { name: 'Remove frame 2' }).click();
  await expect(comparison.getByRole('row')).toHaveCount(3);
  await expect(page.getByLabel('Frame to add', { exact: true })).toHaveValue('archive/b');
  await page.getByLabel('Reference frame', { exact: true }).selectOption('archive/b');
  await expect(page.getByLabel('Reference frame', { exact: true })).toHaveValue('archive/b');
  await expect(page.getByRole('button', { name: 'Play blink', exact: true })).toBeEnabled();
});
