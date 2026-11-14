import type { GaiaSource, SkyQuery } from '../api/frames';

const radians = Math.PI / 180;
const pixelScale = 6.15 / 3600 * radians;
const masToRad = radians / 3_600_000;

export function projectGaia(source: GaiaSource, query: SkyQuery, observedAt: string, side: number) {
  const time = Date.parse(observedAt);
  const years = Number.isFinite(time) ? 2000 + (time - Date.UTC(2000, 0, 1, 12)) / 31_557_600_000 - source.refEpoch : 0;
  const ra = source.ra * radians;
  const dec = source.dec * radians;
  const ra0 = query.ra * radians;
  const dec0 = query.dec * radians;
  const delta = ra - ra0;

  // Tangent vectors for Gaia's pmRA (already includes cos Dec) and pmDec.
  // Rotate the propagated direction into the sky grid's east/north basis.
  const eastMotion = (source.pmRa ?? 0) * years * masToRad;
  const northMotion = (source.pmDec ?? 0) * years * masToRad;
  const horizontal = Math.cos(dec) - northMotion * Math.sin(dec);
  const vertical = Math.sin(dec) + northMotion * Math.cos(dec);
  const radial = horizontal * Math.cos(delta) - eastMotion * Math.sin(delta);
  const east = horizontal * Math.sin(delta) + eastMotion * Math.cos(delta);
  const north = vertical * Math.cos(dec0) - radial * Math.sin(dec0);
  const depth = vertical * Math.sin(dec0) + radial * Math.cos(dec0);
  if (depth <= 0) return null;

  // Use image-edge coordinates. East and north increase leftward and upward.
  const x = side / 2 - east / depth / pixelScale;
  const y = side / 2 - north / depth / pixelScale;
  return x >= 0 && y >= 0 && x < side && y < side ? { x, y } : null;
}
