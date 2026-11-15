import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Frame } from '../api/frames';
import { FrameMetadata } from './FrameMetadata';

it('shows only the displayed exposure values and updates when a different frame is supplied', () => {
  const first = { id: 'first', observedAtUtc: '2025-01-01T00:00:00Z', detector: 'D1', release: 'dr1', wavelengthUm: 1.23, visit: 0 } as Frame;
  const html = renderToStaticMarkup(<FrameMetadata frame={first} />);
  expect(html).toContain('<dl'); expect(html).not.toContain('<table');
  expect(html).toContain('2025-01-01 00:00:00'); expect(html).toContain('1.230 microns');
  const next = renderToStaticMarkup(<FrameMetadata frame={{ ...first, id: 'next', observedAtUtc: '2025-02-02T03:00:00Z', detector: 'D6', wavelengthUm: null }} />);
  expect(next).toContain('2025-02-02 03:00:00'); expect(next).toContain('D6');
  expect(next).toContain('Unavailable'); expect(next).not.toContain('2025-01-01');
  expect(next).not.toContain('1.230');
});
