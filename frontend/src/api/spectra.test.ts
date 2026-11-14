import { describe, expect, it, vi, afterEach } from 'vitest';
import { extractSpectrum, plotDomain, recenterCircle } from './spectra';
import type { Sample } from './spectra';
afterEach(() => vi.unstubAllGlobals());
describe('native circle contract', () => {
  it('scopes requests by sequence and preserves native pixels and group IDs', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ samples: [] }) });
    vi.stubGlobal('fetch', fetcher);
    const circle = { x: 3.5, y: 6, radiusPixels: 2 };
    await extractSpectrum('sequence/1', 'archive/frame.fits', circle, [0, 2], new AbortController().signal);
    expect(fetcher.mock.calls[0][0]).toBe('/api/frames/sequence%2F1/spectra');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ sequenceId: 'sequence/1', referenceFrameId: 'archive/frame.fits', circle, observationGroupIds: [0, 2] });
  });
  it('surfaces backend errors rather than inventing measurements', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { message: 'Science unavailable' } }) }));
    await expect(extractSpectrum('s', 'f', { x: 0, y: 0, radiusPixels: 1 }, [0], new AbortController().signal)).rejects.toThrow('Science unavailable');
  });
});
it('retains negative values and spans uncertainty and bandwidth, omitting missing science', () => {
  const sample = { status: 'partial', value: -2, uncertainty: .5, wavelengthUm: 2, wavelengthRangeUm: null, bandwidthUm: 1 } as Sample;
  const domain = plotDomain([sample, { ...sample, value: null }, { ...sample, status: 'unavailable' }]);
  expect(domain.valid).toEqual([sample]);
  expect(domain.x[0]).toBeLessThan(1.5); expect(domain.x[1]).toBeGreaterThan(2.5);
  expect(domain.y[0]).toBeLessThan(-2.5); expect(domain.y[1]).toBeGreaterThan(0);
});
it('recentres an existing aperture and preserves its sky radii when a WCS scale is supplied', () => {
  const circle = { x: 1, y: 2, radiusPixels: 2, innerRadiusPixels: 4, outerRadiusPixels: 6 };
  expect(recenterCircle(circle, 8, 9)).toEqual({ ...circle, x: 8, y: 9 });
  expect(recenterCircle(circle, 8, 9, { ra: 0, dec: 0, radiusArcsec: 12, innerArcsec: 24, outerArcsec: 36 }, 3)).toEqual({ x: 8, y: 9, radiusPixels: 4, innerRadiusPixels: 8, outerRadiusPixels: 12 });
});
