import type { Frame, SkyQuery } from '../api/frames';
import { projectGaia } from './gaiaProjection';

// MOST positions checked in all three DR1 cutouts.
const sightings = [
  { timestamp: '2025-08-04T11:04:03.533Z', ra: 222.866022, dec: -11.907528 },
  { timestamp: '2025-08-05T00:07:01.891Z', ra: 223.024527, dec: -11.992267 },
  { timestamp: '2025-08-05T13:07:54.451Z', ra: 223.183923, dec: -12.077014 },
];

export function vestaPosition(frame: Frame, query: SkyQuery | null) {
  if (!query || !frame.alignedGrid || frame.detector !== 'SPHEREx-D6' ||
      frame.release !== 'spherex_dr1') return null;
  const index = sightings.findIndex((sighting) => sighting.timestamp === frame.observedAtUtc);
  if (index < 0) return null;

  const { width } = frame.alignedGrid;
  const path = sightings.map(({ ra, dec }) => projectGaia({
    ra, dec, refEpoch: 2000, pmRa: null, pmDec: null,
  }, query, frame.observedAtUtc, width, false));
  const point = path[index];
  if (!point || point.x < 0 || point.y < 0 || point.x >= width || point.y >= width) return null;
  return { ...point, path: path.filter((position) => position !== null), verified: true };
}
