export interface Circle { x: number; y: number; radiusPixels: number; innerRadiusPixels?: number; outerRadiusPixels?: number }
export interface Region { ra: number; dec: number; radiusArcsec: number; innerArcsec: number; outerArcsec: number }
export function recenterCircle(circle: Circle, x: number, y: number, region?: Region, arcsecPerPixel?: number): Circle {
  if (region && arcsecPerPixel != null && Number.isFinite(arcsecPerPixel) && arcsecPerPixel > 0) {
    return { x, y, radiusPixels: region.radiusArcsec / arcsecPerPixel,
      innerRadiusPixels: region.innerArcsec / arcsecPerPixel, outerRadiusPixels: region.outerArcsec / arcsecPerPixel };
  }
  return { ...circle, x, y };
}
export interface Sample {
  frameId: string; observationGroupId: number; observedAtUtc: string; sourceFitsUrl: string;
  status: 'ok' | 'partial' | 'unavailable'; value: number | null; uncertainty: number | null;
  unit: string; wavelengthUm: number | null; bandwidthUm: number | null;
  wavelengthRangeUm: [number, number] | null; coverage: number | null; backgroundCoverage: number | null;
  sourcePixels: number | null; backgroundPixels: number | null; mjd: number | null;
  reasons: string[]; qualityPolicy?: string;
}
export interface Spectrum {
  sequenceId: string; referenceFrameId: string; circle: Circle; region: Region;
  observationGroupIds: number[]; pendingFrames: number; samples: Sample[];
  processingVersion: string; uncertaintyNote: string; regionMapping: string; discoveryScope: string;
  cacheHits: number; observationGrouping: string;
}
export async function extractSpectrum(sequenceId: string, referenceFrameId: string, circle: Circle,
  observationGroupIds: number[], signal: AbortSignal): Promise<Spectrum> {
  const response = await fetch(`/api/frames/${encodeURIComponent(sequenceId)}/spectra`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sequenceId, referenceFrameId, circle, observationGroupIds }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error?.message ?? `Spectrum request failed (${response.status}).`);
  return data;
}

export function plotDomain(samples: Sample[]) {
  const valid = samples.filter(s => s.status !== 'unavailable' && Number.isFinite(s.value) && s.value !== null && s.wavelengthUm !== null && Number.isFinite(s.wavelengthUm));
  const xs = valid.flatMap(s => s.wavelengthRangeUm ?? [s.wavelengthUm! - (s.bandwidthUm ?? 0) / 2, s.wavelengthUm! + (s.bandwidthUm ?? 0) / 2]);
  const ys = valid.flatMap(s => [s.value! - (s.uncertainty ?? 0), s.value! + (s.uncertainty ?? 0)]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys), maxY = Math.max(0, ...ys);
  const dx = Math.max((maxX - minX) * .06, .01), dy = Math.max((maxY - minY) * .1, .001);
  return { valid, x: [minX - dx, maxX + dx], y: [minY - dy, maxY + dy] };
}
