import type { Frame, SkyQuery } from '../api/frames';
import { projectGaia } from './gaiaProjection';

// Predicted positions checked against the corresponding DR1 cutouts.
const early = { timestamp: '2026-04-20T00:10:00.826Z', ra: 296.24573, dec: -24.00048 };
const late = { timestamp: '2026-04-20T19:42:50.947Z', ra: 296.40882, dec: -24.04831 };
const firstTime = Date.parse(early.timestamp);
const lateTime = Date.parse(late.timestamp);
const lastTime = Date.parse('2026-04-20T19:49:19.315Z');

export function arosaPosition(frame: Frame, query: SkyQuery | null) {
  const time = Date.parse(frame.observedAtUtc);
  if (!query || !frame.alignedGrid || frame.detector !== 'SPHEREx-D2' ||
      frame.release !== 'spherex_dr1' || !(time >= firstTime && time <= lastTime)) return null;
  const { width } = frame.alignedGrid;
  const view = query;

  function projectAt(at: number, clip: boolean) {
    const fraction = (at - firstTime) / (lateTime - firstTime);
    return projectGaia({
      ra: early.ra + fraction * (late.ra - early.ra),
      dec: early.dec + fraction * (late.dec - early.dec),
      refEpoch: 2000, pmRa: null, pmDec: null,
    }, view, frame.observedAtUtc, width, clip);
  }

  const point = projectAt(time, true);
  const start = projectAt(firstTime, false);
  const end = projectAt(lastTime, false);
  if (!point || !start || !end) return null;
  return { ...point, start, end, verified: time === firstTime || time === lateTime };
}
