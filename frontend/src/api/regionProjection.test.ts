import { afterEach, expect, it, vi } from 'vitest';
import { cachedRegionProjection, loadRegionProjection, regionProjectionKey } from './regionProjection';
const region = { ra: 10, dec: 20, radiusArcsec: 12, innerArcsec: 24, outerArcsec: 36 };
const rings = [[[1, 2], [3, 4]]];
afterEach(() => vi.unstubAllGlobals());

it('shares prefetch and navigation requests and reuses the resulting sky overlay', async () => {
  let finish!: (value: unknown) => void;
  const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise(resolve => { finish = resolve }));
  vi.stubGlobal('fetch', fetcher);
  const first = loadRegionProjection('dedupe', 'frame/next', region);
  const second = loadRegionProjection('dedupe', 'frame/next', region);
  expect(first).toBe(second);
  expect(fetcher).toHaveBeenCalledTimes(1);
  finish({ ok: true, json: async () => ({ rings }) });
  expect(await first).toEqual(rings);
  expect(cachedRegionProjection(regionProjectionKey('dedupe', 'frame/next', region))).toEqual(rings);
  await loadRegionProjection('dedupe', 'frame/next', region);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('/api/frames/dedupe/frames/frame%2Fnext/projection');
});

it('never reuses a projection for a different frame, sequence or aperture', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rings }) });
  vi.stubGlobal('fetch', fetcher);
  await loadRegionProjection('scoped', 'one', region);
  const moved = { ...region, ra: 11 };
  expect(cachedRegionProjection(regionProjectionKey('scoped', 'one', moved))).toBeUndefined();
  await loadRegionProjection('scoped', 'one', moved);
  await loadRegionProjection('scoped', 'two', region);
  await loadRegionProjection('other', 'one', region);
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it('allows a failed overlay request to be retried', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ rings }) });
  vi.stubGlobal('fetch', fetcher);
  await expect(loadRegionProjection('retry', 'one', region)).rejects.toThrow('unavailable');
  expect(await loadRegionProjection('retry', 'one', region)).toEqual(rings);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
