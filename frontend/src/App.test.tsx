import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';

afterEach(() => vi.unstubAllGlobals());
it('keeps observation settings in the sidebar and static analysis separate from detection', () => {
  vi.stubGlobal('window', { location: { hash: '#explore' } });
  const html = renderToStaticMarkup(<App />);
  const sidebar = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
  expect(sidebar).toContain('Observation settings');
  expect(sidebar).toContain('Include QR3 spectral images');
  expect(sidebar).toContain('Suggested fields');
  expect(html).toContain('aria-labelledby="analysis-tab-static"');
  expect(html).toContain('Region spectrum');
  expect(html).toContain('Channel measurements');
  expect(html).not.toContain('Select a sky region');
  expect(html).not.toContain('Start auto observation');
});
