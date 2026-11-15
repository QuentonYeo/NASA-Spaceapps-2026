import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { RegionImage } from './RegionImage';
import { loadRegionProjection } from '../api/regionProjection';
import { FingerprintPanel } from './FingerprintExplorer';
import type { useFingerprint } from '../state/useFingerprint';
import type { Fingerprint } from '../api/fingerprints';
import type { Frame } from '../api/frames';

type Explorer = ReturnType<typeof useFingerprint>;
const selection = { sequenceId: 'sequence', referenceFrameId: 'native', circle: { x: 3, y: 4, radiusPixels: 2 } };
const fingerprint: Fingerprint = {
  region: { ra: 10, dec: 20, radiusArcsec: 12, innerArcsec: 24, outerArcsec: 36 },
  channels: [{ channel: 1, detector: 1, subchannel: 1, wavelengthUm: 1, minUm: .9, maxUm: 1.1, value: 2, apertureFluxMjy: 3, backgroundFluxMjy: 1, backgroundMeanMJySr: .1, apertureAreaPixels: 3, backgroundPixels: 10, backgroundCoverage: 1, uncertainty: null, pixels: 3, coveredPixels: 3, coverage: 1, flagsOr: 0, reason: '' }],
  usableChannels: 1, totalChannels: 102, references: [], limitations: [], provenance: [],
  unit: 'mJy', processingVersion: 'tutorial-aperture-mjy-v1', product: 'test', qualityPolicy: 'test', combinedEpochs: true, uncertaintyAvailable: false, elapsedSeconds: 0,
};
const explorer = (result: Fingerprint | null): Explorer => ({
  selection, region: result?.region, result, status: null, busy: !result, error: '', selectedChannel: 1,
  setChannel: vi.fn(), commit: vi.fn(), retry: vi.fn(),
});
const frame = (id: string, wavelengthUm: number | null) => ({ id, wavelengthUm, visit: 0, observedAtUtc: '2026-11-15' }) as Frame;

it('offers only observations inside the selected channel and has no mosaic image controls', () => {
  const state = explorer(fingerprint);

  const inside = frame('inside', 1), outside = frame('outside', 2), missing = frame('missing', null);
  outside.observedAtUtc = 'OUTSIDE'; missing.observedAtUtc = 'UNKNOWN';
  const html = renderToStaticMarkup(<FingerprintPanel explorer={state} frame={inside} frames={[inside, outside, missing]} onSelect={vi.fn()} />);
  expect(html).toContain('Displayed observation wavelength at query centre: 1.000');
  expect(html).toContain('linked-observation');
  expect(html).toContain('Background-subtracted flux (mJy)');
  expect(html).not.toContain('Channel response (MJy/sr)');
  expect(html).not.toContain('OUTSIDE');
  expect(html).not.toContain('UNKNOWN');
  expect(html).not.toContain('Show mosaic channel image');
  expect(html).not.toContain('<img');
});


afterEach(() => vi.unstubAllGlobals());
it('keeps a sky aperture on a different native image before the mosaic spectrum is ready', async () => {
  const sky = fingerprint.region;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rings: [[[1, 2], [3, 4]]] }) }));
  await loadRegionProjection('sequence', 'next-native', sky);
  const next = { ...frame('next-native', 1), imageData: 'native.png', grid: { width: 20, height: 20, orientation: 'native' } };
  const state = { ...explorer(null), region: sky };
  const html = renderToStaticMarkup(<RegionImage frame={next} zoom="4" explorer={state} sequenceId="sequence" showBackground={false} />);
  expect(html).toContain('<polygon');
  expect(html).toContain('points="1,2 3,4"');
  const moved = { ...state, region: { ...sky, ra: sky.ra + 1 } };
  const updated = renderToStaticMarkup(<RegionImage frame={next} zoom="4" explorer={moved} sequenceId="sequence" showBackground={false} />);
  expect(updated).not.toContain('<polygon');
  expect(updated).toContain('Positioning selected sky region');
});


it('explains missing selection coordinates beside a preview-only native image', () => {
  const preview = { ...frame('preview', 1), imageData: 'data:image/png;base64,test', grid: { width: 29, height: 29, orientation: 'native' }, scienceStatus: 'unavailable' } as Frame;
  const html = renderToStaticMarkup(<RegionImage frame={preview} zoom="fit" explorer={explorer(null)} clickToSelect onReload={() => {}} />);
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain('This cached image has no selection coordinates');
  expect(html).toContain('Reload field for selection');
});

it('keeps an empty spectrum plot visible with image-selection guidance', () => {
  const state = { ...explorer(null), selection: null, busy: false };
  const html = renderToStaticMarkup(<FingerprintPanel explorer={state} frames={[]} onSelect={() => {}} />);
  expect(html).toContain('class="spectrum-plot"');
  expect(html).toContain('Click the main image to analyse a spectrum.');
  expect(html).toContain('Click a source on the main image');
  expect(html).not.toContain('<circle');
  expect(html).not.toContain('NaN');
});
it('keeps axes without invented samples during loading and for empty results', () => {
  const loading = renderToStaticMarkup(<FingerprintPanel explorer={explorer(null)} frames={[]} onSelect={() => {}} />);
  expect(loading).toContain('class="spectrum-plot"');
  expect(loading).toContain('Loading spectrum...');
  const empty = { ...fingerprint, channels: fingerprint.channels.map(c => ({ ...c, value: null })), usableChannels: 0 };
  const html = renderToStaticMarkup(<FingerprintPanel explorer={explorer(empty)} frames={[]} onSelect={() => {}} />);
  expect(html).toContain('class="spectrum-plot"');
  expect(html).toContain('No usable channels. Try another region.');
  expect(html).not.toContain('<circle');
});
