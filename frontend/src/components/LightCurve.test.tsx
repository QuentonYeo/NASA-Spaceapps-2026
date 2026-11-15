import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FluxChart } from './LightCurve';
it('keeps selected markers and numeric uncertainties without drawing error bars', () => {
  const html = renderToStaticMarkup(<FluxChart selectedId="a" points={[
    { frameId: 'a', fluxMjy: 2, uncertaintyMjy: 20, observedAtUtc: '2025-01-01', detector: 'D1', wavelengthUm: 1, pixels: [] },
    { frameId: 'b', fluxMjy: 3, uncertaintyMjy: null, observedAtUtc: '2025-01-02', detector: 'D1', wavelengthUm: 1, pixels: [] },
  ]} />);
  expect(html).not.toContain('flux-error');
  expect(html).toContain('class="selected"');
  expect(html).toContain('Uncertainty unavailable');
  expect(html).toContain('+/- 20 mJy');
});
