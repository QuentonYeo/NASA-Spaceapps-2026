export interface FluxMeasurement { fluxMjy?: number | null; uncertaintyMjy?: number | null; wavelengthUm?: number | null }
export const usableUncertainty = (value?: number | null): number | null =>
  value != null && Number.isFinite(value) && value > 0 ? value : null;

export function fluxBounds(points: FluxMeasurement[], includeZero = false): [number, number] {
  const ends = points.filter(p => p.fluxMjy != null && Number.isFinite(p.fluxMjy)).flatMap(p => {
    const sigma = usableUncertainty(p.uncertaintyMjy) ?? 0;
    return [p.fluxMjy! - sigma, p.fluxMjy! + sigma];
  });
  if (includeZero) ends.push(0);
  if (!ends.length) return [-1, 1];
  const min = Math.min(...ends), max = Math.max(...ends);
  const padding = (max - min) * .08 || Math.max(1, Math.abs(max) * .08);
  return [min - padding, max + padding];
}

export function measurementStats(points: FluxMeasurement[]) {
  const measured = points.filter(p => p.fluxMjy != null && Number.isFinite(p.fluxMjy));
  const fluxes = measured.map(p => p.fluxMjy!).sort((a, b) => a - b);
  const waves = measured.map(p => p.wavelengthUm).filter((w): w is number => w != null && Number.isFinite(w) && w > 0);
  const valid = measured.filter(p => usableUncertainty(p.uncertaintyMjy) != null);
  // Scale weights to avoid overflow when uncertainties are small.
  const scale = valid.length ? Math.min(...valid.map(p => p.uncertaintyMjy!)) : 1;
  const weights = valid.map(p => (scale / p.uncertaintyMjy!) ** 2);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const mean = valid.length ? valid.reduce((sum, p, i) => sum + p.fluxMjy! * weights[i], 0) / weightSum : null;
  const chiSquare = mean == null ? null : valid.reduce((sum, p) => sum + ((p.fluxMjy! - mean) / p.uncertaintyMjy!) ** 2, 0);
  const snrs = valid.map(p => p.fluxMjy! / p.uncertaintyMjy!);
  return {
    count: measured.length, median: fluxes.length ? (fluxes[Math.floor((fluxes.length - 1) / 2)] + fluxes[Math.floor(fluxes.length / 2)]) / 2 : null,
    wavelengthRange: waves.length ? [Math.min(...waves), Math.max(...waves)] : null,
    strongestSnr: snrs.length ? snrs.reduce((a, b) => Math.abs(a) >= Math.abs(b) ? a : b) : null,
    fit: mean == null ? null : { mean, uncertainty: scale / Math.sqrt(weightSum), chiSquare: chiSquare!, count: valid.length, dof: valid.length - 1, reduced: valid.length > 1 ? chiSquare! / (valid.length - 1) : null },
  };
}

export function fluxDifference(a: FluxMeasurement, b: FluxMeasurement) {
  if (a.fluxMjy == null || b.fluxMjy == null || !Number.isFinite(a.fluxMjy) || !Number.isFinite(b.fluxMjy)) return null;
  const first = usableUncertainty(a.uncertaintyMjy), second = usableUncertainty(b.uncertaintyMjy);
  const difference = b.fluxMjy - a.fluxMjy;
  const uncertainty = first == null || second == null ? null : Math.hypot(first, second);
  return { difference, uncertainty, significance: uncertainty == null ? null : difference / uncertainty };
}
