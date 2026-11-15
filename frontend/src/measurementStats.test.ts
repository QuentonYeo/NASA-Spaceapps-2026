import { expect, it } from 'vitest';
import { fluxBounds, fluxDifference, measurementStats } from './measurementStats';

it('bounds include both uncertainty endpoints, negative flux and padding', () => {
  const [low, high] = fluxBounds([{ fluxMjy: 3, uncertaintyMjy: 10 }, { fluxMjy: -2, uncertaintyMjy: 1 }]);
  expect(low).toBeLessThan(-7); expect(high).toBeGreaterThan(13);
  expect(fluxBounds([{ fluxMjy: 0 }])).toEqual([-1, 1]);
  expect(fluxBounds([{ fluxMjy: 2, uncertaintyMjy: NaN }])).toEqual(fluxBounds([{ fluxMjy: 2 }]));
});
it('fits an inverse-variance constant and counts only supported uncertainties', () => {
  const stats = measurementStats([{ fluxMjy: 2, uncertaintyMjy: 1 }, { fluxMjy: 6, uncertaintyMjy: 2 }, { fluxMjy: 100, uncertaintyMjy: null }]);
  expect(stats.count).toBe(3); expect(stats.median).toBe(6);
  expect(stats.fit?.mean).toBeCloseTo(2.8); expect(stats.fit?.uncertainty).toBeCloseTo(Math.sqrt(.8));
  expect(stats.fit?.chiSquare).toBeCloseTo(3.2); expect(stats.fit?.dof).toBe(1); expect(stats.fit?.reduced).toBeCloseTo(3.2);
  expect(measurementStats([{ fluxMjy: 2, uncertaintyMjy: 1 }]).fit?.reduced).toBeNull();
  expect(measurementStats([{ fluxMjy: 2, uncertaintyMjy: 0 }, { fluxMjy: 3, uncertaintyMjy: -1 }]).fit).toBeNull();
});
it('uses quadrature errors for each difference and preserves unknown significance', () => {
  expect(fluxDifference({ fluxMjy: 2, uncertaintyMjy: 3 }, { fluxMjy: 12, uncertaintyMjy: 4 })).toEqual({ difference: 10, uncertainty: 5, significance: 2 });
  expect(fluxDifference({ fluxMjy: 2 }, { fluxMjy: 12, uncertaintyMjy: 4 })?.significance).toBeNull();
});
